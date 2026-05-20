/**
 * CSRF Protection — Double-Submit Cookie Pattern
 *
 * Owns: CSRF token generation, cookie management, and validation middleware.
 * Does NOT own: authentication, sessions, or business logic.
 *
 * How it works:
 *   1. GET /api/csrf-token → server sets a random token as a SameSite=Strict
 *      cookie AND returns it in the JSON response body.
 *   2. On state-changing requests (POST/PUT/PATCH/DELETE), the client must
 *      send the token in the X-CSRF-Token header.
 *   3. Middleware compares the header value against the cookie value.
 *
 * Why this works:
 *   Attackers can forge requests that auto-include cookies (CSRF), but they
 *   cannot read or set the X-CSRF-Token header from a cross-origin page due
 *   to the browser's same-origin policy.
 *
 * Exemptions (CSRF check bypassed):
 *   - Requests authenticated with a Bearer API token (not cookie-based)
 *   - GET/HEAD/OPTIONS requests (read-only, idempotent)
 *   - The CSRF token endpoint itself
 *
 * Note: sameSite: 'lax' on the session cookie already blocks most CSRF.
 * This layer adds defense-in-depth as required by the security audit.
 */

const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'bo_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const TOKEN_BYTES = 24; // 48 hex chars — sufficient entropy

/**
 * Generate a new CSRF token (hex string).
 */
function generateCsrfToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Express route handler: GET /api/csrf-token
 *
 * Returns an existing CSRF token from the cookie, or generates a new one.
 * Sets the token cookie and returns the token in the response body so the
 * SPA can attach it to subsequent state-changing requests.
 */
function csrfTokenHandler(req, res) {
  let token = req.cookies && req.cookies[CSRF_COOKIE_NAME];
  if (!token || token.length !== TOKEN_BYTES * 2) {
    token = generateCsrfToken();
  }

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,       // Must be readable by JS (SPA reads it to set the header)
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',    // Strict: cookie never sent cross-origin, even on navigation
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  });

  res.json({ token });
}

/**
 * Middleware: validate CSRF token on state-changing requests authenticated via cookie.
 *
 * Bypassed for:
 *   - GET, HEAD, OPTIONS (safe methods)
 *   - Bearer token authenticated requests (API tokens, not cookie-based)
 *
 * Returns 403 if:
 *   - CSRF cookie is missing
 *   - X-CSRF-Token header is missing or doesn't match the cookie
 */
function requireCsrf(req, res, next) {
  const method = req.method && req.method.toUpperCase();

  // Safe methods: no state change, CSRF not applicable
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  // Bearer token auth: CSRF doesn't apply — attacker can't forge Authorization header
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return next();
  }

  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token missing. Refresh the page and try again.',
      code: 'CSRF_MISSING',
    });
  }

  // Constant-time comparison to prevent timing attacks
  const cookieBuf = Buffer.from(cookieToken);
  const headerBuf = Buffer.from(headerToken);
  const valid = cookieBuf.length === headerBuf.length &&
    crypto.timingSafeEqual(cookieBuf, headerBuf);

  if (!valid) {
    return res.status(403).json({
      success: false,
      message: 'CSRF validation failed. Refresh the page and try again.',
      code: 'CSRF_INVALID',
    });
  }

  next();
}

module.exports = {
  generateCsrfToken,
  csrfTokenHandler,
  requireCsrf,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
};
