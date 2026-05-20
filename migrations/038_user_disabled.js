/**
 * Migration 038: Users — disabled flag
 *
 * Adds `disabled` boolean column to users table so admins can
 * suspend accounts from the /admin panel without deleting them.
 * Disabled users have all sessions revoked and cannot log in.
 */
module.exports = {
  name: '038_user_disabled',

  up: async (client) => {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false
    `);
    console.log('[038_user_disabled] disabled column added to users');
  },

  down: async (client) => {
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS disabled`);
  },
};
