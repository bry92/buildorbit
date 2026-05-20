/**
 * Migration 015: Password Authentication Fallback
 *
 * Adds password_hash column to users table for email+password login.
 * Column is nullable — existing users don't have passwords until they set one.
 * bcrypt hashes are always 60 characters (cost factor 12), but bcrypt truncates
 * input at 72 bytes, so we allow up to 255 chars client-side and hash validates.
 */
module.exports = {
  name: '015_add_password_hash',
  up: async (client) => {
    // Idempotent: only add the column if it doesn't already exist.
    // Uses a separate query first to check, since PostgreSQL < 11 doesn't
    // support IF NOT EXISTS on ADD COLUMN.
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL
      `);
    }
  },

  down: async (client) => {
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS password_hash`);
  }
};