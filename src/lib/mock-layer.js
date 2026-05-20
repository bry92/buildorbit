/**
 * BuildOrbit Mock Layer — Permanent Dev/Test Infrastructure
 *
 * Provides auth bypass and email interception for development and CI testing.
 * Proves the system is production-ready minus auth.
 *
 * USAGE:
 *   Set MOCK_MODE=true (and NODE_ENV !== 'production') before loading the server.
 *   Call applyMocks({ auth }) to patch auth middleware in-place.
 *   Call patchEmail(authModule) to intercept email delivery.
 *
 * PRODUCTION GUARD:
 *   This module throws immediately if NODE_ENV === 'production'.
 *   MOCK_MODE=true has no effect in production — the guard fires before any
 *   patch is applied.
 *
 * DEPENDENCY OVERRIDE MAP (documented for every test run):
 *   auth.requireAuth         → injects { id: 'mock-user-001', email: 'test@buildorbit.mock' }
 *   auth.requireApiAuth      → same fake user, no session DB check
 *   auth.makeRequireAuth     → factory returns mock middleware
 *   auth.makeRequireApiAuth  → factory returns mock middleware
 *   auth.sendMagicLinkEmail  → no-op logger, returns fake messageId
 */

'use strict';

// ── Production guard (case-insensitive to prevent bypass via 'Production') ──
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error(
    '[MockLayer] FATAL: Mock layer loaded in production environment. ' +
    'NODE_ENV must not be "production" when MOCK_MODE=true. ' +
    'Check your environment configuration immediately.'
  );
}

// ── Constants ───────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: 'mock-user-001',
  userId: 'mock-user-001',
  email: 'test@buildorbit.mock',
  sessionId: 'mock-session-001',
};

const MOCK_API_KEY = {
  id: 'mock-apikey-001',
  userId: 'mock-user-001',
};

/**
 * Full dependency override map — persisted to every simulation report.
 * Documents exactly what was mocked and what the real counterpart is.
 */
const MOCK_DEPENDENCIES = [
  {
    name: 'auth.requireAuth',
    real_type: 'Express middleware — validates JWT session cookie against sessions table',
    mock_value: `Bypass — injects req.user = ${JSON.stringify(MOCK_USER)}`,
    impact: 'All HTML-protected routes accept requests without a valid session cookie',
  },
  {
    name: 'auth.requireApiAuth',
    real_type: 'Express middleware — validates JWT session cookie, returns 401 JSON on failure',
    mock_value: `Bypass — injects req.user = ${JSON.stringify(MOCK_USER)}`,
    impact: 'All API-protected routes accept requests without a valid session cookie',
  },
  {
    name: 'auth.makeRequireAuth',
    real_type: 'Factory — produces pool-aware session-validation middleware',
    mock_value: 'Factory returns mock bypass middleware regardless of pool argument',
    impact: 'server.js can call makeRequireAuth(pool) and get mock middleware back',
  },
  {
    name: 'auth.makeRequireApiAuth',
    real_type: 'Factory — produces pool-aware API session-validation middleware',
    mock_value: 'Factory returns mock bypass middleware regardless of pool argument',
    impact: 'server.js can call makeRequireApiAuth(pool) and get mock middleware back',
  },
  {
    name: 'auth.sendMagicLinkEmail',
    real_type: 'HTTP call to Polsia email proxy (polsia.com/api/proxy/email/send) — sends magic link email',
    mock_value: 'No-op logger — logs payload to console, returns { messageId: "mock-msg-001", sent: true }',
    impact: 'Zero network calls to email proxy. Magic link tokens are generated but not delivered.',
  },
];

// ── Environment variable injection ──────────────────────────────────────────

/**
 * Inject mock values for any env vars the system reads at startup.
 * Call before requiring any application modules.
 *
 * @returns {string[]} List of var names that were injected
 */
function injectMockEnv() {
  const crypto = require('crypto');
  const injected = [];

  // JWT_SECRET: generate a random 32-byte secret if not set (never hardcoded)
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    injected.push('JWT_SECRET');
    console.log('[MOCK ENV] Generated random JWT_SECRET for testing');
  }

  return injected;
}

// ── Auth middleware mocks ────────────────────────────────────────────────────

/**
 * Mock Express middleware that bypasses session validation.
 * Always injects the mock user into req.user and calls next().
 */
function mockRequireAuth(req, res, next) {
  Object.defineProperty(req, 'user', { value: Object.freeze({ ...MOCK_USER }), writable: false, configurable: false });
  next();
}

/**
 * Same as mockRequireAuth but for API endpoints (JSON 401 on failure).
 * In mock mode, never fails — always injects the mock user.
 */
function mockRequireApiAuth(req, res, next) {
  Object.defineProperty(req, 'user', { value: Object.freeze({ ...MOCK_USER }), writable: false, configurable: false });
  next();
}

/**
 * Mock factory that ignores the pool and returns mock middleware.
 * Matches the signature of auth.makeRequireAuth(pool).
 */
function mockMakeRequireAuth(_pool) {
  return mockRequireAuth;
}

/**
 * Mock factory that ignores the pool and returns mock middleware.
 * Matches the signature of auth.makeRequireApiAuth(pool).
 */
function mockMakeRequireApiAuth(_pool) {
  return mockRequireApiAuth;
}

// ── Email mock ────────────────────────────────────────────────────────────────

/**
 * Patch auth module's sendMagicLinkEmail to be a no-op.
 * No HTTP calls to the email proxy — logs payload to console instead.
 *
 * @param {object} authModule - The loaded auth.js module exports
 */
function patchPostmark(authModule) {
  const originalFn = authModule.sendMagicLinkEmail;

  authModule.sendMagicLinkEmail = async function mockSendMagicLinkEmail(email, token, deviceContext = {}) {
    const payload = {
      to: email,
      subject: 'Your BuildOrbit magic link',
      token_preview: `${token.slice(0, 8)}...`,
      device_context: deviceContext,
    };
    console.log('[MOCK EMAIL] To:', email, '| Token preview:', payload.token_preview);
    console.log('[MOCK EMAIL] Full payload:', JSON.stringify(payload));
    return {
      sent: true,
      messageId: 'mock-msg-001',
      mocked: true,
      original_fn_replaced: typeof originalFn === 'function',
    };
  };

  console.log('[MOCK EMAIL] sendMagicLinkEmail patched — zero network calls');
}

// ── Auth module patcher ──────────────────────────────────────────────────────

/**
 * Patch the auth module in-place to use mock middleware.
 * Call this AFTER pool is available (server.js re-assigns requireAuth/requireApiAuth
 * after pool init — call applyMocks after that).
 *
 * @param {object} authModule - The loaded auth.js module exports
 */
function applyMocks(authModule) {
  // Replace middleware factories so server.js re-assignment produces mock middleware
  authModule.makeRequireAuth    = mockMakeRequireAuth;
  authModule.makeRequireApiAuth = mockMakeRequireApiAuth;

  // Replace the already-assigned middleware (in case it was already assigned)
  authModule.requireAuth    = mockRequireAuth;
  authModule.requireApiAuth = mockRequireApiAuth;

  // Patch email
  patchPostmark(authModule);

  console.log('[MOCK AUTH] Auth middleware patched — all routes accept mock user');
  console.log('[MOCK AUTH] Injected user:', JSON.stringify(MOCK_USER));
}

// ── A2A auth bypass ──────────────────────────────────────────────────────────

/**
 * Returns mock A2A auth middleware that bypasses the api_keys table lookup.
 * Use this when constructing the A2A router in mock mode.
 *
 * Instead of validating a Bearer token against the DB, this injects a fake
 * apiKey object and calls next().
 */
function mockA2AAuth(req, res, next) {
  // Still parse the Authorization header so the pipeline can log it
  const authHeader = req.headers['authorization'];
  const rawKey = authHeader ? authHeader.replace('Bearer ', '').trim() : 'mock-key';

  req.apiKey = {
    id: MOCK_API_KEY.id,
    userId: MOCK_API_KEY.userId,
    rawKey,
    mocked: true,
  };

  next();
}

// ── Summary builder ──────────────────────────────────────────────────────────

/**
 * Build the mock_environment block for the simulation report.
 *
 * @param {string[]} injectedEnvVars - From injectMockEnv()
 * @returns {object}
 */
function buildMockEnvironmentSummary(injectedEnvVars = []) {
  const dependencyOverrideMap = {};
  for (const dep of MOCK_DEPENDENCIES) {
    dependencyOverrideMap[dep.name] = {
      real_type: dep.real_type,
      mock_value: dep.mock_value,
      impact: dep.impact,
    };
  }

  return {
    mock_mode: true,
    node_env: process.env.NODE_ENV || 'test',
    injected_user: MOCK_USER,
    injected_env_vars: injectedEnvVars,
    mocked_dependencies: MOCK_DEPENDENCIES,
    dependency_override_map: dependencyOverrideMap,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  MOCK_USER,
  MOCK_API_KEY,
  MOCK_DEPENDENCIES,

  // Setup functions
  injectMockEnv,
  applyMocks,
  patchPostmark,

  // Individual middleware (for custom wiring)
  mockRequireAuth,
  mockRequireApiAuth,
  mockMakeRequireAuth,
  mockMakeRequireApiAuth,
  mockA2AAuth,

  // Report helpers
  buildMockEnvironmentSummary,
};
