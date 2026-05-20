module.exports = {
  name: 'create_pipeline_runs',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prompt TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        current_phase VARCHAR(20),
        plan JSONB,
        scaffold JSONB,
        code JSONB,
        output JSONB,
        verification JSONB,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
        ON pipeline_runs (status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created
        ON pipeline_runs (created_at DESC)
    `);
  }
};
