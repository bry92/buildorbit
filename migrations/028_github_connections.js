module.exports = {
  name: 'github_connections',
  up: async (client) => {
    // GitHub OAuth connections per user.
    // Stores the encrypted access token, GitHub user info, and scope.
    // One row per user — upserted on reconnect.
    await client.query(`
      CREATE TABLE IF NOT EXISTS github_connections (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        github_user_id    BIGINT NOT NULL,
        github_login      TEXT NOT NULL,
        github_name       TEXT,
        github_avatar_url TEXT,
        -- AES-256-GCM encrypted access token. Format: iv:tag:ciphertext (hex-encoded).
        access_token_enc  TEXT NOT NULL,
        token_scope       TEXT,
        connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS github_connections_user_id_idx
        ON github_connections(user_id)
    `);
  },
  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS github_connections`);
  },
};
