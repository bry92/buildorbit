/**
 * Migration: Soft Delete for Pipeline Runs
 *
 * Adds `deleted_at` to `pipeline_runs` so users can remove runs from the
 * dashboard without destroying execution history. Deleted runs are filtered
 * from the run list but their artifacts, events, and trace data remain intact.
 *
 * Run data in `runs` and `run_events` tables is untouched — this is purely
 * a soft-visibility flag on the pipeline_runs listing.
 */
module.exports = {
  name: 'soft_delete_runs',

  up: async (client) => {
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL
    `);

    // Partial index — only non-deleted rows need fast ordering/filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_active
        ON pipeline_runs (created_at DESC)
        WHERE deleted_at IS NULL
    `);

    console.log('[soft_delete_runs] pipeline_runs.deleted_at added — soft delete enabled');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_pipeline_runs_active`);
    await client.query(`ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS deleted_at`);
  }
};
