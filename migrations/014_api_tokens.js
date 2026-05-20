/**
 * Migration 014: API Tokens for CLI / headless access
 *
 * Creates api_tokens table for Bearer token authentication.
 * These tokens (bo_live_ / bo_mock_ prefixed) are minted via POST /auth/api-token
 * and scoped to the same permissions as the user's session.
 *
 * Unlike api_keys (A2A, bk_ prefix), api_tokens:
 *   - have explicit expiry (default 30d, max 90d)
 *   - are designed for CLI and script access across all protected routes
 *   - enforce a max-10-active-tokens-per-user limit
 */
module.exports = {
  name: '014_api_tokens',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   VARCHAR(64) NOT NULL UNIQUE,
        label        VARCHAR(255),
        expires_at   TIMESTAMPTZ NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS api_tokens_token_hash_idx ON api_tokens (token_hash)
    `);

    // Partial index for active (non-revoked) token lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS api_tokens_active_idx
        ON api_tokens (user_id)
        WHERE revoked_at IS NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS api_tokens`);
  }
};
