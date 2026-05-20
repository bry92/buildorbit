module.exports = {
  name: 'catastrophic_rewrite_block',
  up: async (client) => {
    // Stores the destructive change analysis when the SAVE phase is blocked.
    // Null means no block occurred. Non-null payload allows the user to review
    // what would have been overwritten and confirm override via the API.
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS catastrophic_block JSONB
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS catastrophic_block
    `);
  },
};
