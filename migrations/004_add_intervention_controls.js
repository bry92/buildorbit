module.exports = {
  name: 'add_intervention_controls',
  up: async (client) => {
    // Add run_config JSONB to pipeline_runs
    // Stores: modelConfig (per-agent model selection), constraints (budget, time, quality)
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS run_config JSONB DEFAULT '{}'::jsonb
    `);

    // Pipeline interventions log — append-only record of human steering actions
    // type: 'paused' | 'resumed' | 'instruction_injected' | 'agent_overridden'
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_interventions (
        id         SERIAL PRIMARY KEY,
        run_id     UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        type       VARCHAR(30) NOT NULL,
        payload    JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_interventions_run_id
        ON pipeline_interventions (run_id, created_at ASC)
    `);
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS pipeline_interventions');
    await client.query('ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS run_config');
  }
};
