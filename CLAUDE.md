# BuildOrbit

## What this app does
BuildOrbit is a glass-box AI execution pipeline for regulated industries. Users submit tasks; a deterministic 6-phase pipeline (Intent Gate → Plan → Scaffold → Code → Save → Verify) executes them visibly with a complete audit trail. Designed for legal, finance, and healthcare teams that require explainable AI.

## Stack
Node.js 20 + Express + Neon PostgreSQL + Render deploy + Stripe billing

## Directory map
- `server.js` — Express entry point (legacy god file, do not add to)
- `src/routes/` — Express route modules (billing, analytics, compliance, CLI, A2A, verify-fix, admin, github)
- `src/agents/` — Agent phase implementations (planner, builder, qa, ops); cleaned up from legacy root `/agents/`
- `src/lib/` — Refactored utilities; cleaned up from legacy root `/lib/` and `/services/`
- `src/mcp/` — MCP connector framework (mcp-client.js, mcp-registry.js, mcp-audit.js, pipeline-mcp-bridge.js, built-ins/)
- `db/` — Database query modules (admin.js — admin user queries; SQL-only, no logic)
- `migrations/` — Custom migration files (raw `pg` client, NOT node-pg-migrate — use `client.query()`, not `pgm.*`)
- `buildorbit-frontend/` — React 18 + Vite + TypeScript frontend; builds to public/react-build/
- `public/` — Static frontend (HTML pages, CSS, JS); public/react-build/ is Vite output (do not edit directly)
- `public/css/buildorbit.css` — Main design system stylesheet (light theme tokens)
- `public/css/responsive.css` — Global responsive/overflow fixes, loaded on all pages
- `backend/` — New backend modules (TypeScript, strict architecture)
- `tests/` — Integration + unit tests

## Database
- `pipeline_runs` — Each task execution, phase states, costs, github_repo selection, github_pr_url, source_repo, deploy_url, catastrophic_block (JSONB — block stats when SAVE is hard-blocked), phase_reasoning (JSONB — ordered reasoning timeline per phase)
- `pipeline_events` — Immutable event log per run
- `pipeline_traces` — Execution DAG (nodes + edges for View Trace)
- `deployments` — Deployed artifacts per run
- `users` — Accounts, credits, subscription status, stripe_customer_id
- `magic_links` — One-time auth links
- `api_keys` / `api_tokens` — External API access
- `memory_items` — Compounding knowledge per user/org; user_id column (migration 039) enables strict per-user isolation; pgvector VECTOR(1536) embedding for semantic similarity search
- `governance_schema` — ACL + compliance rules
- `analytics_events` — Page view tracking
- `github_connections` — Per-user GitHub OAuth token (AES-256-GCM encrypted) + GitHub identity
- `orbit_conversations` — Orbit conversation memory (history JSONB, 30-msg window, current_run_id pointer)
- `mcp_connections` — Per-user MCP server configs (transport, JSONB config, enabled flag)
- `run_failure_signatures` — Structured failure patterns per run: phase, error type, stable signature key, LLM root cause + fix proposal. Powers Orbit pattern detection and cross-run comparison.

## External integrations
- Stripe — subscription billing ($29/mo), direct Stripe payment links + webhooks
- Render — hosting, auto-deploy on push to main
- Neon — PostgreSQL (DATABASE_URL)
- Anthropic — LLM calls for pipeline phases
- OpenAI — GPT-4o tool-calling for Orbit action routing (OPENAI_API_KEY, falls back to keyword router if absent)
- Sapiom — web research + browser automation for agents
- GitHub OAuth — user repo connect/push (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
- Browserbase — cloud browser sessions for VERIFY phase visual screenshots (BROWSERBASE_API_KEY, optional)
- Postmark — transactional email (magic links, welcome, billing notifications)

## Recent changes
- 2026-05-15: SECURITY — Server hardening bundle (task #1597340). (1) Body parser limits (10mb). (2) Field-level validation in `src/lib/input-validation.js` (prompt 50KB, email 254 chars). (3) `req.user` frozen via `Object.defineProperty` — prevents privilege escalation. (4) Graceful shutdown handlers (SIGTERM/SIGINT) drain pool with 15s force-exit fallback. (5) Deploy race fixed: `deploy()` + `rollback()` in deploy-engine.js wrapped in transactions with `FOR UPDATE`. (6) CSRF: double-submit cookie pattern via `src/lib/csrf.js`, `/api/csrf-token` endpoint, frontend sends `X-CSRF-Token`.
- 2026-05-15: STABILITY — Runtime stability bundle (task #1597355). (1) Global `unhandledRejection` + `uncaughtException` handlers added to server.js — server stays alive instead of crashing. (2) `PipelineEventBus.emitBusEvent()` wraps `this.emit()` in try-catch — listener throws can't escape. (3) `STAGE_COMPLETED` event bus listener in orchestrator wrapped in try-catch. (4) In-memory rate limiter limitation documented in `src/routes/a2a.js`, `src/lib/auth-rate-limiter.js`, and server.js password-login limiter.
- 2026-05-15: ARCHITECTURE — Add ESLint guard + consolidate agent registry (task #1610065). (1) ESLint rules added: `no-restricted-modules` and `no-restricted-imports` block stray imports from deleted root `/agents/`, `/lib/`, `/routes/`, `/auth` directories. (2) Agent registry (`src/agents/index.js`) confirmed clean — no unused `capabilities.fetchUrl` reference. (3) CLAUDE.md updated to reflect new directory structure; root-level agents/lib moved to `src/`.
- 2026-05-15: SECURITY — Fix 5 critical vulnerabilities (task #1597240). (1) JWT_SECRET fail-fast: server refuses to boot without explicit ≥32-byte JWT_SECRET, all fallback/derivation logic removed from auth, github, and service files. (2) Duplicate routes: legacy `routes/` directory deleted, all route files consolidated into `src/routes/`, server.js imports updated. (3) Mock credentials: hardcoded test secrets replaced with `crypto.randomBytes()`, NODE_ENV guard made case-insensitive. (4) SQL injection: test file table names whitelisted. (5) Dead root `auth.js` deleted.
- 2026-05-15: BUGFIX — Fix blank preview from mixed CDN/Vite architectures (task #1596810). Three-part fix: (1) `previewAssets.ts` now inlines Babel `<script src="app.jsx">` refs and CSS `<link>` refs directly into HTML so iframe preview is self-contained — no file server needed. JSX files excluded from plain JS extraction. (2) `builder-agent.js` scaffold filters out Vite-pattern files (`src/`, `vite.config.*`) from CDN builds; skips separate component file stubs for CDN (components are inline in `app.jsx`). (3) Post-CODE architecture guard detects mixed CDN + module output and strips conflicting Vite files. `BuildOrbitPreview.tsx` detects complete HTML documents and renders them directly instead of wrapping in nested `<html>`.
- 2026-05-14: FEATURE — Promo videos page at /videos (task #1583899). Three HTML5 Canvas animations at `public/videos/` for social media promo: vibe-coding.html (green orbital aesthetic), deterministic-pipeline.html (cyan pipeline phases), audit-trail.html (orange event log). React `Videos.tsx` page at `/videos` with preview iframes, download links, and screen-record how-to guide. Route added to server.js + App.tsx.
- 2026-05-14: FEATURE — Repo-aware Verify phase (task #1565499). QA agent (`agents/qa-agent.js`) now routes to `_runRepoAwareChecks()` for repo-aware builds, replacing greenfield checks. Five repo-aware checks added. Greenfield builds continue using existing `_runChecks()` with full check suite.
- 2026-05-14: ARCHITECTURE — Demote VERIFY to auditor (task #1580548). VERIFY no longer declares run success/failure — emits structured audit report with severity-tagged checks (critical/advisory). Orbit runtime is sole authority for run state. New `partial_success` terminal state.

