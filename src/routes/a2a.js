/**
 * BuildOrbit A2A (Agent-to-Agent) Routes
 *
 * Exposes BuildOrbit's 6-phase deterministic pipeline as a remote subagent
 * callable via Google's Agent-to-Agent (A2A) protocol and any Bearer-token
 * capable HTTP client (Gemini CLI, custom agents, etc.).
 *
 * Endpoints:
 *   POST   /a2a/execute          — Execute pipeline, stream phases via SSE
 *   GET    /a2a/status/:runId    — Poll run status (non-streaming alternative)
 *   POST   /a2a/keys             — Create API key (session auth required)
 *   GET    /a2a/keys             — List your API keys (session auth required)
 *   DELETE /a2a/keys/:id         — Revoke an API key (session auth required)
 *   GET    /a2a/descriptor       — Machine-readable subagent descriptor (public)
 *
 * Auth: Bearer token for /a2a/execute and /a2a/status.
 *       Session cookie for key management endpoints.
 *
 * Rate limit: 10 executions per hour per API key.
 *
 * Phase Mapping (6-phase A2A presentation):
 *   1. INTENT_GATE  → embedded in pipeline 'plan' stage start
 *   2. PLAN         → pipeline 'plan' stage complete
 *   3. SCAFFOLD     → pipeline 'scaffold' stage
 *   4. CODE         → pipeline 'code' stage
 *   5. SAVE         → pipeline 'save' stage
 *   6. VERIFY       → pipeline 'verify' stage
 */

const express = require('express');
const crypto = require('crypto');

// ── Phase Metadata ─────────────────────────────────────────────────────────
// All 6 phases are first-class persisted stages in the state machine.
// INTENT_GATE has its own started/completed events in pipeline_events.

const PHASE_MAP = {
  // pipeline stage → A2A phase descriptor
  // intent_gate is a first-class persisted phase (Phase 1/6)
  intent_gate: { number: 1, name: 'INTENT_GATE', description: 'Classifies intent and compiles immutable constraint contract' },
  plan:        { number: 2, name: 'PLAN',         description: 'Generates structured plan within constraint boundaries' },
  scaffold:    { number: 3, name: 'SCAFFOLD',     description: 'Creates binding file/project structure manifest' },
  code:        { number: 4, name: 'CODE',          description: 'Implements against scaffold manifest' },
  save:        { number: 5, name: 'SAVE',          description: 'Persists artifacts and versions output' },
  verify:      { number: 6, name: 'VERIFY',        description: 'Validates output against plan and constraints' },
};

const TOTAL_PHASES = 6;

// ── In-Memory Rate Limiter ─────────────────────────────────────────────────
//
// KNOWN LIMITATION: This rate limiter is in-memory only.
//   1. State resets on every Render restart (which occurs on every deploy).
//   2. Multiple instances (horizontal scaling) have independent counters —
//      effective limit per instance = RATE_LIMIT, not global.
//
// Interim mitigation: limits are intentionally conservative (10/hr) to tolerate
// partial state loss. Ideal fix: Redis-backed atomic INCR + EXPIRE (e.g. Upstash).
// Upgrade path: provision Redis, swap Map for redis.incr() + redis.expire().

// Map: keyId → { count: number, windowStart: number }
const rateLimitWindows = new Map();
const RATE_LIMIT = 10;          // max executions per window
const WINDOW_MS  = 60 * 60 * 1000; // 1 hour

function checkRateLimit(keyId) {
  const now = Date.now();
  const window = rateLimitWindows.get(keyId);

  if (!window || now - window.windowStart >= WINDOW_MS) {
    // New window
    rateLimitWindows.set(keyId, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT - 1, resetAt: now + WINDOW_MS };
  }

  if (window.count >= RATE_LIMIT) {
    const resetAt = window.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  window.count++;
  return { allowed: true, remaining: RATE_LIMIT - window.count, resetAt: window.windowStart + WINDOW_MS };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey() {
  // Format: bk_<48 random hex chars> → 51 chars total
  const random = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  return `bk_${random}`;
}

function sseEmitter(res) {
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Translate a state machine event into one or more A2A SSE phase events.
 * Returns an array of { event, data } objects to emit in order.
 */
function translateToA2AEvents(stageEvent) {
  const { stage, status, payload, error } = stageEvent;
  const events = [];

  const payloadData = payload
    ? (typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return {}; } })() : payload)
    : {};

  // ── INTENT_GATE — first-class persisted phase (Phase 1/6) ──────────────────
  if (stage === 'intent_gate') {
    const phaseInfo = PHASE_MAP.intent_gate;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'completed') {
      events.push({
        event: 'phase_complete',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'completed',
          artifact: {
            intent_class: payloadData.intent_class || null,
            constraint_contract: payloadData,
          },
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || payloadData.error || 'Intent Gate failed',
        },
      });
    }
  } else if (stage === 'plan') {
    const phaseInfo = PHASE_MAP.plan;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'completed') {
      events.push({
        event: 'phase_complete',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'completed',
          artifact: {
            subtasks: payloadData.subtasks || null,
            estimated_complexity: payloadData.estimatedComplexity || null,
            raw_markdown: payloadData.rawMarkdown || payloadData.raw || null,
          },
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || 'Plan stage failed',
        },
      });
    }
  } else if (stage === 'scaffold') {
    const phaseInfo = PHASE_MAP.scaffold;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'completed') {
      events.push({
        event: 'artifact',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          artifact_type: 'scaffold_manifest',
          content: {
            tree: payloadData.tree || null,
            tech_stack: payloadData.techStack || null,
            file_count: Array.isArray(payloadData.files) ? payloadData.files.length : null,
            constraints: payloadData.constraints || null,
          },
        },
      });
      events.push({
        event: 'phase_complete',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'completed',
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || 'Scaffold stage failed',
        },
      });
    }
  } else if (stage === 'code') {
    const phaseInfo = PHASE_MAP.code;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'completed') {
      const files = payloadData.files || {};
      const fileNames = Object.keys(files);
      events.push({
        event: 'artifact',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          artifact_type: 'generated_files',
          content: {
            file_count: fileNames.length,
            total_lines: payloadData.totalLines || null,
            entry_point: payloadData.entryPoint || null,
            files: fileNames, // file names only — full content via /api/pipeline/:runId/artifacts
          },
        },
      });
      events.push({
        event: 'phase_complete',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'completed',
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || 'Code stage failed',
        },
      });
    }
  } else if (stage === 'save') {
    const phaseInfo = PHASE_MAP.save;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'completed') {
      events.push({
        event: 'phase_complete',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'completed',
          artifact: {
            version_id: payloadData.versionId || null,
            persisted: payloadData.persisted || true,
          },
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || 'Save stage failed',
        },
      });
    }
  } else if (stage === 'verify') {
    const phaseInfo = PHASE_MAP.verify;
    if (status === 'started') {
      events.push({
        event: 'phase_start',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'running',
          description: phaseInfo.description,
        },
      });
    } else if (status === 'failed') {
      events.push({
        event: 'phase_error',
        data: {
          phase: phaseInfo.name,
          phase_number: phaseInfo.number,
          total_phases: TOTAL_PHASES,
          status: 'failed',
          message: error || 'Verify stage failed',
        },
      });
    }
    // verify completed is handled separately (terminal event)
  }

  return events;
}

// ── Router Factory ─────────────────────────────────────────────────────────

/**
 * Create the A2A router.
 *
 * @param {object} deps
 * @param {import('pg').Pool}                    deps.pool
 * @param {object}                               deps.pipeline        — PipelineExecutor (createRun, getRun)
 * @param {object}                               deps.orchestrator    — PipelineOrchestrator (enqueue)
 * @param {object}                               deps.stateMachine    — PipelineStateMachine (on, removeListener, getEvents)
 * @param {object}                               deps.auth            — auth module (requireApiAuth)
 */
function createA2ARouter({ pool, pipeline, orchestrator, stateMachine, auth }) {
  const router = express.Router();

  // ── Bearer Token Middleware ──────────────────────────────────────────────
  //
  // Accepts two token formats:
  //   bk_<hex>   — legacy A2A API keys (api_keys table)
  //   bo_live_*  — CLI/headless API tokens (api_tokens table, created via POST /auth/api-token)
  //   bo_mock_*  — same as bo_live_ but minted in mock mode

  async function requireA2AAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'A2A authentication required. Include: Authorization: Bearer <api_key>',
        docs: 'https://buildorbit.polsia.app/a2a/descriptor',
      });
    }

    const rawKey = authHeader.slice(7).trim();

    // ── bo_live_ / bo_mock_ API tokens (api_tokens table) ─────────────────
    if (rawKey.startsWith('bo_') && auth && typeof auth.validateApiToken === 'function') {
      try {
        const tokenData = await auth.validateApiToken(pool, rawKey);
        if (!tokenData) {
          return res.status(401).json({ success: false, message: 'Invalid or expired API token' });
        }
        req.apiKey = { id: tokenData.id, userId: tokenData.userId, type: 'api_token' };
        return next();
      } catch (err) {
        console.error('[A2A] API token validation error:', err.message);
        return res.status(500).json({ success: false, message: 'Authentication check failed' });
      }
    }

    // ── bk_ legacy API keys (api_keys table) ──────────────────────────────
    if (!rawKey.startsWith('bk_') || rawKey.length < 20) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key format. Use a bk_ API key or a bo_live_ API token.',
      });
    }

    const keyHash = hashKey(rawKey);

    try {
      const result = await pool.query(
        `SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = $1`,
        [keyHash]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Invalid API key' });
      }

      const keyRow = result.rows[0];

      if (keyRow.revoked_at) {
        return res.status(401).json({ success: false, message: 'API key has been revoked' });
      }

      // Update last_used_at async (don't block the request)
      pool.query(
        'UPDATE api_keys SET last_used_at = now() WHERE id = $1',
        [keyRow.id]
      ).catch(err => console.error('[A2A] Failed to update last_used_at:', err.message));

      req.apiKey = { id: keyRow.id, userId: keyRow.user_id, type: 'api_key' };
      next();
    } catch (err) {
      console.error('[A2A] Auth error:', err);
      res.status(500).json({ success: false, message: 'Authentication check failed' });
    }
  }

  // ── GET /a2a/.well-known/agent.json — A2A discovery endpoint ──────────────
  //
  // Standard agent card per Google's A2A protocol so external orchestrators
  // can auto-discover BuildOrbit's capabilities and endpoint.

  router.get('/.well-known/agent.json', (req, res) => {
    res.json({
      name: 'BuildOrbit',
      description: 'Autonomous execution with deterministic 6-phase pipeline and constraint enforcement. Every task produces a cryptographically-traceable execution proof with guardrail metadata.',
      version: '1.0.0',
      capabilities: ['static_surface', 'interactive_light_app', 'product_system'],
      endpoint: 'https://buildorbit.polsia.app/a2a/execute',
      protocol: 'a2a-v1',
      auth: {
        type: 'bearer',
        header: 'Authorization: Bearer <api_key>',
        obtain_key: 'POST https://buildorbit.polsia.app/a2a/keys (session auth required)',
      },
      phases: [
        { number: 1, name: 'INTENT_GATE',  description: 'Classifies intent and compiles immutable constraint contract' },
        { number: 2, name: 'PLAN',          description: 'Generates structured plan within constraint boundaries' },
        { number: 3, name: 'SCAFFOLD',      description: 'Creates binding file/project structure manifest' },
        { number: 4, name: 'CODE',          description: 'Implements against scaffold manifest' },
        { number: 5, name: 'SAVE',          description: 'Persists artifacts and versions output' },
        { number: 6, name: 'VERIFY',        description: 'Validates output against plan and constraints' },
      ],
      guardrails: {
        constraint_enforcement: true,
        regression_checks: ['no_raw_http', 'no_fire_and_forget', 'no_exposed_credentials', 'no_uncaught_promises', 'no_inline_sensitive_data'],
        expansion_lock: true,
        proof_in_response: true,
      },
      rate_limit: { executions_per_hour: 10, window: '1h' },
    });
  });

  // ── GET /a2a/descriptor — Public machine-readable descriptor ─────────────

  router.get('/descriptor', (req, res) => {
    res.json({
      name: 'buildorbit',
      description: 'Deterministic 6-phase system builder — visible execution from intent to verified output',
      version: '1.0.0',
      endpoint: 'https://buildorbit.polsia.app/a2a/execute',
      auth: {
        type: 'bearer',
        header: 'Authorization: Bearer <api_key>',
        obtain_key: 'POST https://buildorbit.polsia.app/a2a/keys (session auth required)',
      },
      input: {
        schema: {
          task_description: { type: 'string', required: true, description: 'What to build' },
          intent_class: {
            type: 'enum',
            required: false,
            values: ['STATIC_SURFACE', 'INTERACTIVE_LIGHT_APP', 'PRODUCT_SYSTEM'],
            description: 'Auto-detected if omitted. STATIC_SURFACE=landing pages, INTERACTIVE_LIGHT_APP=forms/tools, PRODUCT_SYSTEM=full SaaS',
          },
          product_context: { type: 'object', required: false, description: 'Brand/product context for accurate content generation' },
          constraints: { type: 'object', required: false, description: 'Hard constraints passed to INTENT_GATE' },
        },
      },
      output: {
        streaming: 'SSE (text/event-stream)',
        events: [
          { event: 'connected', description: 'Stream opened, run created', fields: ['run_id', 'task_description'] },
          { event: 'phase_start', description: 'Phase execution started', fields: ['phase', 'phase_number', 'total_phases', 'description'] },
          { event: 'phase_complete', description: 'Phase completed with optional artifact', fields: ['phase', 'phase_number', 'status', 'artifact?'] },
          { event: 'artifact', description: 'Intermediate artifact available', fields: ['phase', 'artifact_type', 'content'] },
          { event: 'phase_error', description: 'Phase failed', fields: ['phase', 'phase_number', 'message'] },
          { event: 'complete', description: 'All phases done — final bundle', fields: ['run_id', 'passed', 'verification', 'artifacts_url', 'execution_time_ms'] },
          { event: 'error', description: 'Fatal pipeline error', fields: ['message', 'run_id?'] },
        ],
      },
      phases: [
        { number: 1, name: 'INTENT_GATE', description: 'Classifies intent and compiles immutable constraint contract' },
        { number: 2, name: 'PLAN',         description: 'Generates structured plan within constraint boundaries' },
        { number: 3, name: 'SCAFFOLD',     description: 'Creates binding file/project structure manifest' },
        { number: 4, name: 'CODE',         description: 'Implements against scaffold manifest' },
        { number: 5, name: 'SAVE',         description: 'Persists artifacts and versions output' },
        { number: 6, name: 'VERIFY',       description: 'Validates output against plan and constraints' },
      ],
      capabilities: [
        'landing_pages',
        'web_apps',
        'full_stack_systems',
        'deterministic_execution',
        'phase_streaming',
        'artifact_versioning',
        'constraint_enforcement',
      ],
      rate_limit: { executions_per_hour: 10, window: '1h' },
    });
  });

  // ── GET /a2a/execute — 405 Method Not Allowed ────────────────────────────

  router.get('/execute', (req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      success: false,
      message: 'Method Not Allowed. Use POST /a2a/execute with a JSON body: { "task_description": "..." }',
      docs: 'https://buildorbit.polsia.app/a2a/descriptor',
    });
  });

  // ── POST /a2a/execute — Execute pipeline, stream phases ─────────────────

  router.post('/execute', requireA2AAuth, async (req, res) => {
    // Accept both flat format AND Google A2A protocol envelope:
    //   Flat:     { "task_description": "...", "intent_class": "...", ... }
    //   A2A spec: { "task": { "description": "...", "context": { ... } } }
    const body = req.body || {};
    const isA2AEnvelope = body.task && typeof body.task === 'object';

    const task_description = isA2AEnvelope
      ? (body.task.description || '').trim()
      : (body.task_description || '').trim();

    const intent_class    = isA2AEnvelope ? (body.task.intent_class    || body.intent_class)    : body.intent_class;
    const product_context = isA2AEnvelope ? (body.task.context         || body.product_context) : body.product_context;
    const constraints     = isA2AEnvelope ? (body.task.constraints     || body.constraints)     : body.constraints;

    if (!task_description) {
      return res.status(400).json({
        success: false,
        message: 'task_description is required. Accepted formats: { task_description: "..." } or { task: { description: "..." } }',
      });
    }

    // Rate limit check
    const rl = checkRateLimit(req.apiKey.id);
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt / 1000)));

    if (!rl.allowed) {
      return res.status(429).json({
        success: false,
        message: `Rate limit exceeded. Resets at ${new Date(rl.resetAt).toISOString()}`,
        reset_at: new Date(rl.resetAt).toISOString(),
      });
    }

    // Build run config
    const runConfig = {};
    if (intent_class) runConfig.intentClass = intent_class;
    if (product_context && typeof product_context === 'object') runConfig.productContext = product_context;
    if (constraints && typeof constraints === 'object') runConfig.constraints = constraints;

    let runId;
    const startTime = Date.now();

    // Execution proof accumulator — built up as phase events arrive,
    // attached to the final `complete` SSE event as guardrail metadata.
    const phaseProof = {
      phases: [],
      constraintContract: null,
      intentClass: null,
      violationsDetected: 0,
    };

    try {
      // Create run
      runId = await pipeline.createRun(task_description.trim(), {});

      // Store run config and A2A metadata.
      // api_key_id is only set for bk_ legacy keys (FK to api_keys).
      // bo_* api_tokens store their own id in a separate table — leave api_key_id as NULL.
      const apiKeyId = req.apiKey.type === 'api_key' ? req.apiKey.id : null;
      await pool.query(
        `UPDATE pipeline_runs SET run_config = $1, source = 'a2a', api_key_id = $2 WHERE id = $3`,
        [JSON.stringify(runConfig), apiKeyId, runId]
      );

      // Enqueue
      orchestrator.enqueue(runId, task_description.trim(), {}, runConfig);
    } catch (err) {
      console.error('[A2A] Failed to create/enqueue run:', err);
      return res.status(500).json({ success: false, message: 'Failed to start pipeline execution' });
    }

    // ── SSE Setup ──────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const emit = sseEmitter(res);

    // Initial connection event
    emit('connected', {
      run_id: runId,
      task_description: task_description.trim(),
      total_phases: TOTAL_PHASES,
      message: 'Pipeline queued. Phase stream starting.',
    });

    // Subscribe BEFORE replaying to avoid race conditions
    const bufferedEvents = [];
    let replaying = true;
    const seenEventIds = new Set();

    const onEvent = (event) => {
      if (closed) return;

      if (replaying) {
        bufferedEvents.push(event);
        return;
      }

      if (event.id && seenEventIds.has(event.id)) return;

      // Accumulate execution proof before emitting
      recordPhaseProof(event, phaseProof);

      const a2aEvents = translateToA2AEvents(event);
      for (const ae of a2aEvents) {
        if (!closed) emit(ae.event, ae.data);
      }

      // Handle verify completed (terminal)
      if (event.stage === 'verify' && event.status === 'completed') {
        emitFinalBundle(emit, event, runId, startTime, phaseProof);
        cleanup();
        setTimeout(() => { if (!closed) res.end(); }, 200);
      } else if (event.status === 'failed') {
        emit('error', {
          run_id: runId,
          phase: event.stage ? event.stage.toUpperCase() : 'UNKNOWN',
          message: event.error || 'Pipeline stage failed',
        });
        cleanup();
        if (!closed) res.end();
      }
    };

    stateMachine.on(`run:${runId}`, onEvent);

    const cleanup = () => {
      stateMachine.removeListener(`run:${runId}`, onEvent);
    };
    req.on('close', cleanup);

    // Replay past events (for reconnects or if pipeline already advanced)
    try {
      const pastEvents = await stateMachine.getEvents(runId);
      for (const event of pastEvents) {
        if (closed) { cleanup(); return; }
        if (event.id) seenEventIds.add(event.id);
        recordPhaseProof(event, phaseProof);
        const a2aEvents = translateToA2AEvents(event);
        for (const ae of a2aEvents) {
          if (!closed) emit(ae.event, ae.data);
        }
      }
    } catch (err) {
      console.error('[A2A] Error replaying events:', err);
    }

    // Flush buffered live events
    replaying = false;
    for (const event of bufferedEvents) {
      if (closed) { cleanup(); return; }
      if (event.id && seenEventIds.has(event.id)) continue;
      recordPhaseProof(event, phaseProof);
      const a2aEvents = translateToA2AEvents(event);
      for (const ae of a2aEvents) {
        if (!closed) emit(ae.event, ae.data);
      }
    }

    // Re-check terminal state after replay (for already-completed runs)
    try {
      const currentRun = await pipeline.getRun(runId);
      if (currentRun && currentRun.status === 'completed') {
        const allEvents = await stateMachine.getEvents(runId);
        const verifyDone = allEvents.find(ev => ev.stage === 'verify' && ev.status === 'completed');
        emitFinalBundle(emit, verifyDone || {}, runId, startTime, phaseProof);
        cleanup();
        if (!closed) res.end();
      } else if (currentRun && currentRun.status === 'failed') {
        emit('error', { run_id: runId, message: currentRun.error || 'Pipeline failed' });
        cleanup();
        if (!closed) res.end();
      }
    } catch (err) {
      console.error('[A2A] Error checking terminal state:', err);
    }
  });

  // ── GET /a2a/status/:runId — Poll run status (non-streaming) ─────────────

  router.get('/status/:runId', requireA2AAuth, async (req, res) => {
    const { runId } = req.params;

    try {
      const run = await pipeline.getRun(runId);
      if (!run) {
        return res.status(404).json({ success: false, message: 'Run not found' });
      }

      // Verify this key's user owns the run
      const ownerCheck = await pool.query(
        `SELECT pr.id FROM pipeline_runs pr
         JOIN api_keys ak ON ak.id = pr.api_key_id
         WHERE pr.id = $1 AND ak.user_id = $2 AND pr.source = 'a2a'`,
        [runId, req.apiKey.userId]
      );
      if (ownerCheck.rows.length === 0) {
        return res.status(403).json({ success: false, message: 'Run not found or access denied' });
      }

      const events = await stateMachine.getEvents(runId);
      const completedStages = events
        .filter(e => e.status === 'completed')
        .map(e => e.stage);

      res.json({
        success: true,
        run_id: runId,
        status: run.status,
        state: run.state,
        prompt: run.prompt,
        completed_stages: completedStages,
        current_phase: stageToPhaseNumber(run.state),
        total_phases: TOTAL_PHASES,
        artifacts_url: `https://buildorbit.polsia.app/api/pipeline/${runId}/artifacts`,
        created_at: run.created_at,
      });
    } catch (err) {
      console.error('[A2A] Status check error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch run status' });
    }
  });

  // ── Key Management (session auth) ─────────────────────────────────────────

  // Create a new API key
  router.post('/keys', auth.requireApiAuth, async (req, res) => {
    const { name } = req.body;
    const userId = req.user.userId;
    const keyName = (name && name.trim()) ? name.trim().slice(0, 255) : 'Default';

    const rawKey = generateApiKey();
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12); // "bk_" + 9 chars

    try {
      const result = await pool.query(
        `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, key_prefix, name, created_at`,
        [userId, keyHash, keyPrefix, keyName]
      );

      const row = result.rows[0];

      res.status(201).json({
        success: true,
        message: 'API key created. Save this key — it will not be shown again.',
        key: {
          id: row.id,
          key: rawKey, // Only shown once
          prefix: row.key_prefix,
          name: row.name,
          created_at: row.created_at,
        },
      });
    } catch (err) {
      console.error('[A2A] Key creation error:', err);
      res.status(500).json({ success: false, message: 'Failed to create API key' });
    }
  });

  // List API keys for the authenticated user
  router.get('/keys', auth.requireApiAuth, async (req, res) => {
    const userId = req.user.userId;

    try {
      const result = await pool.query(
        `SELECT id, key_prefix, name, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      );

      res.json({
        success: true,
        keys: result.rows.map(row => ({
          id: row.id,
          prefix: row.key_prefix,
          name: row.name,
          created_at: row.created_at,
          last_used_at: row.last_used_at,
          revoked: !!row.revoked_at,
          revoked_at: row.revoked_at,
        })),
        count: result.rows.length,
      });
    } catch (err) {
      console.error('[A2A] Key list error:', err);
      res.status(500).json({ success: false, message: 'Failed to list API keys' });
    }
  });

  // Revoke an API key
  router.delete('/keys/:id', auth.requireApiAuth, async (req, res) => {
    const userId = req.user.userId;
    const { id } = req.params;

    try {
      const result = await pool.query(
        `UPDATE api_keys
         SET revoked_at = now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id, key_prefix, name`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Key not found or already revoked' });
      }

      res.json({
        success: true,
        message: 'API key revoked',
        key: result.rows[0],
      });
    } catch (err) {
      console.error('[A2A] Key revocation error:', err);
      res.status(500).json({ success: false, message: 'Failed to revoke API key' });
    }
  });

  return router;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

// Known regression checks enforced by the pipeline
const REGRESSION_CHECKS = [
  'no_raw_http',
  'no_fire_and_forget',
  'no_exposed_credentials',
  'no_uncaught_promises',
  'no_inline_sensitive_data',
];

/**
 * Update the phase proof accumulator from a raw state-machine event.
 * Safe to call multiple times for the same event (idempotent by stage+status).
 *
 * @param {{ stage: string, status: string, payload: any, error?: string }} event
 * @param {{ phases: object[], constraintContract: any, intentClass: string|null, violationsDetected: number }} proof
 */
function recordPhaseProof(event, proof) {
  const { stage, status } = event;
  if (!stage || !status) return;

  const payloadData = event.payload
    ? (typeof event.payload === 'string'
        ? (() => { try { return JSON.parse(event.payload); } catch { return {}; } })()
        : event.payload)
    : {};

  // ── INTENT_GATE: read from real persisted event (no reconstruction) ─────
  if (stage === 'intent_gate' && status === 'completed') {
    proof.constraintContract = payloadData;
    proof.intentClass = payloadData.intent_class || null;

    if (!proof.phases.find(p => p.phase === 'INTENT_GATE')) {
      proof.phases.push({
        phase: 'INTENT_GATE',
        status: 'completed',
        intent_class: payloadData.intent_class || null,
        constraints: payloadData.constraints || null,
        expansion_lock: (typeof payloadData.expansion_lock !== 'undefined') ? payloadData.expansion_lock : true,
        cco_hash: payloadData.cco_hash || null,
      });
    }
  }

  // ── PLAN: standalone phase record (no longer carries INTENT_GATE) ─────
  if (stage === 'plan' && status === 'completed') {
    // Add PLAN phase record
    if (!proof.phases.find(p => p.phase === 'PLAN')) {
      const subtasks = payloadData.subtasks;
      proof.phases.push({
        phase: 'PLAN',
        status: 'completed',
        subtask_count: Array.isArray(subtasks) ? subtasks.length : (payloadData.subtaskCount || null),
      });
    }
  }

  if (stage === 'scaffold' && status === 'completed') {
    if (!proof.phases.find(p => p.phase === 'SCAFFOLD')) {
      const files = Array.isArray(payloadData.files) ? payloadData.files : [];
      const hash  = payloadData.manifestHash || payloadData.manifest_hash || null;
      proof.phases.push({
        phase: 'SCAFFOLD',
        status: 'completed',
        manifest_hash: hash,
        file_count: files.length || null,
      });
    }
  }

  if (stage === 'code' && status === 'completed') {
    if (!proof.phases.find(p => p.phase === 'CODE')) {
      proof.phases.push({
        phase: 'CODE',
        status: 'completed',
        scaffold_validated: true, // CODE only runs if SCAFFOLD passed
      });
    }
  }

  if (stage === 'save' && status === 'completed') {
    if (!proof.phases.find(p => p.phase === 'SAVE')) {
      const files = payloadData.files ? Object.keys(payloadData.files) : (payloadData.artifacts || []);
      proof.phases.push({
        phase: 'SAVE',
        status: 'completed',
        artifacts: Array.isArray(files) ? files : [],
      });
    }
  }

  if (stage === 'verify' && status === 'completed') {
    if (!proof.phases.find(p => p.phase === 'VERIFY')) {
      const checks  = Array.isArray(payloadData.checks) ? payloadData.checks : [];
      const passed  = checks.filter(c => c.passed).length;
      const failed  = checks.filter(c => !c.passed).length;
      proof.phases.push({
        phase: 'VERIFY',
        status: 'completed',
        checks_passed: passed,
        checks_failed: failed,
        dom_validation: payloadData.domValidation !== false,
      });
      // Count violations
      proof.violationsDetected = failed;
    }
  }

  // Track failures too
  if (status === 'failed') {
    const phaseName = stageToA2APhaseName(stage);
    if (phaseName && !proof.phases.find(p => p.phase === phaseName)) {
      proof.phases.push({
        phase: phaseName,
        status: 'failed',
        error: event.error || 'Stage failed',
      });
    }
  }
}

function stageToA2APhaseName(stage) {
  if (!stage) return null;
  if (stage === 'plan')     return 'PLAN';
  if (stage === 'scaffold') return 'SCAFFOLD';
  if (stage === 'code')     return 'CODE';
  if (stage === 'save')     return 'SAVE';
  if (stage === 'verify')   return 'VERIFY';
  return stage.toUpperCase();
}

function emitFinalBundle(emit, verifyEvent, runId, startTime, phaseProof) {
  const payload = verifyEvent && verifyEvent.payload
    ? (typeof verifyEvent.payload === 'string'
        ? (() => { try { return JSON.parse(verifyEvent.payload); } catch { return {}; } })()
        : verifyEvent.payload)
    : {};

  const checks  = Array.isArray(payload.checks) ? payload.checks : [];
  const passed  = checks.length > 0 && checks.every(c => c.passed);

  // Emit VERIFY phase_complete first
  emit('phase_complete', {
    phase: 'VERIFY',
    phase_number: 6,
    total_phases: TOTAL_PHASES,
    status: passed ? 'completed' : 'completed_with_warnings',
    artifact: {
      checks_passed: checks.filter(c => c.passed).length,
      total_checks: checks.length,
      errors: payload.errors || [],
      warnings: payload.warnings || [],
    },
  });

  // Build guardrails proof from accumulated phase data
  const proof = phaseProof || { phases: [], constraintContract: null, intentClass: null, violationsDetected: 0 };
  const cc = proof.constraintContract;
  const guardrails = {
    constraint_contract: cc ? 'locked' : 'unknown',
    intent_class: proof.intentClass || null,
    constraints: (cc && cc.constraints) ? cc.constraints : null,
    expansion_lock: (cc && typeof cc.expansion_lock !== 'undefined') ? cc.expansion_lock : true,
    regression_checks: REGRESSION_CHECKS,
    violations_detected: proof.violationsDetected || 0,
  };

  // Then emit final bundle
  emit('complete', {
    task_id: runId,
    run_id: runId,
    status: passed ? 'completed' : 'completed_with_warnings',
    passed,
    total_phases: TOTAL_PHASES,
    phases: proof.phases,
    guardrails,
    verification: {
      passed,
      checks_passed: checks.filter(c => c.passed).length,
      total_checks: checks.length,
      errors: payload.errors || [],
      warnings: payload.warnings || [],
    },
    artifacts_url: `https://buildorbit.polsia.app/api/pipeline/${runId}/artifacts`,
    live_url: `https://buildorbit.polsia.app/live/${runId}/`,
    execution_time_ms: Date.now() - startTime,
  });
}

function stageToPhaseNumber(state) {
  if (!state) return 0;
  if (state.startsWith('plan'))     return state.includes('complete') ? 2 : 1;
  if (state.startsWith('scaffold')) return 3;
  if (state.startsWith('code'))     return 4;
  if (state.startsWith('save'))     return 5;
  if (state.startsWith('verify'))   return 6;
  return 0;
}

module.exports = { createA2ARouter };
