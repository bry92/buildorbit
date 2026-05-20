/**
 * Migration 010: Phase 4 — Soft Expansion Budget
 *
 * Adds pre-commit entropy modeling to constraint_predictions:
 *   - entropy:    Shannon entropy (nats) at classification time
 *   - candidates: JSONB array of { intent_class, probability } sorted by probability
 *   - committed:  boolean — true = single committed class, false = soft expansion activated
 *
 * Also adds violation_type support for the new expansion violation types:
 *   - 'unnecessary_expansion' (severity 0.6) — expansion justified by PLAN but not used
 *   - 'expansion_scope_exceeded' (severity 0.9) — expansion used beyond stated scope
 *
 * No destructive changes to existing rows — all new columns have safe defaults.
 */

module.exports = {
  name: 'phase4_soft_expansion',

  up: async (client) => {
    // ── constraint_predictions: add entropy, candidates, committed ──────────────
    await client.query(`
      ALTER TABLE constraint_predictions
        ADD COLUMN IF NOT EXISTS entropy    FLOAT,
        ADD COLUMN IF NOT EXISTS candidates JSONB,
        ADD COLUMN IF NOT EXISTS committed  BOOLEAN NOT NULL DEFAULT true
    `);

    // Index: quickly query all soft-expansion runs (committed=false)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_predictions_committed
        ON constraint_predictions (committed)
        WHERE committed = false
    `);

    // Index: entropy range queries (Phase 3 CDK uses entropy as a signal)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_predictions_entropy
        ON constraint_predictions (entropy)
        WHERE entropy IS NOT NULL
    `);

    // ── constraint_violations: add expansion-specific violation types ────────────
    // The existing violation_type TEXT column already accepts any string value,
    // so no schema change is needed — just document the new values:
    //   'unnecessary_expansion'   (severity 0.6) — expansion present in plan but not in code
    //   'expansion_scope_exceeded' (severity 0.9) — expansion used beyond stated scope
    //
    // We add a partial index to quickly find expansion-specific violations.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_violations_expansion
        ON constraint_violations (violation_type)
        WHERE violation_type IN ('unnecessary_expansion', 'expansion_scope_exceeded')
    `);

    // ── run_events: ensure expansion event types are indexed ────────────────────
    // New event types logged by orchestrator:
    //   SOFT_EXPANSION_ACTIVATED  — entropy exceeded threshold, soft budget created
    //   EXPANSION_JUSTIFIED       — PLAN used a soft expansion with justification
    //   EXPANSION_UNNECESSARY     — VERIFY determined expansion wasn't needed
    //   EXPANSION_SCOPE_EXCEEDED  — VERIFY found expansion beyond stated scope
    //
    // The run_events table (from migration 007) already has an event_type TEXT column.
    // Add a partial index for expansion event lookups:
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_run_events_expansion
          ON run_events (run_id, event_type)
          WHERE event_type LIKE 'EXPANSION_%' OR event_type = 'SOFT_EXPANSION_ACTIVATED'
      `);
    } catch (e) {
      // run_events may not exist in all environments — non-fatal
      if (!e.message.includes('does not exist')) throw e;
      console.log('[010] run_events table not found — skipping expansion event index');
    }

    console.log('[010_phase4_soft_expansion] Migrations applied: entropy/candidates/committed on constraint_predictions, expansion violation indexes');
  },

  down: async (client) => {
    // Remove expansion indexes
    await client.query(`DROP INDEX IF EXISTS idx_run_events_expansion`);
    await client.query(`DROP INDEX IF EXISTS idx_constraint_violations_expansion`);
    await client.query(`DROP INDEX IF EXISTS idx_constraint_predictions_entropy`);
    await client.query(`DROP INDEX IF EXISTS idx_constraint_predictions_committed`);

    // Remove new columns from constraint_predictions
    await client.query(`
      ALTER TABLE constraint_predictions
        DROP COLUMN IF EXISTS committed,
        DROP COLUMN IF EXISTS candidates,
        DROP COLUMN IF EXISTS entropy
    `);

    console.log('[010_phase4_soft_expansion] Rolled back');
  },
};
