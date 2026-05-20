module.exports = {
  name: 'add_pipeline_traces',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_traces (
        id SERIAL PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        stage VARCHAR(30) NOT NULL,
        agent_name VARCHAR(50),
        step_type VARCHAR(30) NOT NULL DEFAULT 'stage_execution',
        prompt_sent TEXT,
        reasoning TEXT,
        action_taken TEXT,
        output_summary TEXT,
        output_payload JSONB,
        latency_ms INTEGER,
        token_cost JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_traces_run_id
        ON pipeline_traces (run_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_traces_run_stage
        ON pipeline_traces (run_id, stage)
    `);
  }
};
