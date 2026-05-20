/**
 * Migration 036: Phase Reasoning Timeline
 *
 * Adds a phase_reasoning JSONB column to pipeline_runs.
 * Stores the live reasoning timeline — an ordered array of entries,
 * one per phase, capturing the agent's decision text as phases execute.
 *
 * Shape: [{ phase, summary, detail, ts }]
 *   phase   — pipeline stage name (intent_gate, plan, scaffold, code, save, verify)
 *   summary — 1-liner shown in collapsed card state
 *   detail  — full reasoning text shown in expanded state
 *   ts      — ISO timestamp when this entry was written
 *
 * Written by lib/phase-reasoning.js via appendPhaseReasoning().
 * Read by GET /api/runs/:id/reasoning (polling, 3s interval from client).
 */

'use strict';

module.exports = {
  name: 'phase_reasoning',
  up: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS phase_reasoning JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
      DROP COLUMN IF EXISTS phase_reasoning
    `);
  },
};
