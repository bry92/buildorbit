/**
 * Analytics Routes
 *
 * Endpoint:
 *   GET /api/analytics/summary
 *     Returns last 7 days of aggregated product analytics.
 *     Auth: session required (any authenticated user).
 *
 * Response shape:
 *   {
 *     period: { days: 7, from: ISO, to: ISO },
 *     totals: {
 *       runs_started:    number,
 *       runs_completed:  number,
 *       runs_failed:     number,
 *       tasks_submitted: number,
 *       sessions:        number,
 *       active_users:    number,
 *     },
 *     completion_rate:   number (0–1),
 *     avg_duration_ms:   number | null,
 *     by_intent_class:   { [intent_class]: number },
 *     daily: [
 *       { date: "YYYY-MM-DD", started: number, completed: number, failed: number }
 *     ]
 *   }
 */

const express = require('express');

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {object}            opts.auth  — auth module (requireAuth)
 */
function createAnalyticsRouter({ pool, auth }) {
  const router = express.Router();

  // ── GET /api/analytics/summary ────────────────────────────────────────────

  router.get('/summary', auth.requireAuth, async (req, res) => {
    try {
      const now    = new Date();
      const from   = new Date(now);
      from.setDate(from.getDate() - 7);

      const fromIso = from.toISOString();
      const toIso   = now.toISOString();

      // ── Aggregate event counts by type ─────────────────────────────────────
      const countsResult = await pool.query(
        `SELECT event_type, COUNT(*)::int AS count
         FROM analytics_events
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY event_type`,
        [fromIso, toIso]
      );

      const counts = {};
      for (const row of countsResult.rows) {
        counts[row.event_type] = row.count;
      }

      const runsStarted   = counts['PIPELINE_STARTED']   || 0;
      const runsCompleted = counts['PIPELINE_COMPLETED']  || 0;
      const runsFailed    = counts['PIPELINE_FAILED']     || 0;
      const tasksSubmit   = counts['TASK_SUBMITTED']      || 0;
      const sessions      = counts['SESSION_STARTED']     || 0;

      // ── Active users (distinct user_ids in window) ─────────────────────────
      const activeUsersResult = await pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS active_users
         FROM analytics_events
         WHERE created_at >= $1 AND created_at <= $2
           AND user_id IS NOT NULL`,
        [fromIso, toIso]
      );
      const activeUsers = activeUsersResult.rows[0]?.active_users || 0;

      // ── Avg duration from PIPELINE_COMPLETED metadata ──────────────────────
      const durationResult = await pool.query(
        `SELECT AVG((metadata->>'duration_ms')::bigint)::bigint AS avg_duration_ms
         FROM analytics_events
         WHERE event_type = 'PIPELINE_COMPLETED'
           AND created_at >= $1 AND created_at <= $2
           AND metadata->>'duration_ms' IS NOT NULL`,
        [fromIso, toIso]
      );
      const avgDurationMs = durationResult.rows[0]?.avg_duration_ms || null;

      // ── Runs by intent_class ────────────────────────────────────────────────
      const intentResult = await pool.query(
        `SELECT metadata->>'intent_class' AS intent_class, COUNT(*)::int AS count
         FROM analytics_events
         WHERE event_type = 'PIPELINE_STARTED'
           AND created_at >= $1 AND created_at <= $2
           AND metadata->>'intent_class' IS NOT NULL
         GROUP BY metadata->>'intent_class'`,
        [fromIso, toIso]
      );

      const byIntentClass = {};
      for (const row of intentResult.rows) {
        byIntentClass[row.intent_class] = row.count;
      }

      // ── Daily breakdown (last 7 days) ──────────────────────────────────────
      const dailyResult = await pool.query(
        `SELECT
           DATE(created_at AT TIME ZONE 'UTC') AS day,
           event_type,
           COUNT(*)::int AS count
         FROM analytics_events
         WHERE event_type IN ('PIPELINE_STARTED', 'PIPELINE_COMPLETED', 'PIPELINE_FAILED')
           AND created_at >= $1 AND created_at <= $2
         GROUP BY day, event_type
         ORDER BY day`,
        [fromIso, toIso]
      );

      // Build day map
      const dayMap = {};
      for (const row of dailyResult.rows) {
        const d = row.day.toISOString().slice(0, 10);
        if (!dayMap[d]) dayMap[d] = { date: d, started: 0, completed: 0, failed: 0 };
        if (row.event_type === 'PIPELINE_STARTED')   dayMap[d].started   = row.count;
        if (row.event_type === 'PIPELINE_COMPLETED') dayMap[d].completed = row.count;
        if (row.event_type === 'PIPELINE_FAILED')    dayMap[d].failed    = row.count;
      }

      // Fill in any missing days in the 7-day window with zeros
      const daily = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        daily.push(dayMap[key] || { date: key, started: 0, completed: 0, failed: 0 });
      }

      const completionRate = runsStarted > 0
        ? Math.round((runsCompleted / runsStarted) * 100) / 100
        : null;

      res.json({
        success: true,
        period: { days: 7, from: fromIso, to: toIso },
        totals: {
          runs_started:    runsStarted,
          runs_completed:  runsCompleted,
          runs_failed:     runsFailed,
          tasks_submitted: tasksSubmit,
          sessions,
          active_users:    activeUsers,
        },
        completion_rate:  completionRate,
        avg_duration_ms:  avgDurationMs ? Number(avgDurationMs) : null,
        by_intent_class:  byIntentClass,
        daily,
      });
    } catch (err) {
      console.error('[Analytics] Summary query failed:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch analytics summary' });
    }
  });

  return router;
}

module.exports = { createAnalyticsRouter };
