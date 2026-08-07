/**
 * backend/src/email/provider-events.js
 *
 * Layer 5: External Effect Verifier — Email Boundary Health Events
 */

'use strict';

const { isEmailConfigured } = require('./send');

const PROVIDER_EVENT_TYPES = {
  EMAIL_PROVIDER_CHECKED:     'EMAIL_PROVIDER_CHECKED',
  EMAIL_PROVIDER_ACCEPTED:    'EMAIL_PROVIDER_ACCEPTED',
  EMAIL_PROVIDER_REJECTED:    'EMAIL_PROVIDER_REJECTED',
  EMAIL_PROVIDER_UNAVAILABLE: 'EMAIL_PROVIDER_UNAVAILABLE',
};

async function emitProviderEvent(pool, type, payload, runId = null) {
  try {
    await pool.query(
      `INSERT INTO run_events (run_id, agent, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [runId, 'email_boundary', type, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('[ProviderEvents] Failed to write run_event — continuing:', err.message, {
      type,
      operation: payload && payload.operation,
    });
  }
}

async function probeProviderOnStartup(pool) {
  const configValid = isEmailConfigured();
  const mockMode    = !configValid;

  await emitProviderEvent(
    pool,
    PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_CHECKED,
    {
      provider:      'postmark',
      operation:     'startup_config_check',
      status:        'checked',
      message_id:    null,
      error_code:    null,
      error_message: configValid ? null : 'POSTMARK_SERVER_TOKEN or POSTMARK_TOKEN not set — emails will not send',
      config_valid:  configValid,
      mock_mode:     mockMode,
    },
    null
  );

  if (configValid) {
    console.log('[ProviderEvents] EMAIL_PROVIDER_CHECKED — provider=postmark config_valid=true mock_mode=false');
  } else {
    console.warn('[ProviderEvents] EMAIL_PROVIDER_CHECKED — provider=postmark config_valid=false mock_mode=true (Postmark token not set)');
  }
}

module.exports = {
  PROVIDER_EVENT_TYPES,
  emitProviderEvent,
  probeProviderOnStartup,
};
