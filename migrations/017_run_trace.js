/**
 * Migration 017: Run Trace — Causal DAG
 *
 * Adds:
 *   - trace_nodes table: one row per decision node in the causal DAG
 *   - pipeline_runs.non_explainable: boolean flag set when integrity check fails
 *
 * Node IDs are deterministic: {run_id_8chars}-{phase}-{decision_type}-{seq:03d}
 * This makes them stable across retries and queryable.
 */
module.exports = {
  name: 'run_trace',

  up: async (client) => {
    // 1. Add non_explainable flag to pipeline_runs
    await client.query(`
      ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS non_explainable BOOLEAN DEFAULT FALSE
    `);

    // 2. Create trace_nodes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS trace_nodes (
        trace_node_id     VARCHAR(120) PRIMARY KEY,
        parent_node_id    VARCHAR(120) REFERENCES trace_nodes(trace_node_id) ON DELETE SET NULL,
        run_id            UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        phase             VARCHAR(30)  NOT NULL,
        decision_type     VARCHAR(80)  NOT NULL,
        chosen            TEXT         NOT NULL,
        alternatives      JSONB        NOT NULL DEFAULT '[]',
        rejection_reasons JSONB        NOT NULL DEFAULT '[]',
        constraint_refs   JSONB        NOT NULL DEFAULT '[]',
        is_terminal       BOOLEAN      NOT NULL DEFAULT FALSE,
        timestamp         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trace_nodes_run_id
        ON trace_nodes (run_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trace_nodes_parent
        ON trace_nodes (parent_node_id)
        WHERE parent_node_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trace_nodes_run_phase
        ON trace_nodes (run_id, phase)
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS trace_nodes`);
    await client.query(`
      ALTER TABLE pipeline_runs
      DROP COLUMN IF EXISTS non_explainable
    `);
  },
};
