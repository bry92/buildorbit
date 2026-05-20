/**
 * Migration 026: Governance Audit Fields
 *
 * Lays the schema foundation for BuildOrbit's auditable governance layer.
 * Two additive fields on existing tables — no application logic changes.
 *
 * Changes:
 *   1. pipeline_runs.execution_id  — UUID audit session identifier (NOT NULL, unique)
 *   2. pipeline_events.governance_phase — enum phase tag for governed events (NULLABLE)
 *
 * Backfill:
 *   - Existing pipeline_runs rows get a generated UUID for execution_id
 *   - Existing pipeline_events rows are left NULL (null = "pre-governance", intentional)
 *
 * Step 1 of 3 for the governance layer.
 * Step 2: autonomousStep() wrapper
 * Step 3: pipeline integration
 */
module.exports = {
  name: '026_governance_schema',

  up: async (client) => {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Add execution_id to pipeline_runs
    //    Unique audit session identifier. Compliance officers trace this.
    //    NOT NULL with DEFAULT so new rows auto-populate; existing rows backfilled below.
    // ─────────────────────────────────────────────────────────────────────────
    const { rows: hasExecId } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pipeline_runs' AND column_name = 'execution_id'
    `);
    if (hasExecId.length === 0) {
      // Add as nullable first so we can backfill before adding NOT NULL constraint
      await client.query(`
        ALTER TABLE pipeline_runs
          ADD COLUMN execution_id UUID DEFAULT gen_random_uuid()
      `);
      console.log('[026_governance_schema] execution_id column added to pipeline_runs');

      // Backfill existing rows — generate a UUID for every historical run
      await client.query(`
        UPDATE pipeline_runs
           SET execution_id = gen_random_uuid()
         WHERE execution_id IS NULL
      `);
      console.log('[026_governance_schema] execution_id backfilled on existing pipeline_runs rows');

      // Now enforce NOT NULL
      await client.query(`
        ALTER TABLE pipeline_runs
          ALTER COLUMN execution_id SET NOT NULL
      `);
      console.log('[026_governance_schema] execution_id NOT NULL constraint applied');
    }

    // Unique index — one execution_id per run, fast compliance lookups
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_execution_id
        ON pipeline_runs (execution_id)
    `);
    console.log('[026_governance_schema] unique index on pipeline_runs.execution_id created');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Create governance_phase_type enum
    //    REASONING  — intent classification and planning phase
    //    POLICY     — constraint enforcement gate
    //    EXECUTION  — active build / scaffold / code steps
    //    RESULT     — verification and output delivery
    // ─────────────────────────────────────────────────────────────────────────
    const { rows: hasEnum } = await client.query(`
      SELECT 1 FROM pg_type WHERE typname = 'governance_phase_type'
    `);
    if (hasEnum.length === 0) {
      await client.query(`
        CREATE TYPE governance_phase_type AS ENUM (
          'REASONING',
          'POLICY',
          'EXECUTION',
          'RESULT'
        )
      `);
      console.log('[026_governance_schema] governance_phase_type enum created');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Add governance_phase to pipeline_events
    //    NULLABLE — existing events remain NULL (pre-governance, accurate)
    //    New governed events will explicitly tag their phase.
    // ─────────────────────────────────────────────────────────────────────────
    const { rows: hasPhase } = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pipeline_events' AND column_name = 'governance_phase'
    `);
    if (hasPhase.length === 0) {
      await client.query(`
        ALTER TABLE pipeline_events
          ADD COLUMN governance_phase governance_phase_type
      `);
      console.log('[026_governance_schema] governance_phase column added to pipeline_events');
    }

    // Composite index — fast audit queries: "show me all POLICY events for run X"
    // Uses run_id (the actual FK column name from migration 002)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_run_governance_phase
        ON pipeline_events (run_id, governance_phase)
    `);
    console.log('[026_governance_schema] composite index on pipeline_events(run_id, governance_phase) created');

    console.log('[026_governance_schema] Governance schema migration complete.');
  },

  down: async (client) => {
    // Drop index on pipeline_events
    await client.query(`
      DROP INDEX IF EXISTS idx_pipeline_events_run_governance_phase
    `);

    // Drop governance_phase column
    await client.query(`
      ALTER TABLE pipeline_events DROP COLUMN IF EXISTS governance_phase
    `);

    // Drop enum type
    await client.query(`
      DROP TYPE IF EXISTS governance_phase_type
    `);

    // Drop execution_id index and column
    await client.query(`
      DROP INDEX IF EXISTS idx_pipeline_runs_execution_id
    `);
    await client.query(`
      ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS execution_id
    `);

    console.log('[026_governance_schema] Governance schema rolled back.');
  },
};
