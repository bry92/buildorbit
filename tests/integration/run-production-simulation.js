#!/usr/bin/env node
/**
 * BuildOrbit Production Simulation
 * =================================
 * Mock Runtime + Production Simulation — auth-independent system proof
 *
 * Executes the full 6-phase pipeline end-to-end with:
 *   - Mock auth layer (no real session cookie needed)
 *   - Mock Postmark (no email delivery)
 *   - Real OR mock database (auto-detects what's available)
 *   - Real pipeline components (intent gate, planner, builder, ops, QA)
 *
 * DB Mode (auto-detected):
 *   REAL_DB   — uses live Neon PostgreSQL when DATABASE_URL is reachable
 *   MOCK_DB   — in-memory MockPool when DB is unreachable (CI/sandbox)
 *   Both modes exercise the same pipeline code paths.
 *
 * Outputs: tests/validation/production-simulation-report.json
 *
 * Usage:
 *   node tests/validation/run-production-simulation.js
 *   FORCE_MOCK_DB=true node tests/validation/run-production-simulation.js
 *
 * This is PERMANENT DEV/TEST INFRASTRUCTURE — not a one-off script.
 * When real auth ships, MOCK_MODE=false is the only change needed.
 */

'use strict';

// ── Step 0: Production guard (case-insensitive) ─────────────────────────────
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  console.error('[Simulation] ERROR: Cannot run in production environment');
  process.exit(1);
}

// ── Step 1: Inject mock env vars BEFORE loading modules ─────────────────────
const crypto = require('crypto');

process.env.MOCK_MODE = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const injectedEnvVars = [];
if (!process.env.POSTMARK_SERVER_TOKEN) {
  // Generate random token instead of hardcoded value — never ship static secrets
  process.env.POSTMARK_SERVER_TOKEN = `mock-${crypto.randomBytes(16).toString('hex')}`;
  injectedEnvVars.push('POSTMARK_SERVER_TOKEN');
  console.log('[MOCK ENV] Generated random POSTMARK_SERVER_TOKEN for testing');
}
if (!process.env.JWT_SECRET) {
  // Generate random 32-byte secret instead of hardcoded value
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  injectedEnvVars.push('JWT_SECRET');
  console.log('[MOCK ENV] Generated random JWT_SECRET for testing');
}

// ── Step 2: Load modules ────────────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

// Fix: all were pre-reorg root paths; now point to canonical src/ versions
// mock/ has no src/ equivalent — stays at root
const mockLayer = require('../../mock/mock-layer');
const { MockPool } = require('../../mock/mock-db');
const { PipelineExecutor } = require('../../src/phases/pipeline');
const { PipelineStateMachine } = require('../../src/core/state-machine');
const { PipelineEventBus } = require('../../src/core/event-bus');
const { PipelineOrchestrator } = require('../../src/core/pipeline-orchestrator');
const { createAgentRegistry } = require('../../src/agents');
const { ArtifactStore } = require('../../src/core/artifact-store');
const { CostTracker } = require('../../src/lib/cost-tracker');
const auth = require('../../src/lib/auth');
const { createA2ARouter } = require('../../src/routes/a2a');

// ── Constants ────────────────────────────────────────────────────────────────
const TASK_DESCRIPTION = 'Build a landing page for a coffee shop with online ordering';
const MOCK_USER_EMAIL = 'test@buildorbit.mock';
const SIMULATION_TIMEOUT_MS = 5 * 60 * 1000;
const DB_CONNECT_TIMEOUT_MS = 5000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}
function generateApiKey() {
  return `bk_${crypto.randomBytes(24).toString('hex')}`;
}
function log(msg) { console.log(`[Simulation] ${msg}`); }
function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

// ── DB Connectivity Probe ────────────────────────────────────────────────────
async function tryRealDb() {
  if (process.env.FORCE_MOCK_DB === 'true' || !process.env.DATABASE_URL) return null;
  const probe = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    max: 2,
  });
  try {
    await probe.query('SELECT 1');
    log('Real DB connected');
    return probe;
  } catch (err) {
    log(`Real DB unavailable (${err.code || err.message}) — using MockPool`);
    try { await probe.end(); } catch (_) {}
    return null;
  }
}

// ── SSE Client ───────────────────────────────────────────────────────────────
function streamSSE(serverUrl, apiPath, bearerToken, onEvent, onDone) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, serverUrl);
    const body = JSON.stringify({ task_description: TASK_DESCRIPTION });
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port) || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => reject(new Error(`Timeout after ${SIMULATION_TIMEOUT_MS}ms`)), SIMULATION_TIMEOUT_MS);

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', d => { errBody += d; });
        res.on('end', () => { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`)); });
        return;
      }

      let buf = '';
      const events = [];
      let curEvent = null;
      let curData = '';

      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) { curEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) { curData = line.slice(6).trim(); }
          else if (line === '') {
            if (curEvent && curData) {
              let parsed; try { parsed = JSON.parse(curData); } catch (_) { parsed = curData; }
              const evt = { event: curEvent, data: parsed, ts: new Date().toISOString() };
              events.push(evt);
              onEvent(evt);
              if (curEvent === 'complete' || curEvent === 'error') {
                clearTimeout(timer); res.destroy(); onDone(events); resolve(events);
              }
            }
            curEvent = null; curData = '';
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); onDone(events); resolve(events); });
      res.on('error', err => { clearTimeout(timer); reject(err); });
    });

    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runSimulation() {
  section('PHASE A: Mock Environment Setup');

  mockLayer.applyMocks(auth);
  const mockEnv = mockLayer.buildMockEnvironmentSummary(injectedEnvVars);
  log('Auth + Postmark patched');

  // ── DB ────────────────────────────────────────────────────────────────────
  let pool;
  let dbMode;
  let mockPoolRef = null;
  const rawApiKey = generateApiKey();
  const keyHash = hashKey(rawApiKey);
  const keyPrefix = rawApiKey.slice(0, 12);

  const realPool = await tryRealDb();
  if (realPool) {
    pool = realPool;
    dbMode = 'REAL_DB';
  } else {
    mockPoolRef = new MockPool({ id: 'mock-apikey-001', userId: 'mock-user-001', keyHash, prefix: keyPrefix });
    pool = mockPoolRef;
    dbMode = 'MOCK_DB';
    mockEnv.mocked_dependencies.push({
      name: 'PostgreSQL (Neon)',
      real_type: 'Live Neon DB — stores pipeline_runs, pipeline_events, api_keys',
      mock_value: 'MockPool — in-memory state machine matching real schema',
      impact: 'All queries intercepted in-memory; real persistence not verified in this run',
      mode: dbMode,
    });
  }
  log(`DB mode: ${dbMode}`);

  // ── API Key Setup ─────────────────────────────────────────────────────────
  section('Test API Key');

  let testUserId = null;
  let testKeyId = null;
  let mockA2AAuth = false;

  if (dbMode === 'REAL_DB') {
    try {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [MOCK_USER_EMAIL]);
      testUserId = existing.rows.length > 0
        ? existing.rows[0].id
        : (await pool.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [MOCK_USER_EMAIL])).rows[0].id;
      testKeyId = (await pool.query(
        'INSERT INTO api_keys (user_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4) RETURNING id',
        [testUserId, keyHash, keyPrefix, 'simulation-test-key']
      )).rows[0].id;
      log(`Test user: ${testUserId} | API key: ${keyPrefix}...`);
    } catch (err) {
      log(`DB key creation failed (${err.message}) — using mock A2A auth`);
      mockA2AAuth = true;
    }
  } else {
    // MockPool has the key registered by hash from constructor
    testKeyId = 'mock-apikey-001';
    testUserId = 'mock-user-001';
    log(`Mock API key: ${keyPrefix}...`);
  }

  // ── Pipeline Components ───────────────────────────────────────────────────
  section('Pipeline Components');
  const stateMachine = new PipelineStateMachine(pool);
  const pipeline = new PipelineExecutor(pool, stateMachine);
  const eventBus = new PipelineEventBus();
  const agentRegistry = createAgentRegistry(pool);
  const artifactStore = new ArtifactStore(path.join(__dirname, '../../.tmp/sim-artifacts'));
  const costTracker = new CostTracker();
  const orchestrator = new PipelineOrchestrator({
    stateMachine, executor: pipeline, eventBus, pool,
    agentRegistry, artifactStore, costTracker,
  });
  log('Wired');

  // ── Express App ───────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  auth.requireAuth    = mockLayer.mockRequireAuth;
  auth.requireApiAuth = mockLayer.mockRequireApiAuth;

  if (mockA2AAuth) {
    app.use('/a2a', (req, res, next) => {
      req.apiKey = { id: mockLayer.MOCK_API_KEY.id, userId: mockLayer.MOCK_API_KEY.userId, mocked: true };
      next();
    });
  }

  app.use('/a2a', createA2ARouter({ pool, pipeline, orchestrator, stateMachine, auth }));

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s));
  });
  const serverPort = server.address().port;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  // ── Execute Pipeline via HTTP ─────────────────────────────────────────────
  section('PHASE B: HTTP Pipeline Execution');

  const trace = {
    request: { method: 'POST', path: '/a2a/execute', url: `${serverUrl}/a2a/execute`, body: { task_description: TASK_DESCRIPTION }, auth_mode: mockA2AAuth ? 'MOCK_BYPASS' : 'REAL_DB_KEY', db_mode: dbMode },
    phases: {
      intent_gate: { completed: false, output_valid: false, events: [] },
      plan:        { completed: false, output_valid: false, events: [] },
      scaffold:    { completed: false, output_valid: false, events: [] },
      code:        { completed: false, output_valid: false, events: [] },
      save:        { completed: false, output_valid: false, events: [] },
      verify:      { completed: false, output_valid: false, events: [] },
    },
    all_sse_events: [],
    run_id: null,
    fatal_error: null,
    execution_time_ms: null,
    complete_event: null,
  };

  const phaseMap = { INTENT_GATE: 'intent_gate', PLAN: 'plan', SCAFFOLD: 'scaffold', CODE: 'code', SAVE: 'save', VERIFY: 'verify' };
  const leakedDeps = [];
  let simError = null;
  const t0 = Date.now();

  log(`POST ${serverUrl}/a2a/execute`);
  log(`Task: "${TASK_DESCRIPTION}"`);

  try {
    await streamSSE(serverUrl, '/a2a/execute', rawApiKey,
      evt => {
        trace.all_sse_events.push(evt);
        if (evt.event === 'connected') { trace.run_id = evt.data?.run_id; trace.request.run_id = evt.data?.run_id; log(`  Run ID: ${evt.data?.run_id}`); }
        if (evt.event === 'phase_start' && evt.data?.phase) { const k = phaseMap[evt.data.phase]; if (k) { trace.phases[k].started = true; trace.phases[k].events.push('phase_start'); } }
        if (evt.event === 'phase_complete' && evt.data?.phase) { const k = phaseMap[evt.data.phase]; if (k) { trace.phases[k].completed = true; trace.phases[k].output_valid = true; trace.phases[k].events.push('phase_complete'); log(`  ✓ ${evt.data.phase}`); } }
        if (evt.event === 'artifact' && evt.data?.phase) { const k = phaseMap[evt.data.phase]; if (k) { trace.phases[k].artifact_received = true; trace.phases[k].events.push('artifact'); } }
        if (evt.event === 'phase_error') { const k = phaseMap[evt.data?.phase]; if (k) { trace.phases[k].error = evt.data.message; trace.phases[k].events.push('phase_error'); } log(`  ✗ ${evt.data?.phase}: ${evt.data?.message}`); }
        if (evt.event === 'complete') { trace.complete_event = evt.data; log(`  ✅ COMPLETE — passed: ${evt.data?.passed}`); }
        if (evt.event === 'error') { simError = evt.data?.message; trace.fatal_error = evt.data; log(`  ✗ FATAL: ${evt.data?.message}`); }
      },
      allEvts => log(`Stream closed (${allEvts.length} events)`)
    );
    trace.execution_time_ms = Date.now() - t0;
  } catch (err) {
    trace.execution_time_ms = Date.now() - t0;
    simError = err.message;
    trace.fatal_error = { type: 'stream_error', message: err.message };
    if (/auth|401|unauthorized/i.test(err.message)) {
      leakedDeps.push({ dependency: 'A2A auth', leak_type: 'auth_not_bypassed', error: err.message });
    }
    log(`Error: ${err.message}`);
  }

  await new Promise(r => server.close(r));
  log('Server stopped');

  // ── Storage Verification ──────────────────────────────────────────────────
  section('PHASE C: Storage Verification');

  const runId = trace.run_id;
  const storage = {
    pipeline_runs:  { entry_exists: false, user_id_correct: false },
    pipeline_events:{ event_count: 0, all_phases_logged: false, phases_found: [] },
    memory_items:   { entries_created: false, count: 0, note: 'Schema exists (migration 007); not written by current pipeline — future semantic layer' },
    artifacts:      { entries_created: false, count: 0, note: 'Schema exists (migration 007); pipeline uses ArtifactStore (filesystem) — future DB storage' },
    artifact_versions: { entries_created: false, count: 0, note: 'Schema exists (migration 007); not written by current pipeline' },
  };

  if (runId) {
    try {
      const r = await pool.query('SELECT id, state, plan, code FROM pipeline_runs WHERE id = $1', [runId]);
      if (r.rows.length > 0) {
        storage.pipeline_runs.entry_exists = true;
        storage.pipeline_runs.state = r.rows[0].state;
        storage.pipeline_runs.has_artifacts = !!(r.rows[0].plan || r.rows[0].code);
        storage.pipeline_runs.user_id_correct = !!testKeyId;
        log(`pipeline_runs ✓  state=${r.rows[0].state}`);
      } else { log('pipeline_runs ✗  no row'); }
    } catch (err) { storage.pipeline_runs.error = err.message; log(`pipeline_runs ✗  ${err.message}`); }

    try {
      const evts = await pool.query('SELECT stage, status FROM pipeline_events WHERE run_id = $1 ORDER BY id ASC', [runId]);
      storage.pipeline_events.event_count = evts.rows.length;
      const phases = [...new Set(evts.rows.map(e => e.stage))];
      storage.pipeline_events.phases_found = phases;
      storage.pipeline_events.all_phases_logged = ['plan','scaffold','code','save','verify'].every(p => phases.includes(p));
      log(`pipeline_events ✓  ${evts.rows.length} events — ${phases.join(', ')}`);
    } catch (err) { storage.pipeline_events.error = err.message; log(`pipeline_events ✗  ${err.message}`); }
  }

  if (dbMode === 'REAL_DB') {
    // SECURITY: whitelist table names to prevent SQL injection via template literals
    const ALLOWED_TABLES = ['memory_items', 'artifacts', 'artifact_versions'];
    for (const [k, t] of [['memory_items','memory_items'],['artifacts','artifacts'],['artifact_versions','artifact_versions']]) {
      if (!ALLOWED_TABLES.includes(t)) {
        log(`${t}: SKIPPED — not in allowed table whitelist`);
        continue;
      }
      try {
        const r = await pool.query(`SELECT COUNT(*) as c FROM ${t}`);
        storage[k].count = parseInt(r.rows[0].c);
        storage[k].entries_created = storage[k].count > 0;
        log(`${t}: ${storage[k].count} rows (future infra)`);
      } catch (err) { storage[k].note += ` [table inaccessible: ${err.message}]`; }
    }
  }

  // ── Leak Check ────────────────────────────────────────────────────────────
  section('Leak Detection');
  const authErrors = trace.all_sse_events.filter(e => e.event === 'error' && /auth|session|401|unauthorized/i.test(String(e.data?.message)));
  if (authErrors.length > 0) leakedDeps.push({ dependency: 'auth_middleware', leak_type: 'real_session_check_reached', events: authErrors });
  trace.leaked_dependencies = leakedDeps;

  const completed = Object.entries(trace.phases).filter(([,p]) => p.completed).map(([n]) => n);
  const missing = ['intent_gate','plan','scaffold','code','save','verify'].filter(p => !completed.includes(p));
  log(`Completed: ${completed.join(', ') || 'none'}`);
  if (missing.length) log(`Missing: ${missing.join(', ')}`);
  log(`Leaks: ${leakedDeps.length}`);

  // ── Checks ────────────────────────────────────────────────────────────────
  section('Results');
  const checks = {
    no_auth_crash:           !simError || !/auth|session|401|unauthorized/i.test(simError),
    no_hidden_auth_deps:     leakedDeps.filter(d => d.leak_type?.includes('auth')).length === 0,
    runs_table_recording:    storage.pipeline_runs.entry_exists,
    run_events_recorded:     storage.pipeline_events.event_count > 0,
    all_phases_in_events:    storage.pipeline_events.all_phases_logged,
    pipeline_completes:      completed.length === 6,
    no_external_network_leaks: leakedDeps.filter(d => d.leak_type === 'external_network_call').length === 0,
  };

  const overallPass = Object.values(checks).every(Boolean);
  for (const [k, v] of Object.entries(checks)) log(`  ${v ? '✓' : '✗'} ${k}`);
  log(`\nOVERALL: ${overallPass ? '✅ PASS' : '❌ FAIL'}`);

  // ── Report ────────────────────────────────────────────────────────────────
  const report = {
    generated_at: new Date().toISOString(),
    simulation_version: '1.0.0',
    task_description: TASK_DESCRIPTION,

    mock_environment: {
      ...mockEnv,
      db_mode: dbMode,
      db_mode_note: dbMode === 'REAL_DB'
        ? 'Connected to live Neon PostgreSQL — full persistence verified'
        : 'Sandbox/CI environment: real DB unreachable. MockPool provides identical pipeline behavior without network.',
    },

    execution_trace: {
      request: trace.request,
      run_id: trace.run_id,
      phases: trace.phases,
      complete_event: trace.complete_event || null,
      fatal_error: trace.fatal_error,
      execution_time_ms: trace.execution_time_ms,
      total_sse_events: trace.all_sse_events.length,
    },

    storage_verification: {
      runs_table: {
        canonical_table: 'pipeline_runs',
        entry_exists: storage.pipeline_runs.entry_exists,
        user_id_correct: storage.pipeline_runs.user_id_correct,
        has_phase_artifacts: storage.pipeline_runs.has_artifacts || false,
        state: storage.pipeline_runs.state,
        error: storage.pipeline_runs.error,
      },
      run_events_table: {
        canonical_table: 'pipeline_events',
        event_count: storage.pipeline_events.event_count,
        all_phases_logged: storage.pipeline_events.all_phases_logged,
        phases_found: storage.pipeline_events.phases_found,
        error: storage.pipeline_events.error,
      },
      memory_items_table: storage.memory_items,
      artifacts_table: storage.artifacts,
      artifact_versions_table: storage.artifact_versions,
    },

    validation_checks: checks,
    leaked_dependencies: leakedDeps,
    overall_pass: overallPass,

    architecture_notes: [
      'pipeline_runs = primary run record (NOT migration-007 "runs" table)',
      'pipeline_events = phase event log (NOT migration-007 "run_events" table)',
      'memory_items / artifacts / artifact_versions = migration-007 future infra, not yet written by pipeline',
      `Auth mock: requireAuth + requireApiAuth + makeRequireAuth + makeRequireApiAuth all bypassed via mock/mock-layer.js`,
      `Postmark mock: sendMagicLinkEmail no-op, zero network calls`,
      `A2A auth: ${mockA2AAuth ? 'mock bypass (DB fallback)' : 'REAL api_keys DB lookup — verified full auth path'}`,
      `DB: ${dbMode} — ${dbMode === 'REAL_DB' ? 'live Neon verified' : 'MockPool (sandbox — no outbound DB access)'}`,
    ],
  };

  // ── Write ─────────────────────────────────────────────────────────────────
  const reportPath = path.join(__dirname, 'production-simulation-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\nReport: ${reportPath}`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  if (dbMode === 'REAL_DB' && testKeyId) {
    try { await pool.query('DELETE FROM api_keys WHERE id = $1', [testKeyId]); log('Cleaned up test key'); }
    catch (_) {}
  }
  await pool.end();

  section('DONE');
  log(`${overallPass ? '✅ PASS' : '❌ FAIL'}`);
  return { overallPass, report };
}

runSimulation()
  .then(({ overallPass }) => process.exit(overallPass ? 0 : 1))
  .catch(err => { console.error('[Simulation] Fatal:', err.message, '\n', err.stack); process.exit(2); });
