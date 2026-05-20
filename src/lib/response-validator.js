/**
 * Response Validation Middleware — Prevents Incomplete/Invalid API Responses
 *
 * Wraps res.json() to validate responses against registered schemas.
 * Logs validation failures but doesn't block (fail-open), ensuring the app stays responsive
 * even if validation rules are misconfigured.
 *
 * Usage:
 *   const RunSchema = RunResponseSchema;
 *   app.post('/api/runs', validateResponse(RunSchema), handler);
 */

const { ZodError } = require('zod');

/**
 * Middleware factory that validates outbound responses against a Zod schema.
 * Falls back gracefully if validation fails (logs but returns response).
 */
function validateResponse(schema) {
  return (req, res, next) => {
    const originalJson = res.json;

    res.json = function(data) {
      // Attempt validation
      try {
        const validated = schema.parse(data);
        // Validation passed — send validated data
        return originalJson.call(this, validated);
      } catch (err) {
        if (err instanceof ZodError) {
          // Validation failed — log errors but send the original data
          // (fail-open: we don't block the response to avoid cascading failures)
          const errors = err.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
            received: e.code,
          }));
          console.warn(`[${req.id}] Response validation failed for ${req.method} ${req.path}:`, JSON.stringify(errors, null, 2));
          console.warn(`[${req.id}] Sending data anyway to avoid blocking response`);

          // Still send the original data — frontend/client will see it
          return originalJson.call(this, data);
        } else {
          // Unexpected error during validation — not a ZodError
          console.error(`[${req.id}] Unexpected error in response validation:`, err.message);
          return originalJson.call(this, data);
        }
      }
    };

    next();
  };
}

module.exports = { validateResponse };
