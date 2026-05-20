/**
 * Analytics Event Emitter
 *
 * Lightweight fire-and-forget event logging to `analytics_events`.
 * All writes are non-blocking and never throw — a failed write is
 * logged as a warning and dropped rather than crashing the caller.
 *
 * Event types:
 *   TASK_SUBMITTED      — user submitted a new task description
 *   PIPELINE_STARTED    — orchestrator classified intent and started stages
 *   PIPELINE_COMPLETED  — all stages passed (carries duration + check counts)
 *   PIPELINE_FAILED     — a stage failed (carries phase + error summary)
 *   SESSION_STARTED     — user hit the dashboard (deduplicated per session)
 */

/**
 * Emit an analytics event.
 *
 * Fire-and-forget: the returned Promise is intentionally not awaited by callers.
 * Any DB error is swallowed — analytics writes must never affect the critical path.
 *
 * @param {import('pg').Pool} pool
 * @param {string}            eventType  - One of the event types listed above
 * @param {number|null}       userId     - User ID (null for system/anonymous events)
 * @param {object}            [metadata] - Arbitrary JSON payload
 * @returns {Promise<void>}
 */
async function emitEvent(pool, eventType, userId, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO analytics_events (event_type, user_id, metadata)
       VALUES ($1, $2, $3)`,
      [eventType, userId || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    // Non-fatal — analytics writes must never crash the caller
    console.warn(`[Analytics] emitEvent(${eventType}) failed (non-fatal):`, err.message);
  }
}

module.exports = { emitEvent };
