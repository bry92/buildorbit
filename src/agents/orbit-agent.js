/**
 * Orbit — Copilot with Inline Synchronous Pipeline Execution + Semantic Memory
 *
 * Owns: conversation memory (orbit_conversations), LLM-driven action routing,
 *       inline pipeline execution with SSE phase streaming, run query tools,
 *       deep failure analysis (trace_failure_root_cause, compare_runs,
 *       get_failure_patterns), failure signature persistence
 *       (run_failure_signatures table), MCP tool invocation via use_mcp
 *       (audited through McpAudit), semantic memory injection + post-run learning.
 * Does NOT own: pipeline execution internals, state machine, user auth, credits,
 *               MCP transport/registry (injected as dependencies),
 *               embedding computation (OrbitMemory handles that).
 *
 * Architecture:
 *   - Postgres-backed conversation history (30-message sliding window)
 *   - GPT-4o tool-calling (build / modify / query_runs / get_run_details /
 *     explain_failure / trace_failure_root_cause / compare_runs /
 *     get_failure_patterns / get_project_context / use_mcp) with temperature 0.2
 *   - Falls back to keyword router when OPENAI_API_KEY is absent or LLM fails
 *   - For build/modify: executes pipeline INLINE with SSE phase streaming
 *     instead of enqueueing fire-and-forget
 *   - Copilot persona: answers questions, surfaces run history, explains failures,
 *     traces root causes across phases, compares runs, detects recurring patterns
 *   - Semantic memory: reads relevant past memories before every response via
 *     pgvector similarity search; writes new lessons after every completed run.
 *     All memory I/O strictly filtered by user_id — zero cross-user leakage.
 */

'use strict';

// Phase display labels for inline execution progress
const PHASE_LABELS = {
  intent_gate: 'Classifying intent',
  plan:        'Planning',
  scaffold:    'Scaffolding',
  code:        'Generating code',
  save:        'Saving artifacts',
  verify:      'Verifying',
};

class Orbit {
  /**
   * @param {{ pool, pipeline, orchestrator, stateMachine, mcpRegistry?, mcpAudit?, memory? }} deps
   *   pool         — pg.Pool for orbit_conversations + pipeline_runs queries
   *   pipeline     — PipelineExecutor with createRun(prompt) → runId, getRun(runId)
   *   orchestrator — PipelineOrchestrator with enqueue(runId, prompt, {}, config)
   *   stateMachine — PipelineStateMachine with on(), removeListener(), getEvents()
   *   mcpRegistry  — McpRegistry for routing use_mcp tool calls (optional)
   *   mcpAudit     — McpAudit for recording MCP calls in pipeline_events (optional)
   *   memory       — OrbitMemory instance for semantic memory read/write (optional)
   */
  constructor({ pool, pipeline, orchestrator, stateMachine, mcpRegistry = null, mcpAudit = null, memory = null }) {
    this.pool = pool;
    this.pipeline = pipeline;
    this.orchestrator = orchestrator;
    this.stateMachine = stateMachine || null;
    this.mcpRegistry = mcpRegistry;
    this.mcpAudit = mcpAudit;
    this.memory = memory; // OrbitMemory instance — null = semantic memory disabled
    this._openai = null; // lazy-initialized
  }

  // ── OpenAI Lazy Getter ────────────────────────────────────────────────────

  get openai() {
    if (this._openai !== null) return this._openai;

    try {
      const { OpenAI } = require('openai');
      if (!process.env.OPENAI_API_KEY) {
        console.warn('[Orbit] OPENAI_API_KEY not set — falling back to keyword router.');
        this._openai = false; // sentinel: tried, unavailable
        return null;
      }
      // Use Polsia's OpenAI proxy if OPENAI_BASE_URL is set (preferred in production)
      this._openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      });
    } catch (err) {
      console.error('[Orbit] Failed to load OpenAI SDK:', err.message);
      this._openai = false;
    }
    return this._openai || null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Process one user message within a conversation.
   * Returns either a plain JSON result or kicks off inline execution
   * (streaming phase events to the provided emitEvent callback).
   *
   * @param {string} userId
   * @param {string} conversationId
   * @param {string} message
   * @param {object} [runContext] — injected by ChatWidget: { runId, currentPhase, phases, logs }
   * @param {function} [emitEvent] — SSE emitter for streaming build/modify progress
   * @returns {Promise<{type, message, runId?, conversationId}>}
   */
  async chat(userId, conversationId, message, runContext = null, emitEvent = null) {
    if (!userId) userId = 'anonymous';

    const conv = await this._getOrCreateConversation(userId, conversationId);
    let history = conv.history || [];

    history.push({ role: 'user', content: message, ts: new Date().toISOString() });

    // ── Retrieve relevant semantic memories (fail-open, non-blocking) ─────
    // Build a compact query from the last few turns + current message so that
    // the embedding captures conversational context, not just the single turn.
    let memoryBlock = '';
    if (this.memory && userId !== 'anonymous') {
      const recentContext = history
        .slice(-4)
        .map(h => h.content)
        .join(' ')
        .slice(0, 800);
      memoryBlock = await this.memory.recallRelevant(userId, recentContext);
    }

    // ── Decide action (LLM or keyword fallback) ───────────────────────────
    let decision;
    if (this.openai) {
      decision = await this._reasonWithTools(history, message, runContext, conv.current_run_id, memoryBlock);
    } else {
      decision = this._decideAction(message);
    }

    // ── Execute action ────────────────────────────────────────────────────
    let result;

    const isPipelineAction = decision.action === 'build' || decision.action === 'rebuild' || decision.action === 'modify';

    // ── Auth + credit gate for pipeline actions (defense-in-depth) ──────
    // Even if the route layer allowed the request through, the agent itself
    // refuses to execute pipelines for anonymous users or users without credits.
    // This closes the credit bypass via optionalAuth (POL-1536452).
    if (isPipelineAction) {
      if (userId === 'anonymous') {
        result = {
          type: 'error',
          message: '🔒 You need to sign in before I can build anything. [Sign up here](/signup)',
        };
      } else {
        const creditCheck = await this._checkAndDeductCredit(userId);
        if (!creditCheck.allowed) {
          result = {
            type: 'error',
            message: creditCheck.message,
          };
        }
      }
    }

    // Only proceed with pipeline execution if no auth/credit error was set
    if (!result && (decision.action === 'build' || decision.action === 'rebuild')) {
      const buildPrompt = decision.prompt || message;
      if (emitEvent && this.stateMachine) {
        result = await this._executePipelineInline(buildPrompt, decision.intent || 'full_product', emitEvent, userId);
      } else {
        // Fallback: enqueue async (when SSE not available)
        const runId = await this._triggerPipeline(buildPrompt, decision.intent || 'full_product');
        result = { type: 'build', runId, status: 'queued', message: decision.explanation || `✅ Build started. Run ID: ${runId}` };
      }
    } else if (!result && decision.action === 'modify') {
      const enhancedPrompt = this._buildModificationPrompt(history, message);
      if (emitEvent && this.stateMachine) {
        result = await this._executePipelineInline(enhancedPrompt, 'full_product', emitEvent, userId);
      } else {
        const runId = await this._triggerPipeline(enhancedPrompt, 'full_product');
        result = { type: 'modify', runId, status: 'queued', message: decision.explanation || `✅ Modification started. Run ID: ${runId}` };
      }
    } else if (decision.action === 'query_runs') {
      result = await this._queryRuns(userId, decision.limit || 5, decision.status_filter || 'all');
    } else if (decision.action === 'get_run_details') {
      result = await this._getRunDetails(decision.run_id || conv.current_run_id);
    } else if (decision.action === 'explain_failure') {
      result = await this._explainFailure(decision.run_id || conv.current_run_id, userId);
    } else if (decision.action === 'trace_failure_root_cause') {
      result = await this._traceFailureRootCause(decision.run_id || conv.current_run_id, userId);
    } else if (decision.action === 'compare_runs') {
      result = await this._compareRuns(decision.run_id || conv.current_run_id, decision.compare_run_id, userId);
    } else if (decision.action === 'get_failure_patterns') {
      result = await this._getFailurePatterns(userId, decision.signature_key);
    } else if (decision.action === 'get_project_context') {
      result = await this._getProjectContext(userId, conv.current_run_id, runContext);
    } else if (decision.action === 'use_mcp') {
      result = await this._useMcp(userId, conv.current_run_id, decision.tool_name, decision.tool_params || {});
    } else if (!result) {
      // Conversational reply — explanation is the LLM-generated text.
      // Guard: only set if result wasn't already set by auth/credit check above.
      result = {
        type: 'message',
        message: decision.explanation || "What would you like to build, fix, or explore?",
      };
    }

    // ── Persist conversation ──────────────────────────────────────────────
    const assistantContent = result.message || '';
    history.push({ role: 'assistant', content: assistantContent, ts: new Date().toISOString() });
    if (history.length > 30) history = history.slice(-30);

    await this._saveConversation(userId, conversationId, history, result.runId || null, message);

    return { ...result, conversationId };
  }

  // ── Credit Enforcement ──────────────────────────────────────────────────

  /**
   * Check if user has credits and atomically deduct one.
   * Admin users (env var or DB flag) bypass credit checks.
   * Returns { allowed: true } or { allowed: false, message: string }.
   *
   * Mirrors the credit logic in POST /api/pipeline (server.js) so every
   * pipeline execution path enforces credits consistently (POL-1536452).
   *
   * @param {string} userId
   * @returns {Promise<{ allowed: boolean, message?: string }>}
   */
  async _checkAndDeductCredit(userId) {
    if (!userId || userId === 'anonymous') {
      return { allowed: false, message: '🔒 Sign in to build. [Sign up here](/signup)' };
    }

    const numericId = parseInt(userId, 10);
    if (isNaN(numericId) || numericId <= 0) {
      return { allowed: false, message: '🔒 Sign in to build. [Sign up here](/signup)' };
    }

    // Admin bypass — env var first, then DB column
    const adminEnvIds = (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0);

    if (adminEnvIds.includes(numericId)) {
      return { allowed: true };
    }

    try {
      const { rows: adminRows } = await this.pool.query(
        'SELECT is_admin FROM users WHERE id = $1',
        [numericId]
      );
      if (adminRows.length > 0 && adminRows[0].is_admin === true) {
        return { allowed: true };
      }
    } catch (_) { /* is_admin column may not exist yet — treat as non-admin */ }

    // Atomically deduct one credit
    try {
      const creditResult = await this.pool.query(
        `UPDATE users
            SET task_credits = task_credits - 1
          WHERE id = $1 AND task_credits > 0
          RETURNING task_credits`,
        [numericId]
      );

      if (creditResult.rowCount === 0) {
        return {
          allowed: false,
          message: "⚡ You've used all your credits. [Upgrade to continue](/pricing)",
        };
      }

      return { allowed: true };
    } catch (err) {
      console.error('[Orbit] Credit check failed:', err.message);
      // Fail-closed: if we can't verify credits, block the execution
      return { allowed: false, message: 'Credit check failed. Please try again.' };
    }
  }

  // ── Inline Pipeline Execution (synchronous, SSE streaming) ──────────────

  /**
   * Execute pipeline inline and stream phase progress through emitEvent.
   * Returns when the pipeline completes or fails.
   * After resolution, fires learnFromRun() asynchronously to extract memories.
   *
   * @param {string} prompt
   * @param {string} intentClass
   * @param {function} emitEvent — (event, data) → void — SSE emitter
   * @param {string} userId — required for post-run memory learning
   * @returns {Promise<{ type, message, runId, status }>}
   */
  async _executePipelineInline(prompt, intentClass, emitEvent, userId = null) {
    const intentMap = {
      static_surface: 'STATIC_SURFACE',
      light_app:      'INTERACTIVE_LIGHT_APP',
      full_product:   'PRODUCT_SYSTEM',
    };
    const runConfig = { intent_class: intentMap[intentClass] || 'PRODUCT_SYSTEM' };

    let runId;
    try {
      runId = await this.pipeline.createRun(prompt, {});
    } catch (err) {
      console.error('[Orbit] Failed to create run:', err.message);
      emitEvent('error', { message: 'Failed to start pipeline: ' + err.message });
      return { type: 'error', message: 'Failed to start pipeline: ' + err.message };
    }

    // Emit the run start event so the frontend can show the run link
    emitEvent('run_start', { runId, message: `🚀 Pipeline started — run #${runId.slice(0, 8)}` });

    // Listen for events from the state machine for this specific run
    // After the promise resolves, fire learnFromRun() asynchronously so
    // Orbit extracts and stores lessons without blocking the response.
    const pipelineResult = await new Promise((resolve) => {
      let settled = false;
      let seenEvents = new Set();
      // Track phase outcomes for memory extraction
      const phaseOutcomes = [];

      // Timeout safety: resolve after 10 minutes max
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          type: 'error',
          runId,
          message: `⚠️ Pipeline timed out after 10 minutes. Check [run #${runId.slice(0, 8)}](/run/${runId}) for details.`,
          _memoryHint: { status: 'timeout', phases: phaseOutcomes },
        });
      }, 10 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.stateMachine) {
          this.stateMachine.removeListener(`run:${runId}`, onEvent);
        }
      };

      const onEvent = (event) => {
        const { stage, status, payload, error } = event;
        const eventKey = `${stage}:${status}`;
        if (seenEvents.has(eventKey)) return;
        seenEvents.add(eventKey);

        // Record phase outcome for memory learning
        if (status === 'completed' || status === 'failed') {
          phaseOutcomes.push({ stage, status, error: error || null });
        }

        const phaseLabel = PHASE_LABELS[stage] || stage;

        if (status === 'started') {
          emitEvent('phase_start', { phase: stage, label: phaseLabel, message: `⏳ ${phaseLabel}…` });
        } else if (status === 'completed') {
          // Build a human-readable summary per phase
          const phaseSummary = _buildPhaseSummary(stage, payload);
          emitEvent('phase_complete', { phase: stage, label: phaseLabel, message: `✅ ${phaseLabel} complete${phaseSummary ? ' — ' + phaseSummary : ''}` });

          if (stage === 'verify') {
            // Terminal: pipeline completed
            if (settled) return;
            settled = true;
            cleanup();

            const payloadData = _parsePayload(payload);
            const checks = Array.isArray(payloadData.checks) ? payloadData.checks : [];
            const allPassed = checks.length > 0 && checks.every(c => c.passed);
            const passedCount = checks.filter(c => c.passed).length;

            const summaryMsg = allPassed
              ? `✅ Pipeline complete — all ${checks.length} checks passed. [View run](/run/${runId})`
              : `⚠️ Pipeline complete — ${passedCount}/${checks.length} checks passed. Some verifications failed. [View run](/run/${runId})`;

            emitEvent('complete', {
              runId,
              passed: allPassed,
              checksTotal: checks.length,
              checksPassed: passedCount,
              message: summaryMsg,
            });

            resolve({
              type: 'build',
              runId,
              status: allPassed ? 'verified' : 'completed_with_warnings',
              message: summaryMsg,
              _memoryHint: { status: 'completed', phases: phaseOutcomes },
            });
          }
        } else if (status === 'failed') {
          if (settled) return;
          settled = true;
          cleanup();

          const errMsg = error || 'Pipeline stage failed';
          const failMsg = `❌ Pipeline failed at **${phaseLabel}**: ${errMsg}. [View run](/run/${runId}) — want me to retry?`;

          emitEvent('pipeline_error', { phase: stage, message: failMsg, runId });

          resolve({
            type: 'error',
            runId,
            status: 'failed',
            message: failMsg,
            _memoryHint: { status: 'failed', failedPhase: stage, errorMsg: errMsg, phases: phaseOutcomes },
          });
        }
      };

      // Subscribe before enqueue to avoid missing early events
      this.stateMachine.on(`run:${runId}`, onEvent);

      // Replay any already-emitted events (in case pipeline started instantly)
      this.stateMachine.getEvents(runId).then((pastEvents) => {
        for (const evt of pastEvents) {
          if (!settled) onEvent(evt);
        }
      }).catch(() => {/* non-fatal */});

      // Kick off the pipeline
      this.orchestrator.enqueue(runId, prompt, {}, runConfig);
    });

    // ── Post-run semantic memory extraction (fire-and-forget) ─────────────
    // Extract and store lessons from this run without blocking the response.
    // _memoryHint is a private annotation on the result object used only here.
    if (this.memory && userId && userId !== 'anonymous' && pipelineResult._memoryHint) {
      const hint = pipelineResult._memoryHint;
      this.memory.learnFromRun(userId, runId, {
        prompt,
        status: hint.status,
        phases: hint.phases || [],
        failedPhase: hint.failedPhase || null,
        errorMsg: hint.errorMsg || null,
      }).catch(() => {/* learnFromRun is already fail-open internally */});
    }

    // Strip internal annotation before returning to caller
    const { _memoryHint: _ignored, ...publicResult } = pipelineResult;
    return publicResult;
  }

  // ── LLM Reasoning ─────────────────────────────────────────────────────────

  async _reasonWithTools(history, currentMessage, runContext, currentRunId, memoryBlock = '') {
    // Build context block for the system prompt
    const contextBlock = this._buildContextBlock(runContext, currentRunId);

    const systemPrompt =
      `You are Orbit, the AI copilot embedded in BuildOrbit — a glass-box AI execution pipeline for regulated industries.\n\n` +
      `Your personality: direct, technically sharp, not chatty. You know what's happening in the project at all times. ` +
      `You answer questions about pipeline runs, explain failures, and execute builds/modifications inline when asked.\n\n` +
      (memoryBlock ? `${memoryBlock}\n\n` : '') +
      `${contextBlock}\n\n` +
      `ROUTING RULES:\n` +
      `- Greetings / small talk / "what can you do?" → respond conversationally. No tool call.\n` +
      `- "build X", "create X", "make X" → use the \`build\` tool.\n` +
      `- "fix X", "change X", "add X", "update X", "modify X" → use the \`modify\` tool.\n` +
      `- "show runs", "recent runs", "what ran" → use \`query_runs\`.\n` +
      `- "what happened in run X", "show me run X" → use \`get_run_details\`.\n` +
      `- "why did it fail", "explain the failure", "what went wrong" → use \`explain_failure\`.\n` +
      `- "trace the failure", "which phase caused it", "root cause", "where did it break" → use \`trace_failure_root_cause\`.\n` +
      `- "compare with a working run", "what's different from when it worked", "diff runs" → use \`compare_runs\`.\n` +
      `- "is this a recurring failure", "has this happened before", "failure pattern", "recurring errors" → use \`get_failure_patterns\`.\n` +
      `- "what's the current project", "what stack", "project context" → use \`get_project_context\`.\n` +
      `- Ambiguous → ask one focused clarifying question. Don't default to "what do you want to build?"\n` +
      `- "query the database", "show me table X", "what tables exist", "run this SQL" → use \`use_mcp\` with tool_name "postgres.query" or "postgres.list_tables".\n` +
      `- "show git log", "recent commits", "what changed", "diff" → use \`use_mcp\` with tool_name "git.log" or "git.diff".\n` +
      `- "read file X", "show me the code in X", "list files" → use \`use_mcp\` with tool_name "filesystem.read_file" or "filesystem.list_dir".`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ];

    const tools = [
      {
        type: 'function',
        function: {
          name: 'build',
          description: 'Build a new application from scratch or start a fresh project. Executes the full 6-phase pipeline inline.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Full build prompt describing what to create.' },
              intent: { type: 'string', enum: ['static_surface', 'light_app', 'full_product'], description: 'Complexity tier.' },
              explanation: { type: 'string', description: 'Short message to show the user while pipeline starts.' },
            },
            required: ['prompt', 'explanation'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'modify',
          description: 'Modify, fix, or extend the current project. Executes pipeline inline with conversation context.',
          parameters: {
            type: 'object',
            properties: {
              changes: { type: 'string', description: 'Description of what to change.' },
              explanation: { type: 'string', description: 'Short message to show the user.' },
            },
            required: ['changes', 'explanation'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'query_runs',
          description: 'List recent pipeline runs with status, timestamp, and summary.',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max runs to return (default 5).' },
              status_filter: { type: 'string', enum: ['all', 'success', 'failed', 'running'], description: 'Filter by status.' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_run_details',
          description: 'Get full phase-by-phase details for a specific pipeline run.',
          parameters: {
            type: 'object',
            properties: {
              run_id: { type: 'string', description: 'Run ID to fetch details for.' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'explain_failure',
          description: 'Analyze a failed run and explain what went wrong in plain language.',
          parameters: {
            type: 'object',
            properties: {
              run_id: { type: 'string', description: 'Run ID to analyze (defaults to most recent failed run).' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'trace_failure_root_cause',
          description: 'Deep root-cause analysis: traces backward through all pipeline phases to identify which phase introduced the problem and why. More thorough than explain_failure — use when the user wants to understand the causal chain.',
          parameters: {
            type: 'object',
            properties: {
              run_id: { type: 'string', description: 'Run ID to trace (defaults to most recent failed run).' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'compare_runs',
          description: 'Compare a failed run against the most recent successful run with similar intent. Shows exactly where outputs diverged across phases.',
          parameters: {
            type: 'object',
            properties: {
              run_id: { type: 'string', description: 'The failed run ID to analyze (defaults to most recent failed).' },
              compare_run_id: { type: 'string', description: 'Specific successful run to compare against (optional — auto-selected by default).' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_failure_patterns',
          description: 'Show recurring failure signatures across all runs. Flags systemic issues that have happened 3+ times. Use when user asks if a failure is a one-off or a pattern.',
          parameters: {
            type: 'object',
            properties: {
              signature_key: { type: 'string', description: 'Optional: filter to a specific failure signature key.' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_project_context',
          description: 'Return current project info: tech stack, recent changes, active run status.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'use_mcp',
          description: 'Call an external MCP tool. Use to query a database, read files, check git history, or invoke any registered MCP server. Results are logged in the audit trail.',
          parameters: {
            type: 'object',
            properties: {
              tool_name: {
                type: 'string',
                description: 'Tool name, optionally prefixed with server: "postgres.query", "git.log", "filesystem.read_file", or just "query".',
              },
              tool_params: {
                type: 'object',
                description: 'Parameters for the tool (see tool\'s inputSchema).',
              },
              explanation: {
                type: 'string',
                description: 'Short message to show the user while the tool runs.',
              },
            },
            required: ['tool_name', 'explanation'],
          },
        },
      },
    ];

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
      });

      const choice = completion.choices[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      if (toolCall) {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        return {
          action: toolCall.function.name,
          prompt: args.prompt || args.changes,
          intent: args.intent,
          explanation: args.explanation,
          limit: args.limit,
          status_filter: args.status_filter,
          run_id: args.run_id,
          compare_run_id: args.compare_run_id,
          signature_key: args.signature_key,
          tool_name: args.tool_name,
          tool_params: args.tool_params,
        };
      }

      // No tool call → plain conversational reply
      return {
        action: 'chat',
        explanation: choice?.message?.content || "What would you like to build next?",
      };
    } catch (err) {
      console.error('[Orbit] LLM tool-calling failed:', err.message);
      return this._decideAction(currentMessage);
    }
  }

  // ── Query Tools ───────────────────────────────────────────────────────────

  async _queryRuns(userId, limit = 5, statusFilter = 'all') {
    try {
      let whereClause = `WHERE pr.user_id = $1`;
      const params = [userId];

      if (statusFilter === 'success') {
        whereClause += ` AND pr.status = 'completed'`;
      } else if (statusFilter === 'failed') {
        whereClause += ` AND pr.status = 'failed'`;
      } else if (statusFilter === 'running') {
        whereClause += ` AND pr.status = 'running'`;
      }

      params.push(Math.min(limit, 20));
      const { rows } = await this.pool.query(
        `SELECT id, prompt, status, state, created_at, updated_at
         FROM pipeline_runs pr
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );

      if (rows.length === 0) {
        return { type: 'message', message: 'No recent runs found.' };
      }

      const lines = rows.map(r => {
        const age = _timeAgo(r.created_at);
        const statusIcon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'running' ? '⏳' : '⏸';
        const shortId = r.id.slice(0, 8);
        const promptPreview = (r.prompt || '').slice(0, 60).replace(/\n/g, ' ');
        return `${statusIcon} [#${shortId}](/run/${r.id}) — ${promptPreview} — *${age}*`;
      });

      return {
        type: 'message',
        message: `**Recent runs:**\n\n${lines.join('\n')}`,
      };
    } catch (err) {
      console.error('[Orbit] query_runs error:', err.message);
      return { type: 'message', message: 'Could not fetch run history.' };
    }
  }

  async _getRunDetails(runId) {
    if (!runId) {
      return { type: 'message', message: 'No run ID provided or active. Which run do you want to inspect?' };
    }

    try {
      const { rows: runRows } = await this.pool.query(
        `SELECT id, prompt, status, state, created_at FROM pipeline_runs WHERE id = $1`,
        [runId]
      );

      if (runRows.length === 0) {
        return { type: 'message', message: `Run \`${runId.slice(0, 8)}\` not found.` };
      }

      const run = runRows[0];

      // Get phase events (latest per stage via DISTINCT ON)
      const { rows: eventRows } = await this.pool.query(
        `SELECT DISTINCT ON (stage) stage, status, error, created_at, payload
         FROM pipeline_events
         WHERE run_id = $1
         ORDER BY stage, created_at DESC`,
        [runId]
      );

      const statusIcon = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '⏳';
      const lines = [
        `**Run #${run.id.slice(0, 8)}** ${statusIcon} — ${run.status}`,
        `*Prompt:* ${(run.prompt || '').slice(0, 120)}`,
        `*Started:* ${_timeAgo(run.created_at)}`,
        '',
        '**Phases:**',
      ];

      const phaseOrder = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];
      const eventMap = {};
      for (const e of eventRows) eventMap[e.stage] = e;

      for (const phase of phaseOrder) {
        const ev = eventMap[phase];
        if (!ev) continue;
        const icon = ev.status === 'completed' ? '✅' : ev.status === 'failed' ? '❌' : ev.status === 'started' ? '⏳' : '⏸';
        const label = PHASE_LABELS[phase] || phase;
        const errDetail = ev.error ? ` — *${ev.error.slice(0, 80)}*` : '';
        lines.push(`  ${icon} ${label}${errDetail}`);
      }

      lines.push('');
      lines.push(`[View full run](/run/${runId})`);

      return { type: 'message', message: lines.join('\n'), runId };
    } catch (err) {
      console.error('[Orbit] get_run_details error:', err.message);
      return { type: 'message', message: 'Could not fetch run details.' };
    }
  }

  async _explainFailure(runId, userId) {
    try {
      // If no runId given, find the most recent failed run for this user
      let targetRunId = runId;
      if (!targetRunId) {
        const { rows } = await this.pool.query(
          `SELECT id FROM pipeline_runs WHERE user_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        if (rows.length > 0) targetRunId = rows[0].id;
      }

      if (!targetRunId) {
        return { type: 'message', message: "No recent failed runs to analyze. Everything's been working!" };
      }

      // Fetch all events for the failed run
      const { rows: eventRows } = await this.pool.query(
        `SELECT stage, status, error, payload, created_at FROM pipeline_events WHERE run_id = $1 ORDER BY created_at ASC`,
        [targetRunId]
      );

      const failedEvents = eventRows.filter(e => e.status === 'failed');
      if (failedEvents.length === 0) {
        return { type: 'message', message: `Run #${targetRunId.slice(0, 8)} doesn't have a clear failure event. It may have stalled. [View it](/run/${targetRunId})` };
      }

      // Build context for LLM explanation
      const failureSummary = failedEvents.map(e => {
        const payloadData = _parsePayload(e.payload);
        return `Stage: ${e.stage}\nError: ${e.error || 'none'}\nPayload: ${JSON.stringify(payloadData).slice(0, 500)}`;
      }).join('\n\n');

      const { rows: runRows } = await this.pool.query(
        `SELECT prompt FROM pipeline_runs WHERE id = $1`, [targetRunId]
      );
      const originalPrompt = runRows[0]?.prompt || 'unknown';

      // Use GPT-4o to explain the failure in plain language
      if (this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a build system expert. Analyze a pipeline failure and explain it clearly and concisely in 2-4 sentences. Be specific about what went wrong and suggest a fix.' },
            { role: 'user', content: `Original task: ${originalPrompt}\n\nFailure details:\n${failureSummary}` },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });
        const explanation = completion.choices[0]?.message?.content || 'Could not generate explanation.';

        // Persist failure signature for pattern tracking (fail-open)
        this._persistFailureSignature(targetRunId, userId, failedEvents, explanation, null).catch(() => {});

        return {
          type: 'message',
          runId: targetRunId,
          message: `**Run #${targetRunId.slice(0, 8)} failed at ${failedEvents[0].stage}:**\n\n${explanation}\n\n[View run](/run/${targetRunId}) — want me to retry?`,
        };
      }

      // Fallback: plain text summary
      const failStage = failedEvents[0].stage;
      const failError = failedEvents[0].error || 'No error message captured';

      // Persist even without LLM
      this._persistFailureSignature(targetRunId, userId, failedEvents, null, null).catch(() => {});

      return {
        type: 'message',
        runId: targetRunId,
        message: `**Run #${targetRunId.slice(0, 8)} failed at ${PHASE_LABELS[failStage] || failStage}:**\n\n${failError}\n\n[View run](/run/${targetRunId}) — want me to retry?`,
      };
    } catch (err) {
      console.error('[Orbit] explain_failure error:', err.message);
      return { type: 'message', message: 'Could not analyze the failure.' };
    }
  }

  // ── Deep Failure Analysis ─────────────────────────────────────────────────

  /**
   * Trace failure root cause across all pipeline phases.
   * Fetches all phase outputs and errors, then uses GPT-4o to build a causal
   * chain: "verify failed because code produced X because scaffold decided Y
   * because plan chose Z."
   *
   * @param {string} runId
   * @param {string} userId
   */
  async _traceFailureRootCause(runId, userId) {
    try {
      let targetRunId = runId;
      if (!targetRunId) {
        const { rows } = await this.pool.query(
          `SELECT id FROM pipeline_runs WHERE user_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        if (rows.length > 0) targetRunId = rows[0].id;
      }

      if (!targetRunId) {
        return { type: 'message', message: "No recent failed runs to trace. Everything's been working!" };
      }

      // Get run metadata
      const { rows: runRows } = await this.pool.query(
        `SELECT id, prompt, status, created_at FROM pipeline_runs WHERE id = $1`,
        [targetRunId]
      );
      if (runRows.length === 0) {
        return { type: 'message', message: `Run \`${targetRunId.slice(0, 8)}\` not found.` };
      }
      const run = runRows[0];

      // Get ALL phase events in order (not just failed ones)
      const { rows: eventRows } = await this.pool.query(
        `SELECT DISTINCT ON (stage) stage, status, error, payload, created_at
         FROM pipeline_events
         WHERE run_id = $1
         ORDER BY stage, created_at DESC`,
        [targetRunId]
      );

      // Build ordered timeline of what each phase produced / what went wrong
      const phaseOrder = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];
      const eventMap = {};
      for (const e of eventRows) eventMap[e.stage] = e;

      const phaseTrace = phaseOrder
        .filter(p => eventMap[p])
        .map(p => {
          const ev = eventMap[p];
          const payload = _parsePayload(ev.payload);
          // Extract meaningful subset of payload (avoid huge dumps)
          let payloadSummary = '';
          if (p === 'plan') {
            payloadSummary = JSON.stringify(payload.plan || payload).slice(0, 600);
          } else if (p === 'scaffold') {
            const tree = payload.tree || [];
            payloadSummary = `files: [${tree.slice(0, 20).join(', ')}]`;
          } else if (p === 'code') {
            const files = Object.keys(payload.files || {});
            payloadSummary = `files generated: [${files.slice(0, 20).join(', ')}]`;
          } else if (p === 'verify') {
            const checks = (payload.checks || []).map(c => `${c.passed ? '✅' : '❌'} ${c.name}: ${c.message || ''}`);
            payloadSummary = checks.slice(0, 10).join('\n');
          } else {
            payloadSummary = JSON.stringify(payload).slice(0, 300);
          }
          return `=== ${p.toUpperCase()} [${ev.status}] ===\nError: ${ev.error || 'none'}\nOutput: ${payloadSummary}`;
        });

      const traceText = phaseTrace.join('\n\n');

      if (this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert pipeline debugger. Given a trace of pipeline phase outputs and errors, ' +
                'construct a precise causal chain explaining the root cause. Format:\n' +
                '**Root cause:** [one sentence identifying the originating phase and issue]\n' +
                '**Causal chain:** [2-4 bullet points: Phase X produced Y → Phase Z relied on Y → verify failed because...]\n' +
                '**Proposed fix:** [specific: which file/function/config to change and what to change]\n' +
                'Be precise. If the root cause is in scaffold, say exactly what the scaffold produced incorrectly. ' +
                'If it is in plan, say which planning decision was wrong.',
            },
            {
              role: 'user',
              content: `Task: ${run.prompt}\n\nPhase trace:\n\n${traceText}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 500,
        });

        const analysis = completion.choices[0]?.message?.content || 'Could not generate trace.';

        // Persist with richer context
        const failedEvent = eventRows.find(e => e.status === 'failed');
        if (failedEvent) {
          this._persistFailureSignature(targetRunId, userId, [failedEvent], analysis, analysis).catch(() => {});
        }

        return {
          type: 'message',
          runId: targetRunId,
          message: `**Root-cause trace for run #${targetRunId.slice(0, 8)}:**\n\n${analysis}\n\n[View run](/run/${targetRunId})`,
        };
      }

      // Fallback: structured text summary without LLM
      const failedPhases = eventRows.filter(e => e.status === 'failed');
      const lines = [
        `**Phase trace for run #${targetRunId.slice(0, 8)}:**`,
        '',
        ...phaseOrder
          .filter(p => eventMap[p])
          .map(p => {
            const ev = eventMap[p];
            const icon = ev.status === 'completed' ? '✅' : ev.status === 'failed' ? '❌' : '⏸';
            return `${icon} **${PHASE_LABELS[p] || p}**: ${ev.error || 'OK'}`;
          }),
        '',
        failedPhases.length > 0
          ? `First failure at **${PHASE_LABELS[failedPhases[0].stage] || failedPhases[0].stage}**: ${failedPhases[0].error || 'no error message'}`
          : 'No explicit failure events found.',
        '',
        `[View run](/run/${targetRunId})`,
      ];

      return { type: 'message', runId: targetRunId, message: lines.join('\n') };
    } catch (err) {
      console.error('[Orbit] trace_failure_root_cause error:', err.message);
      return { type: 'message', message: 'Could not trace the failure root cause.' };
    }
  }

  /**
   * Compare a failed run against the most recent successful run with similar
   * intent. Shows which phase outputs diverged.
   *
   * @param {string} failedRunId
   * @param {string|null} successRunId — explicit override, or auto-selected
   * @param {string} userId
   */
  async _compareRuns(failedRunId, successRunId, userId) {
    try {
      // Resolve failed run
      let targetRunId = failedRunId;
      if (!targetRunId) {
        const { rows } = await this.pool.query(
          `SELECT id FROM pipeline_runs WHERE user_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        if (rows.length > 0) targetRunId = rows[0].id;
      }

      if (!targetRunId) {
        return { type: 'message', message: "No recent failed runs to compare." };
      }

      // Fetch failed run
      const { rows: failedRunRows } = await this.pool.query(
        `SELECT id, prompt, status, created_at, run_config FROM pipeline_runs WHERE id = $1`,
        [targetRunId]
      );
      if (failedRunRows.length === 0) {
        return { type: 'message', message: `Run \`${targetRunId.slice(0, 8)}\` not found.` };
      }
      const failedRun = failedRunRows[0];

      // Resolve success run — explicit or auto-find most recent completed with similar prompt keywords
      let successRun = null;
      if (successRunId) {
        const { rows } = await this.pool.query(
          `SELECT id, prompt, status, created_at FROM pipeline_runs WHERE id = $1`,
          [successRunId]
        );
        if (rows.length > 0) successRun = rows[0];
      }

      if (!successRun) {
        // Find most recent completed run for this user (simple heuristic)
        const { rows } = await this.pool.query(
          `SELECT id, prompt, status, created_at FROM pipeline_runs
           WHERE user_id = $1 AND status = 'completed' AND id != $2
           ORDER BY created_at DESC LIMIT 1`,
          [userId, targetRunId]
        );
        if (rows.length > 0) successRun = rows[0];
      }

      if (!successRun) {
        return {
          type: 'message',
          runId: targetRunId,
          message: `**Run #${targetRunId.slice(0, 8)} (failed)** — no completed run found to compare against. Build something successfully first, then re-run this comparison.`,
        };
      }

      // Get phase events for both runs
      const [failedEvents, successEvents] = await Promise.all([
        this.pool.query(
          `SELECT DISTINCT ON (stage) stage, status, error, payload FROM pipeline_events WHERE run_id = $1 ORDER BY stage, created_at DESC`,
          [targetRunId]
        ),
        this.pool.query(
          `SELECT DISTINCT ON (stage) stage, status, error, payload FROM pipeline_events WHERE run_id = $1 ORDER BY stage, created_at DESC`,
          [successRun.id]
        ),
      ]);

      const failedMap = {};
      for (const e of failedEvents.rows) failedMap[e.stage] = e;
      const successMap = {};
      for (const e of successEvents.rows) successMap[e.stage] = e;

      // Build per-phase diff
      const phaseOrder = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];
      const phaseDiffs = phaseOrder
        .filter(p => failedMap[p] || successMap[p])
        .map(p => {
          const f = failedMap[p];
          const s = successMap[p];
          const fStatus = f ? f.status : 'not reached';
          const sStatus = s ? s.status : 'not reached';
          const diverged = fStatus !== sStatus || (f?.error && !s?.error);

          // Extract compact payload summaries
          const fPayload = _parsePayload(f?.payload);
          const sPayload = _parsePayload(s?.payload);

          let fSummary = '';
          let sSummary = '';

          if (p === 'scaffold') {
            fSummary = `[${(fPayload.tree || []).slice(0, 10).join(', ')}]`;
            sSummary = `[${(sPayload.tree || []).slice(0, 10).join(', ')}]`;
          } else if (p === 'code') {
            fSummary = `[${Object.keys(fPayload.files || {}).slice(0, 10).join(', ')}]`;
            sSummary = `[${Object.keys(sPayload.files || {}).slice(0, 10).join(', ')}]`;
          } else if (p === 'verify') {
            const fChecks = (fPayload.checks || []).map(c => `${c.passed ? '✅' : '❌'}${c.name}`).join(' ');
            const sChecks = (sPayload.checks || []).map(c => `${c.passed ? '✅' : '❌'}${c.name}`).join(' ');
            fSummary = fChecks || fStatus;
            sSummary = sChecks || sStatus;
          }

          return { phase: p, diverged, fStatus, sStatus, fError: f?.error, fSummary, sSummary };
        });

      const divergedPhases = phaseDiffs.filter(d => d.diverged);
      const firstDivergence = divergedPhases[0];

      if (this.openai && divergedPhases.length > 0) {
        const diffText = phaseDiffs.map(d =>
          `${d.phase}: failed=${d.fStatus}${d.fError ? ` (${d.fError})` : ''} | success=${d.sStatus}${d.fSummary ? `\n  failed output: ${d.fSummary}` : ''}${d.sSummary ? `\n  success output: ${d.sSummary}` : ''}`
        ).join('\n\n');

        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'You are a pipeline diff analyst. Given a phase-by-phase comparison of a failed run vs a successful run, ' +
                'identify exactly where the divergence started and what caused it. Be specific about output differences. ' +
                'Format: **First divergence:** [phase + what changed] | **Why it diverged:** [1-2 sentences] | **Fix:** [specific action]',
            },
            {
              role: 'user',
              content: `Failed run prompt: ${(failedRun.prompt || '').slice(0, 200)}\nSuccess run prompt: ${(successRun.prompt || '').slice(0, 200)}\n\nPhase comparison:\n${diffText}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 400,
        });

        const analysis = completion.choices[0]?.message?.content || '';

        const lines = [
          `**Run comparison:**`,
          `📌 Failed: [#${targetRunId.slice(0, 8)}](/run/${targetRunId}) — ${_timeAgo(failedRun.created_at)}`,
          `✅ Success: [#${successRun.id.slice(0, 8)}](/run/${successRun.id}) — ${_timeAgo(successRun.created_at)}`,
          '',
          analysis,
        ];

        return { type: 'message', runId: targetRunId, message: lines.join('\n') };
      }

      // Fallback: plain diff table
      const lines = [
        `**Run comparison:**`,
        `📌 Failed: [#${targetRunId.slice(0, 8)}](/run/${targetRunId})`,
        `✅ Success: [#${successRun.id.slice(0, 8)}](/run/${successRun.id})`,
        '',
        '| Phase | Failed | Success |',
        '|-------|--------|---------|',
        ...phaseDiffs.map(d => `| ${PHASE_LABELS[d.phase] || d.phase} | ${d.diverged ? '⚠️ ' : ''}${d.fStatus}${d.fError ? ` — ${d.fError.slice(0, 50)}` : ''} | ${d.sStatus} |`),
        '',
        firstDivergence
          ? `**First divergence at ${PHASE_LABELS[firstDivergence.phase] || firstDivergence.phase}**: ${firstDivergence.fError || 'output differed from successful run'}`
          : 'No clear divergence detected.',
      ];

      return { type: 'message', runId: targetRunId, message: lines.join('\n') };
    } catch (err) {
      console.error('[Orbit] compare_runs error:', err.message);
      return { type: 'message', message: 'Could not compare runs.' };
    }
  }

  /**
   * Return recurring failure patterns for this user.
   * Queries run_failure_signatures for signature_keys that appear 3+ times
   * and surfaces them as systemic issues vs one-offs.
   *
   * @param {string} userId
   * @param {string|null} signatureKey — optional filter
   */
  async _getFailurePatterns(userId, signatureKey = null) {
    try {
      let query;
      let params;

      if (signatureKey) {
        // Show history for a specific signature
        query = `
          SELECT rfs.signature_key, rfs.failure_phase, rfs.error_type,
                 rfs.root_cause, rfs.proposed_fix, rfs.created_at,
                 rfs.run_id, pr.prompt
          FROM run_failure_signatures rfs
          LEFT JOIN pipeline_runs pr ON pr.id = rfs.run_id
          WHERE rfs.user_id = $1 AND rfs.signature_key = $2
          ORDER BY rfs.created_at DESC
          LIMIT 10
        `;
        params = [userId, signatureKey];
      } else {
        // Show top recurring signatures (3+ occurrences = systemic)
        query = `
          SELECT signature_key, failure_phase, error_type,
                 COUNT(*) AS occurrence_count,
                 MAX(created_at) AS last_seen,
                 MAX(root_cause) AS root_cause,
                 MAX(proposed_fix) AS proposed_fix
          FROM run_failure_signatures
          WHERE user_id = $1
          GROUP BY signature_key, failure_phase, error_type
          ORDER BY occurrence_count DESC, last_seen DESC
          LIMIT 15
        `;
        params = [userId];
      }

      const { rows } = await this.pool.query(query, params);

      if (rows.length === 0) {
        return {
          type: 'message',
          message: signatureKey
            ? `No history found for failure pattern \`${signatureKey}\`.`
            : "No failure patterns recorded yet. Orbit tracks patterns after analyzing failures with `explain_failure` or `trace_failure_root_cause`.",
        };
      }

      if (signatureKey) {
        // Detailed history for specific signature
        const lines = [
          `**Failure history for \`${signatureKey}\`:**`,
          '',
          ...rows.map(r => {
            const ago = _timeAgo(r.created_at);
            return `- [#${r.run_id.slice(0, 8)}](/run/${r.run_id}) — ${(r.prompt || '').slice(0, 60)} — *${ago}*`;
          }),
        ];
        if (rows[0]?.proposed_fix) {
          lines.push('', `**Suggested fix:** ${rows[0].proposed_fix}`);
        }
        return { type: 'message', message: lines.join('\n') };
      }

      // Pattern summary
      const systemic = rows.filter(r => parseInt(r.occurrence_count, 10) >= 3);
      const oneOff = rows.filter(r => parseInt(r.occurrence_count, 10) < 3);

      const lines = [`**Failure patterns across your runs:**`, ''];

      if (systemic.length > 0) {
        lines.push('🔴 **Systemic issues (3+ occurrences — needs fixing):**');
        for (const r of systemic) {
          lines.push(`- \`${r.signature_key}\` — ${r.failure_phase} — seen **${r.occurrence_count}×**, last ${_timeAgo(r.last_seen)}`);
          if (r.proposed_fix) lines.push(`  → Fix: ${r.proposed_fix.slice(0, 120)}`);
        }
        lines.push('');
      }

      if (oneOff.length > 0) {
        lines.push('🟡 **One-off failures:**');
        for (const r of oneOff) {
          lines.push(`- \`${r.signature_key}\` — ${r.failure_phase} — seen ${r.occurrence_count}×, last ${_timeAgo(r.last_seen)}`);
        }
      }

      if (systemic.length > 0) {
        lines.push('', `Ask me to \`trace_failure_root_cause\` on a recent run to get a specific fix proposal.`);
      }

      return { type: 'message', message: lines.join('\n') };
    } catch (err) {
      // Table may not exist yet if migration hasn't run — fail gracefully
      if (err.message && err.message.includes('relation "run_failure_signatures" does not exist')) {
        return { type: 'message', message: 'Failure pattern tracking is not yet set up (migration pending). Run `npm run migrate` to enable it.' };
      }
      console.error('[Orbit] get_failure_patterns error:', err.message);
      return { type: 'message', message: 'Could not fetch failure patterns.' };
    }
  }

  /**
   * Persist a failure signature for future pattern detection.
   * Fail-open — never throws, never blocks the caller.
   *
   * @param {string} runId
   * @param {string} userId
   * @param {Array} failedEvents — array of { stage, error, payload }
   * @param {string|null} rootCause — LLM-generated root cause text
   * @param {string|null} proposedFix — LLM-generated fix proposal
   */
  async _persistFailureSignature(runId, userId, failedEvents, rootCause, proposedFix) {
    if (!runId || !userId || !failedEvents || failedEvents.length === 0) return;

    try {
      const primaryFailure = failedEvents[0];
      const stage = primaryFailure.stage || 'unknown';
      const errorMsg = (primaryFailure.error || '').slice(0, 120);

      // Stable signature key: phase + normalized error fragment
      // Strip UUIDs, numbers, and run-specific tokens for stability across runs
      const normalizedError = errorMsg
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')
        .replace(/\b\d+\b/g, '<n>')
        .replace(/["'`]/g, '')
        .toLowerCase()
        .trim()
        .slice(0, 60);
      const signatureKey = `${stage}:${normalizedError || 'unknown'}`;

      // Classify error type
      let errorType = 'unknown';
      const errLower = errorMsg.toLowerCase();
      if (stage === 'verify') errorType = 'verify_check';
      else if (errLower.includes('timeout')) errorType = 'timeout';
      else if (errLower.includes('syntax') || errLower.includes('parse')) errorType = 'syntax_error';
      else if (errLower.includes('not found') || errLower.includes('missing')) errorType = 'artifact_missing';
      else if (errLower.includes('llm') || errLower.includes('openai') || errLower.includes('anthropic')) errorType = 'llm_error';
      else if (stage === 'save') errorType = 'save_error';
      else if (stage === 'code') errorType = 'code_gen_error';
      else if (stage === 'scaffold') errorType = 'scaffold_error';
      else if (stage === 'plan') errorType = 'plan_error';

      const context = {
        failedStages: failedEvents.map(e => ({ stage: e.stage, error: e.error })),
      };

      await this.pool.query(
        `INSERT INTO run_failure_signatures
           (run_id, user_id, failure_phase, error_type, signature_key, root_cause, proposed_fix, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [runId, userId, stage, errorType, signatureKey, rootCause || null, proposedFix || null, JSON.stringify(context)]
      );
    } catch (err) {
      // Table not yet migrated or other DB issue — silently drop
      if (!err.message?.includes('relation "run_failure_signatures" does not exist')) {
        console.error('[Orbit] _persistFailureSignature error:', err.message);
      }
    }
  }

  async _getProjectContext(userId, currentRunId, runContext) {
    try {
      const lines = [];

      // If run context was injected by the frontend
      if (runContext && runContext.runId) {
        lines.push(`**Active run:** #${runContext.runId.slice(0, 8)}`);
        if (runContext.currentPhase) lines.push(`**Current phase:** ${PHASE_LABELS[runContext.currentPhase] || runContext.currentPhase}`);
        if (runContext.phases && runContext.phases.length > 0) {
          const phaseStates = runContext.phases.map(p => {
            const icon = p.status === 'complete' ? '✅' : p.status === 'failed' ? '❌' : p.status === 'running' ? '⏳' : '⏸';
            return `${icon} ${p.name || p.phase}`;
          }).join(' → ');
          lines.push(`**Pipeline:** ${phaseStates}`);
        }
        lines.push('');
      }

      // Last few runs for context
      const { rows } = await this.pool.query(
        `SELECT id, prompt, status, run_config FROM pipeline_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3`,
        [userId]
      );

      if (rows.length > 0) {
        const latest = rows[0];
        lines.push(`**Last run:** #${latest.id.slice(0, 8)} — ${latest.status}`);

        // Extract tech stack from run_config if available
        const cfg = latest.run_config || {};
        if (cfg.techStack || cfg.intentClass) {
          lines.push(`**Stack:** ${cfg.techStack || cfg.intentClass || 'not captured'}`);
        }

        const promptPreview = (latest.prompt || '').slice(0, 100).replace(/\n/g, ' ');
        lines.push(`**Last task:** ${promptPreview}`);
        lines.push('');
        lines.push(`[View run](/run/${latest.id})`);
      } else {
        lines.push('No previous runs. Ready to build something?');
      }

      return { type: 'message', message: lines.join('\n') };
    } catch (err) {
      console.error('[Orbit] get_project_context error:', err.message);
      return { type: 'message', message: 'Could not fetch project context.' };
    }
  }

  // ── MCP Tool Invocation ───────────────────────────────────────────────────

  async _useMcp(userId, runId, toolName, toolParams) {
    if (!this.mcpRegistry) {
      return { type: 'message', message: 'MCP is not configured. No MCP servers are registered.' };
    }

    try {
      let result;
      if (this.mcpAudit) {
        result = await this.mcpAudit.call(
          this.mcpRegistry, userId, runId || null, 'copilot', toolName, toolParams
        );
      } else {
        result = await this.mcpRegistry.callTool(userId, toolName, toolParams);
      }

      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map(c => c.text || '').join('\n').trim();
      const isError = result.isError === true;

      return {
        type: 'message',
        message: isError
          ? `⚠️ MCP tool \`${toolName}\` returned an error:\n\n${text}`
          : `**\`${toolName}\` result:**\n\n\`\`\`\n${text}\n\`\`\``,
      };
    } catch (err) {
      console.error('[Orbit] _useMcp error:', err.message);
      return { type: 'message', message: `MCP tool \`${toolName}\` failed: ${err.message}` };
    }
  }

  // ── Keyword Fallback ──────────────────────────────────────────────────────

  _decideAction(message) {
    const text = message.toLowerCase();
    if (/\b(build|create|make|new app|start project|generate)\b/.test(text)) {
      return { action: 'build' };
    }
    if (/\b(add|fix|change|update|modify|improve|refactor|remove|delete)\b/.test(text)) {
      return { action: 'modify' };
    }
    if (/\b(show|list|recent|runs|history)\b/.test(text)) {
      return { action: 'query_runs' };
    }
    if (/\b(fail|broke|why|error|explain)\b/.test(text)) {
      return { action: 'explain_failure' };
    }
    if (/\b(trace|root.?cause|which phase|where did it break|causal)\b/.test(text)) {
      return { action: 'trace_failure_root_cause' };
    }
    if (/\b(compare|diff.?run|working run|successful run|what.?different)\b/.test(text)) {
      return { action: 'compare_runs' };
    }
    if (/\b(pattern|recurring|systemic|happened before|signature)\b/.test(text)) {
      return { action: 'get_failure_patterns' };
    }
    return { action: 'chat' };
  }

  // ── Pipeline Trigger (async fallback) ─────────────────────────────────────

  async _triggerPipeline(prompt, intentClass) {
    const intentMap = {
      static_surface:  'STATIC_SURFACE',
      light_app:       'INTERACTIVE_LIGHT_APP',
      full_product:    'PRODUCT_SYSTEM',
    };
    const runConfig = {
      intent_class: intentMap[intentClass] || 'PRODUCT_SYSTEM',
    };

    const runId = await this.pipeline.createRun(prompt, {});
    this.orchestrator.enqueue(runId, prompt, {}, runConfig);
    return runId;
  }

  // ── Conversation Persistence ──────────────────────────────────────────────

  async _getOrCreateConversation(userId, conversationId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM orbit_conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (rows.length > 0) return rows[0];

    const title = `Conversation ${new Date().toISOString().slice(0, 16)}`;
    await this.pool.query(
      `INSERT INTO orbit_conversations (id, user_id, history, title)
       VALUES ($1, $2, '[]'::jsonb, $3)
       ON CONFLICT (id) DO NOTHING`,
      [conversationId, userId, title]
    );

    return { history: [] };
  }

  async _saveConversation(userId, conversationId, history, currentRunId, lastPrompt) {
    await this.pool.query(
      `UPDATE orbit_conversations
       SET history = $1,
           current_run_id = COALESCE($2, current_run_id),
           last_prompt = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5`,
      [JSON.stringify(history), currentRunId, lastPrompt, conversationId, userId]
    );
  }

  // ── Context Builder ───────────────────────────────────────────────────────

  _buildContextBlock(runContext, currentRunId) {
    const parts = [];

    if (runContext && runContext.runId) {
      parts.push(`ACTIVE RUN: #${runContext.runId.slice(0, 8)}`);
      if (runContext.currentPhase) {
        parts.push(`Current phase: ${PHASE_LABELS[runContext.currentPhase] || runContext.currentPhase}`);
      }
    } else if (currentRunId) {
      parts.push(`Last run: #${currentRunId.slice(0, 8)}`);
    }

    if (parts.length === 0) return '';
    return `CONTEXT:\n${parts.join('\n')}`;
  }

  _buildModificationPrompt(history, newRequest) {
    const recent = history
      .slice(-8)
      .map(h => `${h.role}: ${h.content}`)
      .join('\n\n');

    return (
      `Project conversation history:\n${recent}\n\n` +
      `New request: ${newRequest}\n\n` +
      `Apply these changes intelligently and output the complete updated codebase.`
    );
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return {}; }
  }
  return payload;
}

function _buildPhaseSummary(stage, payload) {
  const data = _parsePayload(payload);
  if (stage === 'verify') {
    const checks = Array.isArray(data.checks) ? data.checks : [];
    if (checks.length > 0) {
      return `${checks.filter(c => c.passed).length}/${checks.length} checks passed`;
    }
  }
  if (stage === 'code') {
    const files = data.files ? Object.keys(data.files) : [];
    if (files.length > 0) return `${files.length} files generated`;
  }
  if (stage === 'scaffold') {
    const tree = data.tree || [];
    if (tree.length > 0) return `${tree.length} files in scaffold`;
  }
  return null;
}

function _timeAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

module.exports = { Orbit };
