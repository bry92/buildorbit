/**
 * Auth Rate Limiting & Abuse Protection
 *
 * In-memory stores (no Redis needed):
 *  - IP rate limit: 5 requests/min, 20 requests/hr
 *  - Velocity: detect 10+ unique emails from one IP in 2 minutes
 *  - Resend: max 3 per email per 15-minute window
 *  - Abuse signals: track suspicious patterns for conditional honeypot check
 *
 * Cleanup: stale entries purged every 5 minutes.
 */

'use strict';

// ── In-Memory Stores ──────────────────────────────────────────────────────────

/** ip → { timestamps: number[] } */
const ipRequests = new Map();

/** ip → { emails: Set<string>, resetAt: number } */
const ipVelocity = new Map();

/** email → { count: number, resetAt: number } */
const resendLog = new Map();

/** ip → { count: number, resetAt: number } */
const abuseSignals = new Map();

// Purge stale entries every 5 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  for (const [key, data] of ipRequests) {
    data.timestamps = data.timestamps.filter(t => now - t < ONE_HOUR);
    if (data.timestamps.length === 0) ipRequests.delete(key);
  }
  for (const [key, data] of ipVelocity) {
    if (now > data.resetAt) ipVelocity.delete(key);
  }
  for (const [key, data] of resendLog) {
    if (now > data.resetAt) resendLog.delete(key);
  }
  for (const [key, data] of abuseSignals) {
    if (now > data.resetAt) abuseSignals.delete(key);
  }
}, 5 * 60 * 1000).unref(); // .unref() so this doesn't keep process alive

// ── Disposable Email Domains ──────────────────────────────────────────────────

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'throwaway.email', 'tempmail.com',
  'temp-mail.org', 'fakeinbox.com', 'dispostable.com', 'maildrop.cc',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamail.net', 'guerrillamail.org', 'spam4.me', 'trashmail.com',
  'trashmail.me', 'trashmail.net', 'trashmail.io', 'trashmail.at',
  'discard.email', 'mailnull.com', 'spamgourmet.com', 'mt2015.com',
  'getairmail.com', 'filzmail.com', 'throwam.com', 'spamhereplease.com',
  'jetable.org', 'nomail.xl.cx', 'no-spam.ws', 'ownmail.net',
  'tempinbox.com', 'spambox.us', 'mailexpire.com', '10minutemail.com',
  '10minutemail.net', '20minutemail.com', 'minutemail.com', 'mytemp.email',
  'tempail.com', 'dropmail.me', 'mailtemp.info', 'spamgrap.com',
  'burnermail.io', 'inboxbear.com', 'getnada.com', 'moakt.com',
  'mohmal.com', 'mailnesia.com', 'spamfree24.org', 'e4ward.com',
]);

/**
 * Returns true if the email's domain is a known disposable provider.
 */
function isDisposableEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  return DISPOSABLE_DOMAINS.has(parts[1].toLowerCase());
}

// ── IP Rate Limiter ───────────────────────────────────────────────────────────

/**
 * Check and record an IP request against per-minute and per-hour limits.
 *   - max 5 per minute
 *   - max 20 per hour
 *
 * @param {string} ip
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkIpRateLimit(ip) {
  const now = Date.now();
  const ONE_MIN = 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  if (!ipRequests.has(ip)) ipRequests.set(ip, { timestamps: [] });
  const record = ipRequests.get(ip);

  // Expire timestamps older than 1 hour
  record.timestamps = record.timestamps.filter(t => now - t < ONE_HOUR);

  const lastMinute = record.timestamps.filter(t => now - t < ONE_MIN).length;
  if (lastMinute >= 5) {
    return { allowed: false, reason: 'rate_limit_minute' };
  }
  if (record.timestamps.length >= 20) {
    return { allowed: false, reason: 'rate_limit_hour' };
  }

  record.timestamps.push(now);
  return { allowed: true };
}

// ── Velocity Tracker ──────────────────────────────────────────────────────────

/**
 * Detect burst patterns: 10 different email addresses from the same IP within
 * a 2-minute sliding window signals a bot or enumeration attack.
 *
 * @param {string} ip
 * @param {string} email  normalized (lowercased) email
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkVelocity(ip, email) {
  const now = Date.now();
  const TWO_MIN = 2 * 60 * 1000;

  if (!ipVelocity.has(ip)) {
    ipVelocity.set(ip, { emails: new Set(), resetAt: now + TWO_MIN });
  }
  const record = ipVelocity.get(ip);

  if (now > record.resetAt) {
    record.emails = new Set();
    record.resetAt = now + TWO_MIN;
  }

  record.emails.add(email);

  if (record.emails.size >= 10) {
    return { allowed: false, reason: 'velocity_burst' };
  }
  return { allowed: true };
}

// ── Resend Rate Limiter ───────────────────────────────────────────────────────

/**
 * Check and record a resend attempt for an email address.
 * Limit: 3 resends per email per 15-minute window.
 *
 * @param {string} email  normalized email
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkResendLimit(email) {
  const now = Date.now();
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const key = email.toLowerCase();

  if (!resendLog.has(key)) {
    resendLog.set(key, { count: 0, resetAt: now + FIFTEEN_MIN });
  }
  const record = resendLog.get(key);

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + FIFTEEN_MIN;
  }

  if (record.count >= 3) {
    return { allowed: false, reason: 'resend_limit' };
  }

  record.count++;
  return { allowed: true };
}

// ── Abuse Signal Tracker ──────────────────────────────────────────────────────

/**
 * Record an abuse signal for an IP (honeypot fill, invalid email, etc).
 * Returns true once the IP crosses the threshold (3 signals in 5 minutes),
 * indicating a honeypot challenge should be required.
 *
 * @param {string} ip
 * @returns {boolean} whether challenge should now be shown
 */
function recordAbuseSignal(ip) {
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;

  if (!abuseSignals.has(ip)) {
    abuseSignals.set(ip, { count: 0, resetAt: now + FIVE_MIN });
  }
  const record = abuseSignals.get(ip);

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + FIVE_MIN;
  }
  record.count++;
  return record.count >= 3;
}

/**
 * Returns true if an IP has enough abuse signals to require a challenge.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function shouldShowChallenge(ip) {
  const record = abuseSignals.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) return false;
  return record.count >= 3;
}

// ── User-Agent Parser ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable "Browser on OS" hint from a User-Agent string.
 * No external library needed — simple regex matching is sufficient.
 *
 * @param {string|undefined} ua
 * @returns {string}  e.g. "Chrome on Mac"
 */
function parseUserAgent(ua) {
  if (!ua) return null;

  let browser = 'Browser';
  let os = 'Unknown';

  // Browser — order matters: Edge/OPR embed Chrome token too
  if (/Edg\//.test(ua))                              browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua))                   browser = 'Opera';
  else if (/Firefox\//.test(ua))                     browser = 'Firefox';
  else if (/Chrome\//.test(ua))                      browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/.test(ua))                  browser = 'IE';

  // OS
  if (/Windows NT/.test(ua))                         os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua))            os = 'Mac';
  else if (/Android/.test(ua))                       os = 'Android';
  else if (/iPhone|iPad/.test(ua))                   os = 'iOS';
  else if (/CrOS/.test(ua))                          os = 'ChromeOS';
  else if (/Linux/.test(ua))                         os = 'Linux';

  return `${browser} on ${os}`;
}

// ── IP Geolocation ────────────────────────────────────────────────────────────

/** IPs that should never be sent to geolocation APIs */
const PRIVATE_IP_RE = /^(127\.|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

/**
 * Resolve approximate city-level location for a public IP address.
 * Uses ip-api.com (free, no auth required). Hard timeout: 2 seconds.
 * Returns null on any error or for private/local IPs.
 *
 * @param {string|undefined} ip
 * @returns {Promise<string|null>}  e.g. "San Francisco, US"
 */
async function getIpLocation(ip) {
  if (!ip || PRIVATE_IP_RE.test(ip)) return null;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,countryCode`,
      { signal: controller.signal }
    );
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'success' && data.city) {
      return `${data.city}, ${data.countryCode}`;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the real client IP from an Express request.
 * Respects X-Forwarded-For (set by Render's proxy).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

module.exports = {
  checkIpRateLimit,
  checkVelocity,
  checkResendLimit,
  recordAbuseSignal,
  shouldShowChallenge,
  isDisposableEmail,
  parseUserAgent,
  getIpLocation,
  getClientIp,
};
