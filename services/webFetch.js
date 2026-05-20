/**
 * WebFetch Service
 *
 * Owns: server-side URL fetching for pipeline agents (BuilderAgent, PlannerAgent, QAAgent).
 * Does NOT own: authentication flows, session management, API key storage.
 *
 * Guardrails enforced here — never bypass this module to call fetch directly in agents.
 */

const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');

// Content-type prefixes that indicate binary/non-text content
const BINARY_CONTENT_TYPES = [
  'image/',
  'video/',
  'audio/',
  'font/',
  'application/octet-stream',
  'application/zip',
  'application/x-tar',
  'application/x-gzip',
  'application/wasm',
];

// Login page heuristics — block pages that are gating content behind auth
const LOGIN_PATTERNS = [
  /<input[^>]+type=['"]password['"]/i,
  /name=['"]login['"]/i,
  /id=['"]login-form['"]/i,
  /action=['"][^'"]*login['"]/i,
  /action=['"][^'"]*signin['"]/i,
  /<form[^>]+class=['"][^'"]*login['"]/i,
];

// Headers returned by auth-gated pages
const AUTH_HEADER_PATTERNS = [
  'www-authenticate',
  'x-amz-security-token',
];

/**
 * Fetch a URL and return sanitized text content.
 *
 * Guardrails applied:
 *   - Blocks binary files (image, video, audio, zip, wasm, etc.)
 *   - Blocks PDFs unless opts.allowPdf is true
 *   - Blocks pages with auth challenge headers
 *   - Blocks pages matching login form patterns
 *   - Strips <script>, <iframe>, <form>, <style> tags
 *   - Caps output at 50,000 characters
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.allowPdf=false] - Allow PDF content-type (returns raw text)
 * @returns {Promise<{ url: string, status: number, content: string }>}
 * @throws {Error} with a descriptive reason when a guardrail fires
 */
async function fetchUrl(url, opts = {}) {
  const { allowPdf = false } = opts;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'BuildOrbitBot/1.0',
        'Accept': 'text/html,application/json',
      },
      // 10s timeout — agents should not hang on slow URLs
      timeout: 10000,
    });
  } catch (err) {
    throw new Error(`[webFetch] Network error fetching ${url}: ${err.message}`);
  }

  // --- Guardrail: authenticated content (HTTP 401/403) ---
  if (res.status === 401 || res.status === 403) {
    throw new Error(`[webFetch] Blocked: URL requires authentication (HTTP ${res.status})`);
  }

  // --- Guardrail: auth challenge headers ---
  for (const header of AUTH_HEADER_PATTERNS) {
    if (res.headers.get(header)) {
      throw new Error(`[webFetch] Blocked: URL returned auth challenge header "${header}"`);
    }
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // --- Guardrail: binary files ---
  for (const prefix of BINARY_CONTENT_TYPES) {
    if (contentType.startsWith(prefix)) {
      throw new Error(`[webFetch] Blocked: binary content-type "${contentType}"`);
    }
  }

  // --- Guardrail: PDF (unless explicitly allowed) ---
  if (contentType.includes('application/pdf') && !allowPdf) {
    throw new Error('[webFetch] Blocked: PDF content requires opts.allowPdf=true');
  }

  const text = await res.text();

  // --- Guardrail: login page detection ---
  for (const pattern of LOGIN_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error('[webFetch] Blocked: page appears to be a login form');
    }
  }

  // --- Strip dangerous tags and extract readable text ---
  let content;
  try {
    const dom = new JSDOM(text, { runScripts: 'outside-only' });
    const document = dom.window.document;

    // Remove script, iframe, form, style, noscript tags
    const STRIP_TAGS = ['script', 'iframe', 'form', 'style', 'noscript'];
    for (const tag of STRIP_TAGS) {
      const elements = document.querySelectorAll(tag);
      for (const el of elements) {
        el.remove();
      }
    }

    content = (document.body ? document.body.textContent : document.textContent) || '';
    // Normalize whitespace
    content = content.replace(/\s+/g, ' ').trim();
  } catch (parseErr) {
    // If JSDOM fails (e.g., non-HTML response), fall back to raw text
    content = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // --- Guardrail: 50k char cap ---
  content = content.slice(0, 50000);

  return {
    url,
    status: res.status,
    content,
  };
}

module.exports = { fetchUrl };
