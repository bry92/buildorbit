/**
 * Environment Variable Validation — Fail-Fast Boot Check
 *
 * Validates all required env vars at server startup. Catches missing credentials
 * before the first request, preventing silent failures and late-stage discovery.
 *
 * Required (hard): DATABASE_URL, JWT_SECRET, NODE_ENV
 * Conditionally required (by feature): OPENAI_API_KEY, STRIPE_SECRET_KEY, GITHUB_CLIENT_ID
 */

/**
 * Validate all environment variables.
 * Throws an error immediately if any required var is missing or invalid.
 */
function validateEnvironment() {
  const errors = [];

  // ── Hard Requirements ──────────────────────────────────────────────────────

  // DATABASE_URL: PostgreSQL connection string (required always)
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL: PostgreSQL connection string required');
  }

  // JWT_SECRET: ≥32 bytes for cryptographic signing (required always)
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET: Must be set (≥32 bytes)');
  } else if (Buffer.from(process.env.JWT_SECRET).length < 32) {
    errors.push('JWT_SECRET: Must be at least 32 bytes (currently ' + Buffer.from(process.env.JWT_SECRET).length + ')');
  }

  // NODE_ENV: Controls feature flags, security headers, logging
  if (!process.env.NODE_ENV || !['production', 'development', 'test'].includes(process.env.NODE_ENV.toLowerCase())) {
    errors.push('NODE_ENV: Must be "production", "development", or "test"');
  }

  // ── Conditional Requirements ──────────────────────────────────────────────

  // OPENAI_API_KEY: Used by all pipeline phases (plan, code, verify)
  // Required unless in MOCK_MODE
  if (!process.env.OPENAI_API_KEY && process.env.MOCK_MODE !== 'true') {
    errors.push('OPENAI_API_KEY: Required unless MOCK_MODE=true');
  }

  // STRIPE_SECRET_KEY: Used for subscription billing
  // Optional — only required if the app actively initializes Stripe.
  // If Stripe initialization is conditional and gracefully fails, this is not required.
  // Uncomment if Stripe is a hard requirement:
  // if (!process.env.STRIPE_SECRET_KEY) {
  //   errors.push('STRIPE_SECRET_KEY: Required for subscription billing');
  // }

  // GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET: GitHub OAuth flow
  // Optional but both must be set if GitHub integration is enabled
  const hasGitHubId = !!process.env.GITHUB_CLIENT_ID;
  const hasGitHubSecret = !!process.env.GITHUB_CLIENT_SECRET;
  if (hasGitHubId !== hasGitHubSecret) {
    errors.push('GitHub OAuth: Both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together');
  }

  // ── Security Checks ────────────────────────────────────────────────────────

  // Fail-safe: MOCK_MODE must never be true in production
  if (process.env.MOCK_MODE === 'true' && process.env.NODE_ENV?.toLowerCase() === 'production') {
    errors.push('MOCK_MODE=true in production: Security violation. MOCK_MODE must be false in production.');
  }

  // ── Collect and Report ─────────────────────────────────────────────────────

  if (errors.length > 0) {
    const message = 'FATAL: Environment validation failed:\n\n' +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n') +
      '\n\nSee .env.example for required variables.';
    console.error(message);
    process.exit(1);
  }

  // Success: log what was validated
  console.log('[ENV] ✓ All required environment variables are set');
  return true;
}

module.exports = { validateEnvironment };
