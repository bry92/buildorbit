/**
 * Migration: CDK Phase 3 — Constraint Dynamics Kernel
 *
 * Adds:
 *   1. constraint_couplings      — Coupling matrix between constraints
 *   2. frozen column             — On constraint_feedback_weights (stability guard)
 *
 * constraint_couplings tracks how penalizing one constraint should
 * propagate to related constraints.  Seeded with 5 known structural
 * relationships; future versions can update from observed co-occurrence.
 *
 * frozen = true on a constraint_feedback_weights row means Phase 2
 * learning MUST skip it — the weight is locked until manual intervention.
 */
module.exports = {
  name: 'cdk_phase3',
  up: async (client) => {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. constraint_couplings — Coupling Matrix
    //
    // coupling_strength: -1.0 to 1.0
    //   > 0  (reinforces) → penalizing A also penalizes B
    //   < 0  (conflicts)  → penalizing A slightly boosts B
    //   = 0  (neutral)    → independent
    //
    // relation_type: reinforces | conflicts | neutral
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS constraint_couplings (
        constraint_a      TEXT NOT NULL,
        constraint_b      TEXT NOT NULL,
        coupling_strength FLOAT NOT NULL DEFAULT 0.0,
        relation_type     TEXT NOT NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (constraint_a, constraint_b)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_couplings_a
        ON constraint_couplings (constraint_a)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_couplings_b
        ON constraint_couplings (constraint_b)
    `);

    // ── Seed: known structural relationships (bidirectional pairs) ───────────
    const seedCouplings = [
      // db ↔ api
      ['db',       'api',      0.7,  'reinforces'],
      ['api',      'db',       0.7,  'reinforces'],
      // frontend ↔ server
      ['frontend', 'server',  -0.3,  'conflicts'],
      ['server',   'frontend', -0.3,  'conflicts'],
      // auth ↔ db
      ['auth',     'db',       0.8,  'reinforces'],
      ['db',       'auth',     0.8,  'reinforces'],
      // api ↔ server
      ['api',      'server',   0.6,  'reinforces'],
      ['server',   'api',      0.6,  'reinforces'],
      // auth ↔ api
      ['auth',     'api',      0.5,  'reinforces'],
      ['api',      'auth',     0.5,  'reinforces'],
    ];

    for (const [a, b, strength, relType] of seedCouplings) {
      await client.query(
        `INSERT INTO constraint_couplings (constraint_a, constraint_b, coupling_strength, relation_type)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (constraint_a, constraint_b) DO NOTHING`,
        [a, b, strength, relType]
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Add frozen column to constraint_feedback_weights
    //
    // When frozen = true, the Phase 2 learning engine MUST skip this row.
    // Weight is permanently locked until manually set back to false.
    // ─────────────────────────────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE constraint_feedback_weights
        ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT false
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_constraint_feedback_weights_frozen
        ON constraint_feedback_weights (frozen)
        WHERE frozen = true
    `);

    console.log('[cdk_phase3] constraint_couplings table created + seeded (10 rows), frozen column added to constraint_feedback_weights');
  },

  down: async (client) => {
    // Remove frozen index + column
    await client.query(`
      DROP INDEX IF EXISTS idx_constraint_feedback_weights_frozen
    `);
    await client.query(`
      ALTER TABLE constraint_feedback_weights
        DROP COLUMN IF EXISTS frozen
    `);

    // Drop coupling table
    await client.query('DROP TABLE IF EXISTS constraint_couplings CASCADE');

    console.log('[cdk_phase3] constraint_couplings dropped, frozen column removed from constraint_feedback_weights');
  },
};
