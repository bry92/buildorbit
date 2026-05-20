/**
 * Migration 023: Add intent_class column to pipeline_runs
 *
 * Surfaces the Intent Gate classification as a top-level column so the
 * frontend can render intent-aware UI without parsing JSON blobs or
 * joining to constraint_predictions.
 *
 * Allowed values: STATIC_SURFACE | INTERACTIVE_LIGHT_APP | PRODUCT_SYSTEM
 * Nullable: older runs won't have it.
 *
 * Backfill: reads task_type from constraint_predictions (most recent
 * prediction per run) and normalises to canonical names.
 */
module.exports = {
  name: '023_intent_class',

  up: async (client) => {
    // 1. Add column (nullable — safe for existing rows)
    await client.query(`
      ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS intent_class TEXT
        CHECK (intent_class IN ('STATIC_SURFACE', 'INTERACTIVE_LIGHT_APP', 'PRODUCT_SYSTEM'))
    `);

    // 2. Index for history-page filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_intent_class
        ON pipeline_runs (intent_class)
    `);

    // 3. Backfill from constraint_predictions.task_type
    //    Most-recent prediction per run is used.
    //    Internal names → canonical names:
    //      static_surface  → STATIC_SURFACE
    //      light_app       → INTERACTIVE_LIGHT_APP
    //      soft_expansion  → INTERACTIVE_LIGHT_APP  (base class is light_app)
    //      full_product    → PRODUCT_SYSTEM
    await client.query(`
      UPDATE pipeline_runs pr
      SET intent_class = CASE cp.task_type
        WHEN 'static_surface' THEN 'STATIC_SURFACE'
        WHEN 'light_app'      THEN 'INTERACTIVE_LIGHT_APP'
        WHEN 'soft_expansion' THEN 'INTERACTIVE_LIGHT_APP'
        WHEN 'full_product'   THEN 'PRODUCT_SYSTEM'
        ELSE NULL
      END
      FROM (
        SELECT DISTINCT ON (run_id) run_id, task_type
        FROM constraint_predictions
        ORDER BY run_id, created_at DESC
      ) cp
      WHERE pr.id = cp.run_id
        AND pr.intent_class IS NULL
    `);

    console.log('[023_intent_class] intent_class column added and backfilled');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_pipeline_runs_intent_class`);
    await client.query(`ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS intent_class`);
  }
};
