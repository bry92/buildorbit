/**
 * Phase Reasoning — live reasoning timeline for pipeline runs.
 *
 * Owns: write/read of phase_reasoning JSONB column on pipeline_runs.
 * Not owned: pipeline execution logic, agent dispatch, state machine transitions.
 *
 * Each phase appends one entry to the timeline as it starts executing.
 * The client polls GET /api/runs/:id/reasoning every 3s to see updates.
 *
 * Entry shape: { phase, summary, detail, ts }
 */

'use strict';

/**
 * Append a reasoning entry for a pipeline phase.
 * Fail-open: errors are logged but never thrown — reasoning must never block a phase.
 *
 * @param {import('pg').Pool} pool
 * @param {string} runId
 * @param {string} phase       - Pipeline stage name (e.g. 'plan', 'code')
 * @param {string} summary     - 1-liner for collapsed card view
 * @param {string} detail      - Full reasoning text for expanded view
 */
async function appendPhaseReasoning(pool, runId, phase, summary, detail) {
  const entry = {
    phase,
    summary,
    detail,
    ts: new Date().toISOString(),
  };

  try {
    await pool.query(
      `UPDATE pipeline_runs
       SET phase_reasoning = COALESCE(phase_reasoning, '[]'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify([entry]), runId]
    );
  } catch (err) {
    // Non-fatal: reasoning is observability, not pipeline logic.
    console.warn(`[PhaseReasoning] append failed for run ${runId?.slice(0, 8)} phase=${phase} (non-fatal):`, err.message);
  }
}

/**
 * Read the full reasoning timeline for a run.
 * Returns [] if run not found or column is null.
 *
 * @param {import('pg').Pool} pool
 * @param {string} runId
 * @returns {Promise<Array<{phase: string, summary: string, detail: string, ts: string}>>}
 */
async function getPhaseReasoning(pool, runId) {
  try {
    const { rows } = await pool.query(
      `SELECT phase_reasoning FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    if (!rows[0]) return [];
    return rows[0].phase_reasoning || [];
  } catch (err) {
    console.warn(`[PhaseReasoning] read failed for run ${runId?.slice(0, 8)} (non-fatal):`, err.message);
    return [];
  }
}

module.exports = { appendPhaseReasoning, getPhaseReasoning };
