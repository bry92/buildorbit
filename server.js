/**
 * Environment Dependencies
 *
 * Required environment variables:
 *   OPENAI_API_KEY       → Direct OpenAI key (platform.openai.com)
 *   JWT_SECRET           → Required. 32+ byte secret for JWT signing.
 *   DATABASE_URL         → PostgreSQL connection string (Neon, self-hosted, etc.)
 *   EMAIL_PROVIDER       → 'postmark' or 'sendgrid' (for transactional email)
 *   POSTMARK_TOKEN       → Postmark API token (if using Postmark)
 *   SENDGRID_API_KEY     → SendGrid API key (if using SendGrid)
 *
 * See .env.example for the full list of required and optional env vars.
 */

// ── ENVIRONMENT VALIDATION (Must Run First) ────────────────────────────────
// Fail-fast if any required env vars are missing. This prevents silent failures
// and ensures the app never boots with incomplete configuration.
const { validateEnvironment } = require('./src/lib/env-validation');
validateEnvironment();

const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const BCRYPT_ROUNDS = 12;
const { PipelineExecutor } = require('./src/phases/pipeline');
const { PipelineStateMachine } = require('./src/core/state-machine');
const { PipelineEventBus } = require('./src/core/event-bus');
const { PipelineOrchestrator } = require('./src/core/pipeline-orchestrator');
const { createAgentRegistry } = require('./src/agents');
const { ArtifactStore } = require('./src/core/artifact-store');
const { CostTracker } = require('./src/lib/cost-tracker');
const { TraceStore } = require('./src/lib/trace-store');
const { RunTrace } = require('./src/lib/run-trace');
const { DeployEngine, DEPLOY_BASE, PREVIEW_BASE, APPS_BASE } = require('./src/lib/deploy-engine');
const { nodeAppRunner } = require('./src/lib/node-app-runner');
const auth = require('./src/lib/auth');
const { probeProviderOnStartup } = require('./backend/src/email/provider-events');
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
} = require('./backend/src/email/transactional');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const { createA2ARouter } = require('./src/routes/a2a');
const { createAnalyticsRouter } = require('./src/routes/analytics');
const { createRunsRouter } = require('./src/routes/runs');
const { createComplianceExportRouter } = require('./src/routes/compliance-export');
const { createExpoExportRouter } = require('./src/routes/expo-export');
const { createAdminRouter } = require('./src/routes/admin');
const analytics = require('./src/lib/analytics');
const cliRouter = require('./src/routes/cli');
const REACT_BUILD_INDEX = path.join(__dirname, 'public', 'react-build', 'index.html');
const REACT_FRONTEND_DIR = path.join(__dirname, 'buildorbit-frontend');
const REACT_FRONTEND_NODE_MODULES = path.join(REACT_FRONTEND_DIR, 'node_modules');
const {
  checkIpRateLimit,
  checkVelocity,
  checkResendLimit,
  recordAbuseSignal,
  shouldShowChallenge,
  isDisposableEmail,
  parseUserAgent,
  getIpLocation,
  getClientIp,
} = require('./src/lib/auth-rate-limiter');
const { correlationIdMiddleware } = require('./src/lib/correlation-id');
const {
  validateRunCreate,
  validateMagicLink,
  validateResend,
  validatePasswordLogin,
  validateMemoryCreate,
} = require('./src/lib/input-validation');
const { csrfTokenHandler, requireCsrf } = require('./src/lib/csrf');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize: State Machine → Executor → Event Bus → Agent Registry → Artifact Store → Orchestrator
const stateMachine = new PipelineStateMachine(pool);
const pipeline = new PipelineExecutor(pool, stateMachine);
const eventBus = new PipelineEventBus();

// Agent registry routes each pipeline stage to its dedicated agent:
//   plan              → PlannerAgent
//   scaffold, code    → BuilderAgent
//   save              → OpsAgent
//   verify            → QAAgent
const agentRegistry = createAgentRegistry(pool);

// Artifact store: persists every stage output to local filesystem
// Directory: ./artifacts/{runId}/{stage}/{filename}
// Abstracted interface — swap basePath with S3 bucket later
const artifactStore = new ArtifactStore('./artifacts');

// Cost tracker: per-run economics (token usage, USD cost, budget enforcement)
const costTracker = new CostTracker();

// Trace store: captures per-stage decision traces (prompt, reasoning, output, latency, cost)
const traceStore = new TraceStore(pool);

// Run trace: decision-level causal DAG — used for GET /api/runs/:id/trace reads
const runTrace = new RunTrace(pool);

// Deploy engine: serves build artifacts live after pipeline completes
// Static: /live/{runId}/ from ./deployed/{runId}/current/
// Node.js: /app/{runId}/ proxied to spawned child process
const deployEngine = new DeployEngine(pool, stateMachine, nodeAppRunner);

const orchestrator = new PipelineOrchestrator({ stateMachine, executor: pipeline, eventBus, pool, agentRegistry, artifactStore, costTracker, traceStore, deployEngine });

// Trust Render's load-balancer proxy so req.ip gives the real client IP
app.set('trust proxy', 1);

// Replace stateless middleware with pool-aware versions that validate the
// sessions table and apply rolling expiry on every authenticated request.
auth.requireAuth    = auth.makeRequireAuth(pool);
auth.requireApiAuth = auth.makeRequireApiAuth(pool);

// ── Password login rate limiting (in-memory) ─────────────────────────────
// 5 attempts per email per 15 minutes. Keyed by lowercased email.
// Structure: Map<email, { count: number, windowStart: number }>
//
// KNOWN LIMITATION: resets on every Render deploy restart. Acceptable for
// single-instance deployment — upgrade to Redis if multi-instance needed.
const passwordLoginRateLimit = new Map();
// Cleanup entries older than the 15-minute window every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, val] of passwordLoginRateLimit) {
    if (val.windowStart < cutoff) passwordLoginRateLimit.delete(key);
  }
}, 5 * 60 * 1000);

// ── Mock Mode (dev/test only) ─────────────────────────────────────────────
// Apply mock layer when MOCK_MODE=true. Impossible to activate in production
// — mock-layer.js throws immediately if NODE_ENV === 'production'.
//
// Usage: MOCK_MODE=true NODE_ENV=test node server.js
// Effect: auth middleware bypassed, Postmark mocked, fake user injected.
if (process.env.MOCK_MODE === 'true') {
  const mockLayer = require('./src/lib/mock-layer');
  mockLayer.applyMocks(auth);
  console.log('[Server] ⚡ MOCK_MODE active — auth bypassed, Postmark mocked');
  console.log('[Server] ⚠️  WARNING: Never enable MOCK_MODE in production');
}

// ── Billing webhook needs raw body for Stripe signature verification ──────
// Mount BEFORE express.json() so the raw Buffer is preserved on this path.
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Body size cap: prevents OOM DoS from oversized payloads.
// 10mb outer limit; field-level limits enforced per-route via validateFields().
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// ── Correlation ID Middleware ──────────────────────────────────────────────
// Attach a unique request ID to every incoming request for tracing and debugging.
// Accepts x-request-id header from clients; generates UUID if not provided.
app.use(correlationIdMiddleware());

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', requestId: req.id });
});

// GET /api/csrf-token — issue a CSRF token for the SPA.
// The React frontend calls this on load and attaches the token to all
// state-changing requests via X-CSRF-Token header. No auth required —
// the token is meaningless without the matching session cookie.
app.get('/api/csrf-token', csrfTokenHandler);

// ── Auth Routes ──────────────────────────────────────────

// Helper: redirect to the styled verify-error page
// Optional email is passed for used/expired cases so the page can pre-fill sign-in.
function sendVerifyError(res, code, email) {
  let url = `/verify-error.html?code=${encodeURIComponent(code)}`;
  if (email) url += `&email=${encodeURIComponent(email)}`;
  res.redirect(url);
}

// ── Shared auth response helpers ──────────────────────────────────────────────

// Enumeration-safe response: identical message regardless of whether the
// email exists, was created, is blocked, or is disposable.
const ENUM_SAFE_MSG = 'If this email is registered, a link has been sent.';

/**
 * Enforce a minimum wall-clock response time to defeat timing-based
 * enumeration attacks.  The code path to "user found" is marginally
 * faster than "user not found" without this guard.
 *
 * @param {number} startedAt  - Date.now() at request entry
 * @param {number} [minMs=300]
 */
async function enforceMinResponseTime(startedAt, minMs = 300) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) {
    await new Promise(r => setTimeout(r, minMs - elapsed));
  }
}

// POST /api/auth/magic-link — request a magic link
app.post('/api/auth/magic-link', validateMagicLink, async (req, res) => {
  const startedAt = Date.now();

  try {
    const clientIp = getClientIp(req);
    const { email, _hp } = req.body; // _hp is the honeypot field

    // ── Honeypot check ─────────────────────────────────────────────────────
    // Real users never fill the hidden _hp field. Bots do.
    if (_hp && String(_hp).trim().length > 0) {
      recordAbuseSignal(clientIp);
      console.warn('[Auth] Honeypot triggered from IP:', clientIp);
      await enforceMinResponseTime(startedAt);
      // Return the same enumeration-safe message — don't signal we caught them
      return res.json({ success: true, message: ENUM_SAFE_MSG });
    }

    // ── Basic email validation ─────────────────────────────────────────────
    if (!email || !email.includes('@')) {
      recordAbuseSignal(clientIp);
      await enforceMinResponseTime(startedAt);
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // ── Conditional honeypot challenge ─────────────────────────────────────
    // After 3+ abuse signals from this IP, require the challenge to be solved.
    // Client sends challenge_answer when the math captcha is present.
    if (shouldShowChallenge(clientIp)) {
      const { challenge_answer, challenge_expected } = req.body;
      // challenge_expected is sent back by the client as a base64 value to avoid
      // storing server-side state.  We verify it wasn't tampered by checking the
      // HMAC.  If absent or wrong, we block the request.
      if (!challenge_answer || !challenge_expected) {
        await enforceMinResponseTime(startedAt);
        return res.status(429).json({
          success: false,
          message: 'Too many attempts. Please solve the challenge to continue.',
          requireChallenge: true,
        });
      }
      // Validate HMAC-signed expected answer
      const [encodedAnswer, sig] = challenge_expected.split('.');
      const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET)
        .update(encodedAnswer).digest('hex');
      const expectedAnswer = Buffer.from(encodedAnswer, 'base64').toString();
      if (sig !== hmac || String(challenge_answer).trim() !== expectedAnswer) {
        recordAbuseSignal(clientIp);
        await enforceMinResponseTime(startedAt);
        return res.status(429).json({
          success: false,
          message: 'Incorrect answer. Please try again.',
          requireChallenge: true,
        });
      }
    }

    // ── IP rate limits ─────────────────────────────────────────────────────
    const ipCheck = checkIpRateLimit(clientIp);
    if (!ipCheck.allowed) {
      recordAbuseSignal(clientIp);
      console.warn('[Auth] IP rate limit hit:', clientIp, ipCheck.reason);
      await enforceMinResponseTime(startedAt);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please wait a moment before trying again.',
      });
    }

    // ── Velocity check ─────────────────────────────────────────────────────
    const velCheck = checkVelocity(clientIp, normalizedEmail);
    if (!velCheck.allowed) {
      recordAbuseSignal(clientIp);
      console.warn('[Auth] Velocity burst from IP:', clientIp);
      await enforceMinResponseTime(startedAt);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please wait a moment before trying again.',
      });
    }

    // ── Disposable email check ─────────────────────────────────────────────
    if (isDisposableEmail(normalizedEmail)) {
      recordAbuseSignal(clientIp);
      // Enumeration-safe: don't reveal WHY we rejected it
      await enforceMinResponseTime(startedAt);
      return res.json({ success: true, message: ENUM_SAFE_MSG });
    }

    // ── Upsert user ────────────────────────────────────────────────────────
    const upsertResult = await pool.query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (LOWER(email)) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [normalizedEmail]
    );
    const userId = upsertResult.rows[0].id;

    // ── Generate & store token (hash only — raw token goes to user via email) ──
    const token = auth.generateToken();
    const tokenHash = auth.hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Resolve device context before insert so we can store context hashes
    const ua = req.headers['user-agent'];
    const browser = parseUserAgent(ua);
    const ipHash = auth.hashContext(clientIp);
    const locationPromise = getIpLocation(clientIp);

    await pool.query(
      `INSERT INTO magic_links (user_id, token, email, expires_at, ip_hash, user_agent, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, tokenHash, normalizedEmail, expiresAt, ipHash, ua ? ua.slice(0, 512) : null]
    );

    // ── Send email (blocking — critical path) ───────────────────────────────
    // PHASE 3: Gate success on Postmark's external acknowledgment (MessageID),
    // not local promise resolution. "await" completing is NOT proof of delivery.
    const location = await locationPromise;
    // pool passed for Layer 5 provider-health event emission
    const emailResult = await auth.sendMagicLinkEmail(normalizedEmail, token, { browser, location }, pool);

    if (!emailResult || !emailResult.sent) {
      console.error('[Auth] Magic link NOT delivered to', normalizedEmail, '— reason:', emailResult && emailResult.reason);
      await enforceMinResponseTime(startedAt);
      return res.status(500).json({
        success: false,
        message: 'Failed to send email. Please try again.',
        reason: emailResult && emailResult.reason
      });
    }

    console.log('[Auth] Email sent successfully — MessageID:', emailResult.messageId);
    await enforceMinResponseTime(startedAt);
    res.json({ success: true, message: ENUM_SAFE_MSG });
  } catch (err) {
    console.error('[Auth] magic-link error:', err);
    await enforceMinResponseTime(startedAt);
    res.status(500).json({
      success: false,
      message: 'Failed to send magic link. Please try again.',
      reason: err.message,
      postmark_error_code: err.errorCode || null
    });
  }
});

// POST /api/auth/resend — resend a magic link (rate-limited separately)
app.post('/api/auth/resend', validateResend, async (req, res) => {
  const startedAt = Date.now();

  try {
    const clientIp = getClientIp(req);
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      await enforceMinResponseTime(startedAt);
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Per-email resend limit: 3 per 15-minute window
    const resendCheck = checkResendLimit(normalizedEmail);
    if (!resendCheck.allowed) {
      console.warn('[Auth] Resend limit hit for email:', normalizedEmail);
      await enforceMinResponseTime(startedAt);
      return res.status(429).json({
        success: false,
        message: 'You\'ve requested too many links. Please wait a few minutes before trying again.',
      });
    }

    // IP rate limit applies here too
    const ipCheck = checkIpRateLimit(clientIp);
    if (!ipCheck.allowed) {
      await enforceMinResponseTime(startedAt);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please wait a moment before trying again.',
      });
    }

    // Look up the user — enumeration-safe: always return same message
    const userResult = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    if (userResult.rows.length > 0) {
      const userId = userResult.rows[0].id;
      const token = auth.generateToken();
      const tokenHash = auth.hashToken(token);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const ua = req.headers['user-agent'];
      const browser = parseUserAgent(ua);
      const ipHash = auth.hashContext(clientIp);
      const locationPromise = getIpLocation(clientIp);

      await pool.query(
        `INSERT INTO magic_links (user_id, token, email, expires_at, ip_hash, user_agent, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [userId, tokenHash, normalizedEmail, expiresAt, ipHash, ua ? ua.slice(0, 512) : null]
      );

      const location = await locationPromise;
      // pool passed for Layer 5 provider-health event emission
      const emailResult = await auth.sendMagicLinkEmail(normalizedEmail, token, { browser, location }, pool);

      if (!emailResult || !emailResult.sent) {
        console.error('[Auth] Magic link resend NOT delivered to', normalizedEmail, '— reason:', emailResult && emailResult.reason);
        await enforceMinResponseTime(startedAt);
        return res.status(500).json({
          success: false,
          message: 'Failed to send email. Please try again.',
          reason: emailResult && emailResult.reason
        });
      }

      console.log('[Auth] Email resent successfully — MessageID:', emailResult.messageId);
    }

    await enforceMinResponseTime(startedAt);
    res.json({ success: true, message: ENUM_SAFE_MSG });
  } catch (err) {
    console.error('[Auth] resend error:', err);
    await enforceMinResponseTime(startedAt);
    res.status(500).json({
      success: false,
      message: 'Failed to send magic link. Please try again.',
      reason: err.message,
      postmark_error_code: err.errorCode || null
    });
  }
});

// GET /api/auth/challenge — generate a signed math challenge for abuse-flagged IPs
app.get('/api/auth/challenge', (req, res) => {
  const clientIp = getClientIp(req);
  if (!shouldShowChallenge(clientIp)) {
    return res.json({ required: false });
  }

  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const answer = String(a + b);
  const encoded = Buffer.from(answer).toString('base64');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(encoded).digest('hex');

  res.json({
    required: true,
    question: `What is ${a} + ${b}?`,
    token: `${encoded}.${sig}`,
  });
});

// GET /auth/verify — verify magic link token and create session
app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  const clientIp = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  if (!token) {
    return sendVerifyError(res, 'missing');
  }

  try {
    const tokenHash = auth.hashToken(token);
    const ipHash = auth.hashContext(clientIp);

    // ── Atomic single-use consumption ───────────────────────────────────────
    // UPDATE only succeeds if token exists, hasn't been used, and hasn't expired.
    // Two simultaneous clicks: exactly one UPDATE wins; the other gets 0 rows.
    const { rows: consumed } = await pool.query(
      `UPDATE magic_links
       SET used_at = NOW(), status = 'used'
       WHERE token = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING id, user_id, email, ip_hash, user_agent, expires_at`,
      [tokenHash]
    );

    if (consumed.length === 0) {
      // Token wasn't consumed atomically — figure out why for the UX response
      const { rows: diagnostic } = await pool.query(
        `SELECT id, user_id, email, used_at, expires_at, status
         FROM magic_links WHERE token = $1`,
        [tokenHash]
      );

      if (diagnostic.length === 0) {
        // Never existed or already cleaned up
        await auth.logSecurityEvent(pool, 'token_invalid', {
          ipHash, userAgent: ua,
          metadata: { tokenHashPrefix: tokenHash.slice(0, 8) }
        });
        return sendVerifyError(res, 'invalid');
      }

      const row = diagnostic[0];

      if (row.used_at) {
        // Token was already consumed — potential forwarding/replay attack
        await auth.logSecurityEvent(pool, 'token_reuse_attempt', {
          userId: row.user_id, email: row.email,
          ipHash, userAgent: ua,
          metadata: { originalUsedAt: row.used_at }
        });
        return sendVerifyError(res, 'used', row.email);
      }

      // Otherwise it expired between generation and click
      await pool.query(
        `UPDATE magic_links SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
        [row.id]
      );
      await auth.logSecurityEvent(pool, 'token_expired', {
        userId: row.user_id, email: row.email, ipHash, userAgent: ua
      });
      return sendVerifyError(res, 'expired', row.email);
    }

    const link = consumed[0];

    // ── Soft context mismatch check ─────────────────────────────────────────
    // Log mismatches for fraud radar but never block — forwarded links are legitimate.
    if (link.ip_hash && link.ip_hash !== ipHash) {
      await auth.logSecurityEvent(pool, 'context_mismatch_ip', {
        userId: link.user_id, email: link.email,
        ipHash, userAgent: ua,
        metadata: { originIpHash: link.ip_hash }
      });
      console.warn('[Auth] IP mismatch on verify — userId:', link.user_id);
    }

    // ── Sibling token invalidation ──────────────────────────────────────────
    // Invalidate all other unused pending tokens for this email.
    // Prevents token accumulation / forwarding attacks.
    await pool.query(
      `UPDATE magic_links SET used_at = NOW(), status = 'expired'
       WHERE email = $1
         AND id != $2
         AND used_at IS NULL
         AND status = 'pending'`,
      [link.email, link.id]
    );

    // ── Update last_login_at ────────────────────────────────────────────────
    await pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [link.user_id]
    );

    // ── Session rotation — new session ID on every login ───────────────────
    const sessionId = await auth.createSession(pool, link.user_id, link.email, {
      ipHash, userAgent: ua
    });
    const sessionJwt = auth.signSession(link.user_id, link.email, sessionId);

    // ── Security event: successful login ───────────────────────────────────
    await auth.logSecurityEvent(pool, 'login_success', {
      userId: link.user_id, email: link.email,
      ipHash, userAgent: ua, sessionId
    });

    console.log('[Auth] Login success — userId:', link.user_id, 'session:', sessionId.slice(0, 8) + '…');

    // Set session cookie and redirect
    res.cookie(auth.COOKIE_NAME, sessionJwt, auth.COOKIE_OPTIONS);
    res.redirect('/new');
  } catch (err) {
    console.error('[Auth] verify error:', err);
    sendVerifyError(res, 'server');
  }
});

// GET /auth/logout — revoke session, clear cookie, redirect to signup
app.get('/auth/logout', async (req, res) => {
  const token = req.cookies && req.cookies[auth.COOKIE_NAME];
  if (token) {
    const payload = auth.verifySession(token);
    if (payload && payload.sessionId) {
      // Revoke server-side session (fire-and-forget — don't block the redirect)
      auth.revokeSession(pool, payload.sessionId).catch(err =>
        console.error('[Auth] logout revokeSession failed:', err.message)
      );
      auth.logSecurityEvent(pool, 'logout', {
        userId: payload.userId, email: payload.email,
        sessionId: payload.sessionId,
        ipHash: auth.hashContext(getClientIp(req))
      }).catch(() => {});
    }
  }
  res.clearCookie(auth.COOKIE_NAME);
  res.redirect('/signup');
});

// POST /api/auth/revoke-all — kill all active sessions for the current user (instant kill switch)
app.post('/api/auth/revoke-all', async (req, res) => {
  const token = req.cookies && req.cookies[auth.COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  const payload = auth.verifySession(token);
  if (!payload) return res.status(401).json({ success: false, message: 'Invalid session' });

  try {
    const count = await auth.revokeAllSessions(pool, payload.userId);
    await auth.logSecurityEvent(pool, 'revoke_all_sessions', {
      userId: payload.userId, email: payload.email,
      ipHash: auth.hashContext(getClientIp(req)),
      userAgent: req.headers['user-agent'],
      metadata: { sessionsRevoked: count }
    });
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ success: true, sessionsRevoked: count });
  } catch (err) {
    console.error('[Auth] revoke-all error:', err);
    res.status(500).json({ success: false, message: 'Failed to revoke sessions' });
  }
});

// ── API Token endpoints (CLI / headless Bearer token access) ──────────────────
//
// POST /auth/api-token  — mint a new bo_live_ / bo_mock_ token (session auth required)
// GET  /auth/api-tokens — list active tokens for the session user (no raw values)
// DELETE /auth/api-token/:id — revoke a token by id (session user must own it)

app.post('/auth/api-token', auth.requireApiAuth, async (req, res) => {
  const { label, expires_in } = req.body || {};
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  try {
    const result = await auth.createApiToken(pool, userId, { label, expires_in });
    res.json({
      token:      result.token,
      label:      result.label,
      expires_at: result.expires_at,
      created_at: result.created_at
    });
  } catch (err) {
    if (err.code === 'TOKEN_LIMIT_EXCEEDED') {
      return res.status(429).json({ success: false, message: err.message });
    }
    console.error('[Auth] create api-token error:', err);
    res.status(500).json({ success: false, message: 'Failed to create API token' });
  }
});

app.get('/auth/api-tokens', auth.requireApiAuth, async (req, res) => {
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  try {
    const tokens = await auth.listApiTokens(pool, userId);
    res.json({ success: true, tokens });
  } catch (err) {
    console.error('[Auth] list api-tokens error:', err);
    res.status(500).json({ success: false, message: 'Failed to list API tokens' });
  }
});

app.delete('/auth/api-token/:id', auth.requireApiAuth, async (req, res) => {
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const { id } = req.params;
  // Basic UUID validation
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, message: 'Invalid token id' });
  }

  try {
    const revoked = await auth.revokeApiToken(pool, id, userId);
    if (!revoked) {
      return res.status(404).json({ success: false, message: 'Token not found or already revoked' });
    }
    res.json({ success: true, message: 'Token revoked' });
  } catch (err) {
    console.error('[Auth] revoke api-token error:', err);
    res.status(500).json({ success: false, message: 'Failed to revoke API token' });
  }
});

// GET /auth/verify-key — validate a Bearer API token (used by CLI login to confirm key is valid)
// Returns user info if valid, 401 if not. Accepts only Bearer tokens (no session fallback).
app.get('/auth/verify-key', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Bearer token required' });
  }
  const rawToken = authHeader.slice(7).trim();
  if (!rawToken.startsWith('bo_live_') && !rawToken.startsWith('bo_mock_') && !rawToken.startsWith('bk_')) {
    return res.status(401).json({ success: false, message: 'Invalid token format' });
  }
  try {
    const tokenData = await auth.validateApiToken(pool, rawToken);
    if (!tokenData) {
      return res.status(401).json({ success: false, message: 'Invalid or expired API token' });
    }
    // Return user email for CLI confirmation message
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [tokenData.userId]);
    const email = rows[0] ? rows[0].email : null;
    res.json({ success: true, userId: tokenData.userId, email, expires_at: tokenData.expires_at });
  } catch (err) {
    console.error('[Auth] verify-key error:', err);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ── Password Authentication (Stage 2) ────────────────────────────────────
// POST /auth/set-password — set or update password for an authenticated user
// POST /auth/login        — email+password login, rate-limited, issues same session cookie

// POST /auth/set-password — requires active session
app.post('/auth/set-password', auth.requireApiAuth, async (req, res) => {
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const { password } = req.body || {};

  // Minimum 8 characters — bcrypt truncates input at 72 bytes, so no arbitrary max
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 8 characters.'
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    );

    await auth.logSecurityEvent(pool, 'password_set', {
      userId,
      ipHash: auth.hashContext(getClientIp(req)),
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] set-password error:', err);
    res.status(500).json({ success: false, message: 'Failed to set password' });
  }
});

// POST /auth/login — email + password with rate limiting
app.post('/auth/login', validatePasswordLogin, async (req, res) => {
  const { email, password } = req.body || {};

  // Generic input validation
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const emailKey = String(email).toLowerCase().trim();
  const clientIp = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  // ── Rate limiting: 5 attempts per email per 15 minutes ────────────────
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const rateLimitEntry = passwordLoginRateLimit.get(emailKey);

  if (rateLimitEntry) {
    const elapsed = now - rateLimitEntry.windowStart;
    if (elapsed < windowMs) {
      if (rateLimitEntry.count >= 5) {
        const retryAfter = Math.ceil((windowMs - elapsed) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          success: false,
          message: `Too many login attempts. Try again in ${retryAfter} seconds.`
        });
      }
      rateLimitEntry.count++;
    } else {
      // Window expired — reset
      passwordLoginRateLimit.set(emailKey, { count: 1, windowStart: now });
    }
  } else {
    passwordLoginRateLimit.set(emailKey, { count: 1, windowStart: now });
  }

  // ── 300ms minimum response time to foil timing oracles ───────────────
  const minDelayMs = 300;
  const delayStart = Date.now();

  try {
    // Look up user by email
    const { rows: userRows } = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
      [emailKey]
    );

    if (!userRows.length) {
      await auth.logSecurityEvent(pool, 'login_failure', {
        email: emailKey, ipHash: auth.hashContext(clientIp), userAgent: ua,
        metadata: { reason: 'user_not_found' }
      });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, minDelayMs - (Date.now() - delayStart))));
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = userRows[0];

    if (!user.password_hash) {
      await auth.logSecurityEvent(pool, 'login_failure', {
        userId: user.id, email: emailKey, ipHash: auth.hashContext(clientIp), userAgent: ua,
        metadata: { reason: 'password_not_set' }
      });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, minDelayMs - (Date.now() - delayStart))));
      return res.status(401).json({
        success: false,
        message: 'Password not set. Use magic link to sign in, then set a password.'
      });
    }

    // bcrypt.compare — constant-time comparison
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      await auth.logSecurityEvent(pool, 'login_failure', {
        userId: user.id, email: emailKey, ipHash: auth.hashContext(clientIp), userAgent: ua,
        metadata: { reason: 'bad_password' }
      });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, minDelayMs - (Date.now() - delayStart))));
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // ── Login success — create session (identical to magic link flow) ────
    const ipHash = auth.hashContext(clientIp);
    const sessionId = await auth.createSession(pool, user.id, user.email, { ipHash, userAgent: ua });
    const sessionJwt = auth.signSession(user.id, user.email, sessionId);

    // Update last_login_at
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    await auth.logSecurityEvent(pool, 'login_success', {
      userId: user.id, email: user.email, ipHash, userAgent: ua, sessionId
    });

    console.log('[Auth] Password login success — userId:', user.id, 'session:', sessionId.slice(0, 8) + '…');

    res.cookie(auth.COOKIE_NAME, sessionJwt, auth.COOKIE_OPTIONS);
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] login error:', err);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// POST /auth/signup | POST /api/auth/register
// Create account with email + password (no session required).
// Both paths are identical — /api/auth/register is the canonical REST alias.
app.post(['/auth/signup', '/api/auth/register'], async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  const emailKey = String(email).toLowerCase().trim();
  const clientIp = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  // Reuse login rate limiter (5 attempts per email per 15 min)
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const rateLimitEntry = passwordLoginRateLimit.get(emailKey);

  if (rateLimitEntry) {
    const elapsed = now - rateLimitEntry.windowStart;
    if (elapsed < windowMs) {
      if (rateLimitEntry.count >= 5) {
        const retryAfter = Math.ceil((windowMs - elapsed) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          success: false,
          message: `Too many attempts. Try again in ${retryAfter} seconds.`
        });
      }
      rateLimitEntry.count++;
    } else {
      passwordLoginRateLimit.set(emailKey, { count: 1, windowStart: now });
    }
  } else {
    passwordLoginRateLimit.set(emailKey, { count: 1, windowStart: now });
  }

  // Disposable email check
  if (isDisposableEmail(emailKey)) {
    return res.status(400).json({ success: false, message: 'Please use a valid email address.' });
  }

  try {
    // Check if user already has a password set
    const { rows: existing } = await pool.query(
      'SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
      [emailKey]
    );

    if (existing.length && existing[0].password_hash) {
      return res.status(409).json({
        success: false,
        message: 'Account already exists. Please sign in.',
        code: 'ACCOUNT_EXISTS'
      });
    }

    // Upsert user — new registrations start on 'trial' with 10 task_credits
    const upsertResult = await pool.query(
      `INSERT INTO users (email, subscription_status, task_credits)
          VALUES ($1, 'trial', 10)
       ON CONFLICT (LOWER(email)) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [emailKey]
    );
    const userId = upsertResult.rows[0].id;

    // Set password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);

    // Create session (identical to login flow)
    const ipHash = auth.hashContext(clientIp);
    const sessionId = await auth.createSession(pool, userId, emailKey, { ipHash, userAgent: ua });
    const sessionJwt = auth.signSession(userId, emailKey, sessionId);

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);

    await auth.logSecurityEvent(pool, 'signup_password', {
      userId, email: emailKey, ipHash, userAgent: ua, sessionId
    });

    console.log('[Auth] Password signup success — userId:', userId, 'session:', sessionId.slice(0, 8) + '…');

    // Fire-and-forget welcome email — never block the signup response
    sendWelcomeEmail(emailKey).catch(err =>
      console.error('[Auth] Welcome email fire-and-forget error:', err.message)
    );

    res.cookie(auth.COOKIE_NAME, sessionJwt, auth.COOKIE_OPTIONS);
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] signup error:', err);
    res.status(500).json({ success: false, message: 'Signup failed. Please try again.' });
  }
});


// POST /auth/forgot-password | POST /api/auth/forgot-password
// Generates a 30-minute password reset token and emails it.
// Enumeration-safe: always returns the same message whether the email exists or not.
app.post(['/auth/forgot-password', '/api/auth/forgot-password'], async (req, res) => {
  const SAFE_MSG = 'If that email is registered, a reset link has been sent.';
  const { email } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }

  const emailKey = String(email).toLowerCase().trim();

  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [emailKey]
    );

    if (rows.length) {
      const userId = rows[0].id;
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

      // Invalidate any existing unused tokens for this user
      await pool.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId]
      );

      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, email, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, tokenHash, emailKey, expiresAt]
      );

      const resetUrl = `${APP_URL}/auth/reset-password?token=${rawToken}`;

      // Fire-and-forget — never block response on email delivery
      sendPasswordResetEmail(emailKey, resetUrl).catch(err =>
        console.error('[Auth] Password reset email error:', err.message)
      );

      console.log('[Auth] Password reset token issued for userId:', userId);
    }

    // Always return the same message (enumeration resistance)
    res.json({ success: true, message: SAFE_MSG });
  } catch (err) {
    console.error('[Auth] forgot-password error:', err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// POST /auth/reset-password | POST /api/auth/reset-password
// Validates reset token, updates password, invalidates token.
app.post(['/auth/reset-password', '/api/auth/reset-password'], async (req, res) => {
  const { token, password } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'Reset token is required.' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );

    if (!rows.length || rows[0].used_at || new Date(rows[0].expires_at) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This reset link is invalid or has expired. Request a new one.'
      });
    }

    const { id: tokenId, user_id: userId } = rows[0];

    // Mark token used (atomic — prevents replay)
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL`,
      [tokenId]
    );

    // Update password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);

    // Revoke all existing sessions for security
    await auth.revokeAllSessions(pool, userId).catch(() => {});

    console.log('[Auth] Password reset completed for userId:', userId);
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    console.error('[Auth] reset-password error:', err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/me — return current user from validated JWT session cookie
// Uses requireApiAuth (JSON 401) not requireAuth (HTML redirect)
app.get('/api/auth/me', auth.requireApiAuth, async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const { rows } = await pool.query(
      `SELECT id, email, subscription_status, task_credits, created_at
         FROM users WHERE id = $1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = rows[0];
    res.json({
      success: true,
      user: {
        id:                  user.id,
        email:               user.email,
        subscription_status: user.subscription_status || 'trial',
        task_credits:        user.task_credits ?? 10,
        created_at:          user.created_at,
      }
    });
  } catch (err) {
    console.error('[Auth] /api/auth/me error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
});

// GET /pricing — serve pricing page
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// GET /terms — serve terms of service
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// GET /privacy — serve privacy policy
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// GET /pipeline — serve pipeline overview page
app.get('/pipeline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pipeline.html'));
});

// GET /api — serve API overview page
app.get('/api', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api.html'));
});

// GET /enterprise — serve enterprise solutions page
app.get('/enterprise', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'enterprise.html'));
});

// GET /legal — serve legal solutions page
app.get('/legal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal.html'));
});

// GET /finance — serve finance solutions page
app.get('/finance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'finance.html'));
});

// GET /healthcare — serve healthcare solutions page
app.get('/healthcare', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'healthcare.html'));
});

// GET /about — serve about page
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// GET /careers — serve careers page
app.get('/careers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'careers.html'));
});

// GET /docs — serve docs page
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// GET /blog — serve blog page
app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog.html'));
});

// GET /case-studies — serve case studies page
app.get('/case-studies', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'case-studies.html'));
});

// GET /signup — serve signup page (redirect to /new if already logged in)
app.get('/signup', (req, res) => {
  const token = req.cookies && req.cookies[auth.COOKIE_NAME];
  if (token && auth.verifySession(token)) {
    return res.redirect('/new');
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// ── Deployed Sites ───────────────────────────────────────
// Serve deployed build artifacts at /live/:runId/
// Files live in ./deployed/:runId/current/ after a successful deploy
app.use('/live/:runId', (req, res, next) => {
  const { runId } = req.params;
  // Basic UUID validation to prevent path traversal
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).send('Invalid run ID');
  }
  const currentDir = path.join(DEPLOY_BASE, runId, 'current');
  if (!fs.existsSync(currentDir)) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html><head><title>Not Found — BuildOrbit</title>
      <style>body{font-family:system-ui;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{text-align:center;padding:3rem}h1{font-size:2rem;color:#ef4444;margin-bottom:1rem}
      a{color:#00e5a0;text-decoration:none}</style></head>
      <body><div class="box"><h1>404 — Not Deployed</h1>
      <p>This run hasn't been deployed yet, or the deployment was removed.</p>
      <p style="margin-top:1rem"><a href="/dashboard">← Back to Dashboard</a></p>
      </div></body></html>
    `);
  }
  express.static(currentDir, {
    index: 'index.html',
    fallthrough: false,
  })(req, res, next);
});

// ── In-Progress Preview Sites ─────────────────────────────
// Serve CODE-phase artifacts at /preview/:runId/ so the iframe can show the
// app while VERIFY runs — before a full deploy is complete.
// Files written by DeployEngine.writePreview() after CODE stage completes.
app.use('/preview/:runId', (req, res, next) => {
  const { runId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).send('Invalid run ID');
  }
  const previewDir = path.join(PREVIEW_BASE, runId);
  if (!fs.existsSync(previewDir)) {
    return res.status(404).send('Preview not ready');
  }
  express.static(previewDir, {
    index: 'index.html',
    fallthrough: false,
  })(req, res, next);
});

// ── PRODUCT_SYSTEM Live Apps ─────────────────────────────
// Reverse-proxy /app/:runId/* to the running Node.js child process.
// Each PRODUCT_SYSTEM deploy spawns its own process on a private port
// managed by NodeAppRunner. We forward the full HTTP request including
// headers, body, and method — so the app behaves exactly as if it were
// accessed directly.
app.use('/app/:runId', (req, res) => {
  const { runId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).send('Invalid run ID');
  }

  const port = nodeAppRunner.getPort(runId);
  if (!port) {
    return res.status(503).send(`
      <!DOCTYPE html>
      <html><head><title>App Not Running — BuildOrbit</title>
      <style>body{font-family:system-ui;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{text-align:center;padding:3rem}h1{font-size:2rem;color:#ef4444;margin-bottom:1rem}p{color:#94a3b8}
      a{color:#00e5a0;text-decoration:none}</style></head>
      <body><div class="box"><h1>App Not Running</h1>
      <p>This app is not currently running. It may have been stopped to free resources,<br>or it hasn't finished deploying yet.</p>
      <p style="margin-top:1rem"><a href="/dashboard">← Back to Dashboard</a></p>
      </div></body></html>
    `);
  }

  // Forward request to the child process
  // req.url inside app.use('/app/:runId', ...) is the path AFTER the matched prefix
  const targetPath = req.url || '/';
  const options = {
    hostname: '127.0.0.1',
    port,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${port}`,
      'x-forwarded-for': req.ip || '',
      'x-forwarded-proto': 'https',
      'x-buildorbit-run-id': runId,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[AppProxy] Error for run ${runId.slice(0, 8)}: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).send('App error — unable to reach the running process');
    }
  });

  // Pipe request body (for POST/PUT/PATCH)
  req.pipe(proxyReq);
});

// ── CLI Distribution Routes (no auth required) ───────────────────────────
// GET /cli/version       — plain-text CLI version
// GET /cli/install.sh    — curl-pipe install script
// GET /cli/buildorbit.tar.gz — served by static middleware below (public/cli/)
app.use('/cli', cliRouter);

// ── Multi-Page Routes ──────────────────────────────────────────────────────
function runReactBuildCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: REACT_FRONTEND_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function ensureReactBuildForRequest() {
  if (fs.existsSync(REACT_BUILD_INDEX)) return true;

  console.warn(`[static] Missing React build at ${REACT_BUILD_INDEX}; attempting on-demand build.`);
  try {
    if (!fs.existsSync(REACT_FRONTEND_NODE_MODULES)) {
      runReactBuildCommand('npm', ['ci', '--include=dev']);
    }
    runReactBuildCommand('npm', ['run', 'build']);
  } catch (err) {
    console.error(`[static] React build failed: ${err.message}`);
    return false;
  }

  return fs.existsSync(REACT_BUILD_INDEX);
}

// All authenticated pages route to the React SPA shell. The Vite bundle is
// generated during deployment, with this fallback covering misconfigured starts.
const serveSPA = (req, res) => {
  if (!ensureReactBuildForRequest()) {
    console.error(`[static] Missing React build at ${REACT_BUILD_INDEX}. Run npm run build before starting the server.`);
    return res.status(503).send('React dashboard build is missing. Run npm run build before starting the server.');
  }
  return res.sendFile(REACT_BUILD_INDEX);
};
app.get('/dashboard', serveSPA);
app.get('/new', serveSPA);
// Redirect /new-task → /new (bookmark safety, old links)
app.get('/new-task', (req, res) => res.redirect('/new'));
app.get('/history', serveSPA);
app.get('/settings', serveSPA);
app.get('/admin', serveSPA);
app.get('/overview', serveSPA);
app.get('/videos', serveSPA);
app.get('/run/:id', serveSPA);

// Serve static files (disable index to use custom / route)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Billing API ─────────────────────────────────────────
const createBillingRouter = require('./src/routes/billing');
app.use('/api/billing', createBillingRouter({ pool, auth }));

// ── Admin API ────────────────────────────────────────────
app.use('/api/admin', createAdminRouter({ pool, auth }));

// ── GitHub OAuth + API ───────────────────────────────────
const { createGitHubRouters } = require('./src/routes/github');
const { oauthRouter: githubOAuthRouter, apiRouter: githubApiRouter } = createGitHubRouters({ pool, auth });
// OAuth flow: GET /auth/github → redirect, GET /auth/github/callback → token exchange
app.use('/auth/github', githubOAuthRouter);
// REST API: GET /api/github/status, GET /api/github/repos, POST /api/github/repos
app.use('/api/github', githubApiRouter);
// GitHub settings page (served by React SPA)
app.get('/github', serveSPA);


// ── Pipeline API ────────────────────────────────────────
// All /api/pipeline/* routes require a valid session
app.use('/api/pipeline', auth.requireApiAuth);
// CSRF: protect cookie-authenticated pipeline mutations.
// Bearer-token requests are exempt (requireCsrf checks Authorization header).
app.use('/api/pipeline', requireCsrf);

// Create a new pipeline run and enqueue it
app.post('/api/pipeline', validateRunCreate, async (req, res) => {
  try {
    const { prompt, budgetCap, budgetWarning, runConfig, productContext,
            github_repo, github_create_repo, github_repo_private,
            source_repo } = req.body;
    // Prompt is optional when building from an existing repo — the repo's
    // contents serve as the prompt context, and we auto-generate a default.
    if ((!prompt || !prompt.trim()) && !source_repo) {
      return res.status(400).json({ success: false, message: 'Prompt is required' });
    }

    // Parse and validate budget options (optional)
    const cap = budgetCap != null ? parseFloat(budgetCap) : null;
    const warn = budgetWarning != null ? parseFloat(budgetWarning) : null;
    const budgetOpts = {
      budgetCap:     (cap  > 0) ? cap  : null,
      budgetWarning: (warn > 0) ? warn : null,
    };

    // Run configuration: model selection, constraints, etc.
    const config = runConfig && typeof runConfig === 'object' ? runConfig : {};

    // Product context: per-run injection for accurate content generation.
    // Priority: explicit per-run value > already in runConfig > env fallback.
    if (productContext && typeof productContext === 'object' && !config.productContext) {
      config.productContext = productContext;
    }
    if (!config.productContext && process.env.PRODUCT_CONTEXT_JSON) {
      try {
        const envCtx = JSON.parse(process.env.PRODUCT_CONTEXT_JSON);
        if (envCtx && typeof envCtx === 'object') config.productContext = envCtx;
      } catch (_) { /* invalid JSON in env — ignore */ }
    }

    // When building from an existing repo with no explicit prompt, use the repo name
    // as a minimal label. Full codebase context flows through productContext — no
    // verbose generic instruction needed here.
    const effectivePrompt = (prompt && prompt.trim())
      ? prompt.trim()
      : (source_repo ? `Improve ${source_repo}` : '');

    const id = await pipeline.createRun(effectivePrompt, budgetOpts);

    // Persist run config and user attribution to DB
    const userId = req.user?.userId || null;

    if (Object.keys(config).length > 0) {
      await pool.query(
        'UPDATE pipeline_runs SET run_config = $1, user_id = $2 WHERE id = $3',
        [JSON.stringify(config), userId, id]
      );
    } else if (userId) {
      pool.query('UPDATE pipeline_runs SET user_id = $1 WHERE id = $2', [userId, id]).catch(() => {});
    }

    // Persist GitHub repo selection (migration 029 adds these columns)
    if (github_repo && typeof github_repo === 'string') {
      pool.query(
        `UPDATE pipeline_runs
            SET github_repo = $1,
                github_create_repo = $2,
                github_repo_private = $3
          WHERE id = $4`,
        [
          github_repo.slice(0, 200),
          Boolean(github_create_repo),
          Boolean(github_repo_private),
          id,
        ]
      ).catch(() => {}); // fire-and-forget; non-critical

      // Scan the target repo's tech stack so the pipeline knows what it's
      // working with BEFORE scaffolding — prevents React files being generated
      // for C#/Go/Python repos. Falls back gracefully if GitHub is unreachable.
      if (userId) {
        try {
          const { scanRepoProfile } = require('./src/services/repo-scanner');
          const repoProfile = await scanRepoProfile({ pool, userId, repoFullName: github_repo.slice(0, 200) });
          if (repoProfile) {
            // Store as top-level config key — orchestrator injects into previousOutputs
            config._repoProfile = repoProfile;
            console.log(`[Pipeline] Repo profile scanned for run ${id.slice(0,8)}: ${repoProfile.language}/${repoProfile.framework || 'unknown'} (isWeb=${repoProfile.isWebProject})`);

            // Persist updated config immediately so retry/recovery picks it up
            await pool.query(
              'UPDATE pipeline_runs SET run_config = $1 WHERE id = $2',
              [JSON.stringify(config), id]
            ).catch(() => {});
          }
        } catch (scanErr) {
          // Non-fatal — pipeline runs with prompt-based detection as fallback
          console.warn(`[Pipeline] Repo profile scan failed for run ${id.slice(0,8)} (non-fatal): ${scanErr.message}`);
        }
      }
    }

    // Persist + fetch source_repo context (migration 031 adds this column).
    // When a source repo is provided, fetch its file tree and key files before
    // enqueuing — the context is injected into the PLAN prompt so the pipeline
    // understands the existing codebase it is extending.
    if (source_repo && typeof source_repo === 'string' && userId) {
      const cleanSourceRepo = source_repo.slice(0, 200);
      pool.query(
        'UPDATE pipeline_runs SET source_repo = $1 WHERE id = $2',
        [cleanSourceRepo, id]
      ).catch(() => {});

      try {
        const { fetchRepoContext } = require('./src/services/github-fetch');
        const repoCtx = await fetchRepoContext({ pool, userId, repoFullName: cleanSourceRepo });
        // Inject as productContext so PlannerAgent picks it up
        if (!config.productContext) config.productContext = {};
        config.productContext._sourceRepo = repoCtx.summary;
        config.productContext._sourceRepoFullName = repoCtx.repoFullName;
        // FIX (#1497201): Pass full file tree — was .slice(0, 100) which silently dropped
        // files in larger repos. The file tree is just paths (strings), not content,
        // so even 500 paths is only ~20KB. Content budget is controlled downstream.
        config.productContext._sourceRepoFileTree = repoCtx.fileTree;
        // Also set the PR target repo to the same repo (user can override in UI)
        if (!github_repo && !config.skipAutoGithubLink) {
          pool.query(
            `UPDATE pipeline_runs SET github_repo = $1, github_create_repo = false WHERE id = $2`,
            [cleanSourceRepo, id]
          ).catch(() => {});
        }
        console.log(`[Pipeline] Source repo context fetched for run ${id.slice(0,8)}: ${cleanSourceRepo} (${repoCtx.totalFiles} files, ${repoCtx.fetchedFiles} fetched)`);
      } catch (repoErr) {
        // Non-fatal — pipeline runs without source context on failure
        console.warn(`[Pipeline] Failed to fetch source repo context for run ${id.slice(0,8)}: ${repoErr.message}`);
      }

      // Persist updated config with source repo context
      await pool.query(
        'UPDATE pipeline_runs SET run_config = $1 WHERE id = $2',
        [JSON.stringify(config), id]
      ).catch(() => {});
    }

    // Analytics: TASK_SUBMITTED (fire-and-forget)
    analytics.emitEvent(pool, 'TASK_SUBMITTED', userId, {
      run_id:        id,
      prompt_length: effectivePrompt.length,
    });

    // ── Credit enforcement ────────────────────────────────────────────────
    // Atomically decrement task_credits.  If the user has no credits, block
    // the run immediately with a clear upgrade message.
    // Admin users bypass credit enforcement entirely (unlimited builds).
    if (userId) {
      // Check admin status — env var takes precedence for bootstrapping,
      // then fall back to the is_admin DB column.
      const adminEnvIds = (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n > 0);
      const isAdminByEnv = adminEnvIds.includes(userId);

      let isAdmin = isAdminByEnv;
      if (!isAdmin) {
        try {
          const { rows: adminRows } = await pool.query(
            'SELECT is_admin FROM users WHERE id = $1',
            [userId]
          );
          isAdmin = adminRows.length > 0 && adminRows[0].is_admin === true;
        } catch (_) { /* column may not exist yet — treat as non-admin */ }
      }

      if (!isAdmin) {
        const creditResult = await pool.query(
          `UPDATE users
              SET task_credits = task_credits - 1
            WHERE id = $1 AND task_credits > 0
            RETURNING task_credits`,
          [userId]
        );
        if (creditResult.rowCount === 0) {
          // No credits remaining — cancel the run record and return 402
          await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [id]).catch(() => {});
          return res.status(402).json({
            success: false,
            code:    'no_credits',
            message: "You've used all your credits. Upgrade to continue.",
            upgrade_url: '/pricing',
          });
        }
      }
    }

    // Enqueue via orchestrator, pass budget opts and run config
    orchestrator.enqueue(id, effectivePrompt, budgetOpts, config);

    res.json({ success: true, id, budgetOpts, runConfig: config });
  } catch (err) {
    console.error('[API] Error creating pipeline run:', err);
    res.status(500).json({ success: false, message: 'Failed to create pipeline run' });
  }
});

// Retry a failed pipeline run
app.post('/api/pipeline/:runId/retry', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;

    // Reload budget opts from DB so cost tracking is re-initialized correctly on retry
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    if (run) {
      costTracker.initRun(runId, {
        budgetCap:     run.budget_cap     ? parseFloat(run.budget_cap)     : null,
        budgetWarning: run.budget_warning ? parseFloat(run.budget_warning) : null,
      });
    }

    const result = await orchestrator.retry(runId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[API] Error retrying pipeline:', err);
    res.status(500).json({ success: false, message: 'Failed to retry pipeline run' });
  }
});

// ── Intervention Controls ─────────────────────────────────

// Pause an active pipeline run
app.post('/api/pipeline/:runId/pause', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    // Verify ownership before allowing pause
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const result = orchestrator.pause(runId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[API] Error pausing pipeline:', err);
    res.status(500).json({ success: false, message: 'Failed to pause pipeline' });
  }
});

// Resume a paused pipeline run
app.post('/api/pipeline/:runId/resume', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    // Verify ownership before allowing resume
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    // resume() may return a Promise if the run needs DB recovery
    const result = await Promise.resolve(orchestrator.resume(runId));
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[API] Error resuming pipeline:', err);
    res.status(500).json({ success: false, message: 'Failed to resume pipeline' });
  }
});

// Inject an instruction directive for the next stage
app.post('/api/pipeline/:runId/inject', async (req, res) => {
  try {
    const { runId } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'message is required' });
    }
    const userId = req.user?.userId || null;
    // Verify ownership before allowing inject
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const result = await orchestrator.inject(runId, message);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[API] Error injecting instruction:', err);
    res.status(500).json({ success: false, message: 'Failed to inject instruction' });
  }
});

// Set a one-shot agent override
app.post('/api/pipeline/:runId/override', async (req, res) => {
  try {
    const { runId } = req.params;
    const { agent, prompt } = req.body;
    if (!agent || !prompt) {
      return res.status(400).json({ success: false, message: 'agent and prompt are required' });
    }
    const userId = req.user?.userId || null;
    // Verify ownership before allowing override
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const result = await orchestrator.override(runId, agent, prompt);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[API] Error setting agent override:', err);
    res.status(500).json({ success: false, message: 'Failed to set agent override' });
  }
});

// Override a catastrophic rewrite block — explicit user confirmation required.
// Returns 200 and re-enqueues the SAVE stage. The block stats are preserved in
// catastrophic_block.override_count so every confirmation is logged.
app.post('/api/pipeline/:runId/override-catastrophic-block', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;

    // Verify ownership
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    // Confirm there is an active block
    const blockRow = await pool.query(
      `SELECT catastrophic_block FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    const blockData = blockRow.rows[0]?.catastrophic_block;
    if (!blockData) {
      return res.status(400).json({ success: false, message: 'No catastrophic block is active for this run' });
    }

    // Increment override counter and record who confirmed
    const updatedBlock = {
      ...blockData,
      override_count:    (blockData.override_count || 0) + 1,
      override_at:       new Date().toISOString(),
      override_by_user:  userId,
    };
    await pool.query(
      `UPDATE pipeline_runs SET catastrophic_block = $1 WHERE id = $2`,
      [JSON.stringify(updatedBlock), runId]
    );

    // Log the override in pipeline_interventions for the audit trail
    await pool.query(
      `INSERT INTO pipeline_interventions (run_id, type, payload)
       VALUES ($1, 'catastrophic_override', $2)`,
      [runId, JSON.stringify({
        reason:         blockData.reason,
        stats_summary: {
          deletedFileCount: blockData.stats?.deletedFileCount,
          rewrittenRatio:   blockData.stats?.rewrittenRatio,
          topologyDelta:    blockData.stats?.topologyDelta,
          removedPackageCount: blockData.stats?.removedPackageCount,
        },
        confirmed_by: userId,
        confirmed_at: new Date().toISOString(),
      })]
    ).catch((e) => console.warn('[API] Failed to log catastrophic override intervention:', e.message));

    // Retry the pipeline (re-enqueues from the save stage)
    const retryResult = await orchestrator.retry(runId);

    console.log(`[API] Catastrophic block override confirmed for run ${runId.slice(0, 8)} by user ${userId}`);

    res.json({
      success:    retryResult.success,
      message:    retryResult.success ? 'Override confirmed. Pipeline re-enqueued.' : retryResult.message,
      runId,
      blockStats: updatedBlock,
    });
  } catch (err) {
    console.error('[API] Error overriding catastrophic block:', err);
    res.status(500).json({ success: false, message: 'Failed to override catastrophic block' });
  }
});

// Get run configuration
app.get('/api/pipeline/:runId/config', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    // Verify ownership before returning config
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const config = await orchestrator.getRunConfig(runId);
    if (config === null) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    res.json({ success: true, runId, config });
  } catch (err) {
    console.error('[API] Error fetching run config:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch run config' });
  }
});

// Get intervention log for a run
app.get('/api/pipeline/:runId/interventions', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    // Verify ownership before returning interventions
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const interventions = await orchestrator.getInterventions(runId);
    res.json({ success: true, runId, interventions, count: interventions.length });
  } catch (err) {
    console.error('[API] Error fetching interventions:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch interventions' });
  }
});

// Stream pipeline execution via SSE (supports late join + replay)
app.get('/api/pipeline/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(id, userId);

    if (!run) {
      return res.status(404).json({ success: false, message: 'Pipeline run not found' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const emit = (event, data) => {
      if (!closed) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Send initial connection event (includes paused state for UI restore)
    emit('connected', { runId: id, prompt: run.prompt, state: run.state || 'queued', status: run.status || 'queued' });

    // Subscribe to live events FIRST (to avoid race condition)
    // Buffer events that arrive while we're replaying
    const bufferedEvents = [];
    let replaying = true;
    const seenEventIds = new Set();
    // Track which stages already had output delivered (prevents duplicate output
    // when both live chunks and completed payloads carry content for the same stage)
    const stagesWithOutput = new Set();

    // Track intent class so we know the right deploy timeout duration
    // Initialized from DB (works for late joiners); updated live via intent_gate classified event
    let _sseIntentClass = run.intent_class || null;

    const onEvent = (event) => {
      if (closed) return;

      if (replaying) {
        // Buffer live events during replay phase
        bufferedEvents.push(event);
        return;
      }

      // Skip events we already replayed (dedup by id)
      if (event.id && seenEventIds.has(event.id)) return;

      // Track intent class from Intent Gate events (persisted completed or ephemeral classified)
      if (event.stage === 'intent_gate' && (event.status === 'classified' || event.status === 'completed') && event.payload) {
        try {
          const p = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          if (p.intent_class) _sseIntentClass = p.intent_class;
        } catch (_) {}
      }

      emitStateEvent(emit, event, false, stagesWithOutput);

      // Check for terminal states
      if (event.status === 'completed' && event.stage === 'verify') {
        // Include verification results so the frontend can show appropriate banner
        const verifyPayload = event.payload
          ? (typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload)
          : {};
        const verifyChecks = Array.isArray(verifyPayload.checks) ? verifyPayload.checks : [];
        const pc = verifyChecks.filter(c => c.passed).length;
        const tc = verifyChecks.length;
        const _allPassed = tc > 0 && pc === tc;
        console.log(`[SSE] complete event for ${id.slice(0, 8)}...: ${pc}/${tc} checks passed, passed=${_allPassed}, payload_type=${typeof event.payload}, has_checks=${Array.isArray(verifyPayload.checks)}`);
        emit('complete', {
          // status reflects actual verify outcome — 'failed' when checks didn't all pass
          status: _allPassed ? 'completed' : 'failed',
          runId: id,
          // passed = ALL checks green (no partial pass)
          passed: _allPassed,
          passedCount: pc,
          totalChecks: tc,
          checks: verifyChecks,
          warnings: verifyPayload.warnings || [],
          errors: verifyPayload.errors || [],
        });

        // Keep SSE open to receive deploy events (DEPLOY phase runs after verify).
        // STATIC_SURFACE: 8s (file I/O only)
        // PRODUCT_SYSTEM: 3 minutes (npm install + Node.js startup)
        // Other/unknown: 8s (not deployed or autoDeploy only)
        const _deployTimeoutMs = _sseIntentClass === 'PRODUCT_SYSTEM' ? 3 * 60 * 1000 : 8000;
        console.log(`[SSE] deploy wait: ${_deployTimeoutMs / 1000}s (intent=${_sseIntentClass || 'unknown'}) for run ${id.slice(0, 8)}`);
        const deployTimeout = setTimeout(() => {
          cleanup();
          if (!closed) res.end();
        }, _deployTimeoutMs);

        // Patch cleanup to also clear the deploy timeout
        const origCleanup = cleanup;
        const patchedCleanup = () => {
          clearTimeout(deployTimeout);
          origCleanup();
        };

        // Intercept deploy terminal events to close SSE promptly
        const deployDone = (deployEvent) => {
          if (deployEvent.stage !== 'deploy') return;
          if (deployEvent.status === 'deploy_complete' || deployEvent.status === 'deploy_failed') {
            patchedCleanup();
            // Small delay so Render's reverse proxy flushes buffered events
            setTimeout(() => { if (!closed) res.end(); }, 200);
          }
        };
        stateMachine.on(`run:${id}`, deployDone);
        // Ensure deployDone is cleaned up when the original listener is removed
        req.on('close', () => stateMachine.removeListener(`run:${id}`, deployDone));

      } else if (event.status === 'failed') {
        emit('error', { message: event.error || 'Pipeline stage failed' });
        cleanup();
        if (!closed) res.end();
      }
    };

    stateMachine.on(`run:${id}`, onEvent);

    const cleanup = () => {
      stateMachine.removeListener(`run:${id}`, onEvent);
    };

    req.on('close', cleanup);

    // Replay existing events (for late joiners or reconnections)
    const pastEvents = await stateMachine.getEvents(id);
    for (const event of pastEvents) {
      if (closed) { cleanup(); return; }
      if (event.id) seenEventIds.add(event.id);
      emitStateEvent(emit, event, true, stagesWithOutput);
    }

    // Flush buffered events (arrived during replay)
    replaying = false;
    for (const event of bufferedEvents) {
      if (closed) { cleanup(); return; }
      if (event.id && seenEventIds.has(event.id)) continue;
      // Pass stagesWithOutput so completed events can extract output
      // if the stage had no live/replay output (race condition fix)
      emitStateEvent(emit, event, false, stagesWithOutput);
    }

    // Re-check terminal state after replay
    const currentRun = await pipeline.getRun(id);
    if (currentRun && (currentRun.status === 'completed' || currentRun.status === 'failed' || currentRun.status === 'paused')) {
      if (currentRun.status === 'completed') {
        // Fetch verify results from event log for replay
        let replayVerify = {};
        try {
          const allEvents = await stateMachine.getEvents(id);
          const verifyDone = allEvents.find(ev => ev.stage === 'verify' && ev.status === 'completed');
          if (verifyDone && verifyDone.payload) {
            replayVerify = typeof verifyDone.payload === 'string' ? JSON.parse(verifyDone.payload) : verifyDone.payload;
          }
        } catch (_) { /* fallback: empty verify data */ }
        const replayChecks = Array.isArray(replayVerify.checks) ? replayVerify.checks : [];
        const rpc = replayChecks.filter(c => c.passed).length;
        const rtc = replayChecks.length;

        // Include deployment URL if available (set by DeployEngine after STATIC_SURFACE build)
        let replayDeployment = null;
        try {
          if (currentRun.deployment) {
            const depData = typeof currentRun.deployment === 'string'
              ? JSON.parse(currentRun.deployment)
              : currentRun.deployment;
            if (depData && depData.status === 'deployed' && depData.url) {
              replayDeployment = { url: depData.url, slug: depData.slug || null };
            }
          }
        } catch (_) {}

        console.log(`[SSE] replay complete for ${id.slice(0, 8)}...: ${rpc}/${rtc} checks passed, passed=${rtc > 0 && rpc === rtc}, has_checks=${Array.isArray(replayVerify.checks)}, deployment=${replayDeployment?.url || 'none'}`);
        emit('complete', {
          status: 'completed',
          runId: id,
          // passed = ALL checks green (no partial pass)
          passed: rtc > 0 && rpc === rtc,
          passedCount: rpc,
          totalChecks: rtc,
          checks: replayChecks,
          warnings: replayVerify.warnings || [],
          errors: replayVerify.errors || [],
          // Deployment info (populated after STATIC_SURFACE deploy, null for others)
          deployment: replayDeployment,
        });
        cleanup();
        if (!closed) res.end();
      } else if (currentRun.status === 'failed') {
        // Check if this is a verify-failed run (state = verify_complete but status = failed).
        // In that case, send a 'complete' event with passed=false and full check details
        // so the frontend can render the verification results, not a generic error.
        if (currentRun.state === 'verify_complete') {
          let replayVerifyFailed = {};
          try {
            const allFailEvents = await stateMachine.getEvents(id);
            const verifyFailDone = allFailEvents.find(ev => ev.stage === 'verify' && ev.status === 'completed');
            if (verifyFailDone && verifyFailDone.payload) {
              replayVerifyFailed = typeof verifyFailDone.payload === 'string' ? JSON.parse(verifyFailDone.payload) : verifyFailDone.payload;
            }
          } catch (_) { /* fallback: empty verify data */ }
          const failChecks = Array.isArray(replayVerifyFailed.checks) ? replayVerifyFailed.checks : [];
          const fpc = failChecks.filter(c => c.passed).length;
          const ftc = failChecks.length;
          console.log(`[SSE] replay verify-failed for ${id.slice(0, 8)}...: ${fpc}/${ftc} checks passed, passed=false`);
          emit('complete', {
            status: 'failed',
            runId: id,
            passed: false,
            passedCount: fpc,
            totalChecks: ftc,
            checks: failChecks,
            warnings: replayVerifyFailed.warnings || [],
            errors: replayVerifyFailed.errors || [],
          });
        } else {
          emit('error', { message: currentRun.error || 'Pipeline failed' });
        }
        cleanup();
        if (!closed) res.end();
      } else if (currentRun.status === 'paused') {
        // Send paused event but keep stream open — user may resume
        emit('pipeline_paused', { runId: id, after_stage: currentRun.state ? currentRun.state.replace('_complete', '') : null });
        // Keep stream alive for live updates on resume
      }
      return;
    }

  } catch (err) {
    console.error('[API] SSE error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Pipeline execution failed' });
    }
  }
});

// Get pipeline events (full event log for a run)
app.get('/api/pipeline/:id/events', async (req, res) => {
  try {
    // Verify ownership before returning events
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(req.params.id, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const events = await stateMachine.getEvents(req.params.id);
    res.json({ success: true, events });
  } catch (err) {
    console.error('[API] Error fetching events:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
});

// Get pipeline run status
app.get('/api/pipeline/:id', async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(req.params.id, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    res.json({ success: true, run });
  } catch (err) {
    console.error('[API] Error fetching run:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch run' });
  }
});

// Get recent pipeline runs (with constraint summaries for badges)
app.get('/api/pipeline', async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const runs = await pipeline.getRecentRuns(20, userId);

    // Enrich with constraint summaries (single batch query)
    if (runs.length > 0) {
      const runIds = runs.map(r => r.id);
      try {
        // Get intent class per run
        const predRows = await pool.query(
          `SELECT DISTINCT ON (run_id) run_id, task_type, confidence
           FROM constraint_predictions
           WHERE run_id = ANY($1)
           ORDER BY run_id, created_at DESC`,
          [runIds]
        );
        // Get violation counts per run
        const violRows = await pool.query(
          `SELECT run_id, COUNT(*) as violation_count,
                  BOOL_OR(violation_type IN ('expansion_scope_exceeded')) as has_hard_fail
           FROM constraint_violations
           WHERE run_id = ANY($1)
           GROUP BY run_id`,
          [runIds]
        );

        const predMap = {};
        predRows.rows.forEach(r => { predMap[r.run_id] = r; });
        const violMap = {};
        violRows.rows.forEach(r => { violMap[r.run_id] = r; });

        runs.forEach(run => {
          const pred = predMap[run.id];
          const viol = violMap[run.id];
          run.constraintSummary = {
            intentClass: pred ? pred.task_type : null,
            confidence: pred ? pred.confidence : null,
            violationCount: viol ? parseInt(viol.violation_count) : 0,
            hasHardFail: viol ? viol.has_hard_fail : false,
          };
        });
      } catch (_) {
        // Constraint tables may not exist on older instances — degrade gracefully
        runs.forEach(run => { run.constraintSummary = null; });
      }
    }

    res.json({ success: true, runs });
  } catch (err) {
    console.error('[API] Error fetching runs:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch runs' });
  }
});

// Paginated history with filtering — used by /history page
// Query params: page (1-based), limit (1-100), status, intent_class, q (prompt search)
app.get('/api/history', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const intentClass = req.query.intent_class || null;
    const q = req.query.q ? `%${req.query.q.slice(0, 100)}%` : null;

    // Build WHERE clauses dynamically
    const conditions = ['deleted_at IS NULL', 'user_id = $1'];
    const params = [userId];
    let pIdx = 2;

    if (status) {
      conditions.push(`status = $${pIdx++}`);
      params.push(status);
    }
    if (intentClass) {
      conditions.push(`intent_class = $${pIdx++}`);
      params.push(intentClass);
    }
    if (q) {
      conditions.push(`prompt ILIKE $${pIdx++}`);
      params.push(q);
    }

    const where = conditions.join(' AND ');

    const [countResult, runsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM pipeline_runs WHERE ${where}`, params),
      pool.query(
        `SELECT id, prompt, status, intent_class, created_at, completed_at,
                EXTRACT(EPOCH FROM (completed_at - created_at)) AS duration_s
         FROM pipeline_runs
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total) || 0;
    const runs = runsResult.rows.map(r => ({
      id: r.id,
      prompt: r.prompt,
      status: r.status,
      intent_class: r.intent_class,
      created_at: r.created_at,
      completed_at: r.completed_at,
      duration_s: r.duration_s ? Math.round(parseFloat(r.duration_s)) : null,
    }));

    res.json({
      success: true,
      runs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[API] Error fetching history:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
});

// Soft-delete a pipeline run (removes from dashboard; preserves execution history)
app.delete('/api/pipeline/:runId', async (req, res) => {
  const { runId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).json({ success: false, message: 'Invalid run id' });
  }
  const client = await pool.connect();
  try {
    const userId = req.user?.userId || null;

    // Verify ownership before deletion
    const { rowCount: found } = await client.query(
      `SELECT id FROM pipeline_runs WHERE id = $1 AND user_id = $2`,
      [runId, userId]
    );
    if (found === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    await client.query('BEGIN');

    // Clean up 4-layer memory tables (best-effort — linked by same UUID if populated)
    // memory_items: source_run_id is SET NULL on cascade, so explicitly remove orphaned items
    await client.query(`DELETE FROM memory_items WHERE source_run_id = $1`, [runId]);
    // artifacts: run_id FK references `runs` table (not pipeline_runs), but try cleanup if IDs match
    await client.query(`DELETE FROM artifacts WHERE run_id = $1`, [runId]);
    // runs layer: delete the matching runs record if it exists (cascades to run_events)
    await client.query(`DELETE FROM runs WHERE id = $1`, [runId]);

    // Hard-delete pipeline run — cascades to:
    //   pipeline_events, pipeline_traces, constraint_predictions,
    //   constraint_violations, constraint_decisions_log, trace_nodes
    await client.query(`DELETE FROM pipeline_runs WHERE id = $1`, [runId]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[API] Error deleting run:', err);
    res.status(500).json({ success: false, message: 'Failed to delete run' });
  } finally {
    client.release();
  }
});

// Bulk delete pipeline runs for the authenticated user.
// Body: { all: true } to wipe all runs, or { ids: ['uuid', ...] } for selective delete.
// Returns: { success: true, deleted: N }
app.delete('/api/builds/bulk', auth.requireAuth, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const { all, ids } = req.body || {};
  if (!all && (!Array.isArray(ids) || ids.length === 0)) {
    return res.status(400).json({ success: false, message: 'Provide { all: true } or { ids: [...] }' });
  }

  // Validate UUIDs when ids provided
  const UUID_RE = /^[0-9a-f-]{36}$/i;
  if (ids && ids.some(id => !UUID_RE.test(id))) {
    return res.status(400).json({ success: false, message: 'One or more invalid run IDs' });
  }

  const client = await pool.connect();
  try {
    // Resolve the run IDs to delete — scoped to this user
    let targetIds;
    if (all) {
      const result = await client.query(
        `SELECT id FROM pipeline_runs WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId]
      );
      targetIds = result.rows.map(r => r.id);
    } else {
      // Only delete runs owned by this user
      const result = await client.query(
        `SELECT id FROM pipeline_runs WHERE id = ANY($1::uuid[]) AND user_id = $2`,
        [ids, userId]
      );
      targetIds = result.rows.map(r => r.id);
    }

    if (targetIds.length === 0) {
      return res.json({ success: true, deleted: 0 });
    }

    await client.query('BEGIN');

    // Clean up associated data (mirrors single-run delete logic)
    await client.query(`DELETE FROM memory_items WHERE source_run_id = ANY($1::uuid[])`, [targetIds]);
    await client.query(`DELETE FROM artifacts WHERE run_id = ANY($1::uuid[])`, [targetIds]);
    await client.query(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [targetIds]);
    await client.query(`DELETE FROM pipeline_runs WHERE id = ANY($1::uuid[])`, [targetIds]);

    await client.query('COMMIT');
    res.json({ success: true, deleted: targetIds.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[API] Error bulk-deleting runs:', err);
    res.status(500).json({ success: false, message: 'Failed to delete builds' });
  } finally {
    client.release();
  }
});

// Get orchestrator + queue status (includes agent routing info)
// Auth required — exposes internal orchestrator state
app.get('/api/queue/status', auth.requireAuth, (req, res) => {
  res.json({ success: true, ...orchestrator.getStatus() });
});

// Get agent registry status (which agent owns which stage)
// Auth required — exposes internal agent architecture
app.get('/api/agents', auth.requireAuth, (req, res) => {
  res.json({ success: true, ...agentRegistry.getStatus() });
});

// Get health summary for a specific pipeline run (from Ops agent)
app.get('/api/pipeline/:id/health', async (req, res) => {
  const userId = req.user?.userId || null;
  const ownerCheck = await pipeline.getRun(req.params.id, userId);
  if (!ownerCheck) {
    return res.status(404).json({ success: false, message: 'Run not found' });
  }
  const health = agentRegistry.ops.getHealth(req.params.id);
  res.json({ success: true, health });
});

// Get QA issues flagged for a pipeline run
app.get('/api/pipeline/:id/issues', async (req, res) => {
  const userId = req.user?.userId || null;
  const ownerCheck = await pipeline.getRun(req.params.id, userId);
  if (!ownerCheck) {
    return res.status(404).json({ success: false, message: 'Run not found' });
  }
  const issues = agentRegistry.qa.getIssues(req.params.id);
  res.json({ success: true, issues, count: issues.length });
});

// ── Cost / Economics API ──────────────────────────────────

// Get full cost breakdown for a specific run
// Returns live in-memory data if run is active, otherwise reads from DB
app.get('/api/pipeline/:runId/costs', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    // Verify ownership
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    // Try in-memory first (active run)
    let costs = costTracker.getRunCosts(runId);

    // Fall back to DB (completed run)
    if (!costs) {
      costs = await CostTracker.getRunCostsFromDb(runId, pool);
    }

    if (!costs) {
      return res.status(404).json({ success: false, message: 'No cost data found for this run' });
    }

    res.json({ success: true, costs });
  } catch (err) {
    console.error('[API] Error fetching run costs:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch cost data' });
  }
});

// Get aggregate cost statistics across all runs (scoped to authenticated user)
// Auth required — userId MUST be present to scope query
app.get('/api/costs/summary', auth.requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const userId = req.user.userId;
    const summary = await CostTracker.getSummary(pool, { limit, userId });
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[API] Error fetching costs summary:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch cost summary' });
  }
});

// ── Dashboard Stats API ─────────────────────────────────
// Aggregate build metrics for the dashboard hero section.
// Auth required — userId always scopes the query. Never return cross-user data.
app.get('/api/dashboard/stats', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [totalsRow, intentRow, recentRow] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)                                                      AS total_builds,
           COUNT(*) FILTER (WHERE status = 'completed')                 AS completed,
           COUNT(*) FILTER (WHERE status = 'failed')                    AS failed,
           COUNT(*) FILTER (WHERE status IN ('running', 'in_progress')) AS running,
           AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))
             FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL) AS avg_duration_seconds
         FROM pipeline_runs
         WHERE user_id = $1
           AND deleted_at IS NULL`,
        [userId]
      ),
      pool.query(
        `SELECT intent_class, COUNT(*) AS cnt
         FROM pipeline_runs
         WHERE user_id = $1
           AND intent_class IS NOT NULL
           AND deleted_at IS NULL
         GROUP BY intent_class
         ORDER BY cnt DESC`,
        [userId]
      ),
      pool.query(
        `SELECT id, prompt, status, intent_class, created_at, completed_at,
                EXTRACT(EPOCH FROM (completed_at - created_at)) AS duration_s
         FROM pipeline_runs
         WHERE user_id = $1
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId]
      ),
    ]);

    const t = totalsRow.rows[0];
    const total = parseInt(t.total_builds) || 0;
    const completed = parseInt(t.completed) || 0;
    const failed = parseInt(t.failed) || 0;
    const running = parseInt(t.running) || 0;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const avgDuration = t.avg_duration_seconds ? Math.round(parseFloat(t.avg_duration_seconds)) : null;

    const intentDist = {};
    for (const row of intentRow.rows) {
      intentDist[row.intent_class] = parseInt(row.cnt);
    }

    const recentRuns = recentRow.rows.map(r => ({
      id: r.id,
      prompt: r.prompt,
      status: r.status,
      intent_class: r.intent_class,
      created_at: r.created_at,
      completed_at: r.completed_at,
      duration_s: r.duration_s ? Math.round(parseFloat(r.duration_s)) : null,
    }));

    res.json({
      success: true,
      stats: {
        total_builds: total,
        completed,
        failed,
        running,
        success_rate: successRate,
        avg_duration_seconds: avgDuration,
        intent_distribution: intentDist,
      },
      recent_runs: recentRuns,
    });
  } catch (err) {
    console.error('[API] Error fetching dashboard stats:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
});

// ── Run Details API ─────────────────────────────────────
// Returns full run metadata including code files + scaffold for the Copilot page.
app.get('/api/pipeline/:runId/details', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ success: false, message: 'Invalid run ID' });
    }
    const result = await pool.query(
      `SELECT id, prompt, status, intent_class, current_phase, plan, scaffold, code, created_at, completed_at,
              github_repo, github_pr_url, catastrophic_block
       FROM pipeline_runs WHERE id = $1 AND user_id = $2`,
      [runId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const run = result.rows[0];
    const parseCol = (col) => {
      if (!col) return null;
      try { return typeof col === 'string' ? JSON.parse(col) : col; } catch { return null; }
    };
    const codeData = parseCol(run.code);
    const scaffoldData = parseCol(run.scaffold);
    const planData = parseCol(run.plan);
    const blockData = run.catastrophic_block || null;

    // Reconstruct per-phase state from pipeline_events so the React Run page
    // can render phase cards with correct status, timing, and errors.
    // Uses DISTINCT ON to pick the latest event per stage (by id DESC).
    const phases = {};
    try {
      const evtResult = await pool.query(
        `SELECT DISTINCT ON (stage) stage, status, error, payload, created_at
         FROM pipeline_events WHERE run_id = $1
         ORDER BY stage, id DESC`,
        [runId]
      );
      // Map DB statuses (started/completed/failed) to frontend PhaseStatus
      const STATUS_MAP = { started: 'running', completed: 'complete', failed: 'failed' };
      for (const evt of evtResult.rows) {
        // Parse payload JSONB — contains phase-specific output data
        let output = undefined;
        if (evt.payload) {
          try { output = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload; } catch (_) {}
        }
        phases[evt.stage] = {
          status: STATUS_MAP[evt.status] || evt.status,
          error: evt.error || undefined,
          output,
          started_at: evt.created_at,
          completed_at: (evt.status === 'completed' || evt.status === 'failed') ? evt.created_at : undefined,
        };
      }
    } catch (_) { /* non-fatal — phases degrade to empty/waiting */ }

    // For failed runs: fetch the most recent error message from pipeline_events
    // so the UI can surface a human-readable failure reason and recovery path.
    let failureReason = null;
    let failedStage = null;
    if (run.status === 'failed') {
      try {
        const errEvt = await pool.query(
          `SELECT stage, error FROM pipeline_events
           WHERE run_id = $1 AND status = 'failed' AND error IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [runId]
        );
        if (errEvt.rows.length > 0) {
          failureReason = errEvt.rows[0].error;
          failedStage   = errEvt.rows[0].stage;
        }
      } catch (_) { /* non-fatal — UI degrades gracefully */ }
    }

    // Enrich phases with fallback data from pipeline_runs columns
    // (plan, scaffold, code columns may have data even if events payload was sparse)
    if (planData && phases.plan && !phases.plan.output) {
      phases.plan.output = planData;
    }
    if (scaffoldData && phases.scaffold && !phases.scaffold.output) {
      phases.scaffold.output = scaffoldData;
    }
    if (codeData && phases.code && !phases.code.output) {
      phases.code.output = codeData;
    }

    res.json({
      success: true,
      run: {
        id: run.id,
        prompt: run.prompt,
        status: run.status,
        intent_class: run.intent_class,
        current_phase: run.current_phase || null,
        phases,
        created_at: run.created_at,
        completed_at: run.completed_at,
        files: (codeData && typeof codeData.files === 'object') ? codeData.files : {},
        scaffold: scaffoldData,
        plan: planData,
        github_repo: run.github_repo || null,
        github_pr_url: run.github_pr_url || null,
        catastrophic_block: blockData,
        failure_reason: failureReason,
        failed_stage: failedStage,
      },
    });
  } catch (err) {
    console.error('[API] Run details error:', err);
    res.status(500).json({ success: false, message: 'Failed to load run details' });
  }
});

// ── Verify Fix API ────────────────────────────────────────
// POST /api/pipeline/:runId/verify-fix       → targeted fix for a single failed check
// POST /api/pipeline/:runId/verify-fix-all   → queue fixes for all failed checks
const { createVerifyFixRouter } = require('./src/routes/verify-fix');
app.use('/api/pipeline', createVerifyFixRouter({ pool, pipeline, artifactStore, requireAuth: auth.requireAuth }));

// ── Compliance Export API ─────────────────────────────────
// GET /api/pipeline/:runId/export?format=json|pdf
// Generates a structured, downloadable compliance artifact for auditors.
// Button appears on the run detail page after any terminal status.
// Note: auth check is handled inside the router to avoid interfering with other /api/pipeline routes.
app.use('/api/pipeline', createComplianceExportRouter({ pool, artifactStore, pipeline, requireAuth: auth.requireAuth }));

// ── Expo Export API ───────────────────────────────────────
// GET  /api/pipeline/:runId/code-files/download  → ZIP of raw generated files
// POST /api/builds/:runId/export/expo            → Expo React Native project ZIP
const _expoExportRouter = createExpoExportRouter({ pool, artifactStore, pipeline, requireAuth: auth.requireAuth });
app.use('/api/pipeline', _expoExportRouter);
app.use('/api/builds',   _expoExportRouter);

// ── Artifact API ─────────────────────────────────────────

// List all artifacts for a pipeline run
app.get('/api/pipeline/:runId/artifacts', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const artifacts = await artifactStore.listArtifacts(runId);
    res.json({
      success: true,
      runId,
      count: artifacts.length,
      artifacts,
    });
  } catch (err) {
    console.error('[API] Error listing artifacts:', err);
    res.status(500).json({ success: false, message: 'Failed to list artifacts' });
  }
});

// List artifacts for a specific stage of a run
app.get('/api/pipeline/:runId/artifacts/:stage', async (req, res) => {
  try {
    const { runId, stage } = req.params;
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const artifacts = await artifactStore.listArtifacts(runId, stage);
    res.json({
      success: true,
      runId,
      stage,
      count: artifacts.length,
      artifacts,
    });
  } catch (err) {
    console.error('[API] Error listing stage artifacts:', err);
    res.status(500).json({ success: false, message: 'Failed to list stage artifacts' });
  }
});

// Get the content of a specific artifact file
app.get('/api/pipeline/:runId/artifacts/:stage/:filename', async (req, res) => {
  try {
    const { runId, stage, filename } = req.params;
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const content = await artifactStore.readArtifact(runId, stage, filename);
    if (content === null) {
      return res.status(404).json({ success: false, message: 'Artifact not found' });
    }
    res.json({ success: true, runId, stage, filename, content });
  } catch (err) {
    console.error('[API] Error reading artifact:', err);
    res.status(500).json({ success: false, message: 'Failed to read artifact' });
  }
});

// Get full replay timeline: events + artifacts in chronological order
app.get('/api/pipeline/:runId/replay', async (req, res) => {
  try {
    const { runId } = req.params;

    // Verify run exists and ownership
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Pipeline run not found' });
    }

    // Fetch event log
    const events = await stateMachine.getEvents(runId);

    // Build replay timeline: events + artifact references merged
    const replay = await artifactStore.buildReplay(runId, events);

    res.json({
      success: true,
      run: {
        id: run.id,
        prompt: run.prompt,
        state: run.state,
        status: run.status,
        createdAt: run.created_at,
      },
      ...replay,
    });
  } catch (err) {
    console.error('[API] Error building replay:', err);
    res.status(500).json({ success: false, message: 'Failed to build replay' });
  }
});

// ── Trace / Explainability API ────────────────────────────

// Get full decision trace for an entire run (all agents, all steps)
app.get('/api/pipeline/:runId/trace', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const trace = await traceStore.getTrace(runId);
    res.json({ success: true, run: { id: run.id, prompt: run.prompt, state: run.state, status: run.status }, ...trace });
  } catch (err) {
    console.error('[API] Error fetching trace:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch trace' });
  }
});

// Get decision trace for a specific stage
app.get('/api/pipeline/:runId/trace/:stage', async (req, res) => {
  try {
    const { runId, stage } = req.params;
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const validStages = ['plan', 'scaffold', 'code', 'save', 'verify'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ success: false, message: `Invalid stage. Must be one of: ${validStages.join(', ')}` });
    }
    const trace = await traceStore.getStageTrace(runId, stage);
    res.json({ success: true, ...trace });
  } catch (err) {
    console.error('[API] Error fetching stage trace:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch stage trace' });
  }
});

// Get artifact diffs (before/after) for each stage in a run
app.get('/api/pipeline/:runId/diffs', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const diffs = await traceStore.getDiffs(runId);
    res.json({ success: true, runId, count: diffs.length, diffs });
  } catch (err) {
    console.error('[API] Error computing diffs:', err);
    res.status(500).json({ success: false, message: 'Failed to compute diffs' });
  }
});

// ── Run Trace Causal DAG ──────────────────────────────────
// GET /api/runs/:id/trace — returns the full causal DAG for a pipeline run.
// Each node is a decision point (not a log entry) with alternatives considered
// and constraint references that caused the decision.
// non_explainable=true means the integrity check failed at run completion.
app.get('/api/runs/:id/trace', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(id, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const dag = await runTrace.getDAG(id);
    res.json({
      success: true,
      run: {
        id: run.id,
        prompt: run.prompt,
        state: run.state,
        status: run.status,
        non_explainable: dag.nonExplainable,
      },
      ...dag,
    });
  } catch (err) {
    console.error('[API] Error fetching run trace DAG:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch run trace' });
  }
});

// Get stage contract schemas (for documentation / frontend)
app.get('/api/pipeline/contracts', (req, res) => {
  const { STAGE_SCHEMAS } = require('./stage-contracts');
  res.json({ success: true, contracts: STAGE_SCHEMAS });
});

// ── Deploy API ───────────────────────────────────────────

// Trigger a deploy manually for a completed run
app.post('/api/pipeline/:runId/deploy', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    if (run.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Run is not completed (status: ${run.status}). Only completed runs can be deployed.`,
      });
    }

    // Fire deploy asynchronously — return immediately
    deployEngine.deploy(runId, run.prompt).catch(err => {
      console.warn(`[API] Deploy error for ${runId.slice(0, 8)}: ${err.message}`);
    });

    res.json({ success: true, message: 'Deploy started. Watch the live stream for progress.' });
  } catch (err) {
    console.error('[API] Error triggering deploy:', err);
    res.status(500).json({ success: false, message: 'Failed to trigger deploy' });
  }
});

// Get deploy status + live URL for a run
app.get('/api/pipeline/:runId/deploy/status', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const status = await deployEngine.getStatus(runId);
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[API] Error fetching deploy status:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch deploy status' });
  }
});

// Get deploy version history for a run
app.get('/api/pipeline/:runId/deploy/history', async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const history = await deployEngine.getHistory(runId);
    res.json({ success: true, runId, count: history.length, history });
  } catch (err) {
    console.error('[API] Error fetching deploy history:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch deploy history' });
  }
});

// Rollback to a specific version
app.post('/api/pipeline/:runId/deploy/rollback/:version', async (req, res) => {
  try {
    const { runId, version } = req.params;
    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      return res.status(400).json({ success: false, message: 'Invalid version number' });
    }

    const userId = req.user?.userId || null;
    const run = await pipeline.getRun(runId, userId);
    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    const result = await deployEngine.rollback(runId, versionNum);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error });
    }

    res.json({ success: true, message: `Rolled back to version ${versionNum}`, url: result.url, version: versionNum });
  } catch (err) {
    console.error('[API] Error rolling back deploy:', err);
    res.status(500).json({ success: false, message: 'Failed to rollback deploy' });
  }
});

// Get event bus debug log
// Auth required — exposes system-wide pipeline events
app.get('/api/events/recent', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const events = eventBus.getRecentEvents(limit);
  res.json({ success: true, events, count: events.length });
});

// ── Constraint Intelligence API ───────────────────────────

// Get full constraint telemetry for a specific pipeline run
// Returns: prediction, violations, decisions log, learning adjustments
app.get('/api/pipeline/:runId/constraints', async (req, res) => {
  try {
    const { runId } = req.params;

    // Verify run exists and ownership
    const userId = req.user?.userId || null;
    const runCheck = await pool.query('SELECT id FROM pipeline_runs WHERE id = $1 AND user_id = $2', [runId, userId]);
    if (runCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    // Fetch prediction data
    const predResult = await pool.query(
      `SELECT cp.task_type, cp.predicted_constraints, cp.confidence, cp.entropy,
              cp.candidates, cp.committed, cp.created_at
       FROM constraint_predictions cp
       WHERE cp.run_id = $1
       ORDER BY cp.created_at DESC
       LIMIT 1`,
      [runId]
    );

    // Fetch violations
    const violResult = await pool.query(
      `SELECT violation_type, violated_layer, severity, created_at
       FROM constraint_violations
       WHERE run_id = $1
       ORDER BY severity DESC`,
      [runId]
    );

    // Fetch decisions log (explainability trail)
    const decResult = await pool.query(
      `SELECT classified_task_type, final_constraints, adjustments_applied, created_at
       FROM constraint_decisions_log
       WHERE run_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId]
    );

    const prediction = predResult.rows[0] || null;
    const violations = violResult.rows;
    const decision = decResult.rows[0] || null;

    // Extract learning adjustments if decision has them
    let learningAdjustments = [];
    if (decision && decision.adjustments_applied) {
      const adj = typeof decision.adjustments_applied === 'string'
        ? JSON.parse(decision.adjustments_applied)
        : decision.adjustments_applied;
      if (Array.isArray(adj)) {
        learningAdjustments = adj;
      } else if (adj && typeof adj === 'object') {
        // May be a key→value map
        learningAdjustments = Object.entries(adj).map(([k, v]) => ({ key: k, ...v }));
      }
    }

    res.json({
      success: true,
      runId,
      prediction,
      violations,
      decision,
      learningAdjustments,
    });
  } catch (err) {
    console.error('[API] Error fetching constraint data:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch constraint data' });
  }
});

// Get constraint health summary for the authenticated user's runs
// Auth required — queries join pipeline_runs which contain user prompts
app.get('/api/constraints/health', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Runs by intent class (scoped to user's predictions via pipeline_runs)
    const intentResult = await pool.query(`
      SELECT cp.task_type, COUNT(*) as count
      FROM constraint_predictions cp
      JOIN pipeline_runs pr ON pr.id = cp.run_id
      WHERE pr.user_id = $1
      GROUP BY cp.task_type
      ORDER BY count DESC
    `, [userId]);

    // Current weight state (system-wide learning weights — no user data)
    const weightResult = await pool.query(`
      SELECT task_type, constraint_key, weight, sample_count, frozen, last_updated
      FROM constraint_feedback_weights
      ORDER BY task_type, constraint_key
    `);

    // Recent violations for this user's runs (last 10)
    const recentViolResult = await pool.query(`
      SELECT cv.run_id, cv.violation_type, cv.violated_layer, cv.severity, cv.created_at,
             pr.prompt
      FROM constraint_violations cv
      JOIN pipeline_runs pr ON pr.id = cv.run_id
      WHERE pr.user_id = $1
      ORDER BY cv.created_at DESC
      LIMIT 10
    `, [userId]);

    // Violation rate for this user's runs
    const violRateResult = await pool.query(`
      SELECT
        COUNT(DISTINCT pr.id) FILTER (WHERE cv.id IS NOT NULL) as runs_with_violations,
        COUNT(DISTINCT pr.id) as total_runs
      FROM pipeline_runs pr
      LEFT JOIN constraint_violations cv ON cv.run_id = pr.id
      WHERE pr.status = 'completed'
        AND pr.user_id = $1
    `, [userId]);

    const frozenConstraints = weightResult.rows.filter(w => w.frozen);
    const violRate = violRateResult.rows[0] || { runs_with_violations: 0, total_runs: 0 };

    res.json({
      success: true,
      intentClassBreakdown: intentResult.rows,
      weightState: weightResult.rows,
      frozenConstraints,
      recentViolations: recentViolResult.rows,
      violationRate: {
        runsWithViolations: parseInt(violRate.runs_with_violations) || 0,
        totalRuns: parseInt(violRate.total_runs) || 0,
      },
    });
  } catch (err) {
    console.error('[API] Error fetching constraint health:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch constraint health' });
  }
});

// ── Code Copilot File APIs ────────────────────────────────

// GET /api/pipeline/:runId/code-files
// Returns the structured file map from the code artifact for the editor.
app.get('/api/pipeline/:runId/code-files', async (req, res) => {
  try {
    const { runId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ success: false, message: 'Invalid run ID' });
    }
    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    // Load the code artifact — files are stored as { files: { "path": "content", ... } }
    // Try filesystem artifact first, fall back to DB if missing (e.g. ephemeral FS wipe)
    let codeArtifact = await artifactStore.readArtifact(runId, 'code', 'code.json');

    if (!codeArtifact || !codeArtifact.files) {
      // Fallback: load from database (mirrors deploy-engine._loadCodeArtifact)
      try {
        const { rows } = await pool.query(
          `SELECT code FROM pipeline_runs WHERE id = $1`,
          [runId]
        );
        if (rows[0]?.code) {
          codeArtifact = typeof rows[0].code === 'string' ? JSON.parse(rows[0].code) : rows[0].code;
        }
      } catch (_dbErr) { /* fall through to empty response */ }
    }

    if (!codeArtifact || !codeArtifact.files) {
      return res.json({ success: true, runId, files: {}, count: 0, note: 'No code artifacts for this run' });
    }

    const files = codeArtifact.files;
    const count = Object.keys(files).length;

    res.json({ success: true, runId, files, count });
  } catch (err) {
    console.error('[API] Error loading code-files:', err);
    res.status(500).json({ success: false, message: 'Failed to load code files' });
  }
});

// POST /api/pipeline/:runId/code-files/save
// Saves a modified file back to the deployed site and artifact store.
app.post('/api/pipeline/:runId/code-files/save', async (req, res) => {
  try {
    const { runId } = req.params;
    const { path: filePath, content } = req.body;

    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ success: false, message: 'Invalid run ID' });
    }
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
      return res.status(400).json({ success: false, message: 'path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    // Sanitize path — block directory traversal
    const safeFilePath = filePath.replace(/\.\./g, '').replace(/^\/+/, '');

    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    // Write to deployed/current/ directory to update live preview
    const deployedPath = path.join(DEPLOY_BASE, runId, 'current', safeFilePath);
    if (fs.existsSync(path.dirname(deployedPath))) {
      fs.mkdirSync(path.dirname(deployedPath), { recursive: true });
      fs.writeFileSync(deployedPath, content, 'utf8');
      console.log(`[Copilot] Saved edit: ${runId.slice(0, 8)}/${safeFilePath} (${content.length}B)`);
    } else {
      // Deployed directory doesn't exist — still store the edit
      fs.mkdirSync(path.dirname(deployedPath), { recursive: true });
      fs.writeFileSync(deployedPath, content, 'utf8');
    }

    // Also persist edit in artifact store under 'copilot_edits' stage
    const editFilename = safeFilePath.replace(/\//g, '__');
    await artifactStore.writeArtifact(runId, 'copilot_edits', editFilename, content);

    res.json({ success: true, runId, path: safeFilePath, size: content.length });
  } catch (err) {
    console.error('[API] Error saving code-file:', err);
    res.status(500).json({ success: false, message: 'Failed to save file' });
  }
});

// POST /api/pipeline/:runId/copilot/edit
// Code Copilot chat — AI-powered code editing for non-technical users.
app.post('/api/pipeline/:runId/copilot/edit', async (req, res) => {
  try {
    const { runId } = req.params;
    const { question, file, fileContent } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ success: false, message: 'question is required' });
    }
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ success: false, message: 'Invalid run ID' });
    }

    const userId = req.user?.userId || null;
    const ownerCheck = await pipeline.getRun(runId, userId);
    if (!ownerCheck) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    const fileName = file ? file.split('/').pop() : 'unknown';
    const fileExt = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';

    // Determine language for code blocks
    const langMap = { html: 'html', htm: 'html', css: 'css', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown' };
    const codeLang = langMap[fileExt] || fileExt || 'code';

    // Build AI prompt
    const systemPrompt = `You are BuildOrbit's Code Copilot — an AI code editor that helps non-technical users modify their generated web applications.

Your job: take the user's natural language instruction and produce the modified code.

Rules:
1. If the user provides a file and its content, apply the requested change and return the COMPLETE modified file wrapped in a \`\`\`${codeLang} code block.
2. Return the FULL file content — not a diff, not a partial snippet. The user will click "Apply" which replaces the entire file.
3. If no file is provided, give a helpful explanation with example code snippets.
4. Keep explanations brief (1-2 sentences before the code block). Non-technical users want results, not lectures.
5. If the change doesn't make sense for the file type, explain why and suggest an alternative.
6. Preserve all existing functionality unless the user specifically asks to remove something.
7. For HTML files, maintain proper structure (doctype, head, body).
8. For CSS changes in HTML files, modify the <style> block or add one if needed.`;

    // Cap file content at 8000 chars (~2000 tokens) to stay within daily budget
    const trimmedContent = fileContent
      ? (fileContent.length > 8000 ? fileContent.slice(0, 8000) + '\n// ... (file truncated — ' + fileContent.length + ' chars total)' : fileContent)
      : null;
    const userPrompt = trimmedContent
      ? `File: ${file}\n\nCurrent code:\n\`\`\`${codeLang}\n${trimmedContent}\n\`\`\`\n\nUser request: ${question.trim()}`
      : `User request: ${question.trim()}\n\n(No file is currently selected — give general guidance and code examples.)`;

    let answer;
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 4000,
        temperature: 0.2
      });

      answer = completion.choices[0]?.message?.content?.trim() || 'No response generated.';
    } catch (aiErr) {
      console.error('[Copilot/Edit] AI call failed:', aiErr.message);
      const errMsg = aiErr.message || 'unknown error';
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
        answer = `AI editing requires an API key to be configured. In the meantime, you can edit the code directly in the editor panel and press Save (Ctrl+S) to apply changes.`;
      } else if (aiErr.status === 429 || errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('token limit')) {
        answer = `⏳ AI is taking a short break — usage limit reached. This resets automatically. In the meantime, you can edit code directly in the editor (click the Code tab) and press Save (Ctrl+S). Try again in a few minutes.`;
      } else {
        answer = `AI hit a temporary issue — try again in a moment. You can still edit code directly in the editor.`;
      }
    }

    res.json({ success: true, answer });
  } catch (err) {
    console.error('[API] Error in copilot/edit:', err);
    res.status(500).json({ success: false, message: 'Copilot error' });
  }
});

// ── Pipeline Copilot API ──────────────────────────────────
// Accepts a natural-language question about a specific run.
// Queries run data (events, constraints, violations, decisions) and asks
// GPT-4o-mini to answer grounded strictly in that data.
app.post('/api/pipeline/:runId/copilot', async (req, res) => {
  try {
    const { runId } = req.params;
    const { question } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'question is required' });
    }

    // Validate run ID format (UUID)
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ success: false, message: 'Invalid run ID' });
    }

    // Fetch the run record (scoped to authenticated user)
    const copilotUserId = req.user?.userId || null;
    const runResult = await pool.query(
      `SELECT id, prompt, status, current_phase, plan, scaffold, code, output, verification, created_at, completed_at
       FROM pipeline_runs WHERE id = $1 AND user_id = $2`,
      [runId, copilotUserId]
    );
    if (runResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    const run = runResult.rows[0];

    // Fetch pipeline events (stage timeline)
    const eventsResult = await pool.query(
      `SELECT stage, status, payload, created_at
       FROM pipeline_events WHERE run_id = $1 ORDER BY created_at ASC LIMIT 60`,
      [runId]
    );

    // Fetch constraint prediction (Intent Gate output)
    const predResult = await pool.query(
      `SELECT task_type, predicted_constraints, confidence, entropy, candidates, committed, created_at
       FROM constraint_predictions WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId]
    );

    // Fetch constraint violations
    const violResult = await pool.query(
      `SELECT violation_type, violated_layer, severity, created_at
       FROM constraint_violations WHERE run_id = $1 ORDER BY severity DESC LIMIT 20`,
      [runId]
    );

    // Fetch decisions log (full explainability trail)
    const decResult = await pool.query(
      `SELECT input_text, classified_task_type, final_constraints, adjustments_applied, created_at
       FROM constraint_decisions_log WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId]
    );

    const prediction = predResult.rows[0] || null;
    const violations = violResult.rows;
    const decision = decResult.rows[0] || null;
    const events = eventsResult.rows;

    // Safely truncate a JSON value to avoid blowing context
    const safeJson = (val, maxLen = 600) => {
      if (!val) return 'N/A';
      const s = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      return s.length > maxLen ? s.slice(0, maxLen) + '… [truncated]' : s;
    };

    // Build grounding context from run data
    const contextBlock = `
=== PIPELINE RUN ===
Run ID: ${runId}
Status: ${run.status}
Current Phase: ${run.current_phase || 'N/A'}
Original Prompt: ${run.prompt}
Started: ${run.created_at}
Completed: ${run.completed_at || 'still running'}

=== PHASE EVENT TIMELINE ===
${events.length > 0 ? events.map(e => {
  const payloadStr = e.payload
    ? (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)).slice(0, 180)
    : '';
  return `[${String(e.stage).toUpperCase()}] ${e.status}${payloadStr ? ' — ' + payloadStr : ''}`;
}).join('\n') : 'No events recorded yet.'}

=== INTENT GATE CLASSIFICATION ===
${prediction ? `
Intent Class (task_type): ${prediction.task_type}
Confidence: ${prediction.confidence !== null && prediction.confidence !== undefined ? (prediction.confidence * 100).toFixed(1) + '%' : 'N/A'}
Entropy: ${prediction.entropy !== null && prediction.entropy !== undefined ? Number(prediction.entropy).toFixed(4) : 'N/A'}
Adaptive Mode Committed: ${prediction.committed ? 'Yes' : 'No'}
Candidates Considered: ${safeJson(prediction.candidates, 300)}
Predicted Constraints: ${safeJson(prediction.predicted_constraints, 600)}
` : 'No constraint prediction data (run may predate the constraint system, or Intent Gate has not run yet).'}

=== CONSTRAINT DECISIONS LOG ===
${decision ? `
Input Text: ${decision.input_text || 'N/A'}
Classified As: ${decision.classified_task_type}
Final Constraints Applied: ${safeJson(decision.final_constraints, 500)}
Adjustments Applied (CDK/ACL): ${safeJson(decision.adjustments_applied, 300)}
` : 'No decisions log entry found for this run.'}

=== CONSTRAINT VIOLATIONS ===
${violations.length > 0
  ? violations.map(v => `- ${v.violation_type} | Layer: ${v.violated_layer} | Severity: ${v.severity}`).join('\n')
  : 'No violations — clean run.'}

=== PHASE OUTPUT SUMMARIES ===
Plan: ${safeJson(run.plan, 500)}
Scaffold: ${safeJson(run.scaffold, 300)}
Code (file count): ${run.code && run.code.files ? Object.keys(run.code.files).length + ' files generated' : run.code ? 'available (no file map)' : 'not generated yet'}
Verification Result: ${safeJson(run.verification, 400)}
`.trim();

    // Call OpenAI gpt-4o-mini grounded strictly on the context
    let answer;
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are the BuildOrbit Pipeline Copilot. Your job is to answer questions about a specific pipeline run using ONLY the data provided below.

Rules:
1. Only use facts from the run data below. Never speculate or hallucinate beyond what the data shows.
2. If a piece of data is "N/A" or missing, say so clearly.
3. Be precise — cite specific values (confidence %, constraint names, violation types, entropy scores) when available.
4. Use plain language. Explain technical terms briefly when needed.
5. Keep answers concise but complete. Use bullet points for lists.
6. If the question asks about something not covered by the data, say you don't have enough data for that.

--- RUN DATA ---
${contextBlock}
--- END RUN DATA ---`
          },
          {
            role: 'user',
            content: question.trim()
          }
        ],
        max_tokens: 600,
        temperature: 0.1
      });

      answer = completion.choices[0]?.message?.content?.trim() || 'No response generated.';
    } catch (aiErr) {
      console.error('[Copilot] AI call failed:', aiErr.message, '| code:', aiErr.code);
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
        // Graceful fallback: return raw context summary without AI
        answer = `AI is not configured (OPENAI_API_KEY missing). Here is the raw run data:\n\n` +
          `• Status: ${run.status}\n` +
          `• Phase: ${run.current_phase || 'N/A'}\n` +
          `• Intent class: ${prediction?.task_type || 'N/A'}\n` +
          `• Confidence: ${prediction?.confidence != null ? (prediction.confidence * 100).toFixed(1) + '%' : 'N/A'}\n` +
          `• Violations: ${violations.length > 0 ? violations.map(v => v.violation_type).join(', ') : 'none'}\n` +
          `• Events recorded: ${events.length}`;
      } else if (aiErr.code === 'rate_limit_exceeded' || aiErr.message?.includes('429')) {
        // Rate limit — let the user know when they can retry
        answer = `AI is at its daily limit for this workspace. Try again after midnight UTC. In the meantime, here's the raw run data:\n\n` +
          `• Status: ${run.status}\n` +
          `• Phase: ${run.current_phase || 'N/A'}\n` +
          `• Intent class: ${prediction?.task_type || 'N/A'}\n` +
          `• Confidence: ${prediction?.confidence != null ? (prediction.confidence * 100).toFixed(1) + '%' : 'N/A'}\n` +
          `• Violations: ${violations.length > 0 ? violations.map(v => v.violation_type).join(', ') : 'none'}\n` +
          `• Events recorded: ${events.length}`;
      } else {
        answer = 'AI is temporarily unavailable. Please try again in a moment.';
      }
    }

    res.json({ success: true, runId, answer });
  } catch (err) {
    console.error('[API] Copilot error:', err);
    res.status(500).json({ success: false, message: 'Copilot request failed' });
  }
});

// ── Prompt Assistant API ──────────────────────────────────
// Helps users write better task prompts via conversational AI.
// Rate limited: 20 requests per user per hour (in-memory).
const _promptAssistantCounts = new Map();
const PROMPT_ASST_LIMIT = 20;
const PROMPT_ASST_WINDOW_MS = 60 * 60 * 1000;

app.post('/api/assistant/prompt-help', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user && (req.user.id || req.user.userId);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Rate limiting
    const now = Date.now();
    const userBucket = _promptAssistantCounts.get(userId);
    if (userBucket && userBucket.resetAt > now) {
      if (userBucket.count >= PROMPT_ASST_LIMIT) {
        return res.status(429).json({ success: false, message: 'Rate limit reached. Try again in an hour.' });
      }
      userBucket.count++;
    } else {
      _promptAssistantCounts.set(userId, { count: 1, resetAt: now + PROMPT_ASST_WINDOW_MS });
    }

    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'messages array is required' });
    }

    // Validate and sanitize messages
    const validMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-12); // keep last 12 turns max

    if (validMessages.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid messages provided' });
    }

    // Optional product context from env
    let productCtxStr = '';
    if (process.env.PRODUCT_CONTEXT_JSON) {
      try {
        const ctx = JSON.parse(process.env.PRODUCT_CONTEXT_JSON);
        productCtxStr = `\nUser's product context: ${JSON.stringify(ctx)}\n`;
      } catch (_) { /* ignore */ }
    }

    const systemPrompt = `You are the BuildOrbit Prompt Assistant — a fast, conversational helper that refines task prompts before they run through the BuildOrbit AI pipeline.

BuildOrbit classifies every task into one of three Intent Gate categories:
- STATIC_SURFACE: Landing pages, marketing sites — HTML/CSS/JS only, no backend, no auth, no database.
- INTERACTIVE_LIGHT_APP: Forms, calculators, waitlists, simple tools — minimal optional backend, no auth unless asked.
- PRODUCT_SYSTEM: SaaS dashboards, multi-user platforms, full-stack apps — full backend, database, auth required.

Your job:
1. Ask targeted clarifying questions to understand what the user wants to build.
2. Keep it conversational — 1-2 focused questions max per turn.
3. Once you have enough detail (typically 2-3 exchanges), produce a polished prompt.
4. The polished prompt should be 2-4 sentences: what it is, key features/pages, audience if relevant.
5. When producing the final prompt, format your reply EXACTLY like this:
   READY PROMPT:
   <the polished prompt text here>
   You can also add a brief note before or after "READY PROMPT:" if helpful.
6. If the user's first message is already detailed enough, skip straight to READY PROMPT.
7. Be direct — this is a quick refinement, not a deep interview.
8. Steer toward what BuildOrbit does well (web apps, landing pages, tools, dashboards).
${productCtxStr}`;

    const OpenAI = require('openai');
    const openai = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...validMessages
      ],
      max_tokens: 350,
      temperature: 0.5
    });

    const reply = completion.choices[0]?.message?.content?.trim() || 'Could not generate a response.';
    res.json({ success: true, reply });
  } catch (err) {
    console.error('[PromptAssistant] Error:', err.message);
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
      return res.status(503).json({ success: false, message: 'AI assistant not configured.' });
    }
    if (err.status === 429 || err.message?.includes('429')) {
      return res.status(429).json({ success: false, message: 'AI is at capacity. Try again in a moment.' });
    }
    res.status(500).json({ success: false, message: 'Assistant unavailable. Please try again.' });
  }
});

// Landing page
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.json({ message: 'BuildOrbit' });
  }
});

// ── A2A (Agent-to-Agent) API ─────────────────────────────
// Exposes the 6-phase pipeline as a remote subagent callable from Gemini CLI
// or any Bearer-token capable A2A client.
// Descriptor: GET /a2a/descriptor
// Execute:    POST /a2a/execute (Bearer auth, SSE response)
// Keys:       GET/POST/DELETE /a2a/keys (session auth)
app.use('/a2a', createA2ARouter({ pool, pipeline, orchestrator, stateMachine, auth }));

// ── MCP Connector Framework ───────────────────────────────
// Layer 2 of BuildOrbit's three-layer architecture: Agents → MCP → Production.
// Registry manages per-user server configs + active connections.
// Audit records every tool call in pipeline_events (event_type='mcp_tool_call').
const { McpRegistry } = require('./src/mcp/mcp-registry');
const { McpAudit } = require('./src/mcp/mcp-audit');
const { createMcpRouter } = require('./src/routes/mcp');

const mcpRegistry = new McpRegistry({ pool });
const mcpAudit = new McpAudit({ pool });

// Expose MCP to the orchestrator so pipeline phases receive _mcpContext
orchestrator.mcpRegistry = mcpRegistry;
orchestrator.mcpAudit = mcpAudit;

app.use('/api/mcp', createMcpRouter({ mcpRegistry, mcpAudit, auth }));

// ── Orbit Chat API ─────────────────────────────────
// Persistent agentic supervisor with GPT-4o tool-calling and conversation memory.
// Chat:  POST /a2a/orbit/chat (session auth, { message, conversationId? })
const { createOrbitRouter } = require('./src/routes/a2a-orbit');
app.use('/a2a/orbit', createOrbitRouter({ pool, pipeline, orchestrator, stateMachine, auth, mcpRegistry, mcpAudit }));

// Analytics API — GET /api/analytics/summary (session auth required)
app.use('/api/analytics', createAnalyticsRouter({ pool, auth }));

// Runs API — GET /api/runs/:id/reasoning (phase reasoning timeline, 3s polling)
app.use('/api/runs', createRunsRouter({ pool, auth, pipeline }));

// Browserbase API — GET /api/runs/:runId/screenshot, GET /api/browserbase/status
const { createBrowserbaseRouter } = require('./src/routes/browserbase');
app.use('/api', createBrowserbaseRouter(auth.requireAuth));

// [Removed] New task page — public/new-task.html no longer exists; /new-task now redirects to /new (see line 1242)

// Dedicated run view page — served by React app (Run.tsx + PipelineView components)
// React Router handles /run/:id client-side; Express delivers the shell.
// NOTE: The old /run static route (public/run.html) is removed — React SPA handles all run views.
app.get('/run/:runId', auth.requireAuth, (req, res) => {
  const { runId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).send('Invalid run ID');
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});

// Code Copilot editor page — 3-panel IDE for post-build editing
app.get('/run/:runId/edit', auth.requireAuth, (req, res) => {
  const { runId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).send('Invalid run ID');
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'copilot.html'));
});

// Command Center dashboard — served by React app (Dashboard.tsx)
// Analytics event still fired server-side before handing off to React shell.
app.get('/dashboard', auth.requireAuth, (req, res) => {
  const sessionUserId = req.user?.userId || null;
  analytics.emitEvent(pool, 'SESSION_STARTED', sessionUserId, {
    user_agent: req.headers['user-agent'] ? req.headers['user-agent'].slice(0, 128) : null,
  });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});

// Decision Trace Viewer — explainability layer for every agent step
app.get('/trace', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'trace.html'));
});

// /history — React app (History.tsx handles client-side)
app.get('/history', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});

// Causal DAG Viewer — visual flowchart of decision nodes from trace_nodes table
// Accessible via "View Trace" button on /run after pipeline completes.
// Data: GET /api/runs/:id/trace
app.get('/dag', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'dag.html'));
});

// Settings — served by React app (Settings.tsx). Both /settings and /settings/api-keys
// are handled client-side by React Router; Express delivers the shell for both.
app.get('/settings', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});
app.get('/settings/api-keys', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});

// /admin — Admin panel. Auth required server-side; React handles the admin gate client-side.
// Non-admins who navigate here will see the "Access Denied" React view, not a raw redirect.
app.get('/admin', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  serveSPA(req, res);
});

// ── Elemental Page — reusable pipeline components (coming soon) ──
app.get('/elemental', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'elemental.html'));
});

// ── Code Copilot Page ─────────────────────────────────────
app.get('/copilot', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'copilot.html'));
});

// ── Orbit Chat Redirect ───────────────────────────
// /chat page retired. Redirect to dashboard with chat widget open via query param.
app.get('/chat', auth.requireAuth, (req, res) => {
  res.redirect(302, '/dashboard?chat=open');
});

// ── Code Copilot Chat API ─────────────────────────────────
// Streaming SSE endpoint. Accepts a message + file context + chat history.
// Builds a rich Claude prompt with: active file content, file tree,
// scaffold manifest, intent class, plan, and chat history.
// Guardrail: refuses backend/auth code requests on STATIC_SURFACE builds.
//
// Rate limit: 30 requests per user per 10 minutes (in-memory sliding window).
const _copilotChatCounts = new Map();
const COPILOT_LIMIT = 30;
const COPILOT_WINDOW_MS = 10 * 60 * 1000;

app.post('/api/copilot/chat', auth.requireAuth, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  // ── Rate limit ────────────────────────────────────────
  const now = Date.now();
  const userKey = String(userId);
  const timestamps = (_copilotChatCounts.get(userKey) || []).filter(t => now - t < COPILOT_WINDOW_MS);
  if (timestamps.length >= COPILOT_LIMIT) {
    return res.status(429).json({ success: false, message: 'Rate limit: max 30 code copilot messages per 10 minutes.' });
  }
  timestamps.push(now);
  _copilotChatCounts.set(userKey, timestamps);

  const { runId, activeFile, message, chatHistory } = req.body;

  if (!runId || typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).json({ success: false, message: 'Invalid runId' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  // ── Load run from DB ──────────────────────────────────
  let run;
  try {
    const result = await pool.query(
      `SELECT id, prompt, status, intent_class, plan, scaffold, code, created_at
       FROM pipeline_runs WHERE id = $1 AND user_id = $2`,
      [runId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    run = result.rows[0];
  } catch (dbErr) {
    console.error('[CodeCopilot] DB error:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Database error' });
  }

  // Parse stored JSON columns
  const parseCol = (col) => {
    if (!col) return null;
    try { return typeof col === 'string' ? JSON.parse(col) : col; } catch { return null; }
  };
  const plan      = parseCol(run.plan);
  const scaffold  = parseCol(run.scaffold);
  const codeData  = parseCol(run.code);
  const files     = (codeData && typeof codeData.files === 'object') ? codeData.files : {};
  const intentClass = run.intent_class || null;

  // ── STATIC_SURFACE guardrail ──────────────────────────
  const BACKEND_KEYWORDS = /\b(server|database|backend|auth|sql|node|express|api route|endpoint|migration|postgres|middleware|session|cookie|jwt|password|encrypt|hash)\b/i;
  if (intentClass === 'static_surface' && BACKEND_KEYWORDS.test(message)) {
    // Stream a refusal
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const refusal = `This project was classified as **STATIC_SURFACE** — it's a static HTML/CSS/JS site without a backend or database. I can help you with:\n\n- HTML structure and content\n- CSS styling and animations\n- Client-side JavaScript\n- Layout and responsiveness\n\nFor backend features (auth, database, API routes), you'd need to start a new build with a different product intent.`;
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: refusal })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();
  }

  // ── Build context ─────────────────────────────────────
  const fileList = Object.keys(files);
  const fileTreeStr = fileList.length > 0
    ? fileList.map(f => `  - ${f}`).join('\n')
    : '  (no files generated)';

  const rawActiveContent = (activeFile && files[activeFile])
    ? files[activeFile]
    : null;
  // Cap active file at ~6000 chars (~1500 tokens) to stay within daily budget
  const activeFileContent = rawActiveContent
    ? (rawActiveContent.length > 6000 ? rawActiveContent.slice(0, 6000) + '\n... (file truncated for context — full file is ' + rawActiveContent.length + ' chars)' : rawActiveContent)
    : null;

  const otherFiles = fileList.filter(f => f !== activeFile);
  // Include condensed view of other files (first 10 lines each, max 5 files — token-efficient)
  const otherFilesContext = otherFiles.slice(0, 5).map(f => {
    const content = files[f] || '';
    const lines = content.split('\n');
    const preview = lines.slice(0, 10).join('\n');
    const truncated = lines.length > 10 ? `\n... (${lines.length - 10} more lines)` : '';
    return `### ${f}\n\`\`\`\n${preview}${truncated}\n\`\`\``;
  }).join('\n\n');

  const scaffoldStr = scaffold
    ? `Intent class: ${scaffold.intentClass || intentClass || 'unknown'}\nTech stack: ${(scaffold.techStack || []).join(', ')}\nFile tree: ${(scaffold.tree || []).join(', ')}`
    : '(not available)';

  const planStr = plan?.rawMarkdown
    ? plan.rawMarkdown.slice(0, 400)
    : (plan ? JSON.stringify(plan).slice(0, 300) : '(not available)');

  // Chat history (last 4 messages max, trimmed — saves tokens)
  const history = Array.isArray(chatHistory) ? chatHistory.slice(-4) : [];
  const historyMessages = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content.slice(0, 800) : '',
  }));

  const systemPrompt = `You are BuildOrbit's Code Copilot — an expert full-stack developer helping users edit and improve their generated web application through natural language.

## Your Role
- Understand the full project context and make targeted, high-quality code changes
- Respond with clear explanations AND complete updated file content
- Respect the project's architecture, tech stack, and constraints

## Project Context
**Original Prompt:** ${run.prompt || 'N/A'}
**Intent Class:** ${intentClass || 'unknown'}
**Tech Stack:** ${(scaffold?.techStack || []).join(', ') || 'Express + Postgres'}

## Scaffold Manifest
${scaffoldStr}

## Architecture Plan
${planStr}

## Full Project File Tree
${fileTreeStr}

${activeFile ? `## Currently Open File: ${activeFile}
\`\`\`
${activeFileContent || '(empty)'}
\`\`\`` : '## No file currently selected'}

${otherFiles.length > 0 ? `## Other Project Files (condensed)\n${otherFilesContext}` : ''}

## Response Format
Always structure your response as:
1. **Brief explanation** of what you're changing and why (1-3 sentences)
2. **Complete updated file** using this exact format for each changed file:

\`\`\`filepath:FILENAME
COMPLETE FILE CONTENT HERE
\`\`\`

Use the \`filepath:\` prefix in the code fence to identify which file each block belongs to.
If multiple files change, include all of them. Always provide the COMPLETE file content — never truncate.

## Rules
- Only output files that actually change
- Always include complete file content, never partial snippets
- If the user asks about something unclear, ask a clarifying question before making changes
- Keep the branding badge (BuildOrbit link from APP_URL) in place
- Maintain the existing code style and patterns`;

  // ── Stream response ───────────────────────────────────
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: message.trim() },
      ],
      max_tokens: 4000,
      temperature: 0.2,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: delta })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (aiErr) {
    console.error('[CodeCopilot] AI error:', aiErr.message);
    const msg = aiErr.message || '';
    const isRateLimit = aiErr.status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('token limit');
    const errMsg = isRateLimit
      ? '\n\n⏳ AI usage limit reached — resets automatically. You can still edit code directly in the editor (Code tab). Try again in a few minutes.'
      : '\n\n⚠️ AI hit a temporary issue. Please try again in a moment.';
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: errMsg })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
});

// ── SPA Catch-All Route ────────────────────────────────────────────────────
// For any unmatched GET requests (after all API routes, static files, etc),
// serve the React SPA entry point so React Router can handle client-side navigation
app.get('*', (req, res) => {
  if (req.method === 'GET') {
    serveSPA(req, res);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Run all pending migrations before accepting traffic.
// Uses the same Pool as the rest of the app; runs once per migration.
{
  const fs = require('fs');
  const path = require('path');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const { rows: applied } = await client.query('SELECT name FROM _migrations');
      const appliedNames = new Set(applied.map(r => r.name));
      const migrationsDir = path.join(__dirname, 'migrations');
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort();
      for (const file of files) {
        const m = require(path.join(migrationsDir, file));
        const name = m.name || file.replace('.js', '');
        if (appliedNames.has(name)) continue;
        console.log(`[migrate] Applying: ${name}`);
        await client.query('BEGIN');
        try {
          await m.up(client);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          console.log(`[migrate] Applied: ${name}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration failed (${name}): ${err.message}`);
        }
      }
      console.log('[migrate] All migrations applied.');
    } finally {
      client.release();
      await pool.end();
    }
  })().catch(err => {
    console.error('[migrate] Fatal:', err.message);
    process.exit(1);
  });
}

// ── Global Process Safety Net ──────────────────────────────────────────────
// Log unhandled rejections and uncaught exceptions without crashing the server.
// Unhandled rejections from fire-and-forget async calls (analytics, tracing, etc.)
// previously caused process.exit(1) in Node ≥15. This safety net prevents that.
// Specific known error paths already catch at source — this is the last resort.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[BuildOrbit] Unhandled rejection (caught by safety net):', msg, { promise });
  // Do NOT exit — allow in-flight requests and pipelines to complete.
});

process.on('uncaughtException', (err) => {
  console.error('[BuildOrbit] Uncaught exception (caught by safety net):', err.message, { stack: err.stack });
  // Do NOT exit — Express stays alive and continues serving requests.
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────
// Drain the DB connection pool and stop accepting new connections on SIGTERM/SIGINT.
// Render sends SIGTERM before a deploy restart — this prevents stale connections.
async function gracefulShutdown(signal) {
  console.log(`[BuildOrbit] Received ${signal}; initiating graceful shutdown`);
  server.close(async () => {
    console.log('[BuildOrbit] HTTP server closed');
    try {
      await pool.end();
      console.log('[BuildOrbit] Database pool drained');
    } catch (err) {
      console.error('[BuildOrbit] Pool drain error (non-fatal):', err.message);
    }
    process.exit(0);
  });

  // Force-exit after 15 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[BuildOrbit] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const server = app.listen(port, () => {
  console.log(`[BuildOrbit] Server running on port ${port}`);
  console.log(`[BuildOrbit] Pipeline agents: PlannerAgent → BuilderAgent → OpsAgent → QAAgent`);
  console.log(`[BuildOrbit] Orchestrator initialized with agent registry + event bus + stage contracts`);
  console.log(`[BuildOrbit] Artifact store: ./artifacts/{runId}/{stage}/{filename}`);
  console.log(`[BuildOrbit] A2A endpoint: POST /a2a/execute (Bearer auth, SSE stream, 6-phase)`);
  console.log(`[BuildOrbit] A2A descriptor: GET /a2a/descriptor`);

  // Layer 5: Emit EMAIL_PROVIDER_CHECKED on boot — records Postmark config validity
  // as a replayable run_event before any auth traffic arrives.
  probeProviderOnStartup(pool).catch(err => {
    console.error('[BuildOrbit] Provider health probe error:', err.message);
  });

  // Recover deployed sites from database (Render filesystem is ephemeral)
  deployEngine.recover().catch(err => {
    console.error('[BuildOrbit] Deploy recovery error:', err.message);
  });

  // Recover any in-flight pipelines from before restart
  orchestrator.recover().catch(err => {
    console.error('[BuildOrbit] Recovery error:', err.message);
  });
});

// ── Helper: Convert state machine event to SSE events ───
// stagesWithOutput: Set that tracks which stages already had output delivered.
// This prevents duplicate output when live chunks AND completed payloads both carry content.
// When a stage has no live output (e.g., SSE connected after stage finished), the completed
// payload is the ONLY source — stagesWithOutput ensures we extract it.
function emitStateEvent(emit, event, isReplay = false, stagesWithOutput = null) {
  const { stage, status, payload } = event;

  if (status === 'started') {
    emit('phase', { phase: stage, status: 'running' });
  } else if (status === 'completed') {
    // Extract output from completed payload when this stage has no prior output.
    // This covers: replay (late joiners), buffered events (race condition where pipeline
    // completes before SSE fully connects), and live events where emitChunk output was lost.
    const needsOutput = payload && (isReplay || (stagesWithOutput && !stagesWithOutput.has(stage)));
    if (needsOutput) {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (stage === 'intent_gate') {
          // Intent Gate — emit constraint contract summary as terminal output
          if (stagesWithOutput) stagesWithOutput.add(stage);
          const parts = [`## Intent Gate\n`];
          if (data.intent_class) parts.push(`**Intent Class:** ${data.intent_class}`);
          if (data.complexity_budget) parts.push(`**Complexity Budget:** ${data.complexity_budget}`);
          if (data.expansion_lock !== undefined) parts.push(`**Expansion Lock:** ${data.expansion_lock}`);
          if (data.constraints) {
            parts.push(`**Constraints:** ${JSON.stringify(data.constraints, null, 2)}`);
          }
          emit('output', { phase: stage, content: parts.join('\n') });
          // Also emit intent_classified for UI-aware rendering
          const icMap = { static_surface: 'STATIC_SURFACE', light_app: 'INTERACTIVE_LIGHT_APP', soft_expansion: 'INTERACTIVE_LIGHT_APP', full_product: 'PRODUCT_SYSTEM' };
          const canonical = icMap[data.intent_class] || data.intent_class || null;
          emit('intent_classified', { intent_class: canonical, raw_class: data.intent_class || null });
        } else if (data.raw || data.rawMarkdown) {
          // Plan stage (rawMarkdown) or any stage with raw text output
          if (stagesWithOutput) stagesWithOutput.add(stage);
          emit('output', { phase: stage, content: data.raw || data.rawMarkdown || '' });
        } else if (data.files && typeof data.files === 'object' && !Array.isArray(data.files)) {
          // Code stage — emit file listing (files is a dict, not an array)
          if (stagesWithOutput) stagesWithOutput.add(stage);
          const fileList = Object.entries(data.files)
            .map(([name, code]) => {
              const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
              return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
            })
            .join('\n\n');
          emit('output', { phase: stage, content: fileList });
        } else if (stage === 'verify' && Array.isArray(data.checks)) {
          // Verify stage — replay the structured verify_report so the frontend
          // renders the visual checklist AND has data for the completion banner.
          if (stagesWithOutput) stagesWithOutput.add(stage);
          // Also replay the check results as terminal output text
          const lines = ['## Verification Results\n'];
          for (const check of data.checks) {
            lines.push(`${check.passed ? '\u2713' : '\u2717'} ${check.name}`);
          }
          const _rpc = data.checks.filter(c => c.passed).length;
          const _rtc = data.checks.length;
          lines.push(`\n**Result: ${_rpc === _rtc ? 'ALL CHECKS PASSED' : (_rpc === 0 ? 'FAILED' : 'PARTIAL')} \u2014 ${_rpc}/${_rtc} checks passed.**`);
          emit('output', { phase: 'verify', content: lines.join('\n') });
          // verify_report is emitted below (outside needsOutput guard) for ALL streams
        } else if (stage === 'scaffold') {
          // Scaffold stage — emit summary + file tree
          if (stagesWithOutput) stagesWithOutput.add(stage);
          const parts = [];
          if (data.summary) parts.push(`## Scaffold\n\n${data.summary}`);
          if (Array.isArray(data.tree) && data.tree.length > 0) {
            parts.push('**File Structure:**\n' + data.tree.map(t =>
              `${t.type === 'dir' ? '\uD83D\uDCC1' : '\uD83D\uDCC4'} ${t.path}`
            ).join('\n'));
          }
          if (Array.isArray(data.techStack) && data.techStack.length > 0) {
            parts.push(`**Tech Stack:** ${data.techStack.join(', ')}`);
          }
          if (parts.length > 0) {
            emit('output', { phase: stage, content: parts.join('\n\n') });
          }
        } else if (stage === 'save') {
          // Save stage — emit save confirmation
          if (stagesWithOutput) stagesWithOutput.add(stage);
          const parts = ['\u2713 Artifacts saved and persisted.'];
          if (data.versionId) parts.push(`**Version:** ${data.versionId}`);
          emit('output', { phase: stage, content: parts.join('\n') });
        } else if (stage === 'intent_gate') {
          // Intent Gate — emit constraint contract summary
          if (stagesWithOutput) stagesWithOutput.add(stage);
          const parts = ['## Intent Gate (Phase 1/6)\n'];
          if (data.intent_class) parts.push(`**Intent Class:** ${data.intent_class}`);
          if (data.complexity_budget) parts.push(`**Complexity Budget:** ${data.complexity_budget}`);
          if (data.expansion_lock !== undefined) parts.push(`**Expansion Lock:** ${data.expansion_lock}`);
          if (data.constraints) {
            parts.push('**Constraints:**');
            for (const [k, v] of Object.entries(data.constraints)) {
              parts.push(`  ${k}: ${v}`);
            }
          }
          if (data.entropy != null) parts.push(`**Entropy:** ${Number(data.entropy).toFixed(4)} nats`);
          parts.push('\n\u2713 Constraint Contract locked and immutable.');
          emit('output', { phase: stage, content: parts.join('\n') });
        }
      } catch (extractErr) {
        // Non-fatal — output extraction should never break the SSE stream
        console.warn('[SSE] Output extraction from completed payload failed:', extractErr.message);
      }
    }
    // ── VERIFY phase: always emit verify_report + check-aware phase status ──
    // This runs for BOTH live and replay streams. The verify_report event carries
    // structured check data so the frontend can render the completion banner and
    // update the phase indicator correctly. Previously, verify_report was only
    // emitted inside the needsOutput guard (replay-only), causing live watchers
    // to never receive it — resulting in a contradictory "passed" phase indicator
    // while individual checks showed failures.
    if (stage === 'verify' && payload) {
      try {
        const _vData = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (Array.isArray(_vData.checks) && _vData.checks.length > 0) {
          const _vpc = _vData.checks.filter(c => c.passed).length;
          const _vtc = _vData.checks.length;
          const _vAllPassed = _vpc === _vtc;
          // Emit structured verify_report for frontend checklist + banner
          emit('verify_report', {
            checks: _vData.checks,
            sectionReport: _vData.sectionReport || [],
            passed: _vAllPassed,
            passedCount: _vpc,
            totalChecks: _vtc,
            errors: _vData.errors || [],
            warnings: _vData.warnings || [],
          });
          // Phase indicator: "completed" (green ✓) only if ALL checks pass.
          // Otherwise "failed" (red ✗) so the phase bar reflects the actual outcome.
          emit('phase', { phase: stage, status: _vAllPassed ? 'completed' : 'failed' });
        } else {
          // No check data — fall back to generic completed
          emit('phase', { phase: stage, status: 'completed' });
        }
      } catch (_vErr) {
        // Fallback: emit completed if payload parsing fails
        emit('phase', { phase: stage, status: 'completed' });
      }
    } else if (stage === 'scaffold' && payload) {
      // ── SCAFFOLD phase: always emit scaffold_complete with structured data ──
      // Same pattern as verify_report — emit the structured scaffold manifest
      // regardless of stagesWithOutput. During live streaming, the frontend
      // accumulates raw text chunks; this event replaces them with the proper
      // tree/techStack/summary UI once the phase finishes.
      try {
        const _scData = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (_scData && Array.isArray(_scData.tree)) {
          emit('scaffold_complete', {
            tree: _scData.tree,
            techStack: _scData.techStack || [],
            summary: _scData.summary || '',
          });
        }
      } catch (_scErr) {
        // Non-fatal — scaffold_complete is a rendering enhancement
      }
      emit('phase', { phase: stage, status: 'completed' });
    } else if (stage === 'save' && payload) {
      // Pass githubPrUrl and deployUrl in the phase event so the frontend can show action buttons.
      try {
        const _saveData = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const _savePayload = {};
        if (_saveData && _saveData.githubPrUrl) _savePayload.githubPrUrl = _saveData.githubPrUrl;
        if (_saveData && _saveData.deployUrl) _savePayload.deployUrl = _saveData.deployUrl;
        if (Object.keys(_savePayload).length > 0) {
          emit('phase', { phase: stage, status: 'completed', payload: _savePayload });
        } else {
          emit('phase', { phase: stage, status: 'completed' });
        }
      } catch (_saveErr) {
        emit('phase', { phase: stage, status: 'completed' });
      }
    } else {
      emit('phase', { phase: stage, status: 'completed' });
    }
  } else if (status === 'output' && payload) {
    // Streaming output chunk (live only, not persisted)
    // Track that this stage received live output so completed payload isn't re-emitted
    if (stagesWithOutput) stagesWithOutput.add(stage);
    const content = typeof payload === 'string' ? JSON.parse(payload) : payload;
    emit('output', { phase: stage, content: content.content || '' });
  } else if (status === 'failed') {
    emit('phase', { phase: stage, status: 'failed' });
  } else if (status === 'paused') {
    // Pipeline paused between stages
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    emit('pipeline_paused', { after_stage: data.after_stage || stage });
  } else if (status === 'resumed') {
    // Pipeline resumed
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    emit('pipeline_resumed', { after_stage: data.after_stage || stage });
  } else if (status === 'instruction_injected') {
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    emit('instruction_injected', { message: data.message || '' });
  } else if (status === 'agent_overridden') {
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    emit('agent_overridden', { agent: data.agent || '', scope: data.scope || 'one_shot' });
  } else if (status === 'verify_report') {
    // Structured verify report from orchestrator (live, after self-heal, etc.)
    // Forward directly so the frontend can update banner + phase indicator
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (Array.isArray(data.checks)) {
        const _vrpc = data.checks.filter(c => c.passed).length;
        const _vrtc = data.checks.length;
        emit('verify_report', {
          checks: data.checks,
          sectionReport: data.sectionReport || [],
          passed: _vrpc === _vrtc,
          passedCount: _vrpc,
          totalChecks: _vrtc,
          errors: data.errors || [],
          warnings: data.warnings || [],
          selfHealed: data.selfHealed || false,
        });
        // Also update the phase indicator to match the latest verify result
        emit('phase', { phase: 'verify', status: _vrpc === _vrtc ? 'completed' : 'failed' });
      }
    } catch (_) { /* non-fatal */ }
  } else if (status === 'self_heal_retry_start' || status === 'self_heal_succeeded' || status === 'self_heal_exhausted') {
    // Forward self-heal events directly to frontend
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      emit(status, data);
    } catch (_) { /* non-fatal */ }
  } else if (status === 'cost_update') {
    // Real-time cost update from cost tracker
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    emit('cost_update', { phase: stage, ...(data || {}) });
  } else if (status === 'budget_warning') {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    emit('budget_warning', { phase: stage, ...(data || {}) });
  } else if (status === 'budget_exceeded') {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    emit('budget_exceeded', { phase: stage, ...(data || {}) });
  } else if (status === 'catastrophic_rewrite_blocked') {
    // Hard-block: generated files would catastrophically overwrite the existing repo.
    // Surface block details to the frontend so the user can review and confirm.
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      emit('catastrophic_rewrite_blocked', {
        runId: id,
        reason:    data.reason || 'Catastrophic rewrite detected',
        stats:     data.stats  || {},
        overrideUrl: `/api/pipeline/${id}/override-catastrophic-block`,
      });
    } catch (_) { /* non-fatal */ }
  } else if (status === 'classified' && stage === 'intent_gate') {
    // Intent Gate classification result — tells frontend the intent_class so it can
    // render intent-aware UI (hide backend/db sections for STATIC_SURFACE, etc.)
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    const icMap = {
      static_surface: 'STATIC_SURFACE',
      light_app:      'INTERACTIVE_LIGHT_APP',
      soft_expansion: 'INTERACTIVE_LIGHT_APP',
      full_product:   'PRODUCT_SYSTEM',
    };
    const canonical = icMap[data.intent_class] || data.intent_class || null;
    emit('intent_classified', { intent_class: canonical, raw_class: data.intent_class || null });
  } else if (status === 'verify_report') {
    // Structured verification report from VERIFY phase — forwarded to frontend for checklist UI
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    emit('verify_report', { ...data });
  } else if (stage === 'deploy') {
    // Deploy engine events — forwarded as-is to the SSE stream
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    if (status === 'preview_ready') {
      // CODE phase finished — preview available before full deploy
      emit('preview_ready', { ...data });
    } else if (status === 'deploy_started' || status === 'deploy_uploading') {
      emit('deploy_progress', { status, ...data });
    } else if (status === 'deploy_complete') {
      emit('deploy_complete', { ...data });
    } else if (status === 'deploy_failed') {
      emit('deploy_failed', { ...data });
    } else if (status === 'deploy_rollback') {
      emit('deploy_rollback', { ...data });
    }
  }
}
