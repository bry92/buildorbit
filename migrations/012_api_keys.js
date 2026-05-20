/**
 * Migration 012: API Keys for A2A (Agent-to-Agent) access
 *
 * Creates api_keys table for Bearer token authentication.
 * Also adds source + api_key_id tracking to pipeline_runs.
 */
module.exports = {
  name: '012_api_keys',
  up: async (client) => {
    // API keys table — stores hashed keys linked to user accounts
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        key_hash VARCHAR(64) NOT NULL UNIQUE,
        key_prefix VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT 'Default',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id)
    `);

    // Track how a pipeline run was triggered (web vs A2A) and which key was used
    await client.query(`
      ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'web'
    `);

    await client.query(`
      ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL
    `);
  }
};
