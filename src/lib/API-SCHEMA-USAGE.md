# API Schema Validation — Usage Guide

This guide shows how to use the Zod-based API schemas to validate responses before sending them to clients.

## Why Validate?

Silent failures are the worst kind of bugs. When a field is missing from an API response, the frontend breaks silently. The user sees a blank page or 500 error. Validation catches these problems at the source — in the API handler — not in the browser.

## Setup

The schemas are defined in `./src/lib/api-schemas.js`:

```javascript
const {
  RunResponseSchema,
  UserResponseSchema,
  ListResponseSchema,
  ErrorResponseSchema,
  validateResponse,
} = require('../lib/api-schemas');
```

## Pattern 1: Validate Before Sending

In your route handler, validate the data before calling `res.json()`:

```javascript
app.get('/api/runs/:id', auth.requireAuth, async (req, res) => {
  const runId = req.params.id;

  // Fetch from database
  const run = await fetchRun(runId);

  // Validate against schema
  const validated = RunResponseSchema.parse(run);

  // Safe to send — schema guarantees structure
  res.json(validated);
});
```

If validation fails, `parse()` throws a `ZodError`. Catch it and return a proper error:

```javascript
app.get('/api/runs/:id', auth.requireAuth, async (req, res) => {
  try {
    const run = await fetchRun(req.params.id);
    const validated = RunResponseSchema.parse(run);
    res.json(validated);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('Run response validation failed:', err.errors);
      return res.status(500).json({
        error: 'internal_error',
        message: 'Failed to format response',
        requestId: req.id,
      });
    }
    throw err;
  }
});
```

## Pattern 2: Safe Validation (Returns Result Object)

Use the `validateResponse()` utility to avoid exceptions:

```javascript
const { validateResponse } = require('../lib/api-schemas');

app.get('/api/users/:id', auth.requireAuth, async (req, res) => {
  const user = await fetchUser(req.params.id);

  const result = validateResponse(user, UserResponseSchema);

  if (!result.success) {
    console.error('Validation failed:', result.errors);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to format response',
      requestId: req.id,
    });
  }

  res.json(result.data);
});
```

## Pattern 3: Middleware-Based Validation

Apply a middleware to automatically validate route responses:

```javascript
const { validateResponse } = require('../lib/response-validator');

// Validate all responses from this route
app.get('/api/runs/:id',
  validateResponse(RunResponseSchema),  // Middleware
  auth.requireAuth,                      // Auth middleware
  async (req, res) => {
    const run = await fetchRun(req.params.id);
    res.json(run);  // Automatically validated by middleware
  }
);
```

The middleware approach is fail-open: validation failures are logged but don't block the response.

## Adding New Schemas

1. Define the schema in `./src/lib/api-schemas.js`:

```javascript
const MyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  tags: z.array(z.string()).optional(),
});
```

2. Export it from the module.

3. Use it in your handler:

```javascript
const { MyResponseSchema } = require('../lib/api-schemas');

app.post('/api/my-resource', async (req, res) => {
  const data = await createResource(req.body);
  const validated = MyResponseSchema.parse(data);
  res.json(validated);
});
```

## Common Schema Patterns

### Optional Fields

Fields that may not always be present:

```javascript
const MySchema = z.object({
  id: z.string(),
  description: z.string().optional(),  // Can be undefined
  tags: z.array(z.string()).default([]), // Defaults to []
});
```

### Nested Objects

Schemas can nest other schemas:

```javascript
const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const ListSchema = z.object({
  items: z.array(ItemSchema),
  total: z.number(),
});
```

### Union Types

Use `.or()` for multiple valid types:

```javascript
const StatusSchema = z.enum(['active', 'inactive', 'pending']);
const ResourceSchema = z.object({
  status: StatusSchema,  // Must be one of the enum values
});
```

### Transformed Values

Use `.transform()` to normalize data:

```javascript
const UserSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase()),
  createdAt: z.string().transform(d => new Date(d).toISOString()),
});
```

## Testing Schemas

In integration tests, validate test fixtures:

```javascript
test('run response includes all required fields', async ({ tx }) => {
  const run = await createTestRun(tx);

  // This will throw if any required fields are missing
  const validated = RunResponseSchema.parse(run);

  expect(validated.runId).toBeDefined();
  expect(validated.phases).toHaveLength(6);
});
```

## Troubleshooting

### "ZodError: Required field missing"

The schema expects a field that the data doesn't have. Either:
1. Add `.optional()` to the schema if the field is truly optional
2. Fix the handler to always populate the field

### "Validation succeeded but field is wrong type"

Common when dates are strings instead of Date objects. Use `.transform()` or ensure the handler returns the correct type:

```javascript
// Bad: returns Date object
const createdAt = new Date();

// Good: returns ISO string
const createdAt = new Date().toISOString();
```

### Performance

Validation is O(n) in the number of fields. For endpoints that return many objects, consider:
1. Validating once for list responses (the schema, not each item)
2. Caching validation results if the same object is returned multiple times

## References

- [Zod Documentation](https://zod.dev)
- [API Schemas Module](./api-schemas.js)
- [Response Validator Middleware](./response-validator.js)
