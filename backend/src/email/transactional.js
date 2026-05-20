/**
 * backend/src/email/transactional.js
 *
 * Transactional email service for BuildOrbit.
 * All sends go through the Polsia email proxy (https://polsia.com/api/proxy/email/send).
 *
 * Templates:
 *   Welcome               — on account creation
 *   Password Reset        — forgot password flow
 *   Credit Warning        — when task_credits drops to ≤ 2
 *   Subscription Confirm  — after Stripe checkout.session.completed
 *   Pipeline Complete     — after a pipeline run finishes verify stage
 *
 * Design rules:
 *   - Never throws. All failures are logged and swallowed.
 *   - Fire-and-forget safe: callers don't need to await unless they want the result.
 *   - HTML matches BuildOrbit dark theme (#0a0a0f bg, #00e5a0 teal, zinc text).
 */

'use strict';

const APP_URL = process.env.APP_URL || 'https://buildorbit.polsia.app';

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wraps inner content in the shared BuildOrbit email shell.
 * Dark background, teal brand header, clean sans-serif.
 */
function emailShell(innerHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:40px auto;padding:0 16px;">
    <tr><td style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:40px 36px;">
      <p style="margin:0 0 8px;font-size:0.8rem;color:#00e5a0;letter-spacing:1px;text-transform:uppercase;font-weight:600;">BuildOrbit</p>
      ${innerHtml}
      <hr style="margin:28px 0;border:none;border-top:1px solid #2a2a3a;">
      <p style="margin:0;font-size:0.75rem;color:#555570;">
        <a href="${APP_URL}" style="color:#00e5a0;text-decoration:none;">buildorbit.polsia.app</a> · Transactional message — no unsubscribe needed.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function primaryButton(text, url) {
  return `<a href="${url}" style="display:inline-block;background:#00e5a0;color:#0a0a0f;text-decoration:none;font-weight:700;font-size:0.9rem;padding:13px 28px;border-radius:8px;letter-spacing:-0.2px;">${text}</a>`;
}

// ── Email templates ───────────────────────────────────────────────────────────

function welcomeHtml(email) {
  const dashUrl = `${APP_URL}/dashboard`;
  return emailShell(`
    <h1 style="margin:0 0 14px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">Welcome to BuildOrbit</h1>
    <p style="margin:0 0 10px;font-size:0.95rem;color:#8888a0;line-height:1.6;">
      Your account is ready. You've got <strong style="color:#e8e8f0;">10 free trial credits</strong> to run your first builds.
    </p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#8888a0;line-height:1.6;">
      Describe what you want to build — BuildOrbit plans, scaffolds, writes, and verifies it automatically.
    </p>
    ${primaryButton('Go to Dashboard →', dashUrl)}
    <p style="margin:24px 0 0;font-size:0.82rem;color:#555570;">
      Signed up as <span style="color:#8888a0;">${escapeHtml(email)}</span>
    </p>
  `);
}

function passwordResetHtml(resetUrl) {
  return emailShell(`
    <h1 style="margin:0 0 14px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:0.95rem;color:#8888a0;line-height:1.6;">
      Click below to set a new password. This link expires in <strong style="color:#e8e8f0;">30 minutes</strong> and can only be used once.
    </p>
    ${primaryButton('Reset Password →', resetUrl)}
    <p style="margin:24px 0 0;font-size:0.8rem;color:#555570;line-height:1.6;">
      Or copy this link:<br>
      <a href="${resetUrl}" style="color:#00e5a0;word-break:break-all;">${escapeHtml(resetUrl)}</a>
    </p>
    <p style="margin:16px 0 0;font-size:0.78rem;color:#555570;">
      If you didn't request this, you can safely ignore this email. Your password won't change.
    </p>
  `);
}

function creditWarningHtml(creditsRemaining) {
  const pricingUrl = `${APP_URL}/pricing`;
  const creditWord = creditsRemaining === 1 ? 'credit' : 'credits';
  return emailShell(`
    <h1 style="margin:0 0 14px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">You're almost out of credits</h1>
    <p style="margin:0 0 10px;font-size:0.95rem;color:#8888a0;line-height:1.6;">
      You have <strong style="color:#00e5a0;">${creditsRemaining} ${creditWord}</strong> remaining.
    </p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#8888a0;line-height:1.6;">
      Upgrade to BuildOrbit Pro for $49/month and get 10 new credits every billing cycle, plus priority execution.
    </p>
    ${primaryButton('View Pricing →', pricingUrl)}
  `);
}

function subscriptionConfirmationHtml() {
  const dashUrl = `${APP_URL}/dashboard`;
  return emailShell(`
    <h1 style="margin:0 0 14px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">You're on the $49/month plan</h1>
    <p style="margin:0 0 10px;font-size:0.95rem;color:#8888a0;line-height:1.6;">
      Your subscription is active. <strong style="color:#00e5a0;">+10 bonus credits</strong> have been added to your account.
    </p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#8888a0;line-height:1.6;">
      You'll receive 5 fresh credits each billing cycle. Build something.
    </p>
    ${primaryButton('Go to Dashboard →', dashUrl)}
  `);
}

function pipelineCompleteHtml(prompt, runId, liveUrl = null) {
  const runUrl = `${APP_URL}/run?id=${encodeURIComponent(runId)}`;
  const shortPrompt = prompt && prompt.length > 120
    ? escapeHtml(prompt.slice(0, 117)) + '…'
    : escapeHtml(prompt || 'Your build');

  // Build the full live URL (absolute) if a relative path is provided
  const fullLiveUrl = liveUrl
    ? (liveUrl.startsWith('http') ? liveUrl : `${APP_URL}${liveUrl}`)
    : null;

  const liveUrlBlock = fullLiveUrl ? `
    <p style="margin:0 0 8px;font-size:0.85rem;color:#555570;text-transform:uppercase;letter-spacing:0.7px;">Live site</p>
    <table cellpadding="0" cellspacing="0" style="background:#0a0a0f;border:1px solid #1a3a2a;border-radius:8px;padding:14px 18px;margin-bottom:24px;width:100%;">
      <tr><td>
        <a href="${escapeHtml(fullLiveUrl)}" style="font-size:0.9rem;color:#00e5a0;word-break:break-all;text-decoration:none;">${escapeHtml(fullLiveUrl)}</a>
      </td></tr>
    </table>
    <a href="${escapeHtml(fullLiveUrl)}" style="display:inline-block;background:#00e5a0;color:#0a0a0f;font-weight:700;font-size:0.9rem;padding:12px 24px;border-radius:8px;text-decoration:none;margin-bottom:16px;">🌐 View Live Site →</a>
    <br>
  ` : '';

  const bodyText = fullLiveUrl
    ? 'All pipeline stages completed and your site is live. Click the link below to see it.'
    : 'All pipeline stages completed. View the output, explore artifacts, or deploy from the run page.';

  return emailShell(`
    <h1 style="margin:0 0 14px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">${fullLiveUrl ? 'Your site is live 🎉' : 'Your build is ready'}</h1>
    <p style="margin:0 0 8px;font-size:0.85rem;color:#555570;text-transform:uppercase;letter-spacing:0.7px;">Build request</p>
    <table cellpadding="0" cellspacing="0" style="background:#0a0a0f;border:1px solid #2a2a3a;border-radius:8px;padding:14px 18px;margin-bottom:24px;width:100%;">
      <tr><td style="font-size:0.9rem;color:#c8c8d8;line-height:1.5;">${shortPrompt}</td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#8888a0;line-height:1.6;">
      ${bodyText}
    </p>
    ${liveUrlBlock}
    ${primaryButton('View Build →', runUrl)}
    <p style="margin:20px 0 0;font-size:0.78rem;color:#555570;">
      Run ID: <span style="color:#8888a0;font-family:monospace;">${escapeHtml(runId)}</span>
    </p>
  `);
}

// ── Core send ─────────────────────────────────────────────────────────────────

/**
 * Send a transactional email via the Polsia email proxy.
 *
 * Endpoint: https://polsia.com/api/proxy/email/send
 * Auth:     Bearer ${process.env.POLSIA_API_KEY}
 *
 * Graceful failure: never throws. Returns { sent: boolean, reason? }.
 *
 * @param {string} to      - Recipient email address
 * @param {string} subject - Email subject line
 * @param {string} html    - Full HTML body
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string }>}
 */
async function sendTransactionalEmail(to, subject, html) {
  const apiKey = process.env.POLSIA_API_KEY;
  if (!apiKey) {
    console.warn(`[Transactional] POLSIA_API_KEY not set — skipping email to ${to} ("${subject}")`);
    return { sent: false, reason: 'no_api_key' };
  }

  // Plain-text fallback (strip tags)
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();

  try {
    const response = await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to,
        subject,
        body: plainText,
        html,
      }),
    });

    let parsed = {};
    try { parsed = await response.json(); } catch (_) { parsed = {}; }

    if (response.ok) {
      const msgId = parsed.messageId || parsed.id || 'proxy-ok';
      console.log(`[Email Proxy SUCCESS] to=${to} subject="${subject}" msgId=${msgId}`);
      return { sent: true, messageId: msgId };
    } else {
      console.error(`[Email Proxy REJECTED] to=${to} subject="${subject}" status=${response.status}`, parsed);
      return { sent: false, reason: 'proxy_error', statusCode: response.status, response: parsed };
    }
  } catch (err) {
    console.error(`[Email Proxy UNAVAILABLE] to=${to}:`, err.message);
    return { sent: false, reason: 'network_error', error: err.message };
  }
}

// ── Named senders (public API) ────────────────────────────────────────────────

/**
 * Welcome email — fire after account creation.
 * @param {string} email
 */
async function sendWelcomeEmail(email) {
  return sendTransactionalEmail(
    email,
    'Welcome to BuildOrbit',
    welcomeHtml(email)
  );
}

/**
 * Password reset email — fire when user requests a reset.
 * @param {string} email
 * @param {string} resetUrl - Full URL with token (expires 30 min)
 */
async function sendPasswordResetEmail(email, resetUrl) {
  return sendTransactionalEmail(
    email,
    'Reset your BuildOrbit password',
    passwordResetHtml(resetUrl)
  );
}

/**
 * Credit warning email — fire when user's task_credits drops to ≤ 2.
 * @param {string} email
 * @param {number} creditsRemaining
 */
async function sendCreditWarningEmail(email, creditsRemaining) {
  return sendTransactionalEmail(
    email,
    "You're almost out of credits",
    creditWarningHtml(creditsRemaining)
  );
}

/**
 * Subscription confirmation email — fire after Stripe checkout success.
 * @param {string} email
 */
async function sendSubscriptionConfirmationEmail(email) {
  return sendTransactionalEmail(
    email,
    "You're on the $49/month plan",
    subscriptionConfirmationHtml()
  );
}

/**
 * Pipeline complete notification — fire when all stages complete.
 * @param {string} email
 * @param {object} opts
 * @param {string} opts.prompt   - Original build prompt
 * @param {string} opts.runId    - Pipeline run ID
 * @param {string} [opts.liveUrl] - Live URL (relative path, e.g. /live/{runId}/) if deployed
 */
async function sendPipelineCompleteEmail(email, { prompt, runId, liveUrl = null }) {
  const subject = liveUrl ? 'Your site is live 🎉' : 'Your build is ready';
  return sendTransactionalEmail(
    email,
    subject,
    pipelineCompleteHtml(prompt, runId, liveUrl)
  );
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendTransactionalEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendCreditWarningEmail,
  sendSubscriptionConfirmationEmail,
  sendPipelineCompleteEmail,
};
