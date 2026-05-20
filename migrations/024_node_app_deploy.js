/**
 * Migration 024: Add node_app_dir column to pipeline_deployments
 *
 * Stores the filesystem path to the deployed Node.js app directory for
 * PRODUCT_SYSTEM builds. Used by the deploy engine and NodeAppRunner to
 * recover running processes after server restarts (Render ephemeral filesystem
 * survives crash restarts but not code deploys).
 *
 * Also adds an index on deploy_type for efficient PRODUCT_SYSTEM lookups.
 */
module.exports = {
  name: '024_node_app_deploy',

  up: async (client) => {
    // App directory path — null for static deploys, set for nodejs deploys
    await client.query(`
      ALTER TABLE pipeline_deployments
        ADD COLUMN IF NOT EXISTS node_app_dir TEXT
    `);

    // Index for PRODUCT_SYSTEM recovery queries (fetch active nodejs deploys)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_deploy_type
        ON pipeline_deployments (deploy_type)
        WHERE is_active = true AND status = 'deployed'
    `);

    console.log('[024_node_app_deploy] node_app_dir column added to pipeline_deployments');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_pipeline_deployments_deploy_type`);
    await client.query(`ALTER TABLE pipeline_deployments DROP COLUMN IF EXISTS node_app_dir`);
  },
};
