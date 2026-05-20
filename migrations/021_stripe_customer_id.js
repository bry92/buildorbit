/**
 * Migration 021: Add stripe_customer_id to users
 *
 * Stores the Stripe customer ID so we can:
 * - Link webhook events to our user records
 * - Generate Customer Portal sessions for subscription management
 */
module.exports = {
  name: '021_stripe_customer_id',

  up: async (client) => {
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'stripe_customer_id'
    `);
    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255)
      `);
    }
    console.log('[021_stripe_customer_id] stripe_customer_id column added');
  },

  down: async (client) => {
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id`);
  }
};
