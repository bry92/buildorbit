module.exports = {
  name: 'github_repo_on_runs',
  up: async (client) => {
    // Selected GitHub repo for a build run.
    // Null when no GitHub push was requested.
    // Format: "owner/repo" (e.g. "bry92/my-app").
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS github_repo TEXT
    `);
    // Whether to create the repo if it doesn't exist.
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS github_create_repo BOOLEAN NOT NULL DEFAULT FALSE
    `);
    // Visibility for newly created repos.
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS github_repo_private BOOLEAN NOT NULL DEFAULT FALSE
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS github_repo,
        DROP COLUMN IF EXISTS github_create_repo,
        DROP COLUMN IF EXISTS github_repo_private
    `);
  },
};
