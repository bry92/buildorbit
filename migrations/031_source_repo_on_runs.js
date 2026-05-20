module.exports = {
  name: 'source_repo_on_runs',
  up: async (client) => {
    // Source GitHub repo to build FROM (read existing code, improve/extend it).
    // Null when building from scratch (default mode).
    // Format: "owner/repo" (e.g. "acme/my-api").
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS source_repo TEXT
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS source_repo
    `);
  },
};
