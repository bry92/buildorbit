/**
 * Pipeline Orchestrator Service (v3 — Intervention-Aware)
 *
 * Owns the full lifecycle of a pipeline run:
 *   1. Picks up queued jobs
 *   2. Routes each stage to the appropriate agent (Planner, Builder, QA, Ops)
 *   3. Enforces stage contracts (typed input/output validation)
 *   4. Fires events through the event bus on every transition
 *   5. Handles failures gracefully (log, mark failed, stop)
 *   6. Supports retry: re-enqueue a failed run — it picks up where it left off
 *   7. Fault-tolerant: on process restart, recovers in-flight runs from the event log
 *   8. Mid-run intervention: pause/resume, instruction injection, agent overrides
 *
 * Agent routing (via AgentRegistry):
 *   plan              → PlannerAgent
 *   scaffold, code    → BuilderAgent
 *   save              → OpsAgent
 *   verify            → QAAgent
 *
 * Agents communicate ONLY through pipeline state (previousOutputs from event log).
 * No direct agent-to-agent calls. Each agent receives its stage input from
 * the orchestrator, which reads previousOutputs from the DB.
 *
 * Backward compatible: if no agentRegistry is provided, falls back to
 * the legacy PipelineExecutor for all stages.
 *
 * Intervention Controls:
 *   pause(runId)                     — request pause after current stage completes
 *   resume(runId)                    — resume a paused run
 *   inject(runId, message)           — inject instruction for next stage
 *   override(runId, agent, prompt)   — override next invocation of an agent
 *   getRunConfig(runId)              — get stored run configuration
 */

const { STAGES } = require('./state-machine');
const { BUS_EVENTS } = require('./event-bus');
const { appendPhaseReasoning } = require('../lib/phase-reasoning');
const { buildStageInput, validateStageOutput, ContractValidationError, validateScaffoldManifest, validateCodeAgainstScaffold } = require('./stage-contracts');
const { CostTracker } = require('../lib/cost-tracker');
const { AGENT_FOR_STAGE } = require('../lib/trace-store');
const { RunTrace } = require('../lib/run-trace');
const { formatProductContext, loadProductContextFromEnv } = require('../lib/product-context');
const { classify: classifyIntent, validateScaffoldAgainstContract, validateCodeAgainstContract, formatConstraintBlock } = require('../phases/intent-gate');
const constraintLearner = require('../lib/constraint-learner');
const { validateCCO, computeCCOHash, verifyCCOHash } = require('../lib/cco-validator');
const { FRONTEND_ROOT_FILES, JS_EQUIVALENTS, buildManifestSet, applyEquivalenceRenames } = require('../lib/manifest-constants');
const analytics = require('../lib/analytics');
const {
  sendPipelineCompleteEmail,
  sendCreditWarningEmail,
} = require('../../backend/src/email/transactional');
const OpenAI = require('openai');

// Map agent stage name → agent key for override lookups
// intent_gate is handled in Step 0 (not agent-routed) but listed for completeness
const STAGE_TO_AGENT = {
  intent_gate: null,
  plan:     'planner',
  scaffold: 'builder',
  code:     'builder',
  save:     'ops',
  verify:   'qa',
};

class PipelineOrchestrator {
  /**
   * @param {object} opts
   * @param {import('./state-machine').PipelineStateMachine}  opts.stateMachine
   * @param {import('./pipeline').PipelineExecutor}           opts.executor       - Legacy fallback executor
   * @param {import('./event-bus').PipelineEventBus}          opts.eventBus
   * @param {import('pg').Pool}                               opts.pool
   * @param {import('./agents/index').AgentRegistry}          [opts.agentRegistry] - Optional: routes stages to agents
   * @param {CostTracker}                                     [opts.costTracker]   - Optional: per-run economics tracking
   */
  constructor({ stateMachine, executor, eventBus, pool, agentRegistry = null, artifactStore = null, costTracker = null, traceStore = null, deployEngine = null, mcpRegistry = null, mcpAudit = null }) {
    this.stateMachine = stateMachine;
    this.executor = executor;
    this.eventBus = eventBus;
    this.pool = pool;
    this.agentRegistry = agentRegistry;
    this.artifactStore = artifactStore;
    this.costTracker = costTracker || new CostTracker();
    this.traceStore = traceStore; // Optional: captures per-stage decision traces
    this.runTrace = new RunTrace(pool); // Decision-level causal DAG per run
    this.deployEngine = deployEngine; // Optional: triggers auto-deploy after pipeline completes
    this.mcpRegistry = mcpRegistry || null; // Optional: MCP connector registry for phase tool access
    this.mcpAudit = mcpAudit || null;       // Optional: MCP audit layer (writes to pipeline_events)
    this._healingOpenAI = null; // Lazy-initialized for self-healing LLM calls

    this.queue = [];
    this.processing = false;
    this.activeRuns = new Map(); // runId → RunContext
    this.concurrency = 1;

    // Wire up the event bus: stage_completed triggers the next stage.
    // Wrapped in try-catch: an uncaught throw from a synchronous listener
    // becomes an unhandled rejection that can crash the process (Node ≥15).
    this.eventBus.on(BUS_EVENTS.STAGE_COMPLETED, (event) => {
      try {
        this._onStageCompleted(event);
      } catch (listenerErr) {
        console.error('[Orchestrator] Event bus STAGE_COMPLETED listener error (non-fatal):', listenerErr.message);
      }
    });

    if (agentRegistry) {
      console.log('[Orchestrator] Agent routing enabled:', agentRegistry.getStatus().stageMapping);
    } else {
      console.log('[Orchestrator] Running in legacy executor mode (no agentRegistry)');
    }
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Enqueue a new pipeline run for execution.
   *
   * @param {string} runId
   * @param {string} prompt
   * @param {{ budgetCap?: number, budgetWarning?: number }} [budgetOpts]
   * @param {object} [runConfig] - Optional: { modelConfig, constraints }
   */
  enqueue(runId, prompt, budgetOpts = {}, runConfig = {}) {
    this.queue.push({ runId, prompt, budgetOpts, runConfig });
    // Initialize cost tracking immediately so budget is available before first stage
    this.costTracker.initRun(runId, budgetOpts);
    console.log(`[Orchestrator] Enqueued run ${runId.slice(0, 8)}... (queue: ${this.queue.length})`);
    this._processNext();
  }

  /**
   * Retry a failed pipeline run. Re-enqueues it.
   * The state machine + idempotency keys ensure completed stages are skipped.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string, nextStage?: string }}
   */
  async retry(runId) {
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Pipeline run not found' };
    }

    // Block retry only for actively running pipelines and successful completions.
    // Everything else (failed, stalled *_complete, paused, queued) is retryable.
    const NON_RETRYABLE = new Set([
      'completed',
      'intent_gate_running', 'plan_running', 'scaffold_running',
      'code_running', 'save_running', 'verify_running',
    ]);
    if (NON_RETRYABLE.has(run.state)) {
      return { success: false, message: `Cannot retry: pipeline is in state "${run.state}" (actively running or already completed)` };
    }

    // Find the stage that needs re-execution.
    // For 'failed' pipelines, look for the last failed event.
    // For stalled *_complete pipelines, determine the next stage from state.
    const events = await this.stateMachine.getEvents(runId);
    let resumeStage = null;

    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === 'failed') {
        resumeStage = events[i].stage;
        break;
      }
    }

    // No failed event found — pipeline stalled at an intermediate *_complete state.
    // Determine the next stage from the current state.
    if (!resumeStage) {
      resumeStage = await this.stateMachine.getNextStage(runId);
    }

    // Fallback: if still unknown, restart from intent_gate
    if (!resumeStage) {
      resumeStage = 'intent_gate';
    }

    // For non-failed states (stalled *_complete, paused), set state to 'failed'
    // so the state machine allows re-entering any stage via failed → *_running.
    if (run.state !== 'failed') {
      try {
        await this.pool.query(
          `UPDATE pipeline_runs SET state = 'failed', status = 'failed' WHERE id = $1`,
          [runId]
        );
      } catch (stateErr) {
        console.warn(`[Orchestrator] Failed to reset state to failed (non-fatal): ${stateErr.message}`);
      }
    }

    // Increment retry_count so the state machine builds distinct idempotency
    // keys for each attempt (key = runId:stage:status:retryCount).
    // Without this, retries reuse the original event key, the INSERT is
    // a no-op, and the state projection never updates — run stays stuck.
    try {
      await this.pool.query(
        'UPDATE pipeline_runs SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = $1',
        [runId]
      );
    } catch (rcErr) {
      console.warn(`[Orchestrator] Failed to increment retry_count (non-fatal): ${rcErr.message}`);
    }

    // Clear QA issues from previous attempt (clean slate for retry)
    if (this.agentRegistry) {
      this.agentRegistry.qa.clearIssues(runId);
    }

    // Reload run config for retry
    const runConfig = run.run_config || {};

    this.enqueue(runId, run.prompt, {}, runConfig);

    return {
      success: true,
      message: `Retry enqueued. Will resume from "${resumeStage}" stage.`,
      nextStage: resumeStage,
    };
  }

  /**
   * Abort a running pipeline.
   */
  abort(runId) {
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.aborted = true;
      ctx.resumed = true; // Wake up any pause-wait loop
      console.log(`[Orchestrator] Abort requested for ${runId.slice(0, 8)}...`);
      return true;
    }
    return false;
  }

  /**
   * Request pause after the current stage completes.
   * If between stages, pauses immediately.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string }}
   */
  pause(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      return { success: false, message: 'Run is not active' };
    }
    if (ctx.pauseRequested || ctx.paused) {
      return { success: false, message: 'Run is already pausing or paused' };
    }
    ctx.pauseRequested = true;
    console.log(`[Orchestrator] Pause requested for ${runId.slice(0, 8)}...`);
    return { success: true, message: 'Pause requested — will hold after current stage completes' };
  }

  /**
   * Resume a paused pipeline run.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string }}
   */
  resume(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      // Run might have been paused across a restart — re-enqueue from DB
      return this._resumeFromDb(runId);
    }
    if (!ctx.paused) {
      return { success: false, message: 'Run is not paused' };
    }
    ctx.paused = false;
    ctx.resumed = true; // Wake wait loop if one exists (mid-run pause)

    // If the run was parked by recovery (not in the processing queue),
    // we need to re-enqueue it via _resumeFromDb so it actually executes.
    // Check: if this.processing is false or the queue doesn't contain this run,
    // the run is parked — delegate to _resumeFromDb for a proper re-enqueue.
    const inQueue = this.queue.some(j => j.runId === runId);
    if (!inQueue && !this.processing) {
      // Parked run — clean up the placeholder ctx and let _resumeFromDb
      // create a fresh execution path from the DB state.
      this.activeRuns.delete(runId);
      console.log(`[Orchestrator] Resume: run ${runId.slice(0, 8)}... was parked — re-enqueuing from DB`);
      return this._resumeFromDb(runId);
    }

    console.log(`[Orchestrator] Resume signal sent for ${runId.slice(0, 8)}...`);
    return { success: true, message: 'Resume signal sent' };
  }

  /**
   * Inject an instruction directive for the next stage execution.
   * The message is prepended to the next agent's prompt.
   *
   * @param {string} runId
   * @param {string} message
   * @returns {{ success: boolean, message: string }}
   */
  async inject(runId, message) {
    if (!message || !message.trim()) {
      return { success: false, message: 'Instruction message is required' };
    }

    // Verify run exists
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }

    // Log to interventions table
    await this.pool.query(
      `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'instruction_injected', $2)`,
      [runId, JSON.stringify({ message: message.trim(), timestamp: new Date().toISOString() })]
    );

    // Store in active run context if running
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.pendingInjections.push(message.trim());
    }

    // Emit SSE event so UI can show the injection
    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'instruction_injected',
      payload: JSON.stringify({ message: message.trim() }),
      created_at: new Date().toISOString()
    });

    console.log(`[Orchestrator] Instruction injected for ${runId.slice(0, 8)}...: ${message.slice(0, 80)}`);
    return { success: true, message: 'Instruction injected — will apply to next stage' };
  }

  /**
   * Set a one-shot agent override for the next invocation.
   * The override applies once then reverts to default.
   *
   * @param {string} runId
   * @param {string} agent  - Agent name (planner, builder, ops, qa)
   * @param {string} prompt - Custom prompt to replace agent's default
   * @returns {{ success: boolean, message: string }}
   */
  async override(runId, agent, prompt) {
    if (!agent || !prompt || !prompt.trim()) {
      return { success: false, message: 'Agent name and prompt are required' };
    }

    const validAgents = ['planner', 'builder', 'ops', 'qa'];
    if (!validAgents.includes(agent.toLowerCase())) {
      return { success: false, message: `Invalid agent. Must be one of: ${validAgents.join(', ')}` };
    }

    // Verify run exists
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }

    const agentKey = agent.toLowerCase();

    // Log to interventions table
    await this.pool.query(
      `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'agent_overridden', $2)`,
      [runId, JSON.stringify({ agent: agentKey, prompt: prompt.trim(), scope: 'one_shot', timestamp: new Date().toISOString() })]
    );

    // Store in active run context
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.agentOverrides[agentKey] = prompt.trim();
    }

    // Emit SSE event
    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'agent_overridden',
      payload: JSON.stringify({ agent: agentKey, scope: 'one_shot' }),
      created_at: new Date().toISOString()
    });

    console.log(`[Orchestrator] Agent override set for ${agentKey} on run ${runId.slice(0, 8)}...`);
    return { success: true, message: `Override set for ${agentKey} — applies on next invocation` };
  }

  /**
   * Get run configuration (stored at run creation time).
   *
   * @param {string} runId
   */
  async getRunConfig(runId) {
    const { rows } = await this.pool.query(
      'SELECT run_config FROM pipeline_runs WHERE id = $1',
      [runId]
    );
    if (!rows[0]) return null;
    return rows[0].run_config || {};
  }

  /**
   * Get all interventions for a run (audit log).
   */
  async getInterventions(runId) {
    const { rows } = await this.pool.query(
      `SELECT id, type, payload, created_at FROM pipeline_interventions WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    return rows;
  }

  /**
   * Recover in-flight pipelines after a process restart.
   * Scans for runs in *_running or paused states and re-enqueues them.
   */
  async recover() {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, prompt, state, run_config FROM pipeline_runs
         WHERE state LIKE '%_running' OR state = 'queued' OR state = 'paused'
         ORDER BY created_at ASC`
      );

      if (rows.length === 0) {
        console.log('[Orchestrator] Recovery: no in-flight pipelines found');
        return;
      }

      console.log(`[Orchestrator] Recovery: found ${rows.length} in-flight pipeline(s)`);

      for (const run of rows) {
        if (run.state === 'paused') {
          // Paused runs: register in activeRuns so resume() can find them,
          // but do NOT enqueue — a paused run entering _waitForResume blocks
          // the serial queue and starves every other pipeline behind it.
          // When the user calls resume(), _resumeFromDb() re-enqueues it.
          console.log(`[Orchestrator] Recovery: run ${run.id.slice(0, 8)}... is paused — parked (not queued)`);
          const ctx = this._createRunContext(run.run_config || {});
          ctx.paused = true;
          ctx.pausedAt = null;
          this.activeRuns.set(run.id, ctx);
          continue;
        }

        if (run.state.endsWith('_running')) {
          const stage = run.state.replace('_running', '');
          try {
            await this.stateMachine.transition(run.id, stage, 'failed', null, 'Process restarted — auto-recovering');
            console.log(`[Orchestrator] Recovery: marked ${stage} as failed for ${run.id.slice(0, 8)}...`);
          } catch (e) {
            console.log(`[Orchestrator] Recovery: could not transition ${run.id.slice(0, 8)}...: ${e.message}`);
          }
        }

        // Increment retry_count so idempotency keys don't collide with
        // previous attempts (same fix as retry() applies).
        try {
          await this.pool.query(
            'UPDATE pipeline_runs SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = $1',
            [run.id]
          );
        } catch (_) { /* non-fatal */ }

        this.enqueue(run.id, run.prompt, {}, run.run_config || {});
      }
    } catch (err) {
      console.error('[Orchestrator] Recovery failed:', err.message);
    }
  }

  /**
   * Get orchestrator status (includes agent registry info).
   */
  getStatus() {
    const status = {
      queued: this.queue.length,
      processing: this.processing,
      activeRuns: Array.from(this.activeRuns.keys()),
      pausedRuns: Array.from(this.activeRuns.entries())
        .filter(([, ctx]) => ctx.paused)
        .map(([id]) => id),
    };

    if (this.agentRegistry) {
      status.agents = this.agentRegistry.getStatus();
    }

    return status;
  }

  // ── Internal Execution ─────────────────────────────────

  _createRunContext(runConfig = {}) {
    return {
      aborted: false,
      pauseRequested: false,
      paused: false,
      resumed: false,
      pausedAfterStage: null,
      pendingInjections: [],
      agentOverrides: {},
      runConfig: runConfig || {},
    };
  }

  async _processNext() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift();

    console.log(`[Orchestrator] Starting run ${job.runId.slice(0, 8)}...`);

    // Reuse existing ctx if recovering a paused run
    let ctx = this.activeRuns.get(job.runId);
    if (!ctx) {
      ctx = this._createRunContext(job.runConfig);
      this.activeRuns.set(job.runId, ctx);
    }

    try {
      await this._executeRun(job.runId, job.prompt, ctx);
    } catch (err) {
      console.error(`[Orchestrator] Run ${job.runId.slice(0, 8)}... crashed:`, err.message);
    } finally {
      // Only clean up if the run is truly done (not paused waiting for resume)
      if (!ctx.paused) {
        try {
          await this.costTracker.persistRunCosts(job.runId, this.pool);
          this.costTracker.clearRun(job.runId);
        } catch (costErr) {
          console.warn('[Orchestrator] Cost persist error (non-fatal):', costErr.message);
        }

        this.activeRuns.delete(job.runId);
      }

      this.processing = false;

      if (this.queue.length > 0) {
        setImmediate(() => this._processNext());
      }
    }
  }

  /**
   * Execute a pipeline run through all 5 stages.
   *
   * Each stage:
   *   1. Validate input contract
   *   2. Transition → {stage}_running
   *   3. Dispatch to agent (or legacy executor)
   *   4. Validate output contract
   *   5. Transition → {stage}_complete
   *   6. Check for pause request — if set, enter pause-wait loop
   */
  async _executeRun(runId, prompt, ctx) {
    const ops = this.agentRegistry ? this.agentRegistry.ops : null;

    // Track pipeline start time for duration analytics
    if (!ctx._pipelineStartMs) ctx._pipelineStartMs = Date.now();

    // If this is a paused run being re-entered after resume, skip the wait
    // The ctx.paused will be true if we're re-entering; wait for resume signal
    if (ctx.paused) {
      console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... is paused — waiting for resume`);
      await this._waitForResume(runId, ctx);
      if (ctx.aborted) return;

      // Restore DB state if run is still 'paused' in DB (recovery scenario)
      try {
        const currentState = await this.stateMachine.getState(runId);
        if (currentState === 'paused') {
          const events = await this.stateMachine.getEvents(runId);
          let afterStage = null;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].status === 'completed' && events[i].stage !== '_system') {
              afterStage = events[i].stage;
              break;
            }
          }
          if (afterStage) {
            await this.stateMachine.resumeRun(runId, afterStage);
            // Log resume
            await this.pool.query(
              `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
              [runId, JSON.stringify({ after_stage: afterStage, source: 'recovery_resume' })]
            ).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[Orchestrator] Could not restore state after recovery resume:', e.message);
      }
    }

    // ── STEP 0: INTENT GATE — classify task and lock constraints ─────────────
    // Run once at pipeline start. Constraint contract is immutable after this.
    // PLAN, SCAFFOLD, CODE, and VERIFY all receive it via previousOutputs._constraintContract.
    // intent_gate is a first-class persisted phase in the state machine.
    if (!ctx.constraintContract) {
      // ── Persist: intent_gate STARTED ──────────────────────────────────────
      await this.stateMachine.transition(runId, 'intent_gate', 'started');

      // ── Build repo context for Intent Gate (fail-open) ──────────────────
      // Check if the user has a connected GitHub repo + source repo context.
      // This enables the Intent Gate to detect repo-referencing prompts and
      // classify them as repo_hardening/repo_refactor/repo_feature/repo_fix.
      let repoContext = null;
      try {
        const _userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
        const _userId = _userRow.rows[0]?.user_id || null;
        if (_userId) {
          const _ghRow = await this.pool.query(
            'SELECT github_login FROM github_connections WHERE user_id = $1 LIMIT 1',
            [_userId]
          );
          const _hasConnection = _ghRow.rowCount > 0;

          // Source repo context from run config (set during pipeline creation in server.js)
          const _productCtx = ctx.runConfig && ctx.runConfig.productContext;
          const _sourceRepoFullName = (_productCtx && _productCtx._sourceRepoFullName) || null;
          const _sourceRepoFileTree = (_productCtx && _productCtx._sourceRepoFileTree) || [];
          const _repoProfile = ctx.runConfig && ctx.runConfig._repoProfile;

          // Also check for github_repo on the run itself (target PR repo)
          const _ghRepoRow = await this.pool.query(
            'SELECT github_repo FROM pipeline_runs WHERE id = $1',
            [runId]
          );
          const _githubRepo = _ghRepoRow.rows[0]?.github_repo || null;

          // Use source_repo or github_repo as the connected repo
          const _repoFullName = _sourceRepoFullName || _githubRepo || null;

          repoContext = {
            hasConnection: _hasConnection,
            repoFullName: _repoFullName,
            repoFiles: _sourceRepoFileTree,
            repoProfile: _repoProfile || null,
          };

          if (_hasConnection && _repoFullName) {
            console.log(`[Orchestrator] Repo context built for Intent Gate: repo=${_repoFullName}, files=${_sourceRepoFileTree.length}, hasProfile=${!!_repoProfile}`);
          }
        }
      } catch (repoCtxErr) {
        // Fail-open: repo context is enrichment, not required
        console.warn('[Orchestrator] Failed to build repo context for Intent Gate (non-fatal):', repoCtxErr.message);
        repoContext = null;
      }

      let rawContract;
      try {
        rawContract = await classifyIntent(prompt, this.pool, runId, repoContext);
      } catch (classifyErr) {
        const msg = `INTENT_GATE_FAILED: classify() threw: ${classifyErr.message}`;
        console.error(`[Orchestrator] ${msg}`);
        // Persist: intent_gate FAILED
        await this.stateMachine.transition(runId, 'intent_gate', 'failed', { error: msg }, msg)
          .catch(e => console.error('[Orchestrator] Failed to persist intent gate failure:', e.message));
        // HARD INVARIANT: Pipeline MUST NOT proceed without a locked constraint contract
        this.eventBus.pipelineFailed(runId, 'intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, 'intent_gate', msg);
        return;
      }

      // ── Repo Connection Required: halt pipeline ─────────────────────────
      // If the prompt references a repo but the user has no GitHub connection,
      // halt the pipeline with a user-facing message to connect their repo.
      if (rawContract && rawContract._repo_connection_required) {
        const msg = rawContract._rejection_reason ||
          'Please connect a GitHub repository to work on existing code.';
        console.warn(`[Orchestrator] REPO_CONNECTION_REQUIRED: ${msg}`);
        await this.stateMachine.transition(runId, 'intent_gate', 'failed', {
          run_event: 'REPO_CONNECTION_REQUIRED',
          error: msg,
          repo_connection_required: true,
        }, msg).catch(e => console.error('[Orchestrator] Failed to persist repo connection required:', e.message));
        this.eventBus.pipelineFailed(runId, 'intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, 'intent_gate', msg);
        return;
      }

      // ── Attach repo profile to contract (before freeze) ─────────────────────
      // The repo profile is scanned from the actual GitHub repo file tree (see
      // src/services/repo-scanner.js). Attaching it here lets agents access it
      // via previousOutputs._constraintContract._repoProfile throughout the run.
      // For non-web repos, also adjust constraints to prevent React/HTML generation.
      {
        const _scannedProfile = ctx.runConfig && ctx.runConfig._repoProfile;
        if (_scannedProfile && rawContract) {
          rawContract._repoProfile = _scannedProfile;
          if (!_scannedProfile.isWebProject) {
            // Adjust constraints: non-web repos should not produce web frontend artifacts.
            // This is a data-driven override — the actual repo files take priority over
            // prompt-based classification. A C# project with .csproj files shouldn't get
            // React scaffolding even if the prompt mentions "dashboard" or "app".
            rawContract.constraints.frontend = false;
            rawContract._non_web = true;
            if (!rawContract.prohibited_layers) rawContract.prohibited_layers = [];
            if (!rawContract.prohibited_layers.includes('react')) {
              rawContract.prohibited_layers.push('react', 'html', 'javascript_frontend');
            }
            console.log(
              `[Orchestrator] Non-web repo detected (${_scannedProfile.language}/${_scannedProfile.framework || 'unknown'}) — ` +
              `adjusted constraints (frontend=false). SCAFFOLD will skip React/HTML generation.`
            );
          }
        }
      }

      // HARD INVARIANT: If classify returns null/undefined, ABORT. No fallback. No graceful degradation.
      if (!rawContract || !rawContract.intent_class) {
        const msg = 'INTENT_GATE_FAILED: classify() returned null/invalid contract — aborting run';
        console.error(`[Orchestrator] ${msg}`);
        // Persist: intent_gate FAILED
        await this.stateMachine.transition(runId, 'intent_gate', 'failed', { error: msg }, msg)
          .catch(e => console.error('[Orchestrator] Failed to persist intent gate failure:', e.message));
        this.eventBus.pipelineFailed(runId, 'intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, 'intent_gate', msg);
        return;
      }

      // ── Phase 4: Rejection check (entropy too high) ─────────────────────────
      // If Phase 4 entropy modeling determined the classification is near-uniform,
      // the contract carries _rejected=true. Fail the pipeline with a user-facing
      // clarification request rather than attempting a likely-incorrect run.
      if (rawContract._rejected) {
        const clarificationMsg = rawContract._rejection_reason ||
          'Classification too uncertain — please clarify your request.';
        const msg = `INTENT_GATE_REJECTED: ${clarificationMsg}`;
        console.warn(`[Orchestrator] Phase 4 rejection: entropy=${rawContract._entropy?.toFixed(4)} | ${clarificationMsg}`);
        // Persist: intent_gate FAILED (rejection is a terminal failure)
        await this.stateMachine.transition(runId, 'intent_gate', 'failed', {
          run_event: 'INTENT_TOO_AMBIGUOUS',
          error: msg,
          entropy: rawContract._entropy,
          candidates: rawContract._candidates,
          clarification_required: true,
        }, msg).catch(e => console.error('[Orchestrator] Failed to persist intent gate rejection:', e.message));
        this.eventBus.pipelineFailed(runId, 'intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, 'intent_gate', msg);
        return;
      }

      // ── CCO HARD SCHEMA VALIDATION — Intent Gate exit gate ──────────────────
      // Runs BEFORE freeze. Every required field must be present and valid.
      // Any failure is a hard rejection — pipeline stops. No defaults, no repair.
      const _ccoValidation = validateCCO(rawContract);
      if (!_ccoValidation.valid) {
        const msg = `CCO_SCHEMA_INVALID: Contract failed schema validation at Intent Gate exit — ${_ccoValidation.errors.join('; ')}`;
        console.error(`[Orchestrator] ${msg}`);
        // Persist: intent_gate FAILED (schema validation failure)
        await this.stateMachine.transition(runId, 'intent_gate', 'failed', {
          run_event: 'CCO_SCHEMA_INVALID',
          error: msg,
          validation_errors: _ccoValidation.errors,
        }, msg).catch(e => console.error('[Orchestrator] Failed to persist CCO validation failure:', e.message));
        this.eventBus.pipelineFailed(runId, 'intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, 'intent_gate', msg);
        return;
      }

      // Freeze the contract — immutable from this point. No agent can modify it.
      ctx.constraintContract = Object.freeze(rawContract);

      // Capture intent_gate reasoning (non-fatal — observability only)
      try {
        const _igReasoning = _buildPhaseReasoning('intent_gate', null, ctx.constraintContract);
        if (_igReasoning) {
          appendPhaseReasoning(this.pool, runId, 'intent_gate', _igReasoning.summary, _igReasoning.detail)
            .catch(e => console.warn('[Orchestrator] Intent gate reasoning capture failed (non-fatal):', e.message));
        }
      } catch (_) { /* non-fatal */ }

      // Compute and store CCO hash immediately after freeze.
      // This hash is verified at every phase transition to detect mutations.
      ctx.ccoHash = computeCCOHash(ctx.constraintContract);
      console.log(`[Orchestrator] CCO hash computed at Intent Gate exit: ${ctx.ccoHash.slice(0, 16)}...`);

      // ── Persist: intent_gate COMPLETED — with Constraint Contract as phase output ──
      // This is the canonical persisted event. The CCO is the phase output payload.
      // A2A, SSE replay, and dashboard all read from this event — no reconstruction.
      await this.stateMachine.transition(runId, 'intent_gate', 'completed', {
        intent_class:     ctx.constraintContract.intent_class,
        complexity_budget: ctx.constraintContract.complexity_budget,
        expansion_lock:   ctx.constraintContract.expansion_lock,
        constraints:      ctx.constraintContract.constraints,
        cco_hash:         ctx.ccoHash,
        // Phase 4 metadata
        entropy:          ctx.constraintContract._entropy    ?? null,
        committed:        ctx.constraintContract._committed  ?? true,
        candidates:       ctx.constraintContract._candidates ?? null,
        ...(ctx.constraintContract.intent_class === 'soft_expansion' ? {
          base_class:          ctx.constraintContract.base_class,
          expansion_candidate: ctx.constraintContract.expansion_candidate,
          soft_expansion:      ctx.constraintContract.soft_expansion,
        } : {}),
      });

      // ── Write intent_class to pipeline_runs (fire-and-forget) ────────────
      // Normalises internal intent-gate names to canonical public-facing values.
      // Single source of truth: written once here, read by all downstream consumers.
      {
        const _icMap = {
          static_surface:  'STATIC_SURFACE',
          light_app:       'INTERACTIVE_LIGHT_APP',
          soft_expansion:  'INTERACTIVE_LIGHT_APP',
          full_product:    'PRODUCT_SYSTEM',
          // Repo-aware intent classes → REPO_AWARE canonical family
          repo_hardening:  'REPO_AWARE',
          repo_refactor:   'REPO_AWARE',
          repo_feature:    'REPO_AWARE',
          repo_fix:        'REPO_AWARE',
        };
        const _canonicalIntentClass = _icMap[ctx.constraintContract.intent_class] || null;
        if (_canonicalIntentClass && this.pool) {
          this.pool.query(
            'UPDATE pipeline_runs SET intent_class = $1 WHERE id = $2',
            [_canonicalIntentClass, runId]
          ).catch(icErr => {
            console.warn('[Orchestrator] intent_class write failed (non-fatal):', icErr.message);
          });
        }
      }

      // ── Analytics: PIPELINE_STARTED (fire-and-forget) ────────────────────
      ;(async () => {
        try {
          const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
          const userId = userRow.rows[0]?.user_id || null;
          await analytics.emitEvent(this.pool, 'PIPELINE_STARTED', userId, {
            run_id:       runId,
            intent_class: ctx.constraintContract.intent_class || null,
          });
        } catch (_) {}
      })();

      // ── Run Trace: emit INTENT_GATE decision nodes ─────────────────────────
      // Non-fatal — trace failures must never block pipeline execution.
      this.runTrace.emitIntentGateNodes(runId, ctx.constraintContract).catch(traceErr => {
        console.warn('[Orchestrator] RunTrace INTENT_GATE nodes failed (non-fatal):', traceErr.message);
      });

      // ── Phase 4.2: ISE — emit surface extraction event (if surfaces detected) ──
      // ISE ran inside classify() and attached _ise to the contract before freeze.
      // Here we emit an observable event so pipeline consumers can see the surfaces.
      // This is fire-and-observe — never blocks the pipeline.
      const _iseOutput = ctx.constraintContract._ise;
      if (_iseOutput && Array.isArray(_iseOutput.surfaces) && _iseOutput.surfaces.length > 0) {
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'intent_gate',
          status: 'ise_extracted',
          payload: {
            run_event:         'ISE_SURFACES_EXTRACTED',
            surfaces:          _iseOutput.surfaces,
            transitions:       _iseOutput.transitions,
            interaction_verbs: _iseOutput.interaction_verbs,
          },
          created_at: new Date().toISOString(),
        });
        console.log(
          `[Orchestrator] ISE_SURFACES_EXTRACTED: surfaces=[${_iseOutput.surfaces.join(', ')}] ` +
          `transitions=[${_iseOutput.transitions.join(', ')}]`
        );
      }

      const _isSoftExpansion = ctx.constraintContract.intent_class === 'soft_expansion';
      console.log(
        `[Orchestrator] Intent Gate → ${ctx.constraintContract.intent_class} | ` +
        `budget: ${ctx.constraintContract.complexity_budget} | ` +
        `expansion_lock: ${ctx.constraintContract.expansion_lock}` +
        (_isSoftExpansion
          ? ` | Phase 4 SOFT_EXPANSION (base=${ctx.constraintContract.base_class}, candidate=${ctx.constraintContract.expansion_candidate})`
          : '')
      );

      // Log CONSTRAINT_PREDICTED run event (Phase 4: includes entropy/candidates/committed)
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage: 'intent_gate',
        status: 'classified',
        payload: {
          run_event: 'CONSTRAINT_PREDICTED',
          intent_class: ctx.constraintContract.intent_class,
          complexity_budget: ctx.constraintContract.complexity_budget,
          expansion_lock: ctx.constraintContract.expansion_lock,
          constraints: ctx.constraintContract.constraints,
          // Phase 4 metadata
          entropy:    ctx.constraintContract._entropy    ?? null,
          committed:  ctx.constraintContract._committed  ?? true,
          candidates: ctx.constraintContract._candidates ?? null,
          ...(ctx.constraintContract.intent_class === 'soft_expansion' ? {
            base_class:          ctx.constraintContract.base_class,
            expansion_candidate: ctx.constraintContract.expansion_candidate,
            soft_expansion:      ctx.constraintContract.soft_expansion,
          } : {}),
        },
        created_at: new Date().toISOString(),
      });

      // Phase 4: emit SOFT_EXPANSION_ACTIVATED event if applicable
      if (_isSoftExpansion) {
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'intent_gate',
          status: 'soft_expansion_activated',
          payload: {
            run_event:           'SOFT_EXPANSION_ACTIVATED',
            base_class:          ctx.constraintContract.base_class,
            expansion_candidate: ctx.constraintContract.expansion_candidate,
            entropy:             ctx.constraintContract._entropy,
            soft_expansion:      ctx.constraintContract.soft_expansion,
          },
          created_at: new Date().toISOString(),
        });
        console.log(`[Orchestrator] Phase 4 SOFT_EXPANSION_ACTIVATED | entropy=${ctx.constraintContract._entropy?.toFixed(4)} | base=${ctx.constraintContract.base_class}`);
      }

      // ACL Phase 1: persist prediction to DB (observation only — no learning yet)
      // Confidence heuristic: full_product / static_surface are strong signals (0.9);
      // light_app is the default fallback class so it carries lower confidence (0.7).
      // Phase 4: for soft_expansion contracts, confidence = top candidate probability.
      const _phase4Candidates = ctx.constraintContract._candidates || null;
      const _phase4Entropy    = ctx.constraintContract._entropy    ?? null;
      const _phase4Committed  = ctx.constraintContract._committed  ?? true;
      const _aclConfidenceMap = { full_product: 0.9, static_surface: 0.9, light_app: 0.7, soft_expansion: 0.5 };
      // For committed single-class, use the top candidate probability if available
      const _topCandidateProb = _phase4Candidates ? _phase4Candidates[0]?.probability : null;
      const _aclConfidence    = _topCandidateProb ?? (_aclConfidenceMap[ctx.constraintContract.intent_class] || 0.8);

      try {
        // Phase 4: INSERT includes entropy, candidates, committed columns (added by migration 010)
        await this.pool.query(
          `INSERT INTO constraint_predictions (run_id, task_type, predicted_constraints, confidence, entropy, candidates, committed)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            runId,
            ctx.constraintContract.task_type,
            JSON.stringify(ctx.constraintContract.constraints),
            _aclConfidence,
            _phase4Entropy,
            _phase4Candidates ? JSON.stringify(_phase4Candidates) : null,
            _phase4Committed,
          ]
        );
        // Capture weight adjustments that influenced this classification (Phase 2 explainability).
        // If classify() applied bias shaping, the contract carries a weight_adjustments field.
        const _weightAdjustments = ctx.constraintContract.weight_adjustments || null;
        const _aclAdjustmentsApplied = _weightAdjustments
          ? JSON.stringify({
              weight_adjustments: _weightAdjustments,
              weights_consulted:  true,
              sample_counts: Object.entries(_weightAdjustments).reduce((acc, [k, v]) => {
                acc[k] = v.sample_count || null;
                return acc;
              }, {}),
            })
          : null;

        await this.pool.query(
          `INSERT INTO constraint_decisions_log
             (run_id, input_text, classified_task_type, final_constraints, adjustments_applied)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            runId,
            prompt,
            ctx.constraintContract.intent_class,
            JSON.stringify(ctx.constraintContract),
            _aclAdjustmentsApplied,
          ]
        );
        console.log(
          `[Orchestrator] ACL logged: prediction + decisions_log for run ${runId.slice(0, 8)} ` +
          `(${ctx.constraintContract.intent_class}, confidence=${_aclConfidence.toFixed(3)}` +
          `${_phase4Entropy ? `, entropy=${_phase4Entropy.toFixed(4)}` : ''}` +
          `${_weightAdjustments ? ', bias-adjusted' : ''}` +
          `${_isSoftExpansion ? ', soft_expansion' : ''})`
        );
      } catch (aclErr) {
        // Non-fatal — ACL logging must never block the pipeline
        // Graceful fallback: try legacy INSERT (without Phase 4 columns) in case migration 010 hasn't run
        console.warn('[Orchestrator] ACL prediction logging failed, trying legacy INSERT:', aclErr.message);
        try {
          await this.pool.query(
            `INSERT INTO constraint_predictions (run_id, task_type, predicted_constraints, confidence)
             VALUES ($1, $2, $3, $4)`,
            [runId, ctx.constraintContract.task_type, JSON.stringify(ctx.constraintContract.constraints), _aclConfidence]
          );
        } catch (legacyErr) {
          console.warn('[Orchestrator] ACL prediction legacy INSERT also failed (non-fatal):', legacyErr.message);
        }
      }
    } else {
      console.log(`[Orchestrator] Intent Gate → reusing cached contract: ${ctx.constraintContract.intent_class}`);
      // Recompute hash for resumed runs (ccoHash may not be set from a previous session).
      // This initializes the baseline so phase transition checks work correctly.
      if (!ctx.ccoHash) {
        ctx.ccoHash = computeCCOHash(ctx.constraintContract);
        console.log(`[Orchestrator] CCO hash initialized for resumed run: ${ctx.ccoHash.slice(0, 16)}...`);
      }
    }

    for (const stage of STAGES) {
      if (ctx.aborted) {
        console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... aborted`);
        return;
      }

      // Skip already-completed stages (idempotent retry support).
      // When skipping, sync the state machine's cached state to {stage}_complete
      // so the NEXT stage can transition legally. Without this, the state stays
      // at the previous stage's _complete (e.g. intent_gate_complete) and the
      // next stage's transition to {next}_running is rejected by the state machine.
      // This was the root cause of the SCAFFOLD failure on existing-repo builds
      // (POL-1516856): plan was already completed (from a prior server instance
      // or first attempt), got skipped, but state stayed at intent_gate_complete.
      const alreadyDone = await this.stateMachine.isStageCompleted(runId, stage);
      if (alreadyDone) {
        // Advance the cached state so downstream stages can transition.
        const expectedState = `${stage}_complete`;
        const currentState = await this.stateMachine.getState(runId);
        if (currentState !== expectedState && currentState !== 'completed') {
          try {
            await this.pool.query(
              'UPDATE pipeline_runs SET state = $1 WHERE id = $2',
              [expectedState, runId]
            );
            console.log(`[Orchestrator] Stage "${stage}" already completed, skipping (state synced: ${currentState} → ${expectedState})`);
          } catch (syncErr) {
            console.warn(`[Orchestrator] Stage "${stage}" skip state sync failed (non-fatal):`, syncErr.message);
          }
        } else {
          console.log(`[Orchestrator] Stage "${stage}" already completed, skipping`);
        }
        continue;
      }

      try {
        // 1. Check budget BEFORE executing (hard cap = stop, soft = warn)
        try {
          const budget = this.costTracker.checkBudget(runId);
          if (budget.exceeded) {
            const msg = `Budget cap exceeded: $${budget.totalCost.toFixed(6)} >= $${budget.budgetCap} (hard cap)`;
            console.warn(`[Orchestrator] ${msg} for run ${runId.slice(0, 8)}...`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId, stage, status: 'budget_exceeded',
              payload: { totalCost: budget.totalCost, budgetCap: budget.budgetCap },
              created_at: new Date().toISOString()
            });
            await this.stateMachine.transition(runId, stage, 'failed', null, msg).catch(() => {});
            this.eventBus.pipelineFailed(runId, stage, msg);
            if (ops) ops.onPipelineFailed(runId, stage, msg);
            return;
          }
          if (budget.shouldWarn) {
            const msg = `Budget warning: $${budget.totalCost.toFixed(6)} >= $${budget.budgetWarning} (soft threshold)`;
            console.warn(`[Orchestrator] ${msg} for run ${runId.slice(0, 8)}...`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId, stage, status: 'budget_warning',
              payload: { totalCost: budget.totalCost, budgetWarning: budget.budgetWarning },
              created_at: new Date().toISOString()
            });
          }
        } catch (budgetErr) {
          console.warn('[Orchestrator] Budget check error (non-fatal):', budgetErr.message);
        }

        // 2. Gather previous outputs for contract validation + agent input
        const previousOutputs = await this.executor.getPreviousOutputs(runId);
        previousOutputs._runId = runId;

        // Attach run config so agents can use model overrides / constraints
        previousOutputs._runConfig = ctx.runConfig || {};

        // Attach formatted product context so agents generate accurate content.
        // Priority: per-run context (in runConfig) > global env fallback > null.
        {
          const rawCtx = (ctx.runConfig && ctx.runConfig.productContext) || loadProductContextFromEnv();
          previousOutputs._productContext = rawCtx ? formatProductContext(rawCtx) : null;
        }

        // ── Repository Mode Detection ─────────────────────────────────────────
        // When a source repo was provided, detect it here and pass repo_mode + file
        // tree to agents so SCAFFOLD produces an extend-not-replace manifest.
        //
        // _repoMode values:
        //   'scaffold_new'    — no source repo, generate fresh app (default)
        //   'extend_existing' — source repo detected, scaffold must merge/extend
        {
          const _rawCtx = ctx.runConfig && ctx.runConfig.productContext;
          const _hasSourceRepo = _rawCtx && (
            typeof _rawCtx._sourceRepoFullName === 'string' ||
            typeof _rawCtx._sourceRepo === 'string'
          );
          previousOutputs._repoMode = _hasSourceRepo ? 'extend_existing' : 'scaffold_new';
          if (_hasSourceRepo) {
            // Pass the file tree so SCAFFOLD can build an accurate manifest
            previousOutputs._sourceRepoFileTree = _rawCtx._sourceRepoFileTree || [];
            previousOutputs._sourceRepoFullName = _rawCtx._sourceRepoFullName || '';
            console.log(
              `[Orchestrator] repo_mode=extend_existing for stage="${stage}" ` +
              `(repo=${previousOutputs._sourceRepoFullName}, ` +
              `fileTree=${previousOutputs._sourceRepoFileTree.length} entries)`
            );
          }
        }

        // ── Repo Profile (Tech Stack) Injection ───────────────────────────────
        // When the target repo was scanned before enqueue (see server.js), inject
        // the structured tech stack profile so SCAFFOLD and VERIFY agents know
        // what they're working with. Non-web repos skip React scaffolding.
        {
          const _repoProfile = ctx.runConfig && ctx.runConfig._repoProfile;
          if (_repoProfile) {
            previousOutputs._repoProfile = _repoProfile;
            if (stage === 'scaffold' || stage === 'code') {
              console.log(
                `[Orchestrator] Repo profile active for stage="${stage}": ` +
                `${_repoProfile.language}/${_repoProfile.framework || 'unknown'} ` +
                `platform=${_repoProfile.platform} isWeb=${_repoProfile.isWebProject}`
              );
            }
          }
        }

        // Attach Intent Gate constraint contract (immutable — set at Step 0).
        // All agents read this but CANNOT modify it.
        previousOutputs._constraintContract = ctx.constraintContract || null;

        // ── Phase transition: verify CCO hash (immutability check) ──────────
        // Any mutation of the CCO between phases would change the hash.
        // Hard gate: if hash doesn't match, stop the pipeline.
        if (ctx.constraintContract && ctx.ccoHash) {
          const _hashCheck = verifyCCOHash(ctx.constraintContract, ctx.ccoHash);
          if (!_hashCheck.valid) {
            const msg = `CCO_MUTATION_DETECTED at phase transition → ${stage}: ${_hashCheck.error}`;
            console.error(`[Orchestrator] CRITICAL: ${msg}`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage,
              status: 'failed',
              payload: {
                run_event: 'CCO_MUTATION_DETECTED',
                error: msg,
                expected_hash: ctx.ccoHash.slice(0, 16),
              },
              created_at: new Date().toISOString(),
            });
            this.eventBus.pipelineFailed(runId, stage, msg);
            if (ops) ops.onPipelineFailed(runId, stage, msg);
            return;
          }
        }

        // 3. Validate stage input contract
        buildStageInput(stage, prompt, previousOutputs);

        // 4. Record start with ops agent
        if (ops) ops.recordEvent(runId, 'stage_started', { stage });

        // 5. Transition → stage_running
        await this.stateMachine.transition(runId, stage, 'started');
        this.eventBus.stageStarted(runId, stage);

        // 6. Build emitChunk — broadcasts live chunks to SSE subscribers
        // Also captures reasoning for trace store (non-fatal)
        const _traceChunks = [];
        const _sseEmit = (content) => {
          this.stateMachine.emit(`run:${runId}`, {
            run_id: runId,
            stage,
            status: 'output',
            payload: { content },
            created_at: new Date().toISOString()
          });
        };
        const emitChunk = (content) => {
          _traceChunks.push(content);
          _sseEmit(content);
        };

        // 7. Consume any pending injections — prepend to prompt for this stage
        const effectivePrompt = this._applyInjections(runId, prompt, ctx);

        // 8. Dispatch to agent (or legacy executor fallback)
        const _stageStartMs = Date.now();
        const rawOutput = await this._dispatchStage(runId, stage, effectivePrompt, previousOutputs, emitChunk, ctx);
        const _stageLatencyMs = Date.now() - _stageStartMs;

        // 8a. Capture phase reasoning (non-fatal — observability only, never blocks pipeline)
        // Extracts a human-readable summary + detail from each phase's output.
        // Written to phase_reasoning JSONB column on pipeline_runs for ReasoningCard polling.
        try {
          const _reasoningEntry = _buildPhaseReasoning(stage, rawOutput, ctx.constraintContract);
          if (_reasoningEntry) {
            appendPhaseReasoning(this.pool, runId, stage, _reasoningEntry.summary, _reasoningEntry.detail)
              .catch(rErr => console.warn(`[Orchestrator] Phase reasoning capture failed for "${stage}" (non-fatal):`, rErr.message));
          }
        } catch (reasoningExtractErr) {
          // Non-fatal: reasoning extraction must never block the pipeline
          console.warn(`[Orchestrator] Phase reasoning extract failed for "${stage}" (non-fatal):`, reasoningExtractErr.message);
        }

        // 9. Extract token usage from agent output (non-fatal)
        try {
          if (rawOutput && rawOutput._tokenUsage) {
            const { model, inputTokens, outputTokens } = rawOutput._tokenUsage;
            this.costTracker.recordTokens(runId, stage, model, inputTokens, outputTokens);
            const costs = this.costTracker.getRunCosts(runId);
            if (costs) {
              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId, stage, status: 'cost_update',
                payload: { stageCost: rawOutput._tokenUsage, totalCostUsd: costs.totalCostUsd },
                created_at: new Date().toISOString()
              });
            }
          }
        } catch (costErr) {
          console.warn('[Orchestrator] Token recording error (non-fatal):', costErr.message);
        }

        // 10. Validate output contract
        const outputForValidation = rawOutput ? { ...rawOutput } : rawOutput;
        if (outputForValidation) delete outputForValidation._tokenUsage;

        let validatedOutput;
        try {
          validatedOutput = validateStageOutput(stage, outputForValidation);
        } catch (contractErr) {
          // HARD GATE for scaffold: output contract failure is fatal, not a warning.
          // Other stages get soft treatment for backward compatibility.
          if (stage === 'scaffold') {
            throw contractErr;
          }
          console.warn(`[Orchestrator] Output contract warning for "${stage}":`, contractErr.message);
          validatedOutput = outputForValidation;
        }

        // 10a. SCAFFOLD HARD GATE — deep manifest validation.
        // If scaffold output doesn't contain a valid manifest (files[], structure{}, constraints{}),
        // the pipeline STOPS. CODE cannot proceed without a binding contract.
        if (stage === 'scaffold' && validatedOutput) {
          try {
            const scaffoldIntentClass = ctx.constraintContract ? ctx.constraintContract.intent_class : null;
            validateScaffoldManifest(validatedOutput, scaffoldIntentClass);
            console.log(`[Orchestrator] Scaffold manifest validated ✓ (${validatedOutput.files.length} files, entry: ${validatedOutput.constraints.entry}, schema: ${scaffoldIntentClass || 'default'})`);
          } catch (manifestErr) {
            console.error(`[Orchestrator] SCAFFOLD HARD GATE — manifest validation failed:`, manifestErr.message);

            // Emit SSE event so UI can show the failure reason
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage: 'scaffold',
              status: 'manifest_invalid',
              payload: {
                error: manifestErr.message,
                violations: manifestErr.violations || [],
              },
              created_at: new Date().toISOString()
            });

            throw manifestErr; // Pipeline stops here
          }

          // 10a-2. INTENT GATE SCAFFOLD CHECK — ensure scaffold respects constraint contract.
          // If expansion_lock=true and scaffold includes prohibited layers → REJECT.
          //
          // EXCEPTION: extend_existing mode bypasses this check.
          // The existing repo's architecture is authoritative — if an Express repo is classified
          // as 'light_app' (server=false constraint) but has server.js in its tree, that's
          // expected. We're extending the existing codebase, not regenerating from intent class.
          const _isExtendExistingScaffold = validatedOutput && validatedOutput._repo_mode === 'extend_existing';
          if (ctx.constraintContract && !_isExtendExistingScaffold) {
            const contractCheck = validateScaffoldAgainstContract(validatedOutput, ctx.constraintContract);
            if (!contractCheck.valid) {
              const violationMsg = `CONSTRAINT_VIOLATION_DETECTED: scaffold violates Intent Gate (${ctx.constraintContract.intent_class}): ${contractCheck.violations.join('; ')}`;
              console.error(`[Orchestrator] ${violationMsg}`);

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'scaffold',
                status: 'constraint_violation',
                payload: {
                  intent_class: ctx.constraintContract.intent_class,
                  violations: contractCheck.violations,
                  run_event: 'CONSTRAINT_VIOLATION_DETECTED',
                },
                created_at: new Date().toISOString(),
              });

              throw new ContractValidationError('scaffold', 'intent_gate_constraints', contractCheck.violations);
            }
            console.log(`[Orchestrator] Intent Gate scaffold check ✓ (${ctx.constraintContract.intent_class})`);
          } else if (_isExtendExistingScaffold) {
            console.log(`[Orchestrator] Intent Gate scaffold check SKIPPED — extend_existing (existing repo architecture is authoritative)`);
          }
        }

        // 10b. POST-CODE ENFORCEMENT + VALIDATION — enforce scaffold manifest on CODE output.
        // Defense-in-depth: even if the agent's internal enforcement failed or was bypassed
        // (e.g., simulated fallback, AI error), the orchestrator strips unexpected files
        // and only fails on MISSING files (which indicate CODE genuinely failed).
        //
        // EXCEPTION: extend_existing mode skips this check entirely.
        // The scaffold manifest contains ALL existing repo files (100+). CODE only generates
        // the subset it's adding/modifying. Checking for "missing" files would always fail.
        if (stage === 'code' && validatedOutput && validatedOutput.files) {
          const scaffoldData = await this.executor.getPreviousOutputs(runId);
          const _isExtendExistingOrchestrator = scaffoldData.scaffold && scaffoldData.scaffold._repo_mode === 'extend_existing';
          if (scaffoldData.scaffold && scaffoldData.scaffold.files && !_isExtendExistingOrchestrator) {
            // ── STEP 1: STRIP unexpected files before validation ──────────
            // This prevents contract violations from extra hallucinated files.
            // The agent should have already done this, but we enforce here as a hard gate.
            const scaffoldFileList = scaffoldData.scaffold.files;
            // Uses shared constants from lib/manifest-constants.js — single source of truth
            const manifestSet = buildManifestSet(scaffoldFileList);

            // Apply JS equivalence mapping + strip unexpected files
            const beforeFiles = { ...validatedOutput.files };
            const renamedFiles = applyEquivalenceRenames(validatedOutput.files, manifestSet, '[Orchestrator]');

            // Strip unexpected files
            const codeFileKeys = Object.keys(renamedFiles);
            const strippedFiles = [];
            const keptFiles = {};
            for (const key of codeFileKeys) {
              let isExpected = manifestSet.has(key);
              // Normalize: public/x → x
              if (!isExpected && key.startsWith('public/')) {
                const basename = key.replace('public/', '');
                if (FRONTEND_ROOT_FILES.has(basename)) {
                  isExpected = manifestSet.has(basename);
                }
              }
              // Reverse: x → public/x
              if (!isExpected && FRONTEND_ROOT_FILES.has(key)) {
                isExpected = manifestSet.has('public/' + key);
              }
              if (!isExpected) {
                strippedFiles.push(key);
              } else {
                keptFiles[key] = renamedFiles[key];
              }
            }

            if (strippedFiles.length > 0) {
              const totalBefore = codeFileKeys.length;
              const stripRatio = totalBefore > 0 ? strippedFiles.length / totalBefore : 0;
              console.log(`[Orchestrator] Manifest enforcement: stripped ${strippedFiles.length}/${totalBefore} unexpected files: ${strippedFiles.join(', ')}`);
              if (stripRatio > 0.5) {
                console.warn(`[Orchestrator] WARNING: Manifest enforcement stripped >${Math.round(stripRatio * 100)}% of files (${strippedFiles.length}/${totalBefore}). Manifest: [${[...manifestSet].join(', ')}]. Stripped: [${strippedFiles.join(', ')}]`);
              }
            }

            // Safety net: if ALL files would be stripped, fall back to renamed files
            if (Object.keys(keptFiles).length === 0 && codeFileKeys.length > 0) {
              console.warn(`[Orchestrator] All files stripped by manifest enforcement — falling back to best-effort renamed files. Manifest: [${[...manifestSet].join(', ')}]. Files: [${codeFileKeys.join(', ')}]`);
              validatedOutput.files = renamedFiles;
            } else {
              validatedOutput.files = keptFiles;
            }

            // ── STEP 2: VALIDATE remaining files against scaffold ─────────
            const codeCheck = validateCodeAgainstScaffold(validatedOutput, scaffoldData.scaffold);

            if (!codeCheck.valid) {
              // After stripping, only MISSING files should cause failures
              // (unexpected files were already stripped above)
              console.error(
                `[Orchestrator] POST-CODE VALIDATION FAILED — ` +
                `${codeCheck.missingFiles.length} missing: ` +
                codeCheck.errors.join('; ')
              );

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'code',
                status: 'scaffold_mismatch',
                payload: {
                  missingFiles: codeCheck.missingFiles,
                  unexpectedFiles: [],
                  errors: codeCheck.errors,
                },
                created_at: new Date().toISOString()
              });

              throw new ContractValidationError('code', 'scaffold_match', codeCheck.errors);
            }

            console.log(
              `[Orchestrator] Post-CODE scaffold validation passed ✓ ` +
              `(${Object.keys(validatedOutput.files).length} files match scaffold` +
              `${strippedFiles.length > 0 ? `, ${strippedFiles.length} stripped` : ''})`
            );

            // ── STEP 3: ENTRY POINT RECONCILIATION ─────────────────────
            // Fix for Report #596913 Pattern 3: CODE's _detectEntryPoint may
            // return 'server.js' when the scaffold expects 'index.html' (or
            // 'public/index.html'). Reconcile here before VERIFY sees the mismatch.
            if (scaffoldData.scaffold.constraints && scaffoldData.scaffold.constraints.entry && validatedOutput.entryPoint) {
              const scaffoldEntry = scaffoldData.scaffold.constraints.entry;
              const codeEntry = validatedOutput.entryPoint;
              if (scaffoldEntry !== codeEntry) {
                // Check if the scaffold entry (or its normalized form) exists in CODE output
                const codeFiles = new Set(Object.keys(validatedOutput.files));
                let resolvedEntry = null;

                if (codeFiles.has(scaffoldEntry)) {
                  resolvedEntry = scaffoldEntry;
                } else if (scaffoldEntry.startsWith('public/')) {
                  const basename = scaffoldEntry.replace('public/', '');
                  if (FRONTEND_ROOT_FILES.has(basename) && codeFiles.has(basename)) {
                    resolvedEntry = basename;
                  }
                } else if (FRONTEND_ROOT_FILES.has(scaffoldEntry) && codeFiles.has('public/' + scaffoldEntry)) {
                  resolvedEntry = 'public/' + scaffoldEntry;
                }

                if (resolvedEntry) {
                  console.log(`[Orchestrator] Entry point reconciled: CODE="${codeEntry}" → scaffold="${resolvedEntry}"`);
                  validatedOutput.entryPoint = resolvedEntry;
                } else {
                  console.warn(`[Orchestrator] Entry point mismatch: scaffold expects "${scaffoldEntry}" but CODE returned "${codeEntry}" and file not found in output`);
                }
              }
            }
          }

          // 10b-2. INTENT GATE CODE CHECK — ensure generated code respects constraint contract.
          if (ctx.constraintContract) {
            const contractCodeCheck = validateCodeAgainstContract(validatedOutput, ctx.constraintContract);
            if (!contractCodeCheck.valid) {
              const violationMsg = `CONSTRAINT_VIOLATION_DETECTED: code violates Intent Gate (${ctx.constraintContract.intent_class}): ${contractCodeCheck.violations.join('; ')}`;
              console.error(`[Orchestrator] ${violationMsg}`);

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'code',
                status: 'constraint_violation',
                payload: {
                  intent_class: ctx.constraintContract.intent_class,
                  violations: contractCodeCheck.violations,
                  run_event: 'CONSTRAINT_VIOLATION_DETECTED',
                },
                created_at: new Date().toISOString(),
              });

              // Warn but don't hard-fail code stage — QA will catch this as an error
              console.warn(`[Orchestrator] Code constraint violation logged — QA will flag`);
            } else {
              console.log(`[Orchestrator] Intent Gate code check ✓ (${ctx.constraintContract.intent_class})`);
            }
          }
        }

        // 10c. Phase 4: Emit expansion events based on stage output
        // For soft_expansion contracts, emit EXPANSION_JUSTIFIED after PLAN completes.
        if (ctx.constraintContract && ctx.constraintContract.intent_class === 'soft_expansion') {
          try {
            if (stage === 'plan' && validatedOutput && validatedOutput.expansion_justifications) {
              const justifications = validatedOutput.expansion_justifications;
              if (justifications.length > 0) {
                for (const j of justifications) {
                  this.stateMachine.emit(`run:${runId}`, {
                    run_id: runId,
                    stage: 'plan',
                    status: 'expansion_justified',
                    payload: {
                      run_event:  'EXPANSION_JUSTIFIED',
                      capability: j.capability,
                      reason:     j.reason,
                      scope:      j.scope,
                    },
                    created_at: new Date().toISOString(),
                  });
                }
                console.log(`[Orchestrator] Phase 4 EXPANSION_JUSTIFIED: ${justifications.map(j => j.capability).join(', ')}`);
              } else {
                console.log('[Orchestrator] Phase 4: PLAN used no soft expansions — staying with base constraints');
              }
            }
          } catch (expansionEventErr) {
            // Non-fatal
            console.warn('[Orchestrator] Phase 4 expansion event emission failed (non-fatal):', expansionEventErr.message);
          }
        }

        // 11a. Capture decision trace (non-fatal — never blocks the pipeline)
        if (this.traceStore) {
          try {
            const tokenCostData = rawOutput?._tokenUsage || null;
            await this.traceStore.addTrace(runId, stage, {
              agentName: AGENT_FOR_STAGE[stage] || 'Unknown',
              promptSent: effectivePrompt,
              reasoning: _traceChunks.join(''),
              actionTaken: stage,
              outputPayload: validatedOutput,
              latencyMs: _stageLatencyMs,
              tokenCost: tokenCostData,
            });
          } catch (traceErr) {
            console.warn(`[Orchestrator] Trace capture failed for "${stage}" (non-fatal):`, traceErr.message);
          }
        }

        // 11a-2. Emit decision-level causal DAG nodes (non-fatal — never blocks the pipeline)
        try {
          const _cco = ctx.constraintContract || null;
          switch (stage) {
            case 'plan':
              await this.runTrace.emitPlanNodes(runId, validatedOutput, _cco);
              break;
            case 'scaffold':
              await this.runTrace.emitScaffoldNodes(runId, validatedOutput, _cco);
              break;
            case 'code':
              await this.runTrace.emitCodeNodes(runId, validatedOutput, _cco);
              break;
            case 'verify':
              await this.runTrace.emitVerifyNodes(runId, validatedOutput, _cco);
              break;
          }
        } catch (nodeErr) {
          console.warn(`[Orchestrator] RunTrace node emission for "${stage}" failed (non-fatal):`, nodeErr.message);
        }

        // 11b. Persist stage artifact
        if (this.artifactStore) {
          try {
            await this.artifactStore.writeStageArtifact(runId, stage, validatedOutput);
          } catch (artifactErr) {
            console.warn(`[Orchestrator] Artifact write failed for "${stage}":`, artifactErr.message);
          }
        }

        // 11c. Write live preview after CODE stage so iframe shows app during VERIFY
        if (stage === 'code' && this.deployEngine && validatedOutput && validatedOutput.files) {
          this.deployEngine.writePreview(runId, validatedOutput, prompt).catch(err => {
            console.warn(`[Orchestrator] Preview write error (non-fatal): ${err.message}`);
          });
        }

        // 11d. Phase 4: Emit expansion audit events after VERIFY stage completes.
        // QAAgent flags EXPANSION_UNNECESSARY and EXPANSION_SCOPE_EXCEEDED via flagIssue().
        // Here we capture those and emit them as pipeline SSE events for observability.
        if (stage === 'verify' && ctx.constraintContract && ctx.constraintContract.intent_class === 'soft_expansion') {
          try {
            const qaAgent = this.agentRegistry && this.agentRegistry.getAgent
              ? this.agentRegistry.getAgent('verify')
              : null;
            if (qaAgent && typeof qaAgent.getIssues === 'function') {
              const qaIssues = qaAgent.getIssues(runId) || [];
              const expansionIssues = qaIssues.filter(i =>
                i.run_event === 'EXPANSION_UNNECESSARY' || i.run_event === 'EXPANSION_SCOPE_EXCEEDED'
              );
              for (const issue of expansionIssues) {
                this.stateMachine.emit(`run:${runId}`, {
                  run_id: runId,
                  stage: 'verify',
                  status: 'expansion_violation',
                  payload: {
                    run_event:  issue.run_event,
                    capability: issue.capability,
                    message:    issue.message,
                    severity:   issue.severity,
                  },
                  created_at: new Date().toISOString(),
                });
              }
              if (expansionIssues.length > 0) {
                console.log(`[Orchestrator] Phase 4: ${expansionIssues.length} expansion audit event(s) emitted (${expansionIssues.map(i => i.run_event).join(', ')})`);
              }
            }
          } catch (expansionAuditErr) {
            // Non-fatal
            console.warn('[Orchestrator] Phase 4 expansion audit event emission failed (non-fatal):', expansionAuditErr.message);
          }
        }

        // 12. Record completion with ops agent
        if (ops) ops.recordEvent(runId, 'stage_completed', { stage });

        // Capture verify output for analytics (used in PIPELINE_COMPLETED below)
        if (stage === 'verify') ctx._verifyOutput = validatedOutput;

        // 12a. Emit verify_report from orchestrator for ALL verify executors.
        // This ensures the frontend receives structured check data via SSE
        // regardless of which executor ran the verify stage (QA Agent, legacy, etc.).
        if (stage === 'verify' && validatedOutput && Array.isArray(validatedOutput.checks)) {
          try {
            const passedCount = validatedOutput.checks.filter(c => c.passed).length;
            const totalChecks = validatedOutput.checks.length;
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage: 'verify',
              status: 'verify_report',
              payload: JSON.stringify({
                checks: validatedOutput.checks,
                sectionReport: validatedOutput.sectionReport || [],
                passed: passedCount === totalChecks,
                passedCount,
                totalChecks,
                errors: validatedOutput.errors || [],
                warnings: validatedOutput.warnings || [],
              }),
              created_at: new Date().toISOString(),
            });
            console.log(`[Orchestrator] verify_report emitted: ${passedCount}/${totalChecks} checks passed`);
          } catch (_) { /* non-fatal */ }
        }

        // 12b. Self-healing: compute pass rate from individual checks and only
        // trigger when BELOW the 75% QA threshold.  Previous bug: relying on
        // the QA agent's boolean `passed` flag was fragile — if the agent
        // miscalculated, self-heal either never fired or fired unnecessarily.
        if (stage === 'verify' && validatedOutput && Array.isArray(validatedOutput.checks)) {
          const _checks = validatedOutput.checks;
          const _totalChecks = _checks.length;
          const _passedChecks = _checks.filter(c => c.passed === true).length;
          const _passRate = _totalChecks === 0 ? 0 : (_passedChecks / _totalChecks) * 100;

          // Only trigger self-heal if BELOW QA threshold
          if (_totalChecks > 0 && _passRate < 75) {
            const _failedChecks = _checks.filter(c => !c.passed);
            ctx._selfHealReason = { passRate: _passRate, failedChecks: _failedChecks };
            console.log(`[Orchestrator] Self-heal triggered: ${_failedChecks.length} failed check(s), pass rate ${_passRate.toFixed(0)}% < 75% for run ${runId.slice(0, 8)}`);
            try {
              const healResult = await this._runSelfHeal(
                runId, effectivePrompt, ctx, validatedOutput, previousOutputs, emitChunk
              );
              // Always update validatedOutput with the latest verify results
              // (whether fully healed or partially improved).  Previously, only
              // fully-healed results were propagated, causing the banner + DB to
              // persist the INITIAL (worse) verify data when self-heal improved
              // but didn't fix every check.
              if (healResult.verifyOutput && Array.isArray(healResult.verifyOutput.checks)) {
                validatedOutput = healResult.verifyOutput;
                ctx._verifyOutput = validatedOutput; // keep analytics capture in sync

                // Re-emit verify_report with the latest results so UI shows final state
                try {
                  const _hPassedCount = validatedOutput.checks.filter(c => c.passed).length;
                  const _hTotalChecks = validatedOutput.checks.length;
                  this.stateMachine.emit(`run:${runId}`, {
                    run_id: runId,
                    stage: 'verify',
                    status: 'verify_report',
                    payload: JSON.stringify({
                      checks: validatedOutput.checks,
                      sectionReport: validatedOutput.sectionReport || [],
                      passed: validatedOutput.passed === true, // Use QA agent's threshold-aware flag
                      passedCount: _hPassedCount,
                      totalChecks: _hTotalChecks,
                      errors: validatedOutput.errors || [],
                      warnings: validatedOutput.warnings || [],
                      selfHealed: healResult.healed || false,
                      selfHealRetryNum: healResult.retryNum,
                    }),
                    created_at: new Date().toISOString(),
                  });
                } catch (_) { /* non-fatal */ }
              }
            } catch (healErr) {
              console.warn(`[Orchestrator] Self-heal: unexpected error (non-fatal):`, healErr.message);
            }
          }
        }

        // 13. Transition → stage_complete
        // Guard: do NOT mark the stage completed if self-heal is still running
        // (self-heal re-dispatches CODE → SAVE → VERIFY internally and manages
        // its own completion semantics).
        if (!ctx._selfHealInProgress) {
          await this.stateMachine.transition(runId, stage, 'completed', validatedOutput);
          this.eventBus.stageCompleted(runId, stage, validatedOutput);
        }

        // 14. Check for pause request AFTER stage completes
        if (ctx.pauseRequested && !ctx.aborted) {
          ctx.pauseRequested = false;
          await this._doPause(runId, stage, ctx);
          if (ctx.aborted) return;
        }

      } catch (err) {
        const errorMsg = err instanceof ContractValidationError
          ? `Contract violation: ${err.violations.join('; ')}`
          : err.message;

        console.error(`[Orchestrator] Stage "${stage}" failed for ${runId.slice(0, 8)}...:`, errorMsg);

        if (ops) ops.recordEvent(runId, 'stage_failed', { stage, error: errorMsg });

        try {
          await this.stateMachine.transition(runId, stage, 'failed', null, errorMsg);
        } catch (transErr) {
          console.error(`[Orchestrator] Failed to record failure:`, transErr.message);
        }

        this.eventBus.stageFailed(runId, stage, errorMsg);
        this.eventBus.pipelineFailed(runId, stage, errorMsg);

        if (ops) ops.onPipelineFailed(runId, stage, errorMsg);

        // ── Analytics: PIPELINE_FAILED (fire-and-forget) ──────────────────
        ;(async () => {
          try {
            const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
            const userId = userRow.rows[0]?.user_id || null;
            await analytics.emitEvent(this.pool, 'PIPELINE_FAILED', userId, {
              run_id:      runId,
              failed_phase: stage || 'unknown',
              error_type:  err instanceof ContractValidationError ? 'contract_violation' : 'execution_error',
              duration_ms: ctx._pipelineStartMs ? (Date.now() - ctx._pipelineStartMs) : null,
            });
          } catch (_) {}
        })();

        return;
      }
    }

    // All stages completed successfully
    console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... completed all stages`);

    // ── ACL Phase 2 + CDK Phase 3: Constraint Learning & Stability Control ───
    // Non-blocking: learning engine failure MUST NOT fail the pipeline.
    //
    // Phase 2: Reads constraint_violations → computes raw weight deltas
    // CDK Phase 3: Governs raw deltas via coupling matrix + envelope clamping
    //              + drift detection + anti-collapse freeze guard
    // Persistence: CDK-governed weights stored in constraint_feedback_weights
    // Events: CDK_WEIGHTS_GOVERNED / CDK_DRIFT_DETECTED / CDK_CONSTRAINT_FROZEN
    //         captured and stored in run_events via ops.recordEvent
    if (ctx.constraintContract) {
      try {
        const _taskType = ctx.constraintContract.task_type;

        // Capture CDK events for run_events persistence (in addition to SSE streaming)
        const _cdkEvents = [];

        const _emitFn = (payload) => {
          // 1. SSE stream (real-time) — same as Phase 2 path
          this.stateMachine.emit(`run:${runId}`, {
            run_id:     runId,
            stage:      '_acl_learner',
            status:     'weight_update',
            payload,
            created_at: new Date().toISOString(),
          });

          // 2. Capture CDK events for DB persistence
          if (payload && payload.run_event && payload.run_event.startsWith('CDK_')) {
            _cdkEvents.push(payload);
          }
        };

        const learnerResult = await constraintLearner.learn(runId, _taskType, this.pool, _emitFn);

        if (!learnerResult.skipped && learnerResult.updates.length > 0) {
          console.log(
            `[Orchestrator] ACL learning: ${learnerResult.updates.length} weight update(s) committed ` +
            `for task_type=${_taskType} (cdk_applied=${learnerResult.cdkApplied}) ` +
            `(run ${runId.slice(0, 8)})`
          );
        }

        // Persist CDK events to pipeline_events for observability.
        // NOTE: Uses pipeline_events (FK → pipeline_runs) NOT run_events (FK → runs).
        // The runId here is a pipeline_runs.id — inserting into run_events caused
        // FK violations on every run because the ID doesn't exist in the runs table.
        if (_cdkEvents.length > 0 && this.pool) {
          let persisted = 0;
          for (const cdkEvt of _cdkEvents) {
            try {
              await this.pool.query(
                `INSERT INTO pipeline_events (run_id, stage, status, payload)
                      VALUES ($1, $2, $3, $4)`,
                [runId, 'CDK', cdkEvt.run_event, JSON.stringify(cdkEvt.payload || cdkEvt)]
              );
              persisted++;
            } catch (evtErr) {
              console.warn(`[Orchestrator] CDK pipeline_events insert failed (non-fatal): ${evtErr.message}`);
            }
          }
          if (persisted > 0) {
            console.log(`[Orchestrator] CDK: ${persisted}/${_cdkEvents.length} event(s) stored for run ${runId.slice(0, 8)}`);
          }
        }

      } catch (learnerErr) {
        // Non-fatal — ACL learning must never block pipeline completion
        console.warn('[Orchestrator] ACL learning step failed (non-fatal):', learnerErr.message);
      }
    }

    // ── Run Trace Integrity Check ─────────────────────────────────────────────
    // Validates the causal DAG: every node has a parent (except root), no orphans,
    // no dangling parent refs. On failure: pipeline_runs.non_explainable = true.
    // Non-fatal — integrity failure never changes the run completion status.
    try {
      await this.runTrace.checkIntegrity(runId);
    } catch (integrityErr) {
      console.warn('[Orchestrator] RunTrace integrity check threw (non-fatal):', integrityErr.message);
    } finally {
      this.runTrace.clearRun(runId);
    }

    // ── VERIFY GATE: Route to success or failure path ──────────────────────
    // Score-based gate aligned with QA threshold (75%).  Previous bug: relied
    // on the boolean `passed` flag which could disagree with the actual check
    // pass rate after self-heal mutated the output.
    const verify = ctx._verifyOutput;
    const _verifyScore = verify?.score ?? (verify?.passed ? 100 : 0);

    if (_verifyScore < 75) {
      // ── VERIFY FAILED PATH ──────────────────────────────────────────────
      const _failChecks = Array.isArray(ctx._verifyOutput?.checks) ? ctx._verifyOutput.checks : [];
      const _failCount = _failChecks.filter(c => !c.passed).length;
      const _totalCount = _failChecks.length;
      const _failMsg = `Verification failed: ${_failCount}/${_totalCount} checks did not pass`;

      console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... VERIFY FAILED — ${_failMsg}`);

      this.eventBus.pipelineFailed(runId, 'verify', _failMsg);

      if (ops) ops.onPipelineFailed(runId, 'verify', _failMsg);

      // Analytics: PIPELINE_FAILED (fire-and-forget)
      ;(async () => {
        try {
          const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
          const userId = userRow.rows[0]?.user_id || null;
          await analytics.emitEvent(this.pool, 'PIPELINE_FAILED', userId, {
            run_id:       runId,
            failed_phase: 'verify',
            error_type:   'verification_checks_failed',
            pass_count:   _failChecks.filter(c => c.passed).length,
            fail_count:   _failCount,
            duration_ms:  ctx._pipelineStartMs ? (Date.now() - ctx._pipelineStartMs) : null,
          });
        } catch (_) {}
      })();

      // Persist canonical state: orchestrator is sole authority (not VERIFY)
      await this._finalizeRun(runId, ctx);

      // No credit deduction. No success email. No deploy.
      return;
    }

    // ── VERIFY PASSED — Success path ────────────────────────────────────────
    this.eventBus.pipelineCompleted(runId);

    // Persist canonical state: orchestrator is sole authority (not VERIFY)
    await this._finalizeRun(runId, ctx);

    if (ops) ops.onPipelineComplete(runId);

    // ── Analytics: PIPELINE_COMPLETED (fire-and-forget) ───────────────────
    ;(async () => {
      try {
        const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
        const userId = userRow.rows[0]?.user_id || null;
        const verifyChecks = Array.isArray(ctx._verifyOutput?.checks) ? ctx._verifyOutput.checks : [];
        await analytics.emitEvent(this.pool, 'PIPELINE_COMPLETED', userId, {
          run_id:       runId,
          intent_class: ctx.constraintContract?.intent_class || null,
          pass_count:   verifyChecks.filter(c => c.passed).length,
          fail_count:   verifyChecks.filter(c => !c.passed).length,
          duration_ms:  ctx._pipelineStartMs ? (Date.now() - ctx._pipelineStartMs) : null,
        });
      } catch (_) {}
    })();

    // ── Credit decrement + transactional email notifications (fire-and-forget) ──
    // Deducts 1 credit per completed run, sends credit warning when ≤2 remain,
    // and notifies the user their build is ready.
    // Non-blocking — email failures never affect pipeline status.
    ;(async () => {
      try {
        const runRow = await this.pool.query(
          'SELECT user_id, prompt FROM pipeline_runs WHERE id = $1',
          [runId]
        );
        const userId = runRow.rows[0]?.user_id;
        const prompt = runRow.rows[0]?.prompt || '';
        if (!userId) return;

        // Decrement 1 credit (floor at 0 — never go negative)
        const creditResult = await this.pool.query(
          `UPDATE users
              SET task_credits = GREATEST(task_credits - 1, 0)
            WHERE id = $1
            RETURNING email, task_credits`,
          [userId]
        );
        const userEmail   = creditResult.rows[0]?.email;
        const newCredits  = creditResult.rows[0]?.task_credits ?? null;

        if (!userEmail) return;

        // Pipeline complete notification (include live URL if deployed)
        sendPipelineCompleteEmail(userEmail, { prompt, runId, liveUrl: ctx._liveUrl || null }).catch(err =>
          console.error('[Orchestrator] Pipeline complete email error (non-fatal):', err.message)
        );

        // Credit warning when ≤ 2 remain
        if (newCredits !== null && newCredits <= 2) {
          sendCreditWarningEmail(userEmail, newCredits).catch(err =>
            console.error('[Orchestrator] Credit warning email error (non-fatal):', err.message)
          );
        }

        console.log(`[Orchestrator] Post-run: userId=${userId} credits now ${newCredits}`);
      } catch (postRunErr) {
        console.error('[Orchestrator] Post-run notifications error (non-fatal):', postRunErr.message);
      }
    })();

    // ── DEPLOY Phase ──────────────────────────────────────────────────────────
    // STATIC_SURFACE → static file deploy at /live/{runId}/
    // PRODUCT_SYSTEM (full_product) → Node.js process deploy at /app/{runId}/
    // Other intent classes: deploy only if autoDeploy flag is set in runConfig.
    // Runs synchronously here so the completion email can include the live URL.
    // All deploy failures are non-fatal — errors never affect pipeline status.
    const _deployIntentClass = ctx.constraintContract?.intent_class;
    const _shouldDeploy = this.deployEngine && (
      _deployIntentClass === 'static_surface' ||
      _deployIntentClass === 'full_product' ||
      (ctx.runConfig && ctx.runConfig.autoDeploy)
    );

    if (_shouldDeploy) {
      console.log(`[Orchestrator] DEPLOY phase triggered for run ${runId.slice(0, 8)} (intent=${_deployIntentClass || 'runConfig.autoDeploy'})...`);
      try {
        const deployResult = await this.deployEngine.deploy(runId, prompt);
        if (deployResult.success && deployResult.url) {
          ctx._liveUrl = deployResult.url;
          console.log(`[Orchestrator] DEPLOY complete → ${deployResult.url} (run ${runId.slice(0, 8)})`);
          // NOTE: deploy events (deploy_started, deploy_uploading, deploy_complete)
          // are now persisted to pipeline_events by DeployEngine._emit() directly.
          // No need to duplicate the INSERT here — idempotency keys prevent conflicts.
        }
      } catch (deployErr) {
        console.warn(`[Orchestrator] DEPLOY error (non-fatal): ${deployErr.message}`);
      }
    }
  }

  /**
   * Enter the pause-wait loop.
   * Blocks (async) until ctx.resumed or ctx.aborted is set.
   */
  async _doPause(runId, afterStage, ctx) {
    ctx.paused = true;
    ctx.pausedAfterStage = afterStage;

    // Transition DB state to 'paused'
    try {
      await this.stateMachine.pauseRun(runId, afterStage);
    } catch (e) {
      console.warn(`[Orchestrator] Could not set paused state: ${e.message}`);
    }

    // Log to interventions table
    try {
      await this.pool.query(
        `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'paused', $2)`,
        [runId, JSON.stringify({ after_stage: afterStage })]
      );
    } catch (e) {
      console.warn('[Orchestrator] Could not log pause intervention:', e.message);
    }

    console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... paused after ${afterStage}`);

    // Wait for resume or abort
    await this._waitForResume(runId, ctx);

    if (!ctx.aborted) {
      ctx.paused = false;

      // Restore DB state to {afterStage}_complete so loop continues
      try {
        await this.stateMachine.resumeRun(runId, afterStage);
      } catch (e) {
        console.warn(`[Orchestrator] Could not restore state on resume: ${e.message}`);
      }

      // Log to interventions table
      try {
        await this.pool.query(
          `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
          [runId, JSON.stringify({ after_stage: afterStage })]
        );
      } catch (e) {
        console.warn('[Orchestrator] Could not log resume intervention:', e.message);
      }

      console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... resumed after ${afterStage}`);
    }
  }

  /**
   * Poll until ctx.resumed or ctx.aborted.
   * Uses 250ms intervals. No timeout — paused runs wait indefinitely.
   */
  _waitForResume(runId, ctx) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (ctx.resumed || ctx.aborted) {
          clearInterval(check);
          ctx.resumed = false; // Reset for next potential pause
          resolve();
        }
      }, 250);
    });
  }

  /**
   * Apply pending injections to the prompt.
   * Clears injections after consuming them.
   */
  _applyInjections(runId, prompt, ctx) {
    if (!ctx.pendingInjections || ctx.pendingInjections.length === 0) {
      return prompt;
    }

    const injections = ctx.pendingInjections.splice(0); // consume all
    const prefix = injections
      .map(msg => `[HUMAN DIRECTIVE]: ${msg}`)
      .join('\n');

    console.log(`[Orchestrator] Applying ${injections.length} injection(s) to run ${runId.slice(0, 8)}...`);
    return `${prefix}\n\n${prompt}`;
  }

  /**
   * Resume a paused run that was restarted (not in activeRuns memory).
   * Re-enqueues from DB with the paused ctx state.
   */
  async _resumeFromDb(runId) {
    const run = await this.executor.getRun(runId).catch(() => null);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }
    if (run.state !== 'paused') {
      return { success: false, message: `Run is not paused (state: ${run.state})` };
    }

    // Find what stage was last completed
    const events = await this.stateMachine.getEvents(runId);
    let afterStage = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === 'completed' && events[i].stage !== '_system') {
        afterStage = events[i].stage;
        break;
      }
    }

    if (!afterStage) {
      return { success: false, message: 'Could not determine last completed stage' };
    }

    // Restore DB state so orchestrator loop works
    try {
      await this.stateMachine.resumeRun(runId, afterStage);
    } catch (e) {
      console.warn('[Orchestrator] Could not restore state for DB resume:', e.message);
    }

    // Log resume
    try {
      await this.pool.query(
        `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
        [runId, JSON.stringify({ after_stage: afterStage, source: 'db_resume' })]
      );
    } catch (e) { /* non-fatal */ }

    this.enqueue(runId, run.prompt, {}, run.run_config || {});

    return { success: true, message: `Run resumed from after "${afterStage}" stage` };
  }

  /**
   * Dispatch a stage to the appropriate agent.
   * Checks for agent overrides and applies them (one-shot).
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} prompt      - Effective prompt (may have injections prepended)
   * @param {object} previousOutputs
   * @param {function} emitChunk
   * @param {object} ctx         - Run context (for agent overrides)
   * @returns {object} Raw stage output
   */
  async _dispatchStage(runId, stage, prompt, previousOutputs, emitChunk, ctx) {
    const agentKey = STAGE_TO_AGENT[stage];
    const hasOverride = ctx && ctx.agentOverrides && ctx.agentOverrides[agentKey];

    if (hasOverride) {
      const overridePrompt = ctx.agentOverrides[agentKey];
      delete ctx.agentOverrides[agentKey]; // one-shot: consume and clear
      console.log(`[Orchestrator] Applying agent override for ${agentKey} on stage "${stage}"`);
      // Prepend override to prompt — agent sees it as a directive
      prompt = `[AGENT OVERRIDE — use this as your primary instruction]: ${overridePrompt}\n\nOriginal context: ${prompt}`;
    }

    if (this.agentRegistry && this.agentRegistry.hasAgent(stage)) {
      const agent = this.agentRegistry.getAgent(stage);
      console.log(`[Orchestrator] Dispatching "${stage}" → ${agent.constructor.name}`);
      // Inject MCP context so agents can optionally query connected tools during execution.
      // Attached to previousOutputs so agents receive it through their standard input path.
      // Non-breaking: agents that don't use MCP ignore _mcpContext entirely.
      if (this.mcpRegistry) {
        previousOutputs._mcpContext = { registry: this.mcpRegistry, audit: this.mcpAudit, runId };
      }
      return agent.execute({ runId, stage, prompt, previousOutputs, emitChunk });
    }

    // Legacy fallback — single executor handles all stages
    console.log(`[Orchestrator] Dispatching "${stage}" → PipelineExecutor (legacy fallback)`);
    return this.executor.executeStage(runId, stage, prompt);
  }

  // ── Self-Healing Loop ───────────────────────────────────

  /**
   * Build the diagnosis prompt for the healing LLM call.
   * Includes failed check names, verify output, generated code sample, scaffold, and CCO.
   */
  _buildHealingDiagnosisPrompt(failedChecks, verifyOutput, codeOutput, scaffoldOutput, cco) {
    const failedCheckLines = failedChecks.map(c =>
      `- **${c.name}**: ${c.description || 'No description'} (category: ${c.category || 'unknown'})`
    ).join('\n');

    // Include a sample of generated code (first 5 files, 1500 chars each)
    const codeSnippet = (codeOutput && codeOutput.files)
      ? Object.entries(codeOutput.files)
          .slice(0, 5)
          .map(([filename, content]) => `\n--- ${filename} ---\n${(content || '').slice(0, 1500)}`)
          .join('\n')
      : 'No code output available';

    const scaffoldFiles = (scaffoldOutput && scaffoldOutput.files)
      ? scaffoldOutput.files.join(', ')
      : 'Not available';

    const intentClass = cco ? cco.intent_class : 'unknown';
    const taskType = cco ? (cco.task_type || cco.intent_class) : 'unknown';

    return `You are reviewing code generated by a build pipeline that failed automated verification checks.

## Failed VERIFY Checks
${failedCheckLines}

## Constraint Contract
- Intent class: ${intentClass}
- Task type: ${taskType}

## Scaffold Manifest (Required Files)
${scaffoldFiles}

## Generated Code (sample — first 5 files)
${codeSnippet}

## Your Task
Analyze WHY each check failed and provide SPECIFIC, ACTIONABLE fix instructions for the code generation agent. Be concise.

For each failed check:
1. State what's likely wrong in the current code
2. Provide the specific fix needed

Format as a numbered list. Do not include preamble.`;
  }

  /**
   * Build a local (no-LLM) diagnosis by analyzing code output against failed checks.
   * Runs deterministic regex/heuristic analysis on the actual generated code to produce
   * specific, actionable fix instructions. Used as fallback when the healing LLM is
   * unavailable (rate-limited, no API key, etc.).
   *
   * @param {object[]} failedChecks - Array of { name, passed, description?, category? }
   * @param {object}   codeOutput   - { files: { [filename]: string }, entryPoint? }
   * @param {object}   scaffoldOutput - { files: string[], structure?, constraints? }
   * @param {object}   cco          - Constraint contract from Intent Gate
   * @returns {string} Specific fix instructions
   */
  _buildLocalDiagnosis(failedChecks, codeOutput, scaffoldOutput, cco) {
    const files = (codeOutput && codeOutput.files) ? codeOutput.files : {};
    const fileNames = Object.keys(files);
    const allCode = Object.values(files).map(String).join('\n');

    // Detect tech stack from scaffold
    const scaffoldConstraints = (scaffoldOutput && scaffoldOutput.constraints) || {};
    const techStack = scaffoldConstraints.tech_stack || scaffoldConstraints.frontend || '';
    const isReactExpected = /react/i.test(String(techStack)) ||
      (scaffoldOutput && scaffoldOutput.files && scaffoldOutput.files.some(f => f.includes('.jsx')));

    const hasAppJsx = fileNames.some(f => f === 'app.jsx' || f.endsWith('/app.jsx'));
    const appJsxContent = hasAppJsx
      ? String(files[fileNames.find(f => f === 'app.jsx' || f.endsWith('/app.jsx'))] || '')
      : '';

    const indexHtmlContent = String(files['index.html'] || '');

    const instructions = [];
    const checkNames = new Set(failedChecks.map(c => c.name));

    // React component structure
    if (checkNames.has('React: app.jsx has valid component structure')) {
      const hasComponentDef = /function\s+[A-Z][A-Za-z]+\s*\(/.test(appJsxContent) ||
        /const\s+[A-Z][A-Za-z]+\s*=\s*(\(|function)/.test(appJsxContent);
      const hasCreateRoot = appJsxContent.includes('createRoot') || appJsxContent.includes('ReactDOM.render');
      const hasVanillaDOM = /document\.(getElementById|querySelector|createElement|innerHTML)/.test(appJsxContent);

      if (!hasAppJsx) {
        instructions.push('CRITICAL: No app.jsx file found. The scaffold requires a React CDN build. Create app.jsx with React functional components using JSX syntax, useState/useEffect hooks, and ReactDOM.createRoot to mount the app.');
      } else if (hasVanillaDOM) {
        instructions.push('CRITICAL: app.jsx contains vanilla DOM manipulation (document.getElementById/innerHTML/querySelector). This MUST be pure React JSX. Remove ALL document.* calls. Use React state (useState) instead of DOM manipulation. Use JSX elements (<div>, <Component />) instead of createElement/innerHTML.');
      } else {
        if (!hasComponentDef) {
          instructions.push('app.jsx is missing React component definitions. Define at least one function component: `function App() { return (<div>...</div>); }` using PascalCase naming.');
        }
        if (!hasCreateRoot) {
          instructions.push('app.jsx is missing ReactDOM.createRoot mount. Add at the bottom: `const root = ReactDOM.createRoot(document.getElementById("root")); root.render(<App />);`');
        }
      }
    }

    // React CDN loader
    if (checkNames.has('React: CDN loader (Babel + React) in index.html')) {
      const hasBabel = indexHtmlContent.includes('babel');
      const hasReactCdn = indexHtmlContent.includes('unpkg.com/react') ||
        indexHtmlContent.includes('cdn.jsdelivr.net/npm/react') ||
        indexHtmlContent.includes('cdnjs.cloudflare.com/ajax/libs/react');

      if (!indexHtmlContent) {
        instructions.push('CRITICAL: index.html is empty or missing. It must include: (1) React 18 CDN: <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>, (2) ReactDOM CDN: <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>, (3) Babel standalone: <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>, (4) Tailwind CDN: <script src="https://cdn.tailwindcss.com"></script>, (5) app.jsx loaded as: <script type="text/babel" src="app.jsx"></script>');
      } else {
        if (!hasReactCdn) {
          instructions.push('index.html is missing React CDN scripts. Add: <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script> and <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>');
        }
        if (!hasBabel) {
          instructions.push('index.html is missing Babel standalone (required for JSX in browser). Add: <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script> BEFORE app.jsx, and load app.jsx as: <script type="text/babel" src="app.jsx"></script>');
        }
      }
    }

    // Responsive breakpoints
    if (checkNames.has('React: responsive breakpoints in JSX')) {
      const hasResponsive = /\b(sm:|md:|lg:|xl:|2xl:)/.test(allCode);
      if (!hasResponsive) {
        instructions.push('No Tailwind responsive breakpoints found (sm:, md:, lg:). Add responsive classes to layout containers: e.g., `className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"`, `className="p-4 md:p-8"`, `className="text-sm md:text-base lg:text-lg"`.');
      }
    }

    // Interactive elements
    if (checkNames.has('Interactive elements are wired')) {
      const hasOnClick = /onClick\s*=/.test(allCode);
      const hasOnSubmit = /onSubmit\s*=/.test(allCode);
      const hasOnChange = /onChange\s*=/.test(allCode);
      const hasUseState = /useState/.test(allCode);

      if (!hasOnClick && !hasOnSubmit && !hasOnChange) {
        instructions.push('No interactive event handlers found (onClick, onSubmit, onChange). Every button must have an onClick handler, every form an onSubmit handler, every input an onChange handler. Use React useState to manage form state and UI toggles.');
      }
      if (!hasUseState) {
        instructions.push('No useState hooks found. The app needs state management for interactivity. Import { useState } from React and use it for form inputs, toggles, modals, tabs, and any dynamic UI.');
      }
    }

    // Tailwind classes
    if (checkNames.has('React: Tailwind utility classes present')) {
      const hasTailwind = /className=["'][^"']*\b(flex|grid|p-|m-|bg-|text-|border|rounded|shadow|w-|h-)\b/.test(allCode);
      if (!hasTailwind) {
        instructions.push('No Tailwind utility classes found in className props. Use Tailwind for ALL styling: bg-*, text-*, p-*, m-*, flex, grid, rounded-*, shadow-*, border-*. Do NOT use inline styles or separate CSS.');
      }
    }

    // Content matches user prompt
    if (checkNames.has('Content matches user prompt')) {
      instructions.push('The generated code does not match the user\'s prompt. Re-read the original prompt carefully and ensure the app\'s content, features, and terminology directly reflect what was requested. Do not generate a generic app — build exactly what the user asked for.');
    }

    // Interaction contract
    if (checkNames.has('Interaction contract fulfilled')) {
      instructions.push('The scaffold defined an interaction contract (routes, forms, interactive features) that the code does not implement. Check the scaffold manifest for required interactions and implement each one with working React components, state, and event handlers.');
    }

    // Domain keyword check
    if (checkNames.has('Domain keywords present in output')) {
      instructions.push('The generated code is missing domain-specific keywords from the user\'s prompt. If the user asked for a "photo sharing platform", the code must contain words like photo, upload, share, gallery, feed, likes. Match the user\'s domain language.');
    }

    // Catch-all for unhandled checks
    const handledChecks = new Set([
      'React: app.jsx has valid component structure',
      'React: CDN loader (Babel + React) in index.html',
      'React: responsive breakpoints in JSX',
      'Interactive elements are wired',
      'React: Tailwind utility classes present',
      'Content matches user prompt',
      'Interaction contract fulfilled',
      'Domain keywords present in output',
    ]);
    for (const check of failedChecks) {
      if (!handledChecks.has(check.name)) {
        instructions.push(`${check.name}: This check failed. ${check.description || 'Ensure this requirement is fully implemented with working code, not stubs or placeholders.'}`);
      }
    }

    // Add tech stack reminder if React expected
    if (isReactExpected) {
      instructions.unshift('TECH STACK REQUIREMENT: The scaffold specifies React CDN build. ALL JavaScript must be React JSX (functional components, hooks, JSX syntax). Do NOT use vanilla JS, document.getElementById, innerHTML, or addEventListener. Use React patterns: useState, useEffect, event handler props (onClick, onChange, onSubmit).');
    }

    if (instructions.length === 0) {
      return `The following verification checks failed — review and fix each:\n${failedChecks.map((c, i) => `${i + 1}. ${c.name}: ${c.description || 'Check not met.'}`).join('\n')}`;
    }

    return instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n');
  }

  /**
   * Call the healing LLM (OpenAI) to diagnose VERIFY failures.
   * Returns a string with specific fix instructions.
   */
  async _callHealingLLM(diagnosisPrompt) {
    if (!this._healingOpenAI) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not set — cannot call healing LLM');
      }
      this._healingOpenAI = new OpenAI();
    }

    const response = await this._healingOpenAI.chat.completions.create({
      model: process.env.SELF_HEAL_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a code reviewer diagnosing why generated code failed quality checks. Provide specific, actionable fix instructions only.',
        },
        {
          role: 'user',
          content: diagnosisPrompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || 'Unable to generate diagnosis — retry with general improvements.';
  }

  /**
   * Self-healing retry loop.
   *
   * When VERIFY has failed checks, calls Claude/LLM to diagnose the failures,
   * then re-runs CODE → SAVE → VERIFY with the diagnosis appended to the prompt.
   * Max 2 retries (3 total attempts including the original).
   *
   * @param {string}   runId
   * @param {string}   basePrompt       - Effective prompt for this run (original + any injections)
   * @param {object}   ctx              - Run context
   * @param {object}   verifyOutput     - Failed VERIFY output { checks, passed, errors, warnings }
   * @param {object}   previousOutputs  - Previous stage outputs (plan, scaffold, code, save, _constraintContract, etc.)
   * @param {function} emitChunk        - SSE emitter
   * @returns {{ healed: boolean, verifyOutput?: object, retryNum?: number, diagnoses?: object[] }}
   */
  async _runSelfHeal(runId, basePrompt, ctx, verifyOutput, previousOutputs, emitChunk) {
    ctx._selfHealInProgress = true;

    const MAX_RETRIES = 3;
    const PASS_THRESHOLD = 0.75; // Must match QA agent's threshold
    const runShort = runId.slice(0, 8);

    ctx._selfHealRetryCount = ctx._selfHealRetryCount || 0;

    const allDiagnoses = [];

    while (ctx._selfHealRetryCount < MAX_RETRIES) {
      ctx._selfHealRetryCount++;
      const retryNum = ctx._selfHealRetryCount;
      const failedChecks = verifyOutput.checks.filter(c => !c.passed);

      console.log(`[Orchestrator] Self-heal: attempt ${retryNum}/${MAX_RETRIES} for run ${runShort} (${failedChecks.length} failed check(s): ${failedChecks.map(c => c.name).join(', ')})`);

      // ── Emit retry-start SSE event for UI ─────────────────────────────────
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage: 'verify',
        status: 'self_heal_retry_start',
        payload: {
          retryNum,
          maxRetries: MAX_RETRIES + 1, // total attempts = 1 original + MAX_RETRIES
          failedChecks: failedChecks.map(c => c.name),
          message: `VERIFY failed — auto-retrying CODE phase (attempt ${retryNum + 1}/${MAX_RETRIES + 1})`,
        },
        created_at: new Date().toISOString(),
      });

      // ── Step 1: Call LLM to diagnose the failure ───────────────────────────
      let diagnosis = null;
      try {
        const diagnosisPrompt = this._buildHealingDiagnosisPrompt(
          failedChecks,
          verifyOutput,
          previousOutputs.code,
          previousOutputs.scaffold,
          ctx.constraintContract
        );
        diagnosis = await this._callHealingLLM(diagnosisPrompt);
        console.log(`[Orchestrator] Self-heal diagnosis (attempt ${retryNum}): ${diagnosis.slice(0, 300)}...`);
      } catch (diagErr) {
        console.warn(`[Orchestrator] Self-heal: LLM diagnosis failed (attempt ${retryNum}, non-fatal):`, diagErr.message);
        // Fallback: intelligent local code analysis instead of generic instructions
        diagnosis = this._buildLocalDiagnosis(failedChecks, previousOutputs.code, previousOutputs.scaffold, ctx.constraintContract);
        console.log(`[Orchestrator] Self-heal: using local diagnosis (${diagnosis.length} chars)`);
      }

      allDiagnoses.push({
        retryNum,
        diagnosis: diagnosis.slice(0, 2000),
        failedChecks: failedChecks.map(c => c.name),
      });

      // ── Log code_retry event to pipeline_events ────────────────────────────
      try {
        await this.pool.query(
          `INSERT INTO pipeline_events (run_id, stage, status, payload) VALUES ($1, $2, $3, $4)`,
          [
            runId,
            `code_retry_${retryNum}`,
            'code_retry',
            JSON.stringify({
              retryNum,
              failedChecks: failedChecks.map(c => ({ name: c.name, description: c.description })),
              diagnosis: diagnosis.slice(0, 2000),
            }),
          ]
        );
      } catch (logErr) {
        console.warn(`[Orchestrator] Self-heal: pipeline_events code_retry log failed (non-fatal):`, logErr.message);
      }

      // ── Step 2: Re-run CODE with diagnosis appended to prompt ─────────────
      let newCodeOutput;
      try {
        // Build heal prompt with previous code excerpt so the agent knows what to fix
        const prevCodeSample = (previousOutputs.code && previousOutputs.code.files)
          ? Object.entries(previousOutputs.code.files)
              .slice(0, 5)
              .map(([f, c]) => `--- ${f} (first 800 chars) ---\n${String(c).slice(0, 800)}`)
              .join('\n\n')
          : '';
        const healPrompt = `${basePrompt}\n\n[SELF-HEAL INSTRUCTIONS — Fix these specific issues detected by VERIFY on the previous attempt]:\n${diagnosis}${prevCodeSample ? `\n\n[PREVIOUS BROKEN CODE — reference these files to understand what went wrong]:\n${prevCodeSample}` : ''}`;

        // Build previousOutputs for CODE retry — keep plan/scaffold/CCO, pass previous code as _previousAttempt, clear stale stages
        const retryPreviousOutputs = {
          ...previousOutputs,
          _previousAttempt: previousOutputs.code, // agent can reference what it generated before
          code: undefined,
          save: undefined,
          verify: undefined,
        };

        // Emit retry output with a prefix so the user can see it in the terminal
        const retryEmit = (content) => emitChunk(`[Retry ${retryNum}] ${content}`);

        newCodeOutput = await this._dispatchStage(runId, 'code', healPrompt, retryPreviousOutputs, retryEmit, ctx);

        if (!newCodeOutput || !newCodeOutput.files || Object.keys(newCodeOutput.files).length === 0) {
          throw new Error('CODE retry produced no files');
        }

        // ── Manifest enforcement (defense in depth — mirrors main loop) ──────
        if (previousOutputs.scaffold && previousOutputs.scaffold.files) {
          const scaffoldFileList = previousOutputs.scaffold.files;
          const manifestSet = buildManifestSet(scaffoldFileList);
          const renamedSelfHeal = applyEquivalenceRenames(newCodeOutput.files, manifestSet, '[Orchestrator:self-heal]');

          const codeFileKeys = Object.keys(renamedSelfHeal);
          const stripped = [];
          const keptSelfHeal = {};
          for (const key of codeFileKeys) {
            let expected = manifestSet.has(key);
            if (!expected && key.startsWith('public/')) {
              const b = key.replace('public/', '');
              if (FRONTEND_ROOT_FILES.has(b)) expected = manifestSet.has(b);
            }
            if (!expected && FRONTEND_ROOT_FILES.has(key)) expected = manifestSet.has('public/' + key);
            if (!expected) {
              stripped.push(key);
            } else {
              keptSelfHeal[key] = renamedSelfHeal[key];
            }
          }
          if (stripped.length > 0) {
            console.log(`[Orchestrator] Self-heal: stripped ${stripped.length} unexpected file(s): ${stripped.join(', ')}`);
          }
          // Safety net: don't strip to empty
          if (Object.keys(keptSelfHeal).length === 0 && codeFileKeys.length > 0) {
            console.warn(`[Orchestrator] Self-heal: all files stripped — falling back to renamed files`);
            newCodeOutput.files = renamedSelfHeal;
          } else {
            newCodeOutput.files = keptSelfHeal;
          }
        }

        console.log(`[Orchestrator] Self-heal: CODE retry ${retryNum} produced ${Object.keys(newCodeOutput.files).length} file(s)`);
      } catch (codeErr) {
        console.warn(`[Orchestrator] Self-heal: CODE retry ${retryNum} failed (stopping):`, codeErr.message);
        break;
      }

      // ── Write preview for retry so iframe shows updated code ──────────────
      if (this.deployEngine && newCodeOutput && newCodeOutput.files) {
        try {
          await this.deployEngine.writePreview(runId, newCodeOutput, basePrompt);
          console.log(`[Orchestrator] Self-heal: preview updated for retry ${retryNum}`);
        } catch (previewErr) {
          console.warn(`[Orchestrator] Self-heal: preview write failed for retry ${retryNum} (non-fatal):`, previewErr.message);
        }
      }

      // ── Step 3: Re-run SAVE with new code ─────────────────────────────────
      let newSaveOutput;
      try {
        const savePreviousOutputs = {
          ...previousOutputs,
          code: newCodeOutput,
          save: undefined,
          verify: undefined,
        };
        newSaveOutput = await this._dispatchStage(runId, 'save', basePrompt, savePreviousOutputs, () => {}, ctx);
      } catch (saveErr) {
        console.warn(`[Orchestrator] Self-heal: SAVE retry ${retryNum} failed (non-fatal, continuing to VERIFY):`, saveErr.message);
        newSaveOutput = { persisted: true, runId, versionId: `retry_${retryNum}`, timestamp: new Date().toISOString() };
      }

      // ── Step 4: Re-run VERIFY with new code ──────────────────────────────
      let newVerifyOutput;
      try {
        const verifyPreviousOutputs = {
          ...previousOutputs,
          code: newCodeOutput,
          save: newSaveOutput,
          verify: undefined,
        };
        // Use retryEmit (not silent () => {}) so retry VERIFY results are visible
        // in the terminal. Previously, the silent emitter caused a contradiction:
        // terminal showed original ✗ marks while the overall status showed "passed"
        // after a successful self-heal.
        const verifyRetryEmit = (content) => emitChunk(`[Retry ${retryNum} VERIFY] ${content}`);
        newVerifyOutput = await this._dispatchStage(runId, 'verify', basePrompt, verifyPreviousOutputs, verifyRetryEmit, ctx);

        if (!newVerifyOutput || !Array.isArray(newVerifyOutput.checks)) {
          throw new Error('VERIFY retry produced invalid output (missing checks array)');
        }
      } catch (verifyErr) {
        console.warn(`[Orchestrator] Self-heal: VERIFY retry ${retryNum} failed:`, verifyErr.message);
        break;
      }

      // ── Log retry VERIFY result ────────────────────────────────────────────
      try {
        const passedCount = newVerifyOutput.checks.filter(c => c.passed).length;
        const totalChecks = newVerifyOutput.checks.length;
        await this.pool.query(
          `INSERT INTO pipeline_events (run_id, stage, status, payload) VALUES ($1, $2, $3, $4)`,
          [
            runId,
            `verify_retry_${retryNum}`,
            'verify_retry',
            JSON.stringify({
              retryNum,
              passedCount,
              totalChecks,
              passed: passedCount === totalChecks,
              checks: newVerifyOutput.checks.map(c => ({ name: c.name, passed: c.passed })),
            }),
          ]
        );
      } catch (logErr) {
        console.warn(`[Orchestrator] Self-heal: verify_retry log failed (non-fatal):`, logErr.message);
      }

      const newFailedChecks = newVerifyOutput.checks.filter(c => !c.passed);
      const newPassedCount = newVerifyOutput.checks.filter(c => c.passed).length;
      const newTotalChecks = newVerifyOutput.checks.length;
      const newPassRate = newTotalChecks === 0 ? 1 : newPassedCount / newTotalChecks;

      if (newPassRate >= PASS_THRESHOLD) {
        // ── SUCCESS (meets 75% threshold — aligned with QA agent) ────────
        console.log(`[Orchestrator] Self-heal: SUCCEEDED on retry ${retryNum} for run ${runShort} ✓ (${newPassedCount}/${newTotalChecks} = ${(newPassRate * 100).toFixed(0)}% ≥ ${(PASS_THRESHOLD * 100).toFixed(0)}%)`);

        // Ensure passed flag reflects threshold success for downstream verify gate
        newVerifyOutput.passed = true;

        // ── Overwrite stale artifacts with healed versions ─────────────────
        // The original artifacts were written during the main loop and are
        // immutable.  After a successful heal, the canonical artifacts must
        // reflect the healed code so deploy-engine and /code-files serve it.
        if (this.artifactStore) {
          try {
            await this.artifactStore.updateStageArtifact(runId, 'code', newCodeOutput);
            if (newSaveOutput) await this.artifactStore.updateStageArtifact(runId, 'save', newSaveOutput);
            await this.artifactStore.updateStageArtifact(runId, 'verify', newVerifyOutput);
            console.log(`[Orchestrator] Self-heal: artifacts updated for run ${runShort}`);
          } catch (artifactErr) {
            console.warn(`[Orchestrator] Self-heal: artifact update failed (non-fatal):`, artifactErr.message);
          }
        }

        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'verify',
          status: 'self_heal_succeeded',
          payload: {
            retryNum,
            message: `✓ Fixed on retry`,
            diagnoses: allDiagnoses,
          },
          created_at: new Date().toISOString(),
        });

        ctx._selfHealInProgress = false;
        return { healed: true, retryNum, verifyOutput: newVerifyOutput };
      }

      // Still failing — update state for next iteration
      console.log(`[Orchestrator] Self-heal: attempt ${retryNum} still has ${newFailedChecks.length} failed check(s) (${newPassedCount}/${newTotalChecks} = ${(newPassRate * 100).toFixed(0)}% < ${(PASS_THRESHOLD * 100).toFixed(0)}%): ${newFailedChecks.map(c => c.name).join(', ')}`);
      verifyOutput = newVerifyOutput;
      previousOutputs = { ...previousOutputs, code: newCodeOutput, save: newSaveOutput };
    }

    // ── All retries exhausted ──────────────────────────────────────────────
    console.log(`[Orchestrator] Self-heal: EXHAUSTED for run ${runShort} after ${ctx._selfHealRetryCount} retry attempt(s)`);

    // ── Check if the LATEST retry actually passes the 75% threshold ───────
    // The last iteration's while-loop condition (passRate < PASS_THRESHOLD) already
    // catches this, but the break-on-error paths can exit the loop before the
    // threshold check runs.  Re-check here so we don't discard a passing result.
    if (verifyOutput && Array.isArray(verifyOutput.checks)) {
      const exhaustPassedCount = verifyOutput.checks.filter(c => c.passed).length;
      const exhaustTotalChecks = verifyOutput.checks.length;
      const exhaustPassRate = exhaustTotalChecks === 0 ? 1 : exhaustPassedCount / exhaustTotalChecks;
      if (exhaustPassRate >= PASS_THRESHOLD) {
        console.log(`[Orchestrator] Self-heal: last retry passes threshold (${exhaustPassedCount}/${exhaustTotalChecks} = ${(exhaustPassRate * 100).toFixed(0)}%) — accepting as healed`);
        verifyOutput.passed = true;

        if (this.artifactStore && previousOutputs.code) {
          try {
            await this.artifactStore.updateStageArtifact(runId, 'code', previousOutputs.code);
            if (previousOutputs.save) await this.artifactStore.updateStageArtifact(runId, 'save', previousOutputs.save);
            await this.artifactStore.updateStageArtifact(runId, 'verify', verifyOutput);
            console.log(`[Orchestrator] Self-heal: artifacts updated for threshold-passing exhaustion for run ${runShort}`);
          } catch (artifactErr) {
            console.warn(`[Orchestrator] Self-heal: artifact update on threshold pass failed (non-fatal):`, artifactErr.message);
          }
        }

        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'verify',
          status: 'self_heal_succeeded',
          payload: {
            retryNum: ctx._selfHealRetryCount,
            message: `✓ Fixed on retry (threshold pass after exhaustion)`,
            diagnoses: allDiagnoses,
          },
          created_at: new Date().toISOString(),
        });

        ctx._selfHealInProgress = false;
        return { healed: true, retryNum: ctx._selfHealRetryCount, verifyOutput };
      }
    }

    // ── Update artifacts with the latest retry's code even on exhaustion ──
    // The last retry's code may be an improvement over the original broken
    // version.  If deploy proceeds despite partial failure, it should use
    // the best available code, not the initial broken code.
    if (this.artifactStore && previousOutputs.code) {
      try {
        await this.artifactStore.updateStageArtifact(runId, 'code', previousOutputs.code);
        if (previousOutputs.save) await this.artifactStore.updateStageArtifact(runId, 'save', previousOutputs.save);
        if (verifyOutput) await this.artifactStore.updateStageArtifact(runId, 'verify', verifyOutput);
        console.log(`[Orchestrator] Self-heal: artifacts updated with last retry for run ${runShort}`);
      } catch (artifactErr) {
        console.warn(`[Orchestrator] Self-heal: artifact update on exhaustion failed (non-fatal):`, artifactErr.message);
      }
    }

    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: 'verify',
      status: 'self_heal_exhausted',
      payload: {
        retriesAttempted: ctx._selfHealRetryCount,
        diagnoses: allDiagnoses,
        message: 'Auto-retry exhausted — all attempts failed',
      },
      created_at: new Date().toISOString(),
    });

    // Return the LATEST verify output (from last retry) so the caller can
    // update validatedOutput with the most accurate data.  Without this,
    // the banner and DB persist the INITIAL verify results instead of the
    // best result achieved by self-heal (e.g. initial 3/7 → retry 6/7).
    ctx._selfHealInProgress = false;
    return { healed: false, diagnoses: allDiagnoses, verifyOutput: verifyOutput };
  }

  // ── Canonical State Resolver ─────────────────────────────────
  // Sole authority for run-level final status.
  // Called after VERIFY completes (and self-heal cycles finish).
  // Evaluates ALL evidence to determine: SUCCESS / FAILED / PARTIAL_SUCCESS.
  //
  // Authority hierarchy (reference):
  //   Orbit Runtime (orchestrator) = sole canonical execution authority
  //   VERIFY = auditor only (reports findings, never declares completion)
  //   All other layers = observers / learners

  /**
   * Persist the canonical run state to the database.
   *
   * Canonical states:
   *   'completed'      — all VERIFY checks passed (score = 100%)
   *   'failed'         — VERIFY critical failures (score < 75%)
   *   'partial_success' — advisory failures only (score >= 75%, some checks failed)
   *
   * @param {string} runId
   * @param {string} status - 'completed' | 'failed' | 'partial_success'
   * @param {string} [error] - Error message for FAILED status
   */
  async _finalizeRunStatus(runId, status, error = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sets = ['state = $2', 'status = $3'];
      const values = [runId, 'completed', status];
      let paramIdx = 4;
      if (status === 'completed' || status === 'partial_success') {
        sets.push(`completed_at = $${paramIdx}`);
        values.push(new Date().toISOString());
        paramIdx++;
      }
      if (status === 'failed' && error) {
        sets.push(`error = $${paramIdx}`);
        values.push(error);
        paramIdx++;
      }
      await client.query(
        `UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = $1`,
        values
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[Orchestrator] _finalizeRunStatus failed for run ${runId?.slice(0, 8)}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Determines and persists the canonical run state.
   * Called after VERIFY completes — evaluates verify output against QA threshold.
   *
   * @param {string} runId
   * @param {object} ctx - Pipeline run context
   */
  async _finalizeRun(runId, ctx) {
    const verify = ctx._verifyOutput || {};
    const checks = Array.isArray(verify.checks) ? verify.checks : [];
    const passedCount = checks.filter(c => c.passed).length;
    const totalCount = checks.length;
    const score = totalCount === 0 ? 0 : Math.round((passedCount / totalCount) * 100);

    let status;
    let error;
    let outcome;

    if (score < 75) {
      // Critical failures — run failed
      const failCount = totalCount - passedCount;
      error = `Verification failed: ${failCount}/${totalCount} checks did not pass`;
      status = 'failed';
      outcome = 'FAILED';
    } else if (passedCount === totalCount) {
      // All checks passed — clean success
      status = 'completed';
      outcome = 'SUCCESS';
    } else {
      // Score >= 75% but advisory failures present
      // TODO(verify-severity): Check per-check severity to distinguish
      // critical vs advisory. For now, score >= 75% with failures = partial_success.
      status = 'partial_success';
      outcome = 'PARTIAL_SUCCESS';
    }

    console.log(`[Orchestrator] Canonical state resolved for run ${runId?.slice(0, 8)}: ${outcome} (score=${score}%${error ? ', ' + error : ''})`);

    await this._finalizeRunStatus(runId, status, error);
  }

  // ── Event Bus Handler ──────────────────────────────────

  /**
   * Callback when a stage completes.
   * Logs transition for observability.
   */
  _onStageCompleted(event) {
    const { runId, stage } = event;
    const stageIdx = STAGES.indexOf(stage);
    if (stageIdx >= 0 && stageIdx < STAGES.length - 1) {
      const nextStage = STAGES[stageIdx + 1];
      const nextAgent = this.agentRegistry && this.agentRegistry.hasAgent(nextStage)
        ? this.agentRegistry.getAgent(nextStage).constructor.name
        : 'PipelineExecutor';
      console.log(`[Orchestrator] Event bus: ${stage} → ${nextStage} (${nextAgent}) for ${(runId || '').slice(0, 8)}...`);
    }
  }
}

module.exports = { PipelineOrchestrator };

// ── Phase Reasoning Extraction ─────────────────────────────────────────────
// Derives human-readable reasoning entries from stage output.
// Returns { summary, detail } or null if nothing meaningful to capture.
// This runs AFTER each phase completes — never before, never blocking.
//
// Summary: 1-liner for the collapsed ReasoningCard state.
// Detail: full text for the expanded transcript view.
function _buildPhaseReasoning(stage, output, contract) {
  try {
    switch (stage) {

      case 'intent_gate': {
        if (!contract) return null;
        const ic = contract.intent_class || 'unknown';
        const budget = contract.complexity_budget || 'standard';
        const constraints = contract.constraints || {};
        const parts = [];
        if (constraints.server) parts.push('server-side API');
        if (constraints.db) parts.push('database');
        if (constraints.auth) parts.push('authentication');
        const capText = parts.length > 0 ? `Enabled capabilities: ${parts.join(', ')}.` : 'Frontend-only build.';
        const icLabel = {
          static_surface: 'Static Surface (landing page / portfolio)',
          light_app: 'Interactive Light App (form / calculator / simple dashboard)',
          soft_expansion: 'Soft Expansion (multi-class blend)',
          full_product: 'Full Product (SaaS / multi-user / auth-required)',
          hard_expansion: 'Hard Expansion (complete rebuild)',
        }[ic] || ic;
        const summary = `🎯 Classified as ${icLabel}`;
        const detail = [
          `**Intent Class:** ${icLabel}`,
          `**Complexity Budget:** ${budget}`,
          `**Expansion Lock:** ${contract.expansion_lock ? 'Yes — no scope creep allowed' : 'No'}`,
          capText,
          contract._entropy != null ? `**Classification Confidence:** entropy=${Number(contract._entropy).toFixed(3)} nats` : null,
        ].filter(Boolean).join('\n');
        return { summary, detail };
      }

      case 'plan': {
        if (!output) return null;
        const subtaskCount = Array.isArray(output.subtasks) ? output.subtasks.length : 0;
        const complexity = output.estimatedComplexity || 'medium';
        const fileCount = Array.isArray(output.planned_files) ? output.planned_files.length : 0;
        const summary = `📋 Generated ${subtaskCount}-step plan (${complexity} complexity, ${fileCount} files)`;
        const subtaskLines = Array.isArray(output.subtasks)
          ? output.subtasks.slice(0, 8).map(t => `• **${t.title}** — ${t.description || ''}`)
          : [];
        const fileLines = Array.isArray(output.planned_files) && output.planned_files.length > 0
          ? ['', '**Planned files:**', output.planned_files.map(f => `\`${f}\``).join(', ')]
          : [];
        const techStack = Array.isArray(output.planned_techStack) ? output.planned_techStack : [];
        const detail = [
          `**Complexity:** ${complexity} | **${subtaskCount} tasks** | **${fileCount} files**`,
          techStack.length > 0 ? `**Tech stack:** ${techStack.join(', ')}` : null,
          '',
          ...subtaskLines,
          ...fileLines,
          output.rawMarkdown ? `\n---\n${output.rawMarkdown.slice(0, 600)}` : null,
        ].filter(s => s !== null).join('\n');
        return { summary, detail };
      }

      case 'scaffold': {
        if (!output) return null;
        const treeLen = Array.isArray(output.tree) ? output.tree.length : (Array.isArray(output.files) ? output.files.length : 0);
        const techStack = Array.isArray(output.techStack) ? output.techStack : [];
        const repoMode = output._repo_mode === 'extend_existing' ? ' (extending existing repo)' : '';
        const summary = `🏗 Scaffolded ${treeLen} files${repoMode}`;
        const fileTree = Array.isArray(output.tree)
          ? output.tree.slice(0, 20).map(t => `${t.type === 'dir' ? '📁' : '📄'} ${t.path}`).join('\n')
          : (Array.isArray(output.files) ? output.files.slice(0, 20).join('\n') : '');
        const detail = [
          output.summary || `File tree generated with ${treeLen} entries.`,
          techStack.length > 0 ? `\n**Tech stack:** ${techStack.join(', ')}` : null,
          fileTree ? `\n**File structure:**\n${fileTree}` : null,
        ].filter(Boolean).join('\n');
        return { summary, detail };
      }

      case 'code': {
        if (!output) return null;
        const fileCount = output.files && typeof output.files === 'object'
          ? Object.keys(output.files).length : 0;
        const totalLines = output.totalLines || 0;
        const entryPoint = output.entryPoint || 'unknown';
        const summary = `💻 Generated ${fileCount} files (${totalLines > 0 ? `${totalLines} lines, ` : ''}entry: ${entryPoint})`;
        const fileNames = output.files ? Object.keys(output.files).join(', ') : '';
        const detail = [
          `**Files generated:** ${fileCount}`,
          totalLines > 0 ? `**Total lines:** ${totalLines}` : null,
          `**Entry point:** \`${entryPoint}\``,
          fileNames ? `\n**Files:** ${fileNames}` : null,
        ].filter(Boolean).join('\n');
        return { summary, detail };
      }

      case 'save': {
        if (!output) return { summary: '💾 Artifacts saved and persisted', detail: 'Pipeline artifacts saved to storage.' };
        const versionId = output.versionId || null;
        const summary = `💾 Saved${versionId ? ` (version ${String(versionId).slice(0, 8)})` : ''}`;
        const detail = [
          '**Artifacts persisted** to storage.',
          versionId ? `**Version ID:** \`${versionId}\`` : null,
          output.savedFiles ? `**Saved files:** ${Array.isArray(output.savedFiles) ? output.savedFiles.join(', ') : output.savedFiles}` : null,
        ].filter(Boolean).join('\n');
        return { summary, detail };
      }

      case 'verify': {
        if (!output) return null;
        const checks = Array.isArray(output.checks) ? output.checks : [];
        const passed = checks.filter(c => c.passed).length;
        const total = checks.length;
        const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
        const statusIcon = pct === 100 ? '✅' : pct >= 75 ? '⚠️' : '❌';
        const summary = `${statusIcon} Verification: ${passed}/${total} checks passed (${pct}%)`;
        const checkLines = checks.map(c =>
          `${c.passed ? '✓' : '✗'} **${c.name || 'Check'}**${c.message ? ` — ${c.message}` : ''}`
        );
        const detail = [
          `**${passed}/${total} checks passed** (${pct}%)`,
          '',
          ...checkLines,
          output.selfHealed ? '\n_Self-heal was applied to fix failing checks._' : null,
        ].filter(s => s !== null).join('\n');
        return { summary, detail };
      }

      default:
        return null;
    }
  } catch (err) {
    // Never throw from here — reasoning extraction is fire-and-observe
    return null;
  }
}
