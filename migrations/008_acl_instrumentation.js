/**
 * Migration: ACL Instrumentation — Phase 1 (Observation Layer)
 *
 * Creates 4 tables for the Auto-Constraint Learning Loop (A.C.L.) engine.
 * This is Phase 1: pure observation. No learning logic, no weight updates.
 *
 * Tables:
 *   constraint_predictions     — What Intent Gate decided per run
 *   constraint_violations      — Where prediction didn't match reality
 *   constraint_feedback_weights — Future learning engine state (empty until Phase 2)
 *   constraint_decisions_log   — Full explainability trail per run
 *
 * Why pipeline_runs(id) as FK target:
 *   pipeline_runs is the primary run ledger in this codebase (migration 001).
 *   All runId values passed through the orchestrator reference pipeline_runs.id.
 */
module.exports = {
  name: 'acl_instrumentation',
  up: async (client) => {

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE 1: constraint_predictions
    // What Intent Gate classified and which constraints it predicted for each run.
    // One row per run (written immediately after classify() returns).
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS constraint_predictions (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id     UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        task_type  TEXT NOT NULL,
        predicted_constraints JSONB NOT NULL,
        confidence FLOAT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_predictions_run
        ON constraint_predictions (run_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_predictions_type
        ON constraint_predictions (task_type)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE 2: constraint_violations
    // Where the pipeline's enforcement layer caught a scope mismatch.
    // Written by QAAgent during VERIFY after checking generated artifacts.
    //
    // violation_type: over_scoped | under_scoped | wrong_classification
    // violated_layer: db | api | auth | server
    // severity: 0.0 (informational) → 1.0 (critical)
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS constraint_violations (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id         UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        violation_type TEXT NOT NULL,
        violated_layer TEXT NOT NULL,
        severity       FLOAT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_violations_run
        ON constraint_violations (run_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_violations_type
        ON constraint_violations (violation_type)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE 3: constraint_feedback_weights
    // Future learning engine state. Created now (schema-ready), populated in Phase 2.
    // Phase 2 will write per-task_type × constraint_key weights here after
    // accumulating sufficient violation data.
    //
    // Intentionally has 0 rows after this migration. Do not write to it until
    // Phase 2 ships.
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS constraint_feedback_weights (
        task_type      TEXT NOT NULL,
        constraint_key TEXT NOT NULL,
        weight         FLOAT NOT NULL DEFAULT 0.0,
        sample_count   INT NOT NULL DEFAULT 0,
        last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (task_type, constraint_key)
      )
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // TABLE 4: constraint_decisions_log
    // Full explainability trail — every classification decision, the input that
    // triggered it, and the final constraints applied.
    // adjustments_applied is NULL until ACL Phase 2 ships (weight-based corrections).
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS constraint_decisions_log (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id               UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        input_text           TEXT NOT NULL,
        classified_task_type TEXT NOT NULL,
        final_constraints    JSONB NOT NULL,
        adjustments_applied  JSONB,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_decisions_run
        ON constraint_decisions_log (run_id)
    `);

    console.log('[acl_instrumentation] 4 ACL tables created: constraint_predictions, constraint_violations, constraint_feedback_weights, constraint_decisions_log');
  },

  down: async (client) => {
    // Drop in reverse dependency order
    await client.query('DROP TABLE IF EXISTS constraint_decisions_log CASCADE');
    await client.query('DROP TABLE IF EXISTS constraint_feedback_weights CASCADE');
    await client.query('DROP TABLE IF EXISTS constraint_violations CASCADE');
    await client.query('DROP TABLE IF EXISTS constraint_predictions CASCADE');

    console.log('[acl_instrumentation] 4 ACL tables dropped');
  },
};
