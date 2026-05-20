/**
 * Migration: Analytics Events
 *
 * Creates `analytics_events` — an append-only event log for product analytics.
 *
 * Events captured:
 *   TASK_SUBMITTED      — user submitted a task description
 *   PIPELINE_STARTED    — orchestrator picked up a run + classified intent
 *   PIPELINE_COMPLETED  — all stages passed (with pass/fail check counts + duration)
 *   PIPELINE_FAILED     — a stage failed (with phase + error type)
 *   SESSION_STARTED     — user hit the dashboard
 *
 * Also adds `user_id` to `pipeline_runs` so analytics can attribute runs
 * to the user who created them.
 */
module.exports = {
  name: 'analytics_events',

  up: async (client) => {
    // ── analytics_events ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id          BIGSERIAL PRIMARY KEY,
        event_type  VARCHAR(64)  NOT NULL,
        user_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
        metadata    JSONB        DEFAULT '{}',
        created_at  TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // Primary query pattern: "events of type X in the last N days"
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time
        ON analytics_events (event_type, created_at DESC)
    `);

    // Secondary query pattern: "events for user X"
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time
        ON analytics_events (user_id, created_at DESC)
        WHERE user_id IS NOT NULL
    `);

    // ── Add user_id to pipeline_runs (nullable — legacy rows have no user) ────
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user
        ON pipeline_runs (user_id, created_at DESC)
        WHERE user_id IS NOT NULL
    `);

    console.log('[analytics_events] Table created + user_id added to pipeline_runs');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_pipeline_runs_user`);
    await client.query(`ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS user_id`);
    await client.query(`DROP INDEX IF EXISTS idx_analytics_events_user_time`);
    await client.query(`DROP INDEX IF EXISTS idx_analytics_events_type_time`);
    await client.query(`DROP TABLE IF EXISTS analytics_events`);
  },
};
