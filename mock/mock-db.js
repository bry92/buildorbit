/**
 * BuildOrbit Mock Database — In-Memory Pool
 * ==========================================
 * pg.Pool-compatible interface backed by in-memory state.
 * Handles all SQL queries issued by the BuildOrbit pipeline.
 *
 * Design: Pattern-matches query strings, returns structured in-memory data.
 * Does not parse SQL — matches known query shapes emitted by the codebase.
 *
 * Used for offline simulation when Neon DB is unreachable (CI/sandbox).
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex').replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    '$1-$2-$3-$4-$5'
  );
}

function ts() { return new Date().toISOString(); }

// ── In-Memory State ───────────────────────────────────────────────────────────

class MockDatabase {
  constructor(mockApiKey) {
    this.runs = new Map();       // runId → run row
    this.events = [];            // pipeline_events rows
    this.idempotencyKeys = new Map(); // key → event row (for ON CONFLICT handling)
    this.nextEventId = 1;
    this.mockApiKey = mockApiKey; // { id, userId, keyHash }
    this.queryLog = [];
  }

  query(sql, params = []) {
    // Normalize whitespace so all pattern matching works regardless of newlines/indentation
    const q = sql.replace(/\s+/g, ' ').trim();
    this.queryLog.push({ sql: q.slice(0, 250), params: (params || []).slice(0, 8), at: ts() });

    // ── Transaction control (no-ops) ───────────────────────────────────────
    if (/^BEGIN$/i.test(q) || /^COMMIT$/i.test(q) || /^ROLLBACK$/i.test(q)) {
      return { rows: [], rowCount: 0 };
    }

    // ── pipeline_runs ──────────────────────────────────────────────────────

    // INSERT INTO pipeline_runs → create new run
    if (/INSERT INTO pipeline_runs/i.test(q)) {
      const runId = makeUUID();
      const run = {
        id: runId,
        prompt: params[0] || '',
        state: 'queued',
        status: 'running',
        budget_cap: params[1] || null,
        budget_warning: params[2] || null,
        plan: null, scaffold: null, code: null,
        run_config: null, source: null, api_key_id: null,
        error: null, current_phase: null, completed_at: null,
        created_at: ts(), updated_at: ts(),
      };
      this.runs.set(runId, run);
      return { rows: [{ id: runId }], rowCount: 1 };
    }

    // UPDATE pipeline_runs SET run_config = $1, source = 'a2a', api_key_id = $2 WHERE id = $3
    if (/UPDATE pipeline_runs SET run_config/i.test(q)) {
      const runId = params[2];
      const run = this.runs.get(runId);
      if (run) { run.run_config = params[0]; run.source = 'a2a'; run.api_key_id = params[1]; }
      return { rows: [], rowCount: 1 };
    }

    // UPDATE pipeline_runs SET "plan" = $2, "scaffold" = $3, "code" = $4 WHERE id = $1
    // UPDATE pipeline_runs SET "plan" = $2 WHERE id = $1 (partial variants)
    if (/UPDATE pipeline_runs SET "plan"/i.test(sql) || /UPDATE pipeline_runs SET "scaffold"/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      if (run) {
        // Parse by position based on SET columns listed in SQL
        const setPart = q.match(/SET (.*) WHERE/i);
        if (setPart) {
          const cols = setPart[1].split(',').map(s => s.trim());
          for (let i = 0; i < cols.length; i++) {
            const colMatch = cols[i].match(/"(\w+)"\s*=\s*\$(\d+)/);
            if (colMatch) {
              const colName = colMatch[1];
              const paramIdx = parseInt(colMatch[2]) - 1;
              if (params[paramIdx] !== undefined) run[colName] = params[paramIdx];
            }
          }
        }
      }
      return { rows: [], rowCount: 1 };
    }

    // UPDATE pipeline_runs SET "state" = $2, "status" = $3, ... WHERE id = $1
    // (from state machine transition — params[0]=runId, rest=fields)
    if (/UPDATE pipeline_runs SET "state"/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      if (run) {
        // Extract all SET assignments from SQL
        const setPart = q.match(/SET (.*) WHERE/i);
        if (setPart) {
          const cols = setPart[1].split(',').map(s => s.trim());
          for (let i = 0; i < cols.length; i++) {
            const colMatch = cols[i].match(/"?(\w+)"?\s*=\s*\$(\d+)/);
            if (colMatch) {
              const colName = colMatch[1];
              const paramIdx = parseInt(colMatch[2]) - 1;
              if (params[paramIdx] !== undefined) run[colName] = params[paramIdx];
            }
          }
        }
        run.updated_at = ts();
      }
      return { rows: [], rowCount: 1 };
    }

    // Catch-all UPDATE pipeline_runs (e.g., SET costs, other fields)
    if (/UPDATE pipeline_runs/i.test(q)) {
      return { rows: [], rowCount: 1 };
    }

    // SELECT state FROM pipeline_runs WHERE id = $1
    if (/SELECT state FROM pipeline_runs/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      return { rows: run ? [{ state: run.state }] : [], rowCount: run ? 1 : 0 };
    }

    // SELECT * FROM pipeline_runs WHERE id = $1
    if (/SELECT \* FROM pipeline_runs WHERE id/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
    }

    // SELECT ... FROM pipeline_runs WHERE id = $1 (generic - for getRun)
    if (/SELECT.*FROM pipeline_runs WHERE id\s*=\s*\$1/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
    }

    // SELECT ... FROM pipeline_runs (list)
    if (/SELECT.*FROM pipeline_runs/i.test(q)) {
      const all = [...this.runs.values()];
      return { rows: all, rowCount: all.length };
    }

    // ── pipeline_events ────────────────────────────────────────────────────

    // INSERT INTO pipeline_events (... idempotency_key) ON CONFLICT DO NOTHING RETURNING *
    if (/INSERT INTO pipeline_events/i.test(q)) {
      const [runId, stage, status, payload, error, idempotencyKey] = params;

      // Idempotency: if key already exists, return empty (ON CONFLICT DO NOTHING)
      if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
        return { rows: [], rowCount: 0 };
      }

      const event = {
        id: this.nextEventId++,
        run_id: runId,
        stage,
        status,
        payload: payload || null,
        error: error || null,
        idempotency_key: idempotencyKey || null,
        created_at: ts(),
      };
      this.events.push(event);
      if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, event);
      return { rows: [event], rowCount: 1 };
    }

    // SELECT * FROM pipeline_events WHERE idempotency_key = $1
    if (/SELECT.*FROM pipeline_events WHERE idempotency_key/i.test(q)) {
      const key = params[0];
      const evt = this.idempotencyKeys.get(key);
      return { rows: evt ? [evt] : [], rowCount: evt ? 1 : 0 };
    }

    // SELECT 1 FROM pipeline_events WHERE run_id = $1 AND stage = $2 AND status = 'completed'
    if (/SELECT 1 FROM pipeline_events/i.test(sql) && /status\s*=\s*'completed'/i.test(q)) {
      const runId = params[0];
      const stage = params[1];
      const found = this.events.find(e => e.run_id === runId && e.stage === stage && e.status === 'completed');
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }

    // SELECT stage, status FROM pipeline_events WHERE run_id = $1 ORDER BY id ASC (storage check)
    if (/SELECT stage, status FROM pipeline_events/i.test(q)) {
      const runId = params[0];
      const evts = this.events.filter(e => e.run_id === runId).map(e => ({ stage: e.stage, status: e.status }));
      return { rows: evts, rowCount: evts.length };
    }

    // SELECT stage, payload FROM pipeline_events WHERE run_id = $1 AND status = 'completed'
    if (/SELECT stage, payload FROM pipeline_events/i.test(q)) {
      const runId = params[0];
      const evts = this.events
        .filter(e => e.run_id === runId && e.status === 'completed' && e.payload != null)
        .map(e => ({ stage: e.stage, payload: e.payload }));
      return { rows: evts, rowCount: evts.length };
    }

    // SELECT id, run_id, stage, status, payload, error, created_at FROM pipeline_events WHERE run_id = $1 ORDER BY id ASC
    if (/SELECT id, run_id, stage, status, payload, error, created_at FROM pipeline_events/i.test(q)) {
      const runId = params[0];
      const evts = this.events.filter(e => e.run_id === runId);
      return { rows: evts, rowCount: evts.length };
    }

    // SELECT ... FROM pipeline_events WHERE run_id = $1 (generic fallback)
    if (/FROM pipeline_events WHERE run_id/i.test(q)) {
      const runId = params[0];
      const evts = this.events.filter(e => e.run_id === runId);
      return { rows: evts, rowCount: evts.length };
    }

    // ── api_keys ───────────────────────────────────────────────────────────

    if (/SELECT.*FROM api_keys WHERE key_hash\s*=\s*\$1/i.test(q)) {
      const keyHash = params[0];
      if (this.mockApiKey && keyHash === this.mockApiKey.keyHash) {
        return { rows: [{ id: this.mockApiKey.id, user_id: this.mockApiKey.userId, revoked_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (/UPDATE api_keys/i.test(q)) { return { rows: [], rowCount: 1 }; }
    if (/SELECT.*FROM api_keys/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── users ──────────────────────────────────────────────────────────────

    if (/INSERT INTO users/i.test(q)) { return { rows: [{ id: makeUUID() }], rowCount: 1 }; }
    if (/SELECT.*FROM users/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── sessions ──────────────────────────────────────────────────────────

    if (/FROM sessions/i.test(q)) { return { rows: [], rowCount: 0 }; }
    if (/INTO sessions/i.test(q)) { return { rows: [{ session_id: makeUUID() }], rowCount: 1 }; }
    if (/UPDATE sessions/i.test(q)) { return { rows: [], rowCount: 1 }; }

    // ── magic_links ────────────────────────────────────────────────────────

    if (/magic_links/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── security_events ────────────────────────────────────────────────────

    if (/security_events/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── pipeline_traces ────────────────────────────────────────────────────

    if (/pipeline_traces/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── constraint_* ──────────────────────────────────────────────────────

    if (/constraint_/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── deployments ────────────────────────────────────────────────────────

    if (/deployments/i.test(q)) { return { rows: [], rowCount: 0 }; }

    // ── Health check ───────────────────────────────────────────────────────

    if (/SELECT 1/i.test(q)) { return { rows: [{ '?column?': 1 }], rowCount: 1 }; }

    // ── JOIN queries (pipeline_runs + api_keys) ────────────────────────────

    if (/pipeline_runs.*JOIN.*api_keys/i.test(sql) || /api_keys.*pipeline_runs/i.test(q)) {
      const runId = params[0];
      const run = this.runs.get(runId);
      return { rows: run ? [{ id: run.id }] : [], rowCount: run ? 1 : 0 };
    }

    // ── Catch-all ──────────────────────────────────────────────────────────
    console.log(`[MockDB] Unhandled query: ${q.slice(0, 120)}`);
    return { rows: [], rowCount: 0 };
  }

  // Expose for inspection
  getQueryLog() { return this.queryLog; }
  getEvents(runId) { return this.events.filter(e => e.run_id === runId); }
  getRun(runId) { return this.runs.get(runId) || null; }
}

// ── Mock Pool ─────────────────────────────────────────────────────────────────

class MockPool extends EventEmitter {
  constructor(mockApiKey) {
    super();
    this.db = new MockDatabase(mockApiKey);
    this._ended = false;
  }

  async query(sql, params) {
    if (this._ended) throw new Error('MockPool: pool has ended');
    return this.db.query(sql, params);
  }

  async connect() {
    const db = this.db;
    return {
      query: async (sql, params) => db.query(sql, params),
      release: () => {},
    };
  }

  async end() { this._ended = true; }

  get _db() { return this.db; }
}

module.exports = { MockPool, MockDatabase };
