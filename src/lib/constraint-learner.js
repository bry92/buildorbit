/**
 * Constraint Learner — ACL Phase 2 (+ CDK Phase 3 Integration)
 *
 * Reads VERIFY-stage violations accumulated in `constraint_violations` for a
 * completed run and updates per-class bias weights in
 * `constraint_feedback_weights`.
 *
 * This is NOT machine learning. It is a control-theory bias-update loop:
 *
 *   INTENT GATE → PLAN → SCAFFOLD → CODE → VERIFY
 *     → ACL Phase 2 (raw weight computation)
 *     → CDK Phase 3 (stability control: coupling + envelope + drift + freeze)
 *     → PERSIST GOVERNED WEIGHTS
 *     → (next run's INTENT GATE reads updated weights)
 *
 * Weight update rule (stable, bounded):
 *   weight_new = clamp(weight_old - (LEARNING_RATE × clamp(severity, 0, 1)), -1, 1)
 *
 * CDK Phase 3 intercepts BEFORE persistence and:
 *   - Propagates penalty to coupled constraints (coupling matrix)
 *   - Hard-clamps weights to stability envelopes per task_type
 *   - Detects drift (weight diverging from 0.0 baseline)
 *   - Freezes constraints at extremes (|w| > 0.8 with sample_count > 20)
 *
 * ONE-DIRECTIONAL learning only:
 *   over_scoped  → weight goes negative → constraints tighten next run ✔
 *   under_scoped → logged but ignored  — loosening is Phase 4 territory ✔
 *
 * Threshold: -0.5  (≈10 consistent violations before classify() changes output)
 *
 * CDK failure is NON-BLOCKING: if govern() throws, raw Phase 2 weights persist.
 *
 * Frozen constraints (frozen = true in DB) are SKIPPED — no weight update.
 *
 * Usage (called by pipeline-orchestrator after VERIFY, non-blocking):
 *   await constraintLearner.learn(runId, taskType, pool, emitFn);
 *
 * @module lib/constraint-learner
 */

'use strict';

const CDK = require('./constraint-dynamics');

const LEARNING_RATE = 0.05;

/**
 * Clamp a value between min and max (inclusive).
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Fetch the current weight for a (task_type, constraint_key) pair.
 * Returns { weight: 0.0, sampleCount: 0, frozen: false } if no row exists.
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @param {string} constraintKey
 * @returns {Promise<{ weight: number, sampleCount: number, frozen: boolean }>}
 */
async function getWeight(pool, taskType, constraintKey) {
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
 * UPSERT a weight row, incrementing sample_count.
 * Preserves frozen=true if already set (never auto-unfreezes).
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @param {string} constraintKey
 * @param {number} newWeight
 * @returns {Promise<void>}
 */
async function upsertWeight(pool, taskType, constraintKey, newWeight) {
  await pool.query(
    `INSERT INTO constraint_feedback_weights
            (task_type, constraint_key, weight, sample_count, last_updated, frozen)
         VALUES ($1, $2, $3, 1, NOW(), false)
     ON CONFLICT (task_type, constraint_key) DO UPDATE
       SET weight       = $3,
           sample_count = constraint_feedback_weights.sample_count + 1,
           last_updated = NOW()
           -- frozen is intentionally NOT updated here (CDK controls freeze via persistGovernedWeights)`,
    [taskType, constraintKey, newWeight]
  );
}

/**
 * Main learning step. Called once per completed run, after VERIFY.
 *
 * Algorithm:
 *   1. Query constraint_violations for this run_id
 *   2. If no violations → skip (nothing to learn)
 *   3. For each over_scoped violation:
 *        - Check frozen flag — if true, SKIP this constraint (CDK Phase 3)
 *        - Read current weight (default 0.0)
 *        - Compute raw new weight via Phase 2 update rule
 *        - Accumulate in rawUpdates (DO NOT persist yet)
 *   4. Under_scoped violations → logged but not acted on (Phase 4)
 *   5. CDK Phase 3 governance (if pool available):
 *        - govern() applies coupling + envelope + drift detection + freeze guard
 *        - persistGovernedWeights() writes CDK-governed weights to DB
 *        - Emits CDK_WEIGHTS_GOVERNED, CDK_DRIFT_DETECTED, CDK_CONSTRAINT_FROZEN
 *   6. Fallback: if CDK throws, persist raw Phase 2 weights (degraded but functional)
 *   7. Update constraint_decisions_log.adjustments_applied for this run
 *
 * @param {string}   runId    - Pipeline run UUID
 * @param {string}   taskType - Intent Gate task type (static_surface, light_app, full_product)
 * @param {import('pg').Pool} pool
 * @param {Function} [emitFn] - Optional: (payload) => void — emits run events
 * @returns {Promise<{ skipped: boolean, updates: Array<object>, cdkApplied: boolean }>}
 */
async function learn(runId, taskType, pool, emitFn = null) {
  if (!pool) {
    console.warn('[ConstraintLearner] No pool provided — skipping learning step');
    return { skipped: true, updates: [], cdkApplied: false };
  }
  if (!runId || !taskType) {
    console.warn('[ConstraintLearner] Missing runId or taskType — skipping');
    return { skipped: true, updates: [], cdkApplied: false };
  }

  // ── Step 1: Query violations for this run ──────────────────────────────────
  const { rows: violations } = await pool.query(
    `SELECT violation_type, violated_layer, severity
       FROM constraint_violations
      WHERE run_id = $1`,
    [runId]
  );

  if (violations.length === 0) {
    console.log(`[ConstraintLearner] Run ${runId.slice(0, 8)}: no violations — skipping`);
    return { skipped: true, updates: [], cdkApplied: false };
  }

  console.log(`[ConstraintLearner] Run ${runId.slice(0, 8)}: ${violations.length} violation(s) found for task_type=${taskType}`);

  // ── Step 2: Separate over_scoped (actionable) from under_scoped (Phase 4) ─
  const overScoped = violations.filter(v => v.violation_type === 'over_scoped');
  const underScoped = violations.filter(v => v.violation_type !== 'over_scoped');

  if (underScoped.length > 0) {
    console.log(`[ConstraintLearner] ${underScoped.length} under_scoped violation(s) — logged, not acted on (Phase 4)`);
  }

  if (overScoped.length === 0) {
    console.log(`[ConstraintLearner] Run ${runId.slice(0, 8)}: no over_scoped violations — skipping weight updates`);
    return { skipped: true, updates: [], cdkApplied: false };
  }

  // ── Step 3: Compute raw Phase 2 updates (no DB writes yet) ────────────────
  const rawUpdates = [];
  let skippedFrozen = 0;

  for (const violation of overScoped) {
    const constraintKey = violation.violated_layer;
    const severity = clamp(parseFloat(violation.severity) || 0, 0, 1);

    try {
      const { weight: oldWeight, sampleCount, frozen } = await getWeight(pool, taskType, constraintKey);

      // CDK Phase 3: skip frozen constraints entirely
      if (frozen) {
        console.log(
          `[ConstraintLearner] ${taskType}.${constraintKey} is FROZEN — skipping weight update`
        );
        skippedFrozen++;
        continue;
      }

      // Phase 2 raw update rule (unchanged from original)
      const newWeight = clamp(oldWeight - (LEARNING_RATE * severity), -1, 1);
      const delta = newWeight - oldWeight;

      rawUpdates.push({
        task_type:      taskType,
        constraint_key: constraintKey,
        old_weight:     oldWeight,
        new_weight:     newWeight,
        delta:          parseFloat(delta.toFixed(6)),
        learning_rate:  LEARNING_RATE,
        severity,
        sample_count:   sampleCount + 1,
      });

      console.log(
        `[ConstraintLearner] Phase 2 raw: ${taskType}.${constraintKey}: ` +
        `weight ${oldWeight.toFixed(4)} → ${newWeight.toFixed(4)} ` +
        `(Δ=${delta.toFixed(4)}, severity=${severity}, n=${sampleCount + 1}) [pending CDK]`
      );

    } catch (readErr) {
      console.warn(
        `[ConstraintLearner] Weight read failed for (${taskType}, ${constraintKey}) — non-fatal:`,
        readErr.message
      );
    }
  }

  if (rawUpdates.length === 0 && skippedFrozen === 0) {
    return { skipped: true, updates: [], cdkApplied: false };
  }

  if (rawUpdates.length === 0) {
    console.log(`[ConstraintLearner] All updates skipped (frozen: ${skippedFrozen}) — nothing to persist`);
    return { skipped: true, updates: [], cdkApplied: false };
  }

  // ── Step 4: CDK Phase 3 governance ────────────────────────────────────────
  // CDK governs: coupling propagation → envelope clamping → drift detection → freeze
  // If CDK throws → fall back to raw Phase 2 weights (degraded but functional)
  let cdkApplied = false;
  let finalUpdates = rawUpdates; // Start with raw; CDK may override

  // Build CDK emitFn that wraps our existing emitFn
  const cdkEmitFn = (payload) => {
    if (typeof emitFn !== 'function') return;
    emitFn(payload);
  };

  try {
    const cdkResult = await CDK.govern(rawUpdates, taskType, pool, cdkEmitFn);

    if (cdkResult.governedUpdates.length > 0) {
      // Persist CDK-governed weights (includes coupling adjustments + clamping + freeze flags)
      await CDK.persistGovernedWeights(pool, taskType, cdkResult.governedUpdates);

      // Build final updates list from CDK output for logging/decisions_log
      finalUpdates = cdkResult.governedUpdates.map(gu => {
        const rawUpdate = rawUpdates.find(r => r.constraint_key === gu.constraint_key) || {};
        return {
          task_type:      taskType,
          constraint_key: gu.constraint_key,
          old_weight:     gu.old_weight,
          new_weight:     gu.weight,
          delta:          parseFloat((gu.weight - gu.old_weight).toFixed(6)),
          learning_rate:  LEARNING_RATE,
          severity:       rawUpdate.severity || null,
          sample_count:   rawUpdate.sample_count || 1,
          cdk_clamped:    gu.was_clamped || false,
          cdk_frozen:     gu.should_freeze || false,
        };
      });

      cdkApplied = true;

      console.log(
        `[ConstraintLearner] CDK governed: ${cdkResult.governedUpdates.length} weight(s) persisted ` +
        `(clamped=${cdkResult.clampedConstraints.length}, ` +
        `frozen=${cdkResult.frozenConstraints.length}, ` +
        `coupling_adjustments=${Object.keys(cdkResult.couplingAdjustments).length}) ` +
        `entropy=${cdkResult.entropy}`
      );
    } else {
      console.log(`[ConstraintLearner] CDK returned 0 governed updates — fallback to raw Phase 2`);
    }

  } catch (cdkErr) {
    // CDK failure is NON-BLOCKING — fall back to raw Phase 2 weights
    console.warn('[ConstraintLearner] CDK govern() failed — falling back to raw Phase 2 weights:', cdkErr.message);

    for (const update of rawUpdates) {
      try {
        await upsertWeight(pool, taskType, update.constraint_key, update.new_weight);
      } catch (upsertErr) {
        console.warn(
          `[ConstraintLearner] Fallback upsert failed for (${taskType}, ${update.constraint_key}):`,
          upsertErr.message
        );
      }
    }

    // Emit legacy CONSTRAINT_WEIGHTS_UPDATED events on fallback path
    for (const update of rawUpdates) {
      if (typeof emitFn === 'function') {
        try {
          emitFn({
            run_event:      'CONSTRAINT_WEIGHTS_UPDATED',
            task_type:      update.task_type,
            constraint_key: update.constraint_key,
            old_weight:     update.old_weight,
            new_weight:     update.new_weight,
            delta:          update.delta,
            learning_rate:  LEARNING_RATE,
            cdk_applied:    false,
          });
        } catch (emitErr) {
          console.warn('[ConstraintLearner] emitFn error (non-fatal):', emitErr.message);
        }
      }
    }
  }

  // ── Step 5: Update constraint_decisions_log for this run ──────────────────
  if (finalUpdates.length > 0) {
    try {
      const adjustments = {
        weight_adjustments: finalUpdates.reduce((acc, u) => {
          acc[u.constraint_key] = {
            old_weight:   u.old_weight,
            new_weight:   u.new_weight,
            delta:        u.delta,
            sample_count: u.sample_count,
            cdk_clamped:  u.cdk_clamped || false,
            cdk_frozen:   u.cdk_frozen  || false,
          };
          return acc;
        }, {}),
        weights_consulted:    false, // This run's classify() ran before learning
        sample_counts:        finalUpdates.reduce((acc, u) => {
          acc[u.constraint_key] = u.sample_count;
          return acc;
        }, {}),
        learning_rate:        LEARNING_RATE,
        over_scoped_count:    overScoped.length,
        under_scoped_count:   underScoped.length,
        skipped_frozen_count: skippedFrozen,
        cdk_applied:          cdkApplied,
        learned_at:           new Date().toISOString(),
      };

      await pool.query(
        `UPDATE constraint_decisions_log
            SET adjustments_applied = $2
          WHERE run_id = $1`,
        [runId, JSON.stringify(adjustments)]
      );

      console.log(
        `[ConstraintLearner] Run ${runId.slice(0, 8)}: ` +
        `${finalUpdates.length} weight update(s) committed (cdk_applied=${cdkApplied}), decisions_log updated`
      );
    } catch (logErr) {
      console.warn('[ConstraintLearner] decisions_log update failed (non-fatal):', logErr.message);
    }
  }

  return { skipped: false, updates: finalUpdates, cdkApplied };
}

/**
 * Query all weights for a given task_type.
 * Used by Intent Gate's classify() to apply bias shaping.
 * Returns only non-frozen weights (frozen weights retain their value but
 * should still influence the Intent Gate — they represent stable learned state).
 *
 * @param {import('pg').Pool} pool
 * @param {string} taskType
 * @returns {Promise<Array<{ constraint_key: string, weight: number, sample_count: number, frozen: boolean }>>}
 */
async function getWeightsForTaskType(pool, taskType) {
  if (!pool || !taskType) return [];
  try {
    const { rows } = await pool.query(
      `SELECT constraint_key, weight, sample_count, frozen
         FROM constraint_feedback_weights
        WHERE task_type = $1`,
      [taskType]
    );
    return rows.map(r => ({
      constraint_key: r.constraint_key,
      weight:         parseFloat(r.weight),
      sample_count:   parseInt(r.sample_count, 10),
      frozen:         Boolean(r.frozen),
    }));
  } catch (err) {
    console.warn('[ConstraintLearner] getWeightsForTaskType error (non-fatal):', err.message);
    return [];
  }
}

module.exports = { learn, getWeightsForTaskType, LEARNING_RATE };
