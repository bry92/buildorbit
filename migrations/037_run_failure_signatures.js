/**
 * Migration 037: run_failure_signatures
 *
 * Stores structured failure patterns extracted from pipeline runs.
 * Enables Orbit to detect recurring failures, compare runs, and propose fixes
 * based on historical data. Each row is one failure root-cause record per run.
 */
module.exports = {
  name: '037_run_failure_signatures',

  up: async (client) => {
    await client.query(`
      CREATE TABLE run_failure_signatures (
        id SERIAL PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        failure_phase VARCHAR(30) NOT NULL,
        error_type VARCHAR(80) NOT NULL,
        signature_key VARCHAR(200) NOT NULL,
        root_cause TEXT,
        proposed_fix TEXT,
        context JSONB DEFAULT '{}',
        resolution TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX run_failure_signatures_run_id ON run_failure_signatures(run_id)`);
    await client.query(`CREATE INDEX run_failure_signatures_user_id ON run_failure_signatures(user_id)`);
    await client.query(`CREATE INDEX run_failure_signatures_signature_key ON run_failure_signatures(signature_key)`);
    await client.query(`CREATE INDEX run_failure_signatures_user_sig ON run_failure_signatures(user_id, signature_key)`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS run_failure_signatures`);
  },
};