/**
 * Migration 025: Users — is_admin flag
 *
 * Adds is_admin boolean column for admin bypass of credit enforcement.
 * Admin users can run unlimited pipeline builds without credit deduction.
 *
 * Bootstrap: if ADMIN_USER_IDS env var is set (comma-separated user IDs),
 * those users are automatically flagged as admin on startup.
 */
module.exports = {
  name: '025_admin_flag',

  up: async (client) => {
    // Add is_admin column — default false for all users
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'is_admin'
    `);
    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false
      `);
      console.log('[025_admin_flag] is_admin column added');
    }

    // Bootstrap: set is_admin = true for any user IDs in ADMIN_USER_IDS env var
    const adminIds = (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0);

    if (adminIds.length > 0) {
      await client.query(
        `UPDATE users SET is_admin = true WHERE id = ANY($1::int[])`,
        [adminIds]
      );
      console.log(`[025_admin_flag] Bootstrapped admin for user IDs: ${adminIds.join(', ')}`);
    }
  },

  down: async (client) => {
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS is_admin`);
  },
};
