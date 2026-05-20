module.exports = {
  name: 'retry_count',
  up: async (client) => {
    // Add retry_count to pipeline_runs so each retry attempt gets
    // a distinct idempotency key (`${runId}:${stage}:${status}:${attempt}`).
    // Without this, retries reuse the old event key, skip the INSERT,
    // and the state projection never updates — leaving the run stuck in 'failed'.
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS retry_count
    `);
  },
};
