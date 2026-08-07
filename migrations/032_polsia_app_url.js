module.exports = {
  name: 'polsia_app_url_on_runs',
  up: async (client) => {
    // Legacy live deploy URL column (renamed to deploy_url in migration 040).
    // Null for PRODUCT_SYSTEM builds (full-stack; deployed separately via GitHub PR).
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS polsia_app_url TEXT
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        DROP COLUMN IF EXISTS polsia_app_url
    `);
  },
};
