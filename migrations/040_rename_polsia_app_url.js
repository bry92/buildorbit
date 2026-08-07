/**
 * Rename legacy polsia_app_url column → deploy_url.
 */
module.exports = {
  name: '040_rename_polsia_app_url',

  up: async (client) => {
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pipeline_runs'
         AND column_name = 'polsia_app_url'
    `);
    if (rows.length > 0) {
      await client.query(`
        ALTER TABLE pipeline_runs RENAME COLUMN polsia_app_url TO deploy_url
      `);
      console.log('[040] Renamed pipeline_runs.polsia_app_url → deploy_url');
    }
  },

  down: async (client) => {
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pipeline_runs'
         AND column_name = 'deploy_url'
    `);
    if (rows.length > 0) {
      await client.query(`
        ALTER TABLE pipeline_runs RENAME COLUMN deploy_url TO polsia_app_url
      `);
    }
  },
};
