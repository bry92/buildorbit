/**
 * Browserbase Service
 *
 * Owns: Cloud browser session lifecycle — create, connect, screenshot, close.
 * Does NOT own: what to do with screenshots (that's the caller's job).
 *
 * Requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID env vars.
 * All public methods return gracefully if Browserbase is not configured
 * (BROWSERBASE_API_KEY absent) — callers should never hard-depend on this
 * service being available.
 *
 * Session lifecycle:
 *   createSession() → { sessionId, connectUrl }
 *   screenshot(sessionId, url) → { png: Buffer, consoleErrors: string[] }
 *   closeSession(sessionId) → void
 *
 * Sessions auto-expire after SESSION_TIMEOUT_SECONDS (default 60s) to prevent
 * runaway billing from leaked sessions. Always call closeSession() explicitly
 * after use, even if screenshot fails.
 */

'use strict';

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.browserbase.com';
const API_KEY = process.env.BROWSERBASE_API_KEY || '';
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';
// Sessions auto-expire after this many seconds (60s is minimum Browserbase allows)
const SESSION_TIMEOUT_SECONDS = 120;

/**
 * Returns true when Browserbase is configured and available.
 * Use this to guard optional calls without throwing.
 */
function isAvailable() {
  return Boolean(API_KEY);
}

// ── REST helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal HTTPS request helper.
 * Returns parsed JSON body or throws on non-2xx status.
 */
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.browserbase.com',
      path,
      method,
      headers: {
        'x-bb-api-key': API_KEY,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw); // some endpoints return non-JSON
          }
        } else {
          reject(new Error(`Browserbase API ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Create a new Browserbase cloud browser session.
 *
 * @returns {{ sessionId: string, connectUrl: string }}
 * @throws if Browserbase is not configured or the API call fails
 */
async function createSession() {
  if (!API_KEY) throw new Error('BROWSERBASE_API_KEY not set — Browserbase is not configured');

  const body = { timeout: SESSION_TIMEOUT_SECONDS };
  if (PROJECT_ID) body.projectId = PROJECT_ID;

  const session = await apiRequest('POST', '/v1/sessions', body);
  return {
    sessionId: session.id,
    connectUrl: session.connectUrl,
  };
}

/**
 * Close/terminate a Browserbase session.
 * Non-fatal: logs on failure rather than throwing.
 *
 * @param {string} sessionId
 */
async function closeSession(sessionId) {
  if (!API_KEY || !sessionId) return;
  try {
    await apiRequest('POST', `/v1/sessions/${sessionId}/stop`, {});
  } catch (err) {
    // Session may have already timed out — not a hard error
    console.warn(`[Browserbase] closeSession ${sessionId} failed (may have already expired):`, err.message);
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────

/**
 * Load a URL in a cloud browser and capture a screenshot.
 * Uses playwright-core to connect via CDP — no local browser binaries required.
 *
 * @param {string} sessionId  - From createSession()
 * @param {string} connectUrl - From createSession()
 * @param {string} url        - URL to load (e.g., a data: URI or public URL)
 * @param {object} [opts]
 * @param {number} [opts.waitMs=2000]       - ms to wait after page load before screenshot
 * @param {boolean} [opts.fullPage=false]   - capture full scrollable page
 *
 * @returns {{ png: Buffer, consoleErrors: string[], title: string }}
 */
async function screenshot(sessionId, connectUrl, url, opts = {}) {
  // Lazy-require playwright-core so the service loads even if the package
  // isn't installed (graceful degradation when Browserbase is not configured).
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    throw new Error(
      'playwright-core is not installed. Add it to package.json to use Browserbase screenshots.'
    );
  }

  const waitMs = opts.waitMs ?? 2000;
  const fullPage = opts.fullPage ?? false;

  const browser = await chromium.connectOverCDP(connectUrl);
  let png;
  let title = '';
  const consoleErrors = [];

  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    // Capture console errors for the VERIFY report
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
      // Fallback for pages that never fire networkidle (SPAs)
      page.goto(url, { waitUntil: 'load', timeout: 20_000 })
    );

    if (waitMs > 0) await page.waitForTimeout(waitMs);

    title = await page.title().catch(() => '');
    png = await page.screenshot({ fullPage, type: 'png' });
  } finally {
    await browser.close();
  }

  return { png, consoleErrors, title };
}

// ── High-level: verify a URL end-to-end ──────────────────────────────────────

/**
 * Create a session, take a screenshot of `url`, close the session.
 * Convenience wrapper for the VERIFY phase.
 *
 * @param {string} url - URL to verify
 * @param {object} [opts] - Passed to screenshot()
 * @returns {{ png: Buffer, consoleErrors: string[], title: string, sessionId: string }}
 */
async function verifyUrl(url, opts = {}) {
  if (!isAvailable()) {
    throw new Error('Browserbase is not configured (BROWSERBASE_API_KEY missing)');
  }

  const { sessionId, connectUrl } = await createSession();
  try {
    const result = await screenshot(sessionId, connectUrl, url, opts);
    return { ...result, sessionId };
  } finally {
    await closeSession(sessionId);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  isAvailable,
  createSession,
  closeSession,
  screenshot,
  verifyUrl,
};
