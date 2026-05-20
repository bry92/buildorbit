/**
 * Constraint Dynamics Kernel (CDK) — ACL Phase 3
 *
 * Runs AFTER Phase 2 learning and BEFORE weight persistence.
 * This is a GOVERNOR, not a learning engine — it controls Phase 2's output.
 *
 * Pipeline position:
 *   VERIFY → ACL Phase 2 (raw learning) → CDK Phase 3 (stability control)
 *           → UPDATE WEIGHTS → STORE DRIFT METRICS
 *
 * Responsibilities:
 *   1. Coupled Weight Updates  — propagate penalty to related constraints
 *   2. Envelope Clamping       — hard bounds per task_type × constraint_key
 *   3. Drift Detection         — flag constraints diverging from baseline
 *   4. Anti-Collapse Guard     — freeze constraints at extremes
 *
 * Safety contract:
 *   - CDK failure is NON-BLOCKING: callers must catch and fall back to raw
 *     Phase 2 weights if govern() throws.
 *   - Frozen constraints are permanent until manually unfrozen.
 *   - Envelope clamps are HARD BOUNDS — no soft violations allowed.
 *   - CDK never generates its own learning signal.
 *
 * @module lib/constraint-dynamics
 */

'use strict';

// ── Stability Envelopes ────────────────────────────────────────────────────
// Acceptable weight range [min, max] per (task_type, constraint_key).
// Weights outside this band are hard-clamped after every update.
const STABILITY_ENVELOPES = {
  static_surface: {
    db:       [-1.0, -0.2],
    server:   [-1.0, -0.1],
    api:      [-1.0, -0.2],
    auth:     [-1.0, -0.3],
    frontend: [-1.0,  1.0], // unconstrained — frontend is fine in static
  },
  light_app: {
    db:       [-0.5,  0.3],
    server:   [-0.3,  0.5],
    api:      [-0.3,  0.5],
    auth:     [-0.5,  0.2],
    frontend: [-1.0,  1.0],
  },
  full_product: {
    db:       [-0.2,  1.0],
    server:   [-0.1,  1.0],
    api:      [-0.2,  1.0],
    auth:     [-0.2,  1.0],
    frontend: [-1.0,  1.0],
  },
};

// Global fallback for unknown task_types or unlisted constraint_keys
const DEFAULT_ENVELOPE = [-1.0, 1.0];

// ── Stability Guard thresholds ─────────────────────────────────────────────
const FREEZE_ABS_WEIGHT_THRESHOLD = 0.8;
const FREEZE_SAMPLE_COUNT_THRESHOLD = 20;
const DRIFT_ALERT_THRESHOLD = 0.3; // |drift_score| > this → CDK_DRIFT_DETECTED

/**
 * Clamp v between min and max (inclusive).
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Get the stability envelope for a (taskType, constraintKey) pair.
 * Returns [min, max].
 * @returns {[number, number]}
 */
function getEnvelope(taskType, constraintKey) {
  const byType = STABILITY_ENVELOPES[taskType];
  if (!byType) return DEFAULT_ENVELOPE;
  const envelope = byType[constraintKey];
  return envelope || DEFAULT_ENVELOPE;
}

/**
 * Load the coupling matrix for a set of constraint keys.
 * Returns a nested map: { constraint_a: { constraint_b: { strength, relation_type } } }
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} constraintKeys - Keys to query couplings for
 * @returns {Promise<Object>}
 */
async function loadCouplings(pool, constraintKeys) {
  if (!constraintKeys || constraintKeys.length === 0) return {};
  const { rows } = await pool.query(
    `SELECT constraint_a, constraint_b, coupling_strength, relation_type
       FROM constraint_couplings
      WHERE constraint_a = ANY($1::text[])`,
    [constraintKeys]
  );
  const matrix = {};
  for (const row of rows) {
    if (!matrix[row.constraint_a]) matrix[row.constraint_a] = {};
    matrix[row.constraint_a][row.constraint_b] = {
      strength:     parseFloat(row.coupling_strength),
      relationType: row.relation_type,
    };
  }
  return matrix;
}

/**
 * Fetch current weight + sample_count for a (task_type, constraint_key) pair.
 * Returns { weight: 0.0, sampleCount: 0, frozen: false } if no row exists.
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @param {string} constraintKey
 * @returns {Promise<{ weight: number, sampleCount: number, frozen: boolean }>}
 */
async function getWeightRow(pool, taskType, constraintKey) {
  const { rows } = await pool.query(
    `SELECT weight, sample_count, frozen
       FROM constraint_feedback_weights
      WHERE task_type = $1 AND constraint_key = $2`,
    [taskType, constraintKey]
  );
  if (!rows[0]) return { weight: 0.0, sampleCount: 0, frozen: false };
  return {
    weight:      parseFloat(rows[0].weight),
    sampleCount: parseInt(rows[0].sample_count, 10),
    frozen:      Boolean(rows[0].frozen),
  };
}

/**
 * Compute Shannon entropy for a given task_type's weight distribution.
 *
 * entropy = -Σ p(c) × log2(p(c))
 * where p(c) = abs(weight_c) / Σ abs(weight_c) across all constraints for taskType.
 *
 * Ranges:
 *   0   — all weight mass in one constraint (collapsed / fully biased)
 *   log2(N) — perfectly uniform spread (max diversity)
 *
 * If all weights are 0.0, entropy returns null (undefined / maximum latent).
 *
 * @param {Array<{ constraint_key: string, weight: number }>} weights
 * @returns {number|null}
 */
function computeEntropy(weights) {
  const absWeights = weights.map(w => Math.abs(w.weight));
  const total = absWeights.reduce((s, v) => s + v, 0);
  if (total === 0) return null; // all weights neutral — entropy undefined

  const probs = absWeights.map(v => v / total);
  const entropy = -probs.reduce((sum, p) => {
    if (p === 0) return sum;
    return sum + p * Math.log2(p);
  }, 0);

  return parseFloat(entropy.toFixed(6));
}

/**
 * The CDK governor.
 *
 * Takes raw Phase 2 weight updates (array of {task_type, constraint_key,
 * old_weight, new_weight, delta, severity, sample_count}) and applies:
 *   1. Cross-constraint coupling propagation
 *   2. Stability envelope clamping (hard bounds)
 *   3. Drift detection
 *   4. Anti-collapse freeze guard
 *
 * Returns governed updates (ready for DB persistence) plus observability
 * metadata for CDK run events.
 *
 * If this function throws, callers MUST catch and fall back to raw Phase 2
 * weights (CDK failure is non-blocking by contract).
 *
 * @param {Array<{
 *   task_type:      string,
 *   constraint_key: string,
 *   old_weight:     number,
 *   new_weight:     number,
 *   delta:          number,
 *   severity:       number,
 *   sample_count:   number
 * }>} rawUpdates - Raw updates from Phase 2 (constraint-learner.js)
 *
 * @param {string} taskType - Intent Gate task_type for this run
 *
 * @param {import('pg').Pool} pool
 *
 * @param {Function} [emitFn] - (payload) => void — emits CDK run events
 *
 * @returns {Promise<{
 *   governedUpdates:    Array<{ constraint_key: string, weight: number, should_freeze: boolean }>,
 *   couplingAdjustments: Object,
 *   frozenConstraints:  string[],
 *   clampedConstraints: string[],
 *   driftScores:        Object,
 *   entropy:            number|null
 * }>}
 */
async function govern(rawUpdates, taskType, pool, emitFn = null) {
  if (!rawUpdates || rawUpdates.length === 0) {
    return {
      governedUpdates:     [],
      couplingAdjustments: {},
      frozenConstraints:   [],
      clampedConstraints:  [],
      driftScores:         {},
      entropy:             null,
    };
  }

  // ── 1. Accumulate updates: primary deltas + coupling propagation ──────────
  // Map of constraint_key → raw delta to apply (negative = tighten weight)
  const deltaMap = {}; // { constraint_key: number }

  // Load coupling matrix for all updated primary constraints
  const primaryKeys = rawUpdates.map(u => u.constraint_key);
  const couplings = await loadCouplings(pool, primaryKeys);

  // Primary deltas (from Phase 2)
  for (const update of rawUpdates) {
    const key = update.constraint_key;
    const rawDelta = update.old_weight - update.new_weight; // positive = weight decreased
    deltaMap[key] = (deltaMap[key] || 0) + rawDelta;
  }

  // Coupled deltas: propagate primary penalty to related constraints
  const couplingAdjustments = {};

  for (const update of rawUpdates) {
    const primaryKey = update.constraint_key;
    const rawDelta = update.old_weight - update.new_weight; // positive = weight decreased
    const coupled = couplings[primaryKey] || {};

    for (const [coupledKey, { strength }] of Object.entries(coupled)) {
      if (coupledKey === primaryKey) continue; // no self-coupling
      const coupledDelta = rawDelta * strength; // can be negative (conflicts) → loosening
      deltaMap[coupledKey] = (deltaMap[coupledKey] || 0) + coupledDelta;

      if (!couplingAdjustments[coupledKey]) {
        couplingAdjustments[coupledKey] = { reasons: [] };
      }
      couplingAdjustments[coupledKey].reasons.push({
        from_constraint: primaryKey,
        coupling_strength: strength,
        applied_delta: parseFloat(coupledDelta.toFixed(6)),
      });
    }
  }

  // ── 2. Fetch current weights for all affected constraints ─────────────────
  const allKeys = Object.keys(deltaMap);
  const currentRows = {}; // { constraint_key: { weight, sampleCount, frozen } }

  for (const key of allKeys) {
    currentRows[key] = await getWeightRow(pool, taskType, key);
  }

  // ── 3. Compute new weights: old − delta, then clamp to envelope ───────────
  const governedUpdates = [];
  const clampedConstraints = [];
  const frozenThisRun = [];

  for (const key of allKeys) {
    const { weight: oldWeight, sampleCount, frozen } = currentRows[key];
    const delta = deltaMap[key] || 0;

    // Apply delta (positive delta = weight goes down)
    const rawNewWeight = oldWeight - delta;

    // Envelope clamping (hard bound)
    const [envMin, envMax] = getEnvelope(taskType, key);
    const clampedWeight = clamp(rawNewWeight, envMin, envMax);

    const wasClamped = Math.abs(clampedWeight - rawNewWeight) > 1e-9;
    if (wasClamped) {
      clampedConstraints.push(key);
    }

    // Update coupling adjustment records with before/after
    if (couplingAdjustments[key] && !primaryKeys.includes(key)) {
      couplingAdjustments[key].from = parseFloat(oldWeight.toFixed(6));
      couplingAdjustments[key].to   = parseFloat(clampedWeight.toFixed(6));
      couplingAdjustments[key].reason = couplingAdjustments[key].reasons
        .map(r => `${r.from_constraint} coupling (${r.coupling_strength})`)
        .join(', ');
    }

    // Freeze check: |weight| > 0.8 AND sample_count > 20
    const effectiveSampleCount = sampleCount + (primaryKeys.includes(key) ? 1 : 0);
    const shouldFreeze = (
      !frozen &&
      Math.abs(clampedWeight) > FREEZE_ABS_WEIGHT_THRESHOLD &&
      effectiveSampleCount > FREEZE_SAMPLE_COUNT_THRESHOLD
    );

    if (shouldFreeze) {
      frozenThisRun.push(key);
      console.log(
        `[CDK] FREEZE: ${taskType}.${key} weight=${clampedWeight.toFixed(4)}, ` +
        `sample_count=${effectiveSampleCount} — locking weight permanently`
      );
    }

    // Skip if already frozen (Phase 2 shouldn't have updated this, but guard anyway)
    if (frozen) {
      console.log(`[CDK] ${taskType}.${key} is frozen — CDK skipping update`);
      continue;
    }

    governedUpdates.push({
      constraint_key: key,
      weight:         parseFloat(clampedWeight.toFixed(6)),
      old_weight:     parseFloat(oldWeight.toFixed(6)),
      should_freeze:  shouldFreeze,
      was_clamped:    wasClamped,
    });
  }

  // ── 4. Drift detection ────────────────────────────────────────────────────
  // drift_score = current_weight - historical_baseline (0.0)
  // Since weight starts at 0 and drifts based on violations, current weight IS drift.
  const driftScores = {};

  for (const update of governedUpdates) {
    driftScores[update.constraint_key] = parseFloat(update.weight.toFixed(6));
  }

  // Also include unfrozen existing weights for entropy calculation
  const allExistingWeights = await pool.query(
    `SELECT constraint_key, weight
       FROM constraint_feedback_weights
      WHERE task_type = $1 AND frozen = false`,
    [taskType]
  );

  // Merge governed updates into weight map for entropy
  const weightMap = {};
  for (const row of allExistingWeights.rows) {
    weightMap[row.constraint_key] = parseFloat(row.weight);
  }
  for (const gu of governedUpdates) {
    weightMap[gu.constraint_key] = gu.weight;
  }

  const weightArray = Object.entries(weightMap).map(([k, w]) => ({
    constraint_key: k,
    weight: w,
  }));

  const entropy = computeEntropy(weightArray);

  // ── 5. Emit CDK events ────────────────────────────────────────────────────
  const emit = (type, payload) => {
    if (typeof emitFn !== 'function') return;
    try {
      emitFn({ run_event: type, ...payload });
    } catch (e) {
      console.warn(`[CDK] emitFn error for ${type} (non-fatal):`, e.message);
    }
  };

  // CDK_WEIGHTS_GOVERNED — always emitted after processing
  const governedPayload = {
    task_type:           taskType,
    drift_scores:        driftScores,
    entropy,
    frozen_constraints:  frozenThisRun,
    clamped_constraints: clampedConstraints,
    coupling_adjustments: Object.fromEntries(
      Object.entries(couplingAdjustments)
        .filter(([key]) => !primaryKeys.includes(key))
        .map(([key, data]) => [key, {
          from:   data.from,
          to:     data.to,
          reason: data.reason,
        }])
    ),
  };
  emit('CDK_WEIGHTS_GOVERNED', { payload: governedPayload });
  console.log(
    `[CDK] CDK_WEIGHTS_GOVERNED: task_type=${taskType}, ` +
    `governed=${governedUpdates.length}, clamped=${clampedConstraints.length}, ` +
    `frozen=${frozenThisRun.length}, entropy=${entropy}`
  );

  // CDK_DRIFT_DETECTED — if any drift_score exceeds threshold
  const highDriftConstraints = Object.entries(driftScores)
    .filter(([, score]) => Math.abs(score) > DRIFT_ALERT_THRESHOLD)
    .map(([key]) => key);

  if (highDriftConstraints.length > 0) {
    emit('CDK_DRIFT_DETECTED', {
      payload: {
        task_type:    taskType,
        drift_scores: driftScores,
        flagged:      highDriftConstraints,
        threshold:    DRIFT_ALERT_THRESHOLD,
      },
    });
    console.warn(
      `[CDK] CDK_DRIFT_DETECTED: ${highDriftConstraints.join(', ')} ` +
      `exceed drift threshold ${DRIFT_ALERT_THRESHOLD} for task_type=${taskType}`
    );
  }

  // CDK_CONSTRAINT_FROZEN — if any new constraints froze this run
  for (const frozenKey of frozenThisRun) {
    emit('CDK_CONSTRAINT_FROZEN', {
      payload: {
        task_type:      taskType,
        constraint_key: frozenKey,
        weight:         driftScores[frozenKey],
        reason:         `|weight| > ${FREEZE_ABS_WEIGHT_THRESHOLD} with sample_count > ${FREEZE_SAMPLE_COUNT_THRESHOLD}`,
      },
    });
    console.warn(
      `[CDK] CDK_CONSTRAINT_FROZEN: ${taskType}.${frozenKey} frozen at weight=${driftScores[frozenKey]}`
    );
  }

  // Clean up coupling adjustments to the final export format
  const exportedCouplingAdjustments = {};
  for (const [key, data] of Object.entries(couplingAdjustments)) {
    if (primaryKeys.includes(key)) continue; // skip primary keys
    exportedCouplingAdjustments[key] = {
      from:   data.from,
      to:     data.to,
      reason: data.reason,
    };
  }

  return {
    governedUpdates,
    couplingAdjustments:  exportedCouplingAdjustments,
    frozenConstraints:    frozenThisRun,
    clampedConstraints,
    driftScores,
    entropy,
  };
}

/**
 * Check whether a constraint is frozen in the database.
 * Used by constraint-learner.js before attempting a weight update.
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @param {string} constraintKey
 * @returns {Promise<boolean>}
 */
async function isFrozen(pool, taskType, constraintKey) {
  if (!pool) return false;
  try {
    const { rows } = await pool.query(
      `SELECT frozen
         FROM constraint_feedback_weights
        WHERE task_type = $1 AND constraint_key = $2`,
      [taskType, constraintKey]
    );
    return rows[0] ? Boolean(rows[0].frozen) : false;
  } catch (err) {
    console.warn(`[CDK] isFrozen check failed (non-fatal):`, err.message);
    return false;
  }
}

/**
 * Persist the CDK-governed weight updates to the database.
 * Handles: weight UPSERT + frozen flag update.
 *
 * Called by constraint-learner.js INSTEAD of its own upsertWeight calls
 * when CDK governance succeeds.
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @param {Array<{ constraint_key: string, weight: number, should_freeze: boolean }>} governedUpdates
 * @returns {Promise<void>}
 */
async function persistGovernedWeights(pool, taskType, governedUpdates) {
  for (const update of governedUpdates) {
    await pool.query(
      `INSERT INTO constraint_feedback_weights
              (task_type, constraint_key, weight, sample_count, last_updated, frozen)
           VALUES ($1, $2, $3, 1, NOW(), $4)
       ON CONFLICT (task_type, constraint_key) DO UPDATE
         SET weight       = $3,
             sample_count = constraint_feedback_weights.sample_count + 1,
             last_updated = NOW(),
             frozen       = CASE
                              WHEN $4 = true THEN true
                              ELSE constraint_feedback_weights.frozen
                            END`,
      [taskType, update.constraint_key, update.weight, update.should_freeze]
    );
  }
}

module.exports = {
  govern,
  isFrozen,
  persistGovernedWeights,
  computeEntropy,
  getEnvelope,
  STABILITY_ENVELOPES,
  FREEZE_ABS_WEIGHT_THRESHOLD,
  FREEZE_SAMPLE_COUNT_THRESHOLD,
  DRIFT_ALERT_THRESHOLD,
};
