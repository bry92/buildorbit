/**
 * Pipeline State Machine
 *
 * States: queued → intent_gate_running → intent_gate_complete
 *         → plan_running → plan_complete → scaffold_running → scaffold_complete
 *         → code_running → code_complete → save_running → save_complete
 *         → verify_running → verify_complete → completed
 *
 * Any *_running state can also → failed
 * Any *_complete state can also → paused (human intervention)
 * paused → next stage *_running (on resume)
 * failed → {stage}_running (retry)
 *
 * Source of truth: pipeline_events table (append-only event log)
 * pipeline_runs.state is a cached projection, updated on every transition.
 *
 * NOTE: After pipeline completes (verify_complete → completed), a 7th DEPLOY phase
 * may run asynchronously for STATIC_SURFACE builds. Deploy progress is tracked via
 * SSE events (deploy_started, deploy_uploading, deploy_complete, deploy_failed) but
 * is NOT a formal state machine stage — it runs post-completion and does not affect
 * pipeline_runs.status.
 */

const EventEmitter = require('events');

const STAGES = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];

// Valid state transitions
const TRANSITIONS = {
  'queued':                 ['intent_gate_running'],
  'intent_gate_running':    ['intent_gate_complete', 'failed'],
  'intent_gate_complete':   ['plan_running', 'paused'],
  'plan_running':           ['plan_complete', 'failed'],
  'plan_complete':          ['scaffold_running', 'paused'],
  'scaffold_running':       ['scaffold_complete', 'failed'],
  'scaffold_complete':      ['code_running', 'paused'],
  'code_running':           ['code_complete', 'failed'],
  'code_complete':          ['save_running', 'paused'],
  'save_running':           ['save_complete', 'failed'],
  'save_complete':          ['verify_running', 'paused'],
  'verify_running':         ['verify_complete', 'failed'],
  'verify_complete':        ['completed'],
  'completed':              [],
  'failed':                 STAGES.map(s => `${s}_running`), // retry from any stage
  // paused can resume into any stage (orchestrator sets the right next stage)
  'paused':                 STAGES.map(s => `${s}_running`),
};

class PipelineStateMachine extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.setMaxListeners(100); // multiple SSE connections
  }

  /**
   * Get the current state of a pipeline run.
   * Reads from cached state column (fast path).
   */
  async getState(runId) {
    const { rows } = await this.pool.query(
      'SELECT state FROM pipeline_runs WHERE id = $1',
      [runId]
    );
    if (!rows[0]) return null;
    return rows[0].state || 'queued';
  }

  /**
   * Derive state from event log (slow path, used for verification/recovery).
   */
  async deriveState(runId) {
    const { rows } = await this.pool.query(
      `SELECT stage, status FROM pipeline_events
       WHERE run_id = $1
       ORDER BY id DESC LIMIT 1`,
      [runId]
    );
    if (!rows[0]) return 'queued';
    const { stage, status } = rows[0];
    if (status === 'failed') return 'failed';
    if (status === 'started') return `${stage}_running`;
    if (status === 'completed') {
      // Check if this was the final stage
      if (stage === 'verify') return 'verify_complete';
      return `${stage}_complete`;
    }
    return 'queued';
  }

  /**
   * Get the full event log for a pipeline run.
   */
  async getEvents(runId) {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, stage, status, payload, error, created_at
       FROM pipeline_events
       WHERE run_id = $1
       ORDER BY id ASC`,
      [runId]
    );
    return rows;
  }

  /**
   * Attempt a state transition. Returns the new state or throws.
   *
   * @param {string} runId - Pipeline run UUID
   * @param {string} stage - Stage name (plan, scaffold, code, save, verify)
   * @param {string} status - Event status (started, completed, failed)
   * @param {object} [payload] - Optional JSON payload (stage output, etc.)
   * @param {string} [error] - Error message if status is 'failed'
   * @returns {object} The created event
   */
  async transition(runId, stage, status, payload = null, error = null) {
    // Validate stage
    if (!STAGES.includes(stage)) {
      throw new Error(`Invalid stage: ${stage}`);
    }

    // Validate status
    if (!['started', 'completed', 'failed'].includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    // Compute target state
    let targetState;
    if (status === 'failed') {
      targetState = 'failed';
    } else if (status === 'started') {
      targetState = `${stage}_running`;
    } else if (status === 'completed') {
      targetState = `${stage}_complete`;
    }

    // Insert event + update cached state atomically.
    // State read is INSIDE the transaction with FOR UPDATE to prevent
    // TOCTOU races (previously read outside the txn).
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row and read current state + retry_count atomically
      const { rows: runRows } = await client.query(
        'SELECT state, COALESCE(retry_count, 0) AS retry_count FROM pipeline_runs WHERE id = $1 FOR UPDATE',
        [runId]
      );
      if (runRows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Pipeline run not found: ${runId}`);
      }

      const currentState = runRows[0].state || 'queued';
      const retryCount = runRows[0].retry_count;

      const allowed = TRANSITIONS[currentState] || [];
      if (!allowed.includes(targetState)) {
        await client.query('ROLLBACK');
        throw new Error(
          `Invalid transition: ${currentState} → ${targetState} ` +
          `(allowed: ${allowed.join(', ') || 'none'})`
        );
      }

      // Build idempotency key — includes retry_count so each retry attempt
      // gets a distinct key. Without this, retries collide with the original
      // event and the ON CONFLICT DO NOTHING path skips the state update,
      // leaving the run stuck in 'failed'.
      const idempotencyKey = `${runId}:${stage}:${status}:${retryCount}`;

      // Insert event (idempotency_key prevents duplicates within same attempt)
      const { rows } = await client.query(
        `INSERT INTO pipeline_events (run_id, stage, status, payload, error, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [runId, stage, status, payload ? JSON.stringify(payload) : null, error, idempotencyKey]
      );

      // If we got no rows, this event was already recorded (idempotent)
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        // Return existing event
        const existing = await this.pool.query(
          'SELECT * FROM pipeline_events WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        return existing.rows[0];
      }

      // Update cached state on pipeline_runs
      const updateFields = { state: targetState };
      if (status === 'failed') {
        updateFields.status = 'failed';
        updateFields.error = error;
      } else {
        updateFields.status = 'running';
        updateFields.current_phase = stage;
      }

      const keys = Object.keys(updateFields);
      const values = Object.values(updateFields);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
      await client.query(
        `UPDATE pipeline_runs SET ${sets} WHERE id = $1`,
        [runId, ...values]
      );

      await client.query('COMMIT');

      const event = rows[0];

      // Emit event for SSE subscribers
      this.emit(`run:${runId}`, event);

      return event;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a stage has already been completed for a run.
   * Used for idempotent retries.
   */
  async isStageCompleted(runId, stage) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM pipeline_events
       WHERE run_id = $1 AND stage = $2 AND status = 'completed'
       LIMIT 1`,
      [runId, stage]
    );
    return rows.length > 0;
  }

  /**
   * Get the next stage to execute.
   * Returns null if pipeline is complete or failed.
   */
  async getNextStage(runId) {
    const state = await this.getState(runId);

    if (state === 'queued') return 'intent_gate';
    if (state === 'completed' || state === 'failed') return null;

    // Find which stage just completed
    for (let i = 0; i < STAGES.length; i++) {
      if (state === `${STAGES[i]}_complete` && i + 1 < STAGES.length) {
        return STAGES[i + 1];
      }
    }

    return null; // In a running state or terminal
  }

  /**
   * Transition a run to the 'paused' state.
   * Called after a stage completes when a pause has been requested.
   *
   * @param {string} runId
   * @param {string} afterStage - The stage that just completed before pause
   */
  async pauseRun(runId, afterStage) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE pipeline_runs SET state = 'paused', status = 'paused' WHERE id = $1`,
        [runId]
      );
    } finally {
      client.release();
    }

    this.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'paused',
      payload: JSON.stringify({ after_stage: afterStage }),
      created_at: new Date().toISOString()
    });
  }

  /**
   * Resume a paused run — restores state to {afterStage}_complete so the
   * orchestrator loop can continue naturally to the next stage.
   *
   * @param {string} runId
   * @param {string} afterStage - The stage that had completed before the pause
   */
  async resumeRun(runId, afterStage) {
    const restoreState = afterStage === 'verify' ? 'verify_complete' : `${afterStage}_complete`;
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE pipeline_runs SET state = $1, status = 'running' WHERE id = $2`,
        [restoreState, runId]
      );
    } finally {
      client.release();
    }

    this.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'resumed',
      payload: JSON.stringify({ after_stage: afterStage }),
      created_at: new Date().toISOString()
    });
  }
}

module.exports = { PipelineStateMachine, STAGES, TRANSITIONS };
