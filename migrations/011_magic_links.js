module.exports = {
  name: 'add_magic_links',
  up: async (client) => {
    // Add last_login_at to existing users table (idempotent)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
    `);

    // Create magic_links table
    await client.query(`
      CREATE TABLE IF NOT EXISTS magic_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links (token)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links (expires_at)
    `);
  }
};
