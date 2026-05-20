module.exports = {
  name: 'create_pipeline_events',
  up: async (client) => {
    // Append-only event log — source of truth for pipeline state
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        id SERIAL PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        stage VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        payload JSONB,
        error TEXT,
        idempotency_key VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Fast lookups by run (state derivation)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_run_id
        ON pipeline_events (run_id, id ASC)
    `);

    // Idempotency guard
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_idempotency
        ON pipeline_events (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    // Add state column to pipeline_runs for fast reads (derived from events, but cached)
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS state VARCHAR(30) DEFAULT 'queued'
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_state
        ON pipeline_runs (state)
    `);
  }
};
