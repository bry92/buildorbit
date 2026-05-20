/**
 * backend/src/email/provider-events.js
 *
 * Layer 5: External Effect Verifier — Email Boundary Health Events
 *
 * Converts email proxy probe results and send outcomes into replayable audit events
 * in run_events. This is the first Layer 5 implementation in the A2A runtime.
 *
 * Layer 5 sits between the application and the external provider. It observes:
 *   - Startup config validity (POLSIA_API_KEY present)
 *   - Pre-send readiness (config still valid at send time)
 *   - Provider acceptance (send succeeded)
 *   - Provider rejection (explicit error code/message from proxy)
 *   - Provider unavailability (network failure, timeout, unexpected response)
 *
 * Events go to run_events with run_id = NULL for system/infrastructure events
 * (requires migration 016 which makes run_id nullable).
 *
 * Design rule: this module MUST NOT throw. Observability cannot crash the auth path.
 */

'use strict';

// ── Event type constants ─────────────────────────────────────────────────────

/**
 * Provider health event types for run_events.event_type.
 *
 * Four values cover the complete lifecycle of an external email effect:
 *   CHECKED     — config validation, before any send attempt
 *   ACCEPTED    — provider accepted the send (external ack)
 *   REJECTED    — provider refused the request (explicit error)
 *   UNAVAILABLE — provider unreachable / timed out / unexpected response
 */
const PROVIDER_EVENT_TYPES = {
  EMAIL_PROVIDER_CHECKED:     'EMAIL_PROVIDER_CHECKED',
  EMAIL_PROVIDER_ACCEPTED:    'EMAIL_PROVIDER_ACCEPTED',
  EMAIL_PROVIDER_REJECTED:    'EMAIL_PROVIDER_REJECTED',
  EMAIL_PROVIDER_UNAVAILABLE: 'EMAIL_PROVIDER_UNAVAILABLE',
};

// ── Core helper ──────────────────────────────────────────────────────────────

/**
 * Emit a provider health event to run_events.
 *
 * @param {import('pg').Pool} pool     - Postgres connection pool
 * @param {string}            type     - One of PROVIDER_EVENT_TYPES values
 * @param {ProviderEventPayload} payload - Structured event payload (see typedef)
 * @param {string|null}       [runId]  - Pipeline run context; null for system events
 * @returns {Promise<void>}
 *
 * @typedef {Object} ProviderEventPayload
 * @property {'polsia_proxy'}                               provider
 * @property {'startup_config_check'}                       operation
 * @property {'accepted'|'rejected'|'unavailable'|'checked'} status
 * @property {string|null}  message_id    - Message ID from proxy (ACCEPTED only)
 * @property {number|null}  error_code    - HTTP status code (REJECTED only)
 * @property {string|null}  error_message - Human-readable error (REJECTED/UNAVAILABLE)
 * @property {boolean}      config_valid  - Whether POLSIA_API_KEY is present
 * @property {boolean}      mock_mode     - True when running without a real key
 */
async function emitProviderEvent(pool, type, payload, runId = null) {
  try {
    await pool.query(
      `INSERT INTO run_events (run_id, agent, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [runId, 'email_boundary', type, JSON.stringify(payload)]
    );
  } catch (err) {
    // Observability must never crash the auth path. Log and move on.
    console.error('[ProviderEvents] Failed to write run_event — continuing:', err.message, {
      type,
      operation: payload && payload.operation,
    });
  }
}

// ── Startup probe ────────────────────────────────────────────────────────────

/**
 * Validate Polsia email proxy config on server boot and emit EMAIL_PROVIDER_CHECKED.
 *
 * Run once from app.listen(). Records whether the provider is configured
 * before any real traffic arrives. Consumers can query:
 *
 *   SELECT payload FROM run_events
 *   WHERE event_type = 'EMAIL_PROVIDER_CHECKED'
 *     AND run_id IS NULL
 *   ORDER BY timestamp DESC LIMIT 1;
 *
 * @param {import('pg').Pool} pool - Postgres connection pool
 * @returns {Promise<void>}
 */
async function probeProviderOnStartup(pool) {
  const apiKey     = process.env.POLSIA_API_KEY;
  const configValid = Boolean(apiKey && apiKey.trim().length > 0 && apiKey.startsWith('company_'));
  const mockMode    = !configValid;

  await emitProviderEvent(
    pool,
    PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_CHECKED,
    {
      provider:      'polsia_proxy',
      operation:     'startup_config_check',
      status:        'checked',
      message_id:    null,
      error_code:    null,
      error_message: configValid ? null : 'POLSIA_API_KEY not set or invalid — emails will not send',
      config_valid:  configValid,
      mock_mode:     mockMode,
    },
    null  // system event — no run context
  );

  if (configValid) {
    console.log('[ProviderEvents] EMAIL_PROVIDER_CHECKED — provider=polsia_proxy config_valid=true mock_mode=false');
  } else {
    console.warn('[ProviderEvents] EMAIL_PROVIDER_CHECKED — provider=polsia_proxy config_valid=false mock_mode=true (POLSIA_API_KEY not set or missing company_ prefix)');
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  PROVIDER_EVENT_TYPES,
  emitProviderEvent,
  probeProviderOnStartup,
};
