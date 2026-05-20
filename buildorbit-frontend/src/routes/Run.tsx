/**
 * Run — Pipeline execution view.
 * Owns: 6 phase cards, SSE stream, status polling, WebSocket streaming, action buttons.
 * Not owned: pipeline logic, server execution.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchRun, fetchRunReasoning, type PipelineRun, type PhaseState, type ReasoningEntry } from '../lib/api';
import PipelineView, { type PipelinePhase } from '../components/pipeline/PipelineView';
import ReasoningCard from '../components/pipeline/ReasoningCard';
import { type PhaseStatus } from '../components/pipeline/StatusBadge';
import PreviewPanel from '../components/preview/PreviewPanel';
import ScaffoldPreviewPanel from '../components/preview/ScaffoldPreviewPanel';
import { isServerProject, extractPreviewAssets, extractPreviewFromCodeString } from '../lib/previewAssets';
import { useRun } from '../state/runContext';
import { useUIState } from '../state/uiState';
import { connectToRunStream, type StreamMessage, type RunStreamConnection, type ConnectionState } from '../state/websocket';
import './Run.css';

const PHASE_META = [
  { key: 'intent_gate', label: 'Intent Gate', icon: '🎯', desc: 'Classify intent & set constraints' },
  { key: 'plan',        label: 'Plan',        icon: '📋', desc: 'Architecture & component plan' },
  { key: 'scaffold',    label: 'Scaffold',    icon: '🏗',  desc: 'File tree & structure' },
  { key: 'code',        label: 'Code',        icon: '💻', desc: 'Generate implementation' },
  { key: 'save',        label: 'Save',        icon: '💾', desc: 'Commit & deploy to GitHub' },
  { key: 'verify',      label: 'Verify',      icon: '✅', desc: 'Test, screenshot & validate' },
];

/** Map a PhaseState from the API onto a PipelinePhase shape for PipelineView. */
function buildPhases(phases: Record<string, PhaseState>, activePhase: string | null): PipelinePhase[] {
  return PHASE_META.map(meta => {
    const state = phases[meta.key];
    const rawStatus = state?.status ?? 'waiting';
    // Guard — only pass known status values
    const status: PhaseStatus =
      ['waiting', 'running', 'complete', 'failed', 'skipped'].includes(rawStatus)
        ? (rawStatus as PhaseStatus)
        : 'waiting';

    // Phase output — raw payload from pipeline_events (interpreted by PhaseDetail)
    const output = state?.output as Record<string, unknown> | undefined;

    // Extract streaming logs from output (appended by WebSocket)
    const logs = Array.isArray(output?.logs) ? (output.logs as string[]) : undefined;
    const diff = typeof output?.diff === 'string' ? output.diff : undefined;
    const code = typeof output?.code === 'string' ? output.code : undefined;

    // Highlight the active phase (set by WebSocket stream)
    const isActive = activePhase === meta.key;

    return {
      name:     meta.key,
      label:    meta.label,
      icon:     meta.icon,
      desc:     meta.desc,
      status:   isActive && status === 'waiting' ? 'running' : status,
      logs,
      diff,
      code,
      output,
      error:    state?.error,
    };
  });
}

/** Merge a WebSocket phase update into the local phases map. */
function applyStreamMessage(
  prev: PipelineRun,
  msg: StreamMessage,
): PipelineRun {
  if (!msg.phase) return prev;

  const existing = prev.phases[msg.phase] ?? { status: 'waiting' as PhaseStatus };

  const updatedPhase: PhaseState = {
    ...existing,
    status: (msg.status as PhaseState['status']) ?? existing.status,
  };

  // Append log lines if present
  if (msg.log) {
    const prevOutput = existing.output as Record<string, unknown> | undefined;
    const prevLogs   = Array.isArray(prevOutput?.logs) ? (prevOutput.logs as string[]) : [];
    updatedPhase.output = { ...(prevOutput ?? {}), logs: [...prevLogs, msg.log] };
  }

  return {
    ...prev,
    // Advance current_phase whenever a phase transitions to running
    current_phase: msg.status === 'running' ? msg.phase : prev.current_phase,
    phases: { ...prev.phases, [msg.phase]: updatedPhase },
  };
}

/**
 * Merge a polling API response with existing WS-enriched state.
 * Takes canonical fields (status, cost, URLs) from the API but preserves
 * WS-enriched phase output (logs, diff, code) when richer than the API version.
 * WHY: polling replaces the entire run every 3s, clobbering streaming logs
 * the WebSocket delivered but the API hasn't persisted yet.
 */
function mergePollingUpdate(existing: PipelineRun, incoming: PipelineRun): PipelineRun {
  const mergedPhases: Record<string, PhaseState> = { ...incoming.phases };

  for (const key of Object.keys(existing.phases)) {
    const existingPhase = existing.phases[key];
    const incomingPhase = incoming.phases[key];
    if (!incomingPhase) {
      // Phase exists locally but not in API — keep it (WS delivered it first)
      mergedPhases[key] = existingPhase;
      continue;
    }
    // Preserve richer output (more logs) from WS when API hasn't caught up
    const existingOutput = existingPhase.output as Record<string, unknown> | undefined;
    const incomingOutput = incomingPhase.output as Record<string, unknown> | undefined;
    const existingLogs = Array.isArray(existingOutput?.logs) ? existingOutput.logs as string[] : [];
    const incomingLogs = Array.isArray(incomingOutput?.logs) ? incomingOutput.logs as string[] : [];

    if (existingLogs.length > incomingLogs.length) {
      // WS has more logs — keep local output, take API status
      mergedPhases[key] = {
        ...incomingPhase,
        output: existingOutput,
      };
    }
  }

  return {
    ...incoming,
    phases: mergedPhases,
  };
}

export default function Run() {
  const { id: runId } = useParams<{ id: string }>();

  // Global state
  const { run, setRun }           = useRun();
  const { state: uiState, setActivePhase } = useUIState();

  // Error state — loading is derived from !run && !error to prevent
  // spinner/data desync when WS and polling race each other
  const [error, setError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<ConnectionState>('connecting');
  const loading = !run && !error;

  // Phase reasoning timeline — polled every 3s independently of run status polling
  const [reasoningTimeline, setReasoningTimeline] = useState<ReasoningEntry[]>([]);
  const reasoningIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const connRef      = useRef<RunStreamConnection | null>(null);

  // ── Polling fallback ──────────────────────────────────────────
  // WHY merge instead of replace: polling fires every 3s and used to do
  // setRun(data.run), clobbering WS-enriched logs/diff/code. Now it
  // merges, preserving richer output from the live stream.
  const loadRun = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await fetchRun(runId);
      if (data.success) {
        setRun(prev => prev ? mergePollingUpdate(prev, data.run) : data.run);
        if (['completed', 'partial_success', 'failed'].includes(data.run.status)) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          // Also stop reasoning polling — run is done, no more phases to capture
          if (reasoningIntervalRef.current) clearInterval(reasoningIntervalRef.current);
          // Run finished — stop reconnect attempts, stream is done
          connRef.current?.disconnect();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load run');
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }, [runId, setRun]);

  // ── WebSocket streaming (auto-reconnect with exponential backoff) ──
  const connectWS = useCallback(() => {
    if (!runId) return;
    connRef.current = connectToRunStream(runId, {
      onMessage: (msg: StreamMessage) => {
        // Update active phase highlight in global UI state
        if (msg.phase && msg.status === 'running') {
          setActivePhase(msg.phase);
        }
        if (msg.phase && (msg.status === 'complete' || msg.status === 'failed')) {
          setActivePhase(null);
        }

        // Merge update into global run state (reactive — no polling needed
        // while WS is live, but polling continues as a safety net)
        setRun(prev => {
          if (!prev) return prev;
          return applyStreamMessage(prev, msg);
        });
      },
      onStateChange: setWsState,
      onError: () => {
        // WS error — reconnect is handled automatically by the connection
        // manager; polling continues as a safety net
      },
    });
  }, [runId, setRun, setActivePhase]);

  // ── Reasoning polling ─────────────────────────────────────────
  // Polls GET /api/runs/:id/reasoning every 3s. Runs independently of
  // the run-status poller so reasoning updates don't stall on run merge logic.
  // Stops automatically once the run finishes (completed or failed).
  const loadReasoning = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await fetchRunReasoning(runId);
      if (data.success && Array.isArray(data.timeline)) {
        setReasoningTimeline(data.timeline);
      }
    } catch {
      // Non-fatal: reasoning failures must not disrupt the run view
    }
  }, [runId]);

  // ── Lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    // Clear stale run from previous navigation — spinner shows until
    // either the fetch or WS populates run, whichever is first
    setRun(null);
    setError(null);
    setActivePhase(null);
    setReasoningTimeline([]);

    loadRun();
    intervalRef.current = setInterval(loadRun, 3000);
    connectWS();

    // Reasoning polling — 3s interval, independent of run polling
    loadReasoning();
    reasoningIntervalRef.current = setInterval(loadReasoning, 3000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (reasoningIntervalRef.current) clearInterval(reasoningIntervalRef.current);
      connRef.current?.disconnect();
      connRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (!runId) {
    return <div className="run-error">Invalid run ID</div>;
  }

  const phases         = run?.phases ?? {};
  const isRunning      = run && !['completed', 'partial_success', 'failed'].includes(run.status);
  const isPartialSuccess = run?.status === 'partial_success';
  const pipelinePhases = buildPhases(phases, uiState.activePhase);

  // Determine if the full code preview panel should be shown (after CODE or VERIFY completes)
  const showPreview = useMemo(() => {
    if (!run) return false;
    const codePhase = phases.code;
    const verifyPhase = phases.verify;
    if (codePhase?.status !== 'complete' && verifyPhase?.status !== 'complete') return false;
    const output = codePhase?.output as Record<string, unknown> | undefined;
    if (!output) return false;
    const files = output.files as Record<string, unknown> | undefined;
    const code = typeof output.code === 'string' ? output.code : undefined;
    // Server projects show file tree; web projects show iframe
    if (isServerProject(files, run.intent_class)) return true;
    if (extractPreviewAssets(files)) return true;
    if (code && extractPreviewFromCodeString(code)) return true;
    return false;
  }, [run, phases]);

  // Scaffold preview: show during pipeline run (before CODE completes) when the
  // run is active and we have at least intent_gate or plan data. Never show
  // generic CRUD placeholder content — only context-aware or "build initializing".
  const showScaffoldPreview = useMemo(() => {
    if (!run) return false;
    if (showPreview) return false; // Full preview takes over once code completes
    // Show during active runs or if the run is completed but code preview isn't available
    const hasStarted = run.status !== 'queued' &&
      Object.values(phases).some(p => p.status !== 'waiting');
    return hasStarted;
  }, [run, phases, showPreview]);

  // Extract scaffold phase output for the ScaffoldPreviewPanel
  const scaffoldPhaseOutput = useMemo(() => {
    const scaffoldPhase = phases.scaffold;
    if (!scaffoldPhase?.output || scaffoldPhase.status === 'waiting') return null;
    return scaffoldPhase.output as Record<string, unknown>;
  }, [phases]);

  // Extract plan summary from plan phase output
  const planSummary = useMemo(() => {
    const planPhase = phases.plan;
    if (!planPhase?.output) return null;
    const out = planPhase.output as Record<string, unknown>;
    return (typeof out.summary === 'string' ? out.summary : null) ||
      (typeof out.plan_summary === 'string' ? out.plan_summary : null);
  }, [phases]);

  return (
    <div className="page-run">
      {/* Background */}
      <div className="cloud-bg">
        <div className="cloud-layer-1" />
        <div className="cloud-layer-2" />
        <div className="cloud-layer-3" />
        <div className="cloud-layer-4" />
      </div>

      <main className="run-main">
        {loading ? (
          <div className="run-loading">
            <div className="spinner" />
            <span>Loading run…</span>
          </div>
        ) : error ? (
          <div className="run-error-box">
            <div className="run-error-icon">⚠</div>
            <div className="run-error-msg">{error}</div>
            <Link to="/dashboard" className="run-back-link">← Back to Dashboard</Link>
          </div>
        ) : run ? (
          <>
            {/* Run header */}
            <div className="run-header">
              <div className="run-header-left">
                <div className="run-prompt">{run.prompt || 'Untitled'}</div>
                <div className="run-meta">
                  <span className="run-id">#{runId?.slice(0, 8)}</span>
                  {run.intent_class && (
                    <span className="run-intent">{run.intent_class}</span>
                  )}
                  <span className={`run-status run-status--${run.status}`}>
                    {run.status}
                  </span>
                </div>
              </div>
              {isRunning && wsState === 'reconnecting' ? (
                <div className="run-reconnect-indicator">
                  <div className="run-reconnect-spinner" />
                  Reconnecting…
                </div>
              ) : isRunning ? (
                <div className="run-live-indicator">
                  <div className="run-live-dot" />
                  Live
                </div>
              ) : null}
            </div>

            {/* Pipeline phases + preview panel (split on desktop when preview available) */}
            {showPreview ? (
              <div className="run-content-split">
                <div className="run-content-phases">
                  <PipelineView phases={pipelinePhases} />
                  <ReasoningCard
                    timeline={reasoningTimeline}
                    isRunning={!!isRunning}
                  />
                </div>
                <div className="run-content-preview">
                  <PreviewPanel
                    phases={phases}
                    intentClass={run.intent_class}
                    polsiaAppUrl={run.polsia_app_url}
                  />
                </div>
              </div>
            ) : showScaffoldPreview ? (
              /* Context-aware scaffold preview — shown during pipeline run before code
                 completes. Replaces the generic CRUD placeholder entirely. */
              <div className="run-content-split">
                <div className="run-content-phases">
                  <PipelineView phases={pipelinePhases} />
                  <ReasoningCard
                    timeline={reasoningTimeline}
                    isRunning={!!isRunning}
                  />
                </div>
                <div className="run-content-preview">
                  <ScaffoldPreviewPanel
                    currentPhase={run.current_phase}
                    scaffoldOutput={scaffoldPhaseOutput}
                    planSummary={planSummary}
                    prompt={run.prompt}
                    isRunning={!!isRunning}
                  />
                </div>
              </div>
            ) : (
              <>
                <PipelineView phases={pipelinePhases} />
                <ReasoningCard
                  timeline={reasoningTimeline}
                  isRunning={!!isRunning}
                />
              </>
            )}

            {/* Partial success warning banner */}
            {isPartialSuccess && (
              <div className="run-partial-banner">
                <span className="run-partial-icon">⚠</span>
                <div className="run-partial-text">
                  <strong>Build completed with findings</strong>
                  <span>Some advisory checks did not pass. Review the Verify phase for details.</span>
                </div>
              </div>
            )}

            {/* Action buttons — shown for both completed and partial_success */}
            {(run.status === 'completed' || run.status === 'partial_success') && (
              <div className="run-actions">
                {run.github_pr_url && (
                  <a
                    href={run.github_pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="run-action-btn run-action-btn--primary"
                  >
                    View PR →
                  </a>
                )}
                {run.polsia_app_url && (
                  <a
                    href={run.polsia_app_url}
                    target="_blank"
                    rel="noreferrer"
                    className="run-action-btn"
                  >
                    View Live App →
                  </a>
                )}
                <Link
                  to={`/run/${runId}/edit`}
                  className="run-action-btn"
                >
                  Open Copilot →
                </Link>
              </div>
            )}

            {/* Duration footer */}
            {run.cost !== undefined && (
              <div className="run-footer">
                <span className="run-cost">Cost: ${run.cost.toFixed(4)}</span>
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
