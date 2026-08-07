/**
 * backend/src/email/send.js
 *
 * Transactional email via Postmark (direct API).
 * Never throws — returns { sent, reason?, messageId? }.
 */

'use strict';

function getPostmarkToken() {
  return process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_TOKEN || null;
}

function getFromEmail() {
  return process.env.EMAIL_FROM || 'noreply@buildorbit.com';
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string, statusCode?: number }>}
 */
async function sendEmail(to, subject, html) {
  const token = getPostmarkToken();
  if (!token) {
    console.warn(`[Email] POSTMARK token not set — skipping email to ${to} ("${subject}")`);
    return { sent: false, reason: 'no_postmark_token' };
  }

  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();

  try {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: getFromEmail(),
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: plainText,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
      }),
    });

    let parsed = {};
    try { parsed = await response.json(); } catch (_) { parsed = {}; }

    if (response.ok) {
      const msgId = parsed.MessageID || parsed.messageId || 'postmark-ok';
      console.log(`[Email] Postmark SUCCESS to=${to} subject="${subject}" msgId=${msgId}`);
      return { sent: true, messageId: msgId };
    }

    console.error(`[Email] Postmark REJECTED to=${to} subject="${subject}" status=${response.status}`, parsed);
    return { sent: false, reason: 'postmark_error', statusCode: response.status, response: parsed };
  } catch (err) {
    console.error(`[Email] Postmark UNAVAILABLE to=${to}:`, err.message);
    return { sent: false, reason: 'network_error', error: err.message };
  }
}

function isEmailConfigured() {
  return Boolean(getPostmarkToken());
}

module.exports = { sendEmail, isEmailConfigured, getPostmarkToken, getFromEmail };
