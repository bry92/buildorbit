module.exports = {
  name: 'polsia_app_url_on_runs',
  up: async (client) => {
    // Live CDN URL for static/interactive builds deployed to Polsia R2.
    // Set during SAVE phase after successful polsia-deploy upload.
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
