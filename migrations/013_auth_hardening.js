module.exports = {
  name: 'auth_hardening',
  up: async (client) => {
    // ── magic_links: harden existing table ───────────────────────────────────

    // status column: 'pending' | 'used' | 'expired'
    await client.query(`
      ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    `);

    // Backfill status for already-consumed rows
    await client.query(`
      UPDATE magic_links SET status = 'used'
      WHERE used_at IS NOT NULL AND status = 'pending'
    `);
    await client.query(`
      UPDATE magic_links SET status = 'expired'
      WHERE used_at IS NULL AND expires_at < NOW() AND status = 'pending'
    `);

    // Soft context-binding columns (SHA-256 hashes, never raw values)
    await client.query(`
      ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS ip_hash TEXT
    `);
    await client.query(`
      ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS user_agent TEXT
    `);

    // Index on status for efficient expired-token cleanup queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS magic_links_status_idx ON magic_links (status)
    `);

    // ── sessions: server-side session registry ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id   TEXT UNIQUE NOT NULL,
        user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email        TEXT NOT NULL,
        ip_hash      TEXT,
        user_agent   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL,
        revoked_at   TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_session_id_idx ON sessions (session_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)
      WHERE revoked_at IS NULL
    `);

    // ── security_events: audit log for auth actions ───────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     INT REFERENCES users(id) ON DELETE SET NULL,
        event_type  TEXT NOT NULL,
        email       TEXT,
        ip_hash     TEXT,
        user_agent  TEXT,
        session_id  TEXT,
        metadata    JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS security_events_user_id_idx ON security_events (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS security_events_type_idx ON security_events (event_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at DESC)
    `);
  }
};
