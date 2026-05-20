/**
 * Repo Manifest Generator
 *
 * Owns: building a structured operating constitution for existing repositories.
 * Does NOT own: scaffold generation, code generation, or pipeline routing.
 *
 * This module gives extend_existing builds a persistent identity that prevents
 * the model from losing repo structure mid-generation. The manifest is:
 *   1. Generated once from the actual file tree (no LLM calls — deterministic)
 *   2. Attached to the scaffold output and forwarded to CODE
 *   3. Injected into every CODE prompt as a binding "DO NOT TOUCH" / "SAFE TO CHANGE" map
 *
 * The manifest answers three questions CODE must know before touching anything:
 *   Q1: What kind of repo is this? (repo_type, frameworks, architectural_pattern)
 *   Q2: What is off-limits?        (protected_files, protected_dirs)
 *   Q3: What is safe to change?    (edit_scope, critical_dirs)
 */

'use strict';

// ── Classification helpers ───────────────────────────────────────────────────

/**
 * Classify the high-level repo type from file patterns.
 * Returns one of: fullstack_platform | frontend_spa | backend_api |
 *                 static_site | monorepo | library | unknown
 */
function classifyRepoType(files) {
  const f = new Set(files);
  const paths = files.join(' ');

  const hasServer    = f.has('server.js') || f.has('index.js') || f.has('app.js');
  const hasFrontend  = files.some(p => p.endsWith('.html') || /\.(jsx|tsx)$/.test(p));
  const hasNextJs    = f.has('next.config.js') || f.has('next.config.ts') || files.some(p => p.startsWith('pages/') || p.match(/^app\/.*page\.(tsx|jsx|js)$/));
  const hasVite      = f.has('vite.config.js') || f.has('vite.config.ts');
  const hasPackageJson = f.has('package.json');
  const hasDb        = files.some(p => p.includes('db/') || p.includes('migrations/') || p.includes('schema.'));
  const hasRoutes    = files.some(p => p.startsWith('routes/'));
  const hasPublic    = files.some(p => p.startsWith('public/'));
  const hasPackages  = files.some(p => p.includes('packages/') || p.includes('apps/')); // monorepo

  if (hasPackages) return 'monorepo';
  if (hasNextJs)    return 'frontend_spa';   // Next.js = opinionated SPA/SSR framework
  if (hasServer && hasDb && hasFrontend) return 'fullstack_platform';
  if (hasServer && hasDb)  return 'backend_api';
  if (hasServer && hasFrontend) return 'fullstack_platform';
  if (hasVite && hasFrontend)   return 'frontend_spa';
  if (hasFrontend && !hasServer)  return 'static_site';
  if (hasPackageJson && !hasFrontend) return 'backend_api';
  return 'unknown';
}

/**
 * Detect frameworks from file patterns.
 */
function detectFrameworks(files) {
  const f = new Set(files);
  const frameworks = [];

  if (f.has('next.config.js') || f.has('next.config.ts')) frameworks.push('nextjs');
  else if (files.some(p => /\.(jsx|tsx)$/.test(p))) frameworks.push('react');

  if (f.has('vite.config.js') || f.has('vite.config.ts')) frameworks.push('vite');
  if (f.has('server.js') || f.has('index.js') || files.some(p => p.startsWith('routes/'))) frameworks.push('express');
  if (f.has('tailwind.config.js') || f.has('tailwind.config.ts')) frameworks.push('tailwindcss');
  if (files.some(p => p.includes('prisma/'))) frameworks.push('prisma');
  if (files.some(p => p.includes('migrations/') || p === 'db/queries.js' || p === 'db/pool.js')) frameworks.push('postgres');
  if (files.some(p => p === 'db/database.js')) frameworks.push('sqlite');
  if (f.has('package.json')) frameworks.push('node');

  return [...new Set(frameworks)]; // dedupe
}

/**
 * Detect architectural pattern from file layout.
 */
function detectArchitecturalPattern(files) {
  const hasRoutes     = files.some(p => p.startsWith('routes/'));
  const hasModels     = files.some(p => p.startsWith('models/'));
  const hasServices   = files.some(p => p.startsWith('services/'));
  const hasControllers = files.some(p => p.startsWith('controllers/'));
  const hasSrc        = files.some(p => p.startsWith('src/'));
  const hasMonorepo   = files.some(p => p.startsWith('packages/') || p.startsWith('apps/'));

  if (hasMonorepo)    return 'monorepo';
  if (hasControllers) return 'mvc';
  if (hasModels && hasRoutes && hasServices) return 'layered';
  if (hasRoutes)      return 'modular_monolith';
  if (hasSrc)         return 'src_layout';
  return 'flat';
}

// ── Protected file/dir classification ────────────────────────────────────────

/**
 * Identify files that MUST NOT be replaced.
 *
 * Rules:
 *   - Dependency manifests (package.json, package-lock.json, yarn.lock, etc.)
 *   - Config files that encode infrastructure (prisma/schema.prisma, .env.example, Dockerfile)
 *   - DB migration files (existing migrations must not be rewritten — add new ones)
 *   - CI/deployment config (.github/, .vercel/, Procfile, render.yaml)
 *   - Auth/security files (.env, .gitignore)
 */
function classifyProtectedFiles(files) {
  const ALWAYS_PROTECTED = new Set([
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.env', '.env.example', '.env.local', '.env.production',
    '.gitignore', '.gitattributes',
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    'Procfile', 'render.yaml', 'railway.json', 'fly.toml',
    'vercel.json', '.vercelignore',
    'tsconfig.json', 'jsconfig.json',
    'eslint.config.js', '.eslintrc.js', '.eslintrc.json',
    'prettier.config.js', '.prettierrc',
    'jest.config.js', 'vitest.config.ts',
    'next.config.js', 'next.config.ts',
    'vite.config.js', 'vite.config.ts',
    'tailwind.config.js', 'tailwind.config.ts',
    'postcss.config.js',
  ]);

  const protected_ = [];
  for (const f of files) {
    if (ALWAYS_PROTECTED.has(f)) {
      protected_.push(f);
      continue;
    }
    // Protect any prisma schema
    if (f.includes('prisma/') && f.endsWith('.prisma')) { protected_.push(f); continue; }
    // Protect existing migration files (new ones can be added, not old ones modified)
    if (f.startsWith('migrations/') || f.startsWith('db/migrations/')) { protected_.push(f); continue; }
    // Protect CI/CD config
    if (f.startsWith('.github/') || f.startsWith('.circleci/')) { protected_.push(f); continue; }
  }
  return protected_;
}

/**
 * Identify directories that are architecturally load-bearing.
 * These exist but can be extended (not replaced).
 */
function classifyCriticalDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length > 1) dirs.add(parts[0]);
  }

  const CRITICAL_DIR_PATTERNS = ['src', 'db', 'routes', 'middleware', 'models', 'services',
    'controllers', 'lib', 'utils', 'helpers', 'agents', 'core', 'api', 'backend', 'prisma', 'infra', 'config'];

  return [...dirs].filter(d => CRITICAL_DIR_PATTERNS.includes(d));
}

/**
 * Determine edit scope based on repo size and complexity.
 *
 * Scopes:
 *   - feature_extension   — add new routes/components/views, safe default
 *   - targeted_modification — modify specific existing files the user asked about
 *   - refactor_only       — restructure without behavior change (rare, explicit)
 */
function determineEditScope(fileCount, repoType) {
  // All extend_existing runs default to feature_extension unless the user
  // explicitly says "refactor" — we don't infer scope from repo size.
  // The scope is what the CODE agent uses to determine if it should be
  // additive-only or can modify existing behavior.
  if (repoType === 'library') return 'feature_extension';
  return 'feature_extension';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a repository manifest from a flat file list.
 *
 * The manifest is the operating constitution for CODE: it knows what the repo
 * IS, what is OFF-LIMITS, and what is SAFE TO CHANGE.
 *
 * @param {string[]} fileTree      - Array of file paths (relative to repo root)
 * @param {string}   repoFullName  - "owner/repo" string for logging
 * @returns {RepoManifest}
 *
 * @typedef {object} RepoManifest
 * @property {string}   repo_type           - Type classification
 * @property {string[]} frameworks          - Detected frameworks
 * @property {string[]} critical_dirs       - Dirs that are architecturally load-bearing
 * @property {string[]} protected_files     - Files that must never be replaced
 * @property {string}   architectural_pattern - Code layout pattern
 * @property {string}   edit_scope          - How CODE should approach changes
 * @property {number}   file_count          - Total files in repo
 * @property {string}   entry_point         - Detected app entry point
 * @property {string[]} _file_tree          - Original (capped) file list
 */
function generateRepoManifest(fileTree, repoFullName = '') {
  // Normalise input — strings or {path} objects
  const normalised = (fileTree || [])
    .map(f => (typeof f === 'string' ? f : (f && f.path ? f.path : null)))
    .filter(Boolean)
    .filter(f => !f.startsWith('.git/'))
    .slice(0, 200); // hard cap consistent with scaffold

  if (normalised.length === 0) {
    return {
      repo_type: 'unknown',
      frameworks: [],
      critical_dirs: [],
      protected_files: [],
      architectural_pattern: 'flat',
      edit_scope: 'feature_extension',
      file_count: 0,
      entry_point: 'index.html',
      _file_tree: [],
    };
  }

  const repoType           = classifyRepoType(normalised);
  const frameworks         = detectFrameworks(normalised);
  const criticalDirs       = classifyCriticalDirs(normalised);
  const protectedFiles     = classifyProtectedFiles(normalised);
  const archPattern        = detectArchitecturalPattern(normalised);
  const editScope          = determineEditScope(normalised.length, repoType);

  // Entry point detection (mirrors _executeScaffoldExtendExisting logic)
  const f = new Set(normalised);
  let entryPoint = 'server.js';
  if (f.has('server.js'))      entryPoint = 'server.js';
  else if (f.has('index.js'))  entryPoint = 'index.js';
  else if (f.has('app.js'))    entryPoint = 'app.js';
  else if (f.has('index.html')) entryPoint = 'index.html';
  else if (f.has('public/index.html')) entryPoint = 'public/index.html';

  const manifest = {
    repo_type:           repoType,
    frameworks,
    critical_dirs:       criticalDirs,
    protected_files:     protectedFiles,
    architectural_pattern: archPattern,
    edit_scope:          editScope,
    file_count:          normalised.length,
    entry_point:         entryPoint,
    _file_tree:          normalised,
  };

  console.log(
    `[RepoManifest] Generated for ${repoFullName || 'unknown'}: ` +
    `type=${repoType}, frameworks=[${frameworks.join(',')}], ` +
    `pattern=${archPattern}, protected=${protectedFiles.length} files, ` +
    `critical_dirs=[${criticalDirs.join(',')}]`
  );

  return manifest;
}

/**
 * Format the repo manifest as a CODE prompt injection block.
 *
 * This produces the "operating constitution" that every CODE-phase prompt
 * starts with when in extend_existing mode. It tells the model:
 *   1. What kind of repo it's working in (so it doesn't cargo-cult boilerplate)
 *   2. What it MUST NOT touch (protected files, dirs)
 *   3. What its changes should look like (additive, targeted)
 *
 * @param {RepoManifest} manifest
 * @returns {string}
 */
function formatRepoManifestBlock(manifest) {
  if (!manifest || manifest.file_count === 0) return '';

  const protectedList = manifest.protected_files.length > 0
    ? manifest.protected_files.slice(0, 20).map(f => `  - ${f}`).join('\n')
    : '  (none detected)';

  const criticalDirsList = manifest.critical_dirs.length > 0
    ? manifest.critical_dirs.map(d => `  - ${d}/`).join('\n')
    : '  (none detected)';

  return `
=== REPOSITORY MANIFEST (OPERATING CONSTITUTION — READ BEFORE WRITING ANY CODE) ===
This is an EXISTING repository. You are extending it — not replacing it.

REPO IDENTITY:
  Type:                 ${manifest.repo_type}
  Frameworks:           ${manifest.frameworks.join(', ') || 'unknown'}
  Architecture:         ${manifest.architectural_pattern}
  Entry point:          ${manifest.entry_point}
  Total files:          ${manifest.file_count}
  Edit scope:           ${manifest.edit_scope}

PROTECTED FILES — DO NOT MODIFY OR REPLACE:
${protectedList}

CRITICAL DIRECTORIES — EXTEND, NEVER REPLACE:
${criticalDirsList}

MANDATORY RULES FOR THIS BUILD:
1. ADDITIVE ONLY: Add new files and new functions. Do NOT rewrite existing files from scratch.
2. PRESERVE ARCHITECTURE: Match the existing pattern (${manifest.architectural_pattern}). New code goes where similar code already lives.
3. NEVER TOUCH protected_files: ${manifest.protected_files.slice(0, 5).join(', ')}${manifest.protected_files.length > 5 ? '...' : ''} — modifying these breaks deployments.
4. DO NOT GENERATE BOILERPLATE: No generic "express app" or "React app from scratch". This repo already has that.
5. INCREMENTAL CHANGES: The diff should be small and surgical. If your output would replace >40% of the repo's existing code, stop — you are regenerating instead of extending.
=== END REPOSITORY MANIFEST ===`;
}

/**
 * Generate an incremental build plan for extend_existing mode.
 *
 * This is a deterministic pre-generation plan that forces the CODE agent to
 * declare intent before writing any code. The plan identifies:
 *   - FILES TO MODIFY (existing files that need changes)
 *   - FILES TO CREATE (new files to add)
 *   - DO NOT TOUCH (files the task must not change)
 *
 * This is injected into the CODE prompt BEFORE the actual generation request,
 * so the model commits to a scope before producing output.
 *
 * @param {string}       prompt        - User's task description
 * @param {RepoManifest} manifest      - Repo manifest from generateRepoManifest()
 * @param {object}       plan          - Pipeline plan output (subtasks, etc.)
 * @returns {string}                   - Formatted plan block for prompt injection
 */
function formatIncrementalPlanBlock(prompt, manifest, plan) {
  if (!manifest || manifest.file_count === 0) return '';

  const lower = (prompt || '').toLowerCase();

  // Infer likely files to modify from the prompt + manifest
  const toModify = [];
  const toCreate = [];
  const doNotTouch = [...manifest.protected_files].slice(0, 10);

  // Heuristic: if prompt mentions routes/endpoints, existing routes file likely needs changes
  if (/route|endpoint|api|path/.test(lower) && manifest._file_tree.includes('routes/api.js')) {
    toModify.push('routes/api.js (add new endpoint)');
  }

  // Heuristic: if adding auth-related features, auth route and middleware
  if (/auth|login|signup|register|user|permission/.test(lower)) {
    if (manifest._file_tree.includes('routes/auth.js')) toModify.push('routes/auth.js');
    if (manifest._file_tree.includes('middleware/auth.js')) toModify.push('middleware/auth.js');
  }

  // Heuristic: DB changes → migrations are always new files, never modify existing
  if (/database|table|schema|migration|column|field/.test(lower)) {
    toCreate.push('migrations/<timestamp>_<feature>.js (new migration — NEVER modify existing ones)');
    if (manifest._file_tree.some(f => f.startsWith('db/'))) toModify.push('db/queries.js or db/database.js (add new queries)');
  }

  // Heuristic: UI changes → frontend files
  const frontendFiles = manifest._file_tree.filter(f =>
    f.endsWith('.html') || f.endsWith('.jsx') || f.endsWith('.tsx') || f === 'app.js'
  );
  if (/page|component|view|ui|frontend|display|show/.test(lower) && frontendFiles.length > 0) {
    const mainFrontend = frontendFiles.find(f => f === 'index.html' || f === 'app.jsx' || f === 'app.js') || frontendFiles[0];
    toModify.push(`${mainFrontend} (add new UI section/component)`);
  }

  // If we couldn't infer anything specific, be generic but correct
  if (toModify.length === 0 && toCreate.length === 0) {
    toCreate.push('<new-file> (determine based on task requirements)');
  }

  // Extract task bullets from plan if available
  const subtaskList = plan && Array.isArray(plan.subtasks) && plan.subtasks.length > 0
    ? plan.subtasks.slice(0, 5).map((t, i) => `  ${i + 1}. ${t.title || t.description || t}`).join('\n')
    : null;

  const modifySection = toModify.length > 0
    ? toModify.map(f => `  - ${f}`).join('\n')
    : '  (infer from task — be specific)';

  const createSection = toCreate.length > 0
    ? toCreate.map(f => `  - ${f}`).join('\n')
    : '  (infer from task — be specific)';

  const doNotTouchSection = doNotTouch.length > 0
    ? doNotTouch.map(f => `  - ${f}`).join('\n')
    : '  (see protected_files in manifest above)';

  return `
=== INCREMENTAL BUILD PLAN (COMMIT TO SCOPE BEFORE GENERATING) ===
You are making a TARGETED CHANGE to an existing repository.
Before writing any code, you have committed to this scope:

TASK CONTEXT:
${subtaskList ? `Subtasks from plan:\n${subtaskList}` : `  Task: ${(prompt || '').slice(0, 200)}`}

FILES TO MODIFY (existing files — add or change specific functions only):
${modifySection}

FILES TO CREATE (new files — do not exist yet):
${createSection}

DO NOT TOUCH (these files must be unchanged in your output):
${doNotTouchSection}

SCOPE ENFORCEMENT:
- If you find yourself regenerating package.json, server.js, or any migration from scratch — STOP.
  Those files are off-limits. Add to them if needed; never replace them.
- Your output should contain ONLY the files listed above (modify + create).
  Do NOT output files listed in DO NOT TOUCH.
- If the task requires touching a DO NOT TOUCH file, output only the specific line changes
  as a targeted patch, not a full file replacement.
=== END INCREMENTAL BUILD PLAN ===`;
}

module.exports = {
  generateRepoManifest,
  formatRepoManifestBlock,
  formatIncrementalPlanBlock,
  // Exposed for testing
  _classifyRepoType: classifyRepoType,
  _detectFrameworks: detectFrameworks,
  _classifyProtectedFiles: classifyProtectedFiles,
};
