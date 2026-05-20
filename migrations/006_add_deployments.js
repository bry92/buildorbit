module.exports = {
  name: 'add_deployments',
  up: async (client) => {
    // Deployments table: tracks every deploy attempt per run + version history
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_deployments (
        id SERIAL PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        slug VARCHAR(100),
        url TEXT,
        deploy_type VARCHAR(20) DEFAULT 'static',
        file_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deployed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_run_id
        ON pipeline_deployments (run_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_slug
        ON pipeline_deployments (slug)
    `);

    // Add deployment column to pipeline_runs for quick access
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS deployment JSONB
    `);
  }
};
