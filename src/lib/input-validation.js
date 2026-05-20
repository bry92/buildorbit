/**
 * Input validation middleware — field-level size and type enforcement.
 *
 * Owns: per-route request body validation guards.
 * Does NOT own: authentication, authorization, or business logic.
 *
 * Why field-level limits matter: the global 10mb body limit prevents OOM from
 * single giant payloads but doesn't stop an attacker from embedding a 9.9mb
 * prompt inside an otherwise-small JSON body.  These guards enforce tight
 * per-field ceilings so oversized single fields are rejected early.
 */

/**
 * Build a validation middleware that checks req.body fields against a spec.
 *
 * spec is a map of fieldName → { maxLen?: number, type?: 'string'|'number', required?: boolean }
 *
 * Returns 400 with a descriptive error if any constraint is violated.
 * Fields absent from spec are ignored (pass-through).
 *
 * @param {Record<string, { maxLen?: number, type?: string, required?: boolean }>} spec
 * @returns {import('express').RequestHandler}
 */
function validateFields(spec) {
  return function fieldValidationMiddleware(req, res, next) {
    const body = req.body || {};

    for (const [field, rules] of Object.entries(spec)) {
      const value = body[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        return res.status(400).json({
          success: false,
          message: `Missing required field: ${field}`,
        });
      }

      // Only validate further if the field is present
      if (value === undefined || value === null) continue;

      if (rules.type === 'string' && typeof value !== 'string') {
        return res.status(400).json({
          success: false,
          message: `Field '${field}' must be a string`,
        });
      }

      if (rules.maxLen !== undefined && typeof value === 'string' && value.length > rules.maxLen) {
        return res.status(400).json({
          success: false,
          message: `Field '${field}' exceeds maximum length of ${rules.maxLen} characters`,
        });
      }
    }

    next();
  };
}

// Pre-built validators for common API endpoints.
// Import the specific validator you need rather than importing validateFields directly.

/** POST /api/runs — prompt up to 50KB, context up to 200KB */
const validateRunCreate = validateFields({
  prompt:       { required: true, type: 'string', maxLen: 50_000 },
  context:      { type: 'string', maxLen: 200_000 },
  github_repo:  { type: 'string', maxLen: 500 },
  source_repo:  { type: 'string', maxLen: 500 },
});

/** POST /api/auth/magic-link — email max 254 chars (RFC 5321 limit) */
const validateMagicLink = validateFields({
  email: { required: true, type: 'string', maxLen: 254 },
});

/** POST /api/auth/resend — same as magic-link */
const validateResend = validateFields({
  email: { required: true, type: 'string', maxLen: 254 },
});

/** POST /api/auth/password-login */
const validatePasswordLogin = validateFields({
  email:    { required: true, type: 'string', maxLen: 254 },
  password: { required: true, type: 'string', maxLen: 1024 },
});

/** POST /api/memory — content up to 50KB */
const validateMemoryCreate = validateFields({
  content:   { required: true, type: 'string', maxLen: 50_000 },
  title:     { type: 'string', maxLen: 500 },
  tags:      { type: 'string', maxLen: 1000 },
});

module.exports = {
  validateFields,
  validateRunCreate,
  validateMagicLink,
  validateResend,
  validatePasswordLogin,
  validateMemoryCreate,
};
