/**
 * Migration: Provider Health Events (Layer 5 — External Effect Verifier)
 *
 * Makes run_events.run_id nullable so infrastructure events (email provider
 * health checks, startup probes) can be recorded without a pipeline run context.
 *
 * Background:
 * - run_events was designed for pipeline audit: every stage action tied to a run
 * - Layer 5 adds external effect observation: Postmark degradation, startup config
 *   validation, etc. — these fire outside of any pipeline run
 * - Nullable run_id preserves the existing FK constraint (checked when NOT NULL)
 *   while enabling system-scoped events with run_id = NULL
 *
 * New event types (enforced by application, not DB constraint):
 *   EMAIL_PROVIDER_CHECKED     — startup config validation + pre-send check
 *   EMAIL_PROVIDER_ACCEPTED    — provider accepted the send (MessageID present)
 *   EMAIL_PROVIDER_REJECTED    — provider explicitly rejected (error code/message)
 *   EMAIL_PROVIDER_UNAVAILABLE — provider unreachable or timed out
 */
module.exports = {
  name: 'provider_health_events',

  up: async (client) => {
    // Make run_id nullable — existing rows are unaffected (all have valid UUIDs)
    // FK constraint remains: when run_id IS NOT NULL it must reference runs(id)
    await client.query(`
      ALTER TABLE run_events
        ALTER COLUMN run_id DROP NOT NULL
    `);

    // Index for system-event queries: WHERE run_id IS NULL AND event_type LIKE 'EMAIL_%'
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_run_events_system_events
        ON run_events (event_type, timestamp DESC)
        WHERE run_id IS NULL
    `);

    console.log('[provider_health_events] run_events.run_id is now nullable — Layer 5 system events enabled');
  },

  down: async (client) => {
    // Re-add NOT NULL — safe only if no rows have run_id = NULL
    // If system events exist, this will fail (correct — roll back removes the feature)
    await client.query(`
      DROP INDEX IF EXISTS idx_run_events_system_events
    `);

    await client.query(`
      ALTER TABLE run_events
        ALTER COLUMN run_id SET NOT NULL
    `);
  }
};
