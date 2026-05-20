/**
 * API Response Schemas — Zod Validation
 *
 * Schemas for critical API responses. Validates structure before returning to clients,
 * catching missing fields early rather than letting the frontend break silently.
 *
 * Usage:
 *   const response = { runId: '...', phases: [...] };
 *   const validated = RunResponseSchema.parse(response);  // throws ZodError if invalid
 *   res.json(validated);
 */

const { z } = require('zod');

// ── Pipeline Run Response ──────────────────────────────────────────────────

const PhaseSchema = z.object({
  phase: z.string(),
  status: z.string(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  reasoning: z.record(z.any()).optional(),
  error: z.string().optional(),
});

const RunResponseSchema = z.object({
  runId: z.string().uuid(),
  userId: z.string(),
  status: z.enum(['pending', 'executing', 'completed', 'failed', 'partial_success']),
  phases: z.array(PhaseSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  costUsd: z.number().nonnegative().optional(),
  errors: z.array(z.any()).optional(),
});

// ── User / Auth Response ───────────────────────────────────────────────────

const UserResponseSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  displayName: z.string().optional(),
  subscriptionStatus: z.enum(['trial', 'active', 'paused', 'canceled']).optional(),
  creditsRemaining: z.number().nonnegative().optional(),
  createdAt: z.string().datetime(),
});

// ── List Response (generic paginated) ──────────────────────────────────────

const ListResponseSchema = z.object({
  items: z.array(z.any()),
  total: z.number().nonnegative(),
  page: z.number().positive().optional(),
  pageSize: z.number().positive().optional(),
});

// ── Error Response ─────────────────────────────────────────────────────────

const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number(),
  requestId: z.string().optional(),
  details: z.record(z.any()).optional(),
});

// ── GitHub Integration Response ────────────────────────────────────────────

const GitHubConnectionResponseSchema = z.object({
  connected: z.boolean(),
  username: z.string().optional(),
  avatar_url: z.string().url().optional(),
  repositories: z.array(z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
  })).optional(),
});

// ── Billing / Subscription Response ────────────────────────────────────────

const SubscriptionResponseSchema = z.object({
  customerId: z.string(),
  subscriptionId: z.string().optional(),
  status: z.enum(['active', 'past_due', 'canceled', 'paused']),
  planId: z.string(),
  currentPeriodStart: z.string().datetime(),
  currentPeriodEnd: z.string().datetime(),
  cancelAtPeriodEnd: z.boolean().optional(),
});

// ── Safe Validation Function ───────────────────────────────────────────────

/**
 * Validates a response object against a schema.
 * Returns { success: true, data } or { success: false, errors }
 * This prevents exceptions from crashing the response handler.
 */
function validateResponse(data, schema) {
  try {
    const validated = schema.parse(data);
    return { success: true, data: validated };
  } catch (err) {
    return { success: false, errors: err.errors };
  }
}

module.exports = {
  // Schemas
  RunResponseSchema,
  UserResponseSchema,
  ListResponseSchema,
  ErrorResponseSchema,
  GitHubConnectionResponseSchema,
  SubscriptionResponseSchema,
  PhaseSchema,

  // Validation utility
  validateResponse,
};
