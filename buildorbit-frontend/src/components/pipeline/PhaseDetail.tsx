/**
 * PhaseDetail — renders phase-specific expanded content.
 * Owns: interpreting phase output payload into readable detail panels.
 * Not owned: expand/collapse logic, card chrome, data fetching.
 */

import { useState, useCallback } from 'react';
import type { PhaseCardData } from './PhaseCard';
import LogPanel from './LogPanel';
import CodePreview from './CodePreview';
import { useRun } from '../../state/runContext';
import { triggerVerifyFix, fetchRun, type VerifyFixResult } from '../../lib/api';

interface PhaseDetailProps {
  phase: PhaseCardData;
}

/** Safely extract a string or return undefined */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Safely extract an array of strings */
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(x => typeof x === 'string') as string[];
}

/** Render a labeled key-value row */
function Field({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="bo-detail-field">
      <span className="bo-detail-label">{label}</span>
      <span className="bo-detail-value">{String(value)}</span>
    </div>
  );
}

/** Render a list of items */
function ListField({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="bo-detail-list-field">
      <span className="bo-detail-label">{label}</span>
      <ul className="bo-detail-list">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}

/** Intent Gate: classification reasoning, intent class, constraints */
function IntentGateDetail({ output }: { output: Record<string, unknown> }) {
  const intentClass = str(output.intent_class);
  const complexityBudget = str(output.complexity_budget);
  const constraints = output.constraints as Record<string, unknown> | undefined;
  const expansionLock = output.expansion_lock;
  const reasoning = str(output.reasoning) || str(output.classification_reasoning);

  return (
    <div className="bo-detail-section">
      {reasoning && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Classification Reasoning</span>
          <pre className="bo-detail-pre">{reasoning}</pre>
        </div>
      )}
      <Field label="Intent Class" value={intentClass} />
      <Field label="Complexity Budget" value={complexityBudget} />
      {expansionLock !== undefined && (
        <Field label="Expansion Lock" value={String(expansionLock)} />
      )}
      {constraints && typeof constraints === 'object' && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Constraints</span>
          <pre className="bo-detail-pre">{JSON.stringify(constraints, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/** Plan: structured execution plan, file list, change scope */
function PlanDetail({ output }: { output: Record<string, unknown> }) {
  const plan = str(output.plan) || str(output.execution_plan);
  const components = strArr(output.planned_components) || strArr(output.components);
  const techStack = strArr(output.planned_techStack) || strArr(output.tech_stack);
  const files = strArr(output.planned_files) || strArr(output.files);
  const summary = str(output.summary) || str(output.plan_summary);

  // If output looks like it is the plan itself (not nested), render raw
  const hasStructuredFields = plan || components || techStack || files || summary;

  return (
    <div className="bo-detail-section">
      {summary && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Plan Summary</span>
          <pre className="bo-detail-pre">{summary}</pre>
        </div>
      )}
      {plan && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Execution Plan</span>
          <pre className="bo-detail-pre">{plan}</pre>
        </div>
      )}
      <ListField label="Components" items={components} />
      <ListField label="Tech Stack" items={techStack} />
      <ListField label="Files" items={files} />
      {!hasStructuredFields && (
        <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>
      )}
    </div>
  );
}

/** Scaffold: file tree decisions, tech stack, scaffold summary */
function ScaffoldDetail({ output }: { output: Record<string, unknown> }) {
  const tree = strArr(output.tree) || strArr(output.file_tree);
  const structure = output.structure as Record<string, unknown> | undefined;
  const summary = str(output.summary) || str(output.scaffold_summary);
  const files = output.files as unknown;

  return (
    <div className="bo-detail-section">
      {summary && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Scaffold Summary</span>
          <pre className="bo-detail-pre">{summary}</pre>
        </div>
      )}
      <ListField label="File Tree" items={tree} />
      {structure && typeof structure === 'object' && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Structure</span>
          <pre className="bo-detail-pre">{JSON.stringify(structure, null, 2)}</pre>
        </div>
      )}
      {!summary && !tree && !structure && !!files && (
        <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>
      )}
    </div>
  );
}

/** Code: generated code display */
function CodeDetail({ output }: { output: Record<string, unknown> }) {
  const code = str(output.code);
  const files = output.files as Record<string, unknown> | undefined;

  // If we have individual files, render each
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    const fileEntries = Object.entries(files).slice(0, 20); // Cap at 20 files
    return (
      <div className="bo-detail-section">
        {fileEntries.map(([filename, content]) => (
          <div key={filename} className="bo-detail-file">
            <span className="bo-detail-filename">{filename}</span>
            <CodePreview code={typeof content === 'string' ? content : JSON.stringify(content, null, 2)} />
          </div>
        ))}
        {Object.keys(files).length > 20 && (
          <div className="bo-detail-truncated">+ {Object.keys(files).length - 20} more files</div>
        )}
      </div>
    );
  }

  if (code) {
    return (
      <div className="bo-detail-section">
        <CodePreview code={code} />
      </div>
    );
  }

  return (
    <div className="bo-detail-section">
      <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>
    </div>
  );
}

/** Save: commit & deploy details */
function SaveDetail({ output }: { output: Record<string, unknown> }) {
  const prUrl = str(output.pr_url) || str(output.github_pr_url);
  const branch = str(output.branch);
  const commitSha = str(output.commit_sha) || str(output.sha);
  const deployUrl = str(output.deploy_url) || str(output.polsia_app_url);

  const hasFields = prUrl || branch || commitSha || deployUrl;

  return (
    <div className="bo-detail-section">
      <Field label="Branch" value={branch} />
      <Field label="Commit" value={commitSha} />
      {prUrl && (
        <div className="bo-detail-field">
          <span className="bo-detail-label">Pull Request</span>
          <a href={prUrl} target="_blank" rel="noreferrer" className="bo-detail-link">{prUrl}</a>
        </div>
      )}
      {deployUrl && (
        <div className="bo-detail-field">
          <span className="bo-detail-label">Deploy URL</span>
          <a href={deployUrl} target="_blank" rel="noreferrer" className="bo-detail-link">{deployUrl}</a>
        </div>
      )}
      {!hasFields && (
        <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>
      )}
    </div>
  );
}

/** Per-check fix state */
type FixState = 'idle' | 'fixing' | 'success' | 'exhausted' | 'error';

interface CheckFixState {
  state: FixState;
  retryCount: number;
  message?: string;
}

/** Verify: audit report with severity-tagged checks, Fix buttons for failed checks */
function VerifyDetail({ output }: { output: Record<string, unknown> }) {
  const { run, setRun } = useRun();
  const runId = run?.id;

  const checks = output.checks as Array<{
    name?: string; passed?: boolean; message?: string;
    severity?: 'critical' | 'advisory';
    expected?: string; actual?: string;
  }> | undefined;
  const audit = output.audit as {
    passedCount?: number; totalChecks?: number;
    criticalFailures?: string[]; advisoryFailures?: string[];
    hasCriticalFailures?: boolean;
  } | undefined;
  const screenshotUrl = str(output.screenshot_url) || str(output.screenshot);
  const summary = str(output.summary) || str(output.diagnosis);

  // Track per-check fix state: checkName → state
  const [fixStates, setFixStates] = useState<Record<string, CheckFixState>>({});
  const [fixAllRunning, setFixAllRunning] = useState(false);

  const failedChecks = checks?.filter(c => !c.passed && c.name) ?? [];

  // WHY: after a fix, re-fetch the full run to get updated verify results
  // so pass/fail status reflects the actual post-fix state
  const refreshRun = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await fetchRun(runId);
      if (data.success) setRun(data.run);
    } catch { /* polling will catch up */ }
  }, [runId, setRun]);

  const handleFix = useCallback(async (checkName: string) => {
    if (!runId) return;
    setFixStates(prev => ({
      ...prev,
      [checkName]: { state: 'fixing', retryCount: prev[checkName]?.retryCount ?? 0 },
    }));
    try {
      const result: VerifyFixResult = await triggerVerifyFix(runId, checkName);
      if (result.check.passed) {
        setFixStates(prev => ({
          ...prev,
          [checkName]: { state: 'success', retryCount: result.retryCount, message: result.check.message },
        }));
      } else if (result.exhausted) {
        setFixStates(prev => ({
          ...prev,
          [checkName]: { state: 'exhausted', retryCount: result.retryCount, message: result.check.message },
        }));
      } else {
        // Fix ran but check still fails — allow retry
        setFixStates(prev => ({
          ...prev,
          [checkName]: { state: 'idle', retryCount: result.retryCount, message: result.check.message },
        }));
      }
      await refreshRun();
    } catch (err) {
      setFixStates(prev => ({
        ...prev,
        [checkName]: {
          state: 'error',
          retryCount: prev[checkName]?.retryCount ?? 0,
          message: err instanceof Error ? err.message : 'Fix failed',
        },
      }));
    }
  }, [runId, refreshRun]);

  const handleFixAll = useCallback(async () => {
    if (!runId || fixAllRunning) return;
    setFixAllRunning(true);
    // Run fixes sequentially (same as legacy) — cap at 5
    const toFix = failedChecks.slice(0, 5);
    for (const check of toFix) {
      if (!check.name) continue;
      const current = fixStates[check.name];
      if (current?.state === 'success' || current?.state === 'exhausted') continue;
      await handleFix(check.name);
    }
    setFixAllRunning(false);
  }, [runId, fixAllRunning, failedChecks, fixStates, handleFix]);

  // Count still-fixable failed checks (not yet successfully fixed or exhausted)
  const fixableCount = failedChecks.filter(c => {
    const s = fixStates[c.name!];
    return !s || (s.state !== 'success' && s.state !== 'exhausted');
  }).length;

  // Determine verdict display from audit report (runtime authority)
  const verdictDisplay = audit
    ? audit.hasCriticalFailures
      ? 'FAILED — Critical issues found'
      : (audit.passedCount === audit.totalChecks)
        ? 'ALL CHECKS PASSED'
        : `${audit.passedCount}/${audit.totalChecks} passed — advisory findings`
    : null;

  const verdictClass = audit
    ? audit.hasCriticalFailures
      ? 'verdict-failed'
      : (audit.passedCount === audit.totalChecks)
        ? 'verdict-passed'
        : 'verdict-partial'
    : '';

  return (
    <div className="bo-detail-section">
      {verdictDisplay && (
        <div className={`bo-verify-verdict ${verdictClass}`}>
          <span className="bo-verdict-label">{verdictDisplay}</span>
        </div>
      )}
      {audit?.criticalFailures && audit.criticalFailures.length > 0 && (
        <div className="bo-verify-critical-banner">
          <span className="bo-critical-icon">🚨</span>
          <span>Critical: {audit.criticalFailures.join(', ')}</span>
        </div>
      )}
      {summary && (
        <div className="bo-detail-reasoning">
          <span className="bo-detail-label">Summary</span>
          <pre className="bo-detail-pre">{summary}</pre>
        </div>
      )}
      {checks && Array.isArray(checks) && checks.length > 0 && (
        <div className="bo-detail-checks">
          <div className="bo-detail-checks-header">
            <span className="bo-detail-label">Checks ({checks.filter(c => c.passed).length}/{checks.length} passed)</span>
            {fixableCount > 1 && runId && (
              <button
                className="bo-verify-fix-all-btn"
                onClick={(e) => { e.stopPropagation(); handleFixAll(); }}
                disabled={fixAllRunning}
                title="Attempt automatic fix for all failed checks"
              >
                {fixAllRunning ? (
                  <><span className="bo-fix-icon spinning">🔧</span> Fixing All…</>
                ) : (
                  <><span className="bo-fix-icon">🔧</span> Fix All ({fixableCount})</>
                )}
              </button>
            )}
          </div>
          <div className="bo-detail-check-list">
            {checks.map((check, i) => {
              const checkName = check.name || `Check ${i + 1}`;
              const fs = fixStates[checkName];
              const isFailed = !check.passed;
              const isFixed = fs?.state === 'success';
              const isExhausted = fs?.state === 'exhausted';
              const isFixing = fs?.state === 'fixing';
              const hasError = fs?.state === 'error';
              const showBtn = isFailed && !isFixed && runId;

              return (
                <div key={i} className={`bo-detail-check ${isFixed ? 'passed' : check.passed ? 'passed' : 'failed'}`}>
                  <span className="bo-detail-check-icon">
                    {isFixed ? '✓' : check.passed ? '✓' : '✗'}
                  </span>
                  <span className="bo-detail-check-name">{checkName}</span>
                  {check.severity && !check.passed && (
                    <span className={`bo-check-severity bo-check-severity--${check.severity}`}>
                      {check.severity}
                    </span>
                  )}
                  {check.message && !fs?.message && (
                    <span className="bo-detail-check-msg">{check.message}</span>
                  )}
                  {fs?.message && (
                    <span className="bo-detail-check-msg">{fs.message}</span>
                  )}
                  {showBtn && (
                    <button
                      className={`bo-verify-fix-btn${isExhausted ? ' exhausted' : ''}${hasError ? ' error' : ''}`}
                      onClick={(e) => { e.stopPropagation(); handleFix(checkName); }}
                      disabled={isFixing || isExhausted}
                      title={isExhausted ? 'Retries exhausted — manual review needed' : 'Auto-fix this failed check'}
                    >
                      {isFixing ? (
                        <><span className="bo-fix-icon spinning">🔧</span> Fixing…</>
                      ) : isExhausted ? (
                        <>⚠ Manual review</>
                      ) : fs?.retryCount ? (
                        <><span className="bo-fix-icon">🔧</span> Retry ({fs.retryCount})</>
                      ) : (
                        <><span className="bo-fix-icon">🔧</span> Fix</>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {screenshotUrl && (
        <div className="bo-detail-field">
          <span className="bo-detail-label">Screenshot</span>
          <a href={screenshotUrl} target="_blank" rel="noreferrer" className="bo-detail-link">View Screenshot</a>
        </div>
      )}
      {!checks && !summary && !audit && (
        <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>
      )}
    </div>
  );
}

/** Route to phase-specific detail component based on phase name */
export default function PhaseDetail({ phase }: PhaseDetailProps) {
  const output = phase.output;
  const hasLogs = phase.logs && phase.logs.length > 0;

  // If no output and no logs, show a minimal message
  if (!output && !hasLogs && !phase.error) {
    return (
      <div className="bo-detail-section">
        <div className="bo-detail-empty">No execution data recorded for this phase.</div>
      </div>
    );
  }

  // Show error if present
  const errorBlock = phase.error ? (
    <div className="bo-detail-error">
      <span className="bo-detail-label">Error</span>
      <pre className="bo-detail-pre bo-detail-error-text">{phase.error}</pre>
    </div>
  ) : null;

  // Phase-specific content
  let content = null;
  if (output) {
    switch (phase.name) {
      case 'intent_gate':
        content = <IntentGateDetail output={output} />;
        break;
      case 'plan':
        content = <PlanDetail output={output} />;
        break;
      case 'scaffold':
        content = <ScaffoldDetail output={output} />;
        break;
      case 'code':
        content = <CodeDetail output={output} />;
        break;
      case 'save':
        content = <SaveDetail output={output} />;
        break;
      case 'verify':
        content = <VerifyDetail output={output} />;
        break;
      default:
        // Unknown phase — render raw JSON
        content = <pre className="bo-detail-pre">{JSON.stringify(output, null, 2)}</pre>;
    }
  }

  return (
    <>
      {errorBlock}
      {content}
      {hasLogs && <LogPanel logs={phase.logs!} />}
    </>
  );
}
