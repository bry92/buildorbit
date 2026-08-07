# BuildOrbit

BuildOrbit is a verifiable execution runtime for AI agent orchestration. It turns a user request into an auditable build run, moves that run through a contract-checked pipeline, persists state as events, and exposes the process through an operational dashboard, API, and CLI.

The repository contains the production Express runtime, PostgreSQL migrations, agent orchestration code, a React dashboard, and the distributable `buildorbit` CLI.

## What BuildOrbit Provides

- Verifiable AI execution: every pipeline transition is recorded in `pipeline_events`.
- Contract-bound orchestration: intent classification constrains what later agents may create.
- Agent routing: planner, builder, QA, and ops agents are invoked through a single orchestrator.
- Operational dashboard: React UI for creating builds, inspecting runs, viewing traces, and managing settings.
- Local and remote execution: API endpoints and a CLI for triggering runs and streaming status.
- Deployment/export flows: generated apps can be saved, packaged, exported, and deployed through configured providers.

## Architecture

```
User / CLI / Dashboard
        |
        v
  Express API (server.js)
        |
        v
 PipelineOrchestrator
        |
        +--> Intent Gate  -> constraint contract
        +--> Planner      -> implementation plan
        +--> Builder      -> scaffold + code
        +--> Ops          -> persisted artifacts
        +--> QA           -> verification report
        |
        v
 PostgreSQL event log + artifact storage
```

The pipeline state machine is event-sourced. `pipeline_runs.state` is a cached projection; `pipeline_events` is the durable audit log.

```
queued
  |
  v
intent_gate_running -> intent_gate_complete
  |
  v
plan_running        -> plan_complete
  |
  v
scaffold_running    -> scaffold_complete
  |
  v
code_running        -> code_complete
  |
  v
save_running        -> save_complete
  |
  v
verify_running      -> verify_complete -> completed

Any *_running state can transition to failed.
Any *_complete state can pause for intervention.
failed and paused runs can resume through orchestrator-controlled retry paths.
```

Agent ownership is explicit:

```
plan              -> PlannerAgent
scaffold, code    -> BuilderAgent
save              -> OpsAgent
verify            -> QAAgent
```

## Repository Layout

```
server.js                 Express app, auth, API routes, static serving
src/core/                 State machine, event bus, orchestrator, artifacts
src/agents/               Planner, builder, QA, ops, and Orbit agents
src/phases/               Legacy and phase-level pipeline execution logic
src/routes/               API route modules
src/lib/                  Auth, validation, costs, traces, deploy helpers
src/mcp/                  MCP registry, client, audit, and built-in tools
migrations/               Ordered PostgreSQL schema migrations
backend/src/email/        Transactional email/provider integration
buildorbit-frontend/      Vite + React operational dashboard
cli/                      Publishable BuildOrbit CLI package
tests/unit/               Deterministic unit and contract tests
tests/integration/        A2A and production-simulation tests
scripts/                  Packaging, migration, and verification utilities
```

## Requirements

- Node.js 18 or newer
- npm 9 or newer
- PostgreSQL database for full local runtime
- OpenAI-compatible API key for non-mock AI pipeline runs
- Optional: Anthropic, Stripe, GitHub OAuth, Browserbase, and Postmark (transactional email)

## Environment Variables

Copy `.env.example` to `.env` and set values for your environment.

Required for normal runtime:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `JWT_SECRET` | JWT signing secret, at least 32 bytes. |
| `NODE_ENV` | `development`, `test`, or `production`. |
| `OPENAI_API_KEY` | Required unless `MOCK_MODE=true`. |

Common optional variables:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public base URL for links, redirects, CLI install output, and email. |
| `PORT` | Express port, defaults to `3000`. |
| `OPENAI_BASE_URL` | OpenAI-compatible proxy URL. |
| `ANTHROPIC_API_KEY` | Enables Anthropic code generation fallback. |
| `STRIPE_SECRET_KEY` | Enables billing portal/subscription management. |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhooks. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Enables GitHub OAuth integration. |
| `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` | Enables Browserbase screenshots. |
| `POSTMARK_SERVER_TOKEN` | Enables magic-link and transactional email via Postmark. |
| `EMAIL_FROM` | Sender address for Postmark (default `noreply@buildorbit.com`). |
| `MOCK_MODE` | Set to `true` for local test paths without external providers. Never use in production. |

## Local Development

Install root dependencies:

```bash
npm install
```

Install frontend dependencies:

```bash
npm install --prefix buildorbit-frontend
```

Run migrations:

```bash
npm run migrate
```

Start the backend:

```bash
npm run dev
```

Start the frontend dev server in another terminal:

```bash
npm run dev --prefix buildorbit-frontend
```

The backend defaults to `http://localhost:3000`. The Vite dashboard defaults to `http://localhost:5173` and proxies API calls to the backend.

## Building

Build the dashboard and CLI package:

```bash
npm run build
```

The React build is written to `public/react-build/` for Express static serving. That directory is generated output and should not be committed.

Build only the frontend:

```bash
npm run build --prefix buildorbit-frontend
```

Build only the CLI archive:

```bash
npm run build:cli
```

## Testing

Run the full local test suite:

```bash
npm test
```

Run only unit tests:

```bash
npm run test:unit
```

Run only integration tests:

```bash
npm run test:integration
```

Integration tests default to mock-safe behavior when `DATABASE_URL` is not reachable. Use `FORCE_MOCK_DB=true` to force the production simulation to avoid a real database.

## CLI

The CLI lives in `cli/` and exposes the `buildorbit` command.

```bash
cd cli
npm install
node bin/buildorbit.js health
node bin/buildorbit.js run "Build a landing page for a coffee shop"
node bin/buildorbit.js status <run-id>
node bin/buildorbit.js history
```

The CLI reads its API base URL and token from its config helpers. Use `buildorbit login` when connecting to a deployed BuildOrbit instance.

## Migrations

Migrations are ordered JavaScript files in `migrations/`:

```
001_create_pipeline_runs.js
002_create_pipeline_events.js
...
039_memory_items_user_id.js
```

Each migration should be:

- Numbered with a zero-padded prefix.
- Append-only after it has been deployed.
- Idempotent where practical.
- Focused on a single schema concern.

Run migrations with:

```bash
npm run migrate
```

## Deployment

1. Provision PostgreSQL.
2. Set all required environment variables.
3. Run `npm install`.
4. Run `npm run build`.
5. Run migrations with `npm run migrate`.
6. Start the server with `npm start`.

`render.yaml` is included for Render-style deployment. In production, `NODE_ENV=production`, `MOCK_MODE=false`, and a strong `JWT_SECRET` are required.

## Troubleshooting

`FATAL: Environment validation failed`

- Confirm `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`, and `OPENAI_API_KEY` are set.
- For test-only local runs, set `MOCK_MODE=true` and `NODE_ENV=test`.

`JWT_SECRET must be at least 32 bytes`

- Generate a new value and update your environment:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Frontend build cannot resolve `vite.config.ts`

- Run from the repository root or use `npm run build --prefix buildorbit-frontend`.
- Ensure `buildorbit-frontend/node_modules` exists.
- Avoid committing `public/react-build/`; rebuild it during deployment.

Pipeline runs stall in an intermediate state

- Inspect `/api/pipeline/:runId/events` and `/api/pipeline/:runId/trace`.
- Use the retry endpoint to resume from the failed or next pending stage.
- Check `pipeline_events` for the last recorded event; it is the source of truth.

Integration tests try to connect to a real database

- Set `FORCE_MOCK_DB=true` to force mock database mode.

CLI cannot reach the server

- Confirm the backend is running.
- Confirm the CLI base URL points to the backend.
- Confirm auth/API token configuration if the endpoint requires authentication.
