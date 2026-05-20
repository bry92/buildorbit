/**
 * Migration 022: Add password_reset_tokens table
 *
 * Stores time-limited, single-use tokens for the forgot password flow.
 * Tokens expire after 30 minutes. Used_at set on consumption (single-use).
 *
 * Design: separate table from magic_links to keep concerns distinct.
 * Token column stores SHA-256 hash of the raw token (never store raw).
 */
module.exports = {
  name: '022_password_reset_tokens',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        email      VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
        ON password_reset_tokens (token_hash)
    `);

    console.log('[022_password_reset_tokens] password_reset_tokens table created');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS password_reset_tokens`);
  }
};
