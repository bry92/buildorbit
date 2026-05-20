module.exports = {
  name: 'github_pr_url',
  up: async (client) => {
    // PR URL written by the SAVE phase after a successful GitHub push.
    // Null when no GitHub push was performed or the push failed.
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS github_pr_url TEXT
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS github_pr_url
    `);
  },
};
