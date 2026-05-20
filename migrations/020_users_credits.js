/**
 * Migration 020: Users — task_credits + subscription_status default
 *
 * Adds task_credits column (5 free credits for new trial users).
 * Sets DEFAULT 'trial' on subscription_status so new registrations
 * automatically start with trial status without explicit INSERT.
 *
 * Both changes are idempotent (IF NOT EXISTS / conditional ALTER).
 */
module.exports = {
  name: '020_users_credits',

  up: async (client) => {
    // Add task_credits column — default 5 for new users
    const { rows: creditsCol } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'task_credits'
    `);
    if (creditsCol.length === 0) {
      await client.query(`
        ALTER TABLE users ADD COLUMN task_credits INTEGER NOT NULL DEFAULT 5
      `);
    }

    // Set DEFAULT 'trial' on subscription_status so every new INSERT
    // that omits subscription_status automatically gets 'trial'.
    // Uses ALTER COLUMN ... SET DEFAULT — safe on existing rows.
    await client.query(`
      ALTER TABLE users
        ALTER COLUMN subscription_status SET DEFAULT 'trial'
    `);

    // Backfill existing users that have NULL subscription_status
    await client.query(`
      UPDATE users
         SET subscription_status = 'trial'
       WHERE subscription_status IS NULL
    `);

    console.log('[020_users_credits] task_credits added, subscription_status defaulted to trial');
  },

  down: async (client) => {
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS task_credits`);
    await client.query(`ALTER TABLE users ALTER COLUMN subscription_status DROP DEFAULT`);
  }
};
