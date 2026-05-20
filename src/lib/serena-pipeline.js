/**
 * Serena Pipeline Integration — Phase-level helpers for Serena codebase intelligence.
 *
 * Owns: Wrapping the Serena built-in MCP server for use inside pipeline phases.
 *       Provides fail-open helpers that phases can call without try/catch at every site.
 * Does NOT own: pipeline execution, phase logic, MCP registry wiring, auth.
 *
 * Usage:
 *   const serena = require('../lib/serena-pipeline');
 *
 *   // In PLAN phase (when source repo is provided):
 *   const analysis = await serena.analyzeSourceRepo(repoRoot);
 *   // Inject `analysis` into the planner system prompt for context-aware planning.
 *
 *   // In CODE phase:
 *   const structure = await serena.getFileStructure(repoRoot, 'src/');
 *
 *   // In VERIFY phase:
 *   const diagnostics = await serena.checkDiagnostics(generatedFilesDir);
 *
 * All methods are fail-open: they return null / [] / empty strings on error so
 * Serena unavailability never blocks the pipeline.
 */

'use strict';

const { createSerenaServer } = require('../mcp/built-ins/serena');

// Shared singleton client — created once, reused across all pipeline calls.
// In-process client needs no process spawn, so singleton is safe.
let _client = null;

async function _getClient() {
  if (_client && _client.connected) return _client;
  _client = createSerenaServer();
  await _client.connect();
  return _client;
}

async function _call(toolName, params) {
  try {
    const client = await _getClient();
    const result = await client.callTool(toolName, params);
    if (!result || !result.content || !result.content.length) return null;
    const first = result.content.find(c => c.type === 'text');
    return first ? first.text : null;
  } catch (err) {
    // Fail-open: Serena errors must never block the pipeline
    console.warn(`[SerenaPipeline] ${toolName} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Analyze a source repository and return a structured summary string.
 * Call in PLAN phase before generating the plan so the agent knows what exists.
 *
 * @param {string} root - Absolute path to project root
 * @returns {Promise<string|null>} Analysis text, or null if unavailable
 */
async function analyzeSourceRepo(root) {
  if (!root) return null;
  return _call('analyze_codebase', { root, include_dependencies: true });
}

/**
 * Run full project onboarding — deeper than analyze_codebase.
 * Returns entry points, key modules, API routes, exported symbols.
 * Best called once at the start of a session with an existing codebase.
 *
 * @param {string} root - Absolute path to project root
 * @returns {Promise<string|null>}
 */
async function onboardProject(root) {
  if (!root) return null;
  return _call('onboard_project', { root });
}

/**
 * Get annotated file tree for a directory.
 * Use in SCAFFOLD/CODE phases to know what files already exist before writing.
 *
 * @param {string} root - Absolute path to project root
 * @param {string} [subPath] - Subdirectory within root (default: '.')
 * @param {number} [depth] - Max depth (default: 3)
 * @returns {Promise<string|null>}
 */
async function getFileStructure(root, subPath = '.', depth = 3) {
  if (!root) return null;
  return _call('get_file_structure', { path: subPath, depth });
}

/**
 * Find where a symbol (function, class, variable) is defined across the codebase.
 * Use in CODE phase so the agent modifies the right file and doesn't duplicate code.
 *
 * @param {string} root - Absolute path to project root (used by the singleton client)
 * @param {string} symbol - Symbol name to find
 * @param {string} [scope] - Subdirectory to restrict search
 * @param {'function'|'class'|'variable'|'type'|'any'} [kind] - Symbol kind
 * @returns {Promise<string|null>}
 */
async function findSymbol(root, symbol, scope, kind = 'any') {
  if (!root || !symbol) return null;
  return _call('find_symbol', { symbol, scope, kind });
}

/**
 * Find all files that reference a symbol.
 * Use before renaming or replacing a module to understand the impact.
 *
 * @param {string} root - Absolute path to project root
 * @param {string} symbol - Symbol to look up
 * @param {string} [scope] - Subdirectory to restrict search
 * @returns {Promise<string|null>}
 */
async function findReferences(root, symbol, scope) {
  if (!root || !symbol) return null;
  return _call('find_references', { symbol, scope });
}

/**
 * List all imports (require/import) in a file, classified by type.
 * Use before editing a file to understand its dependency surface.
 *
 * @param {string} filePath - Relative path to file within project root
 * @returns {Promise<string|null>}
 */
async function listImports(filePath) {
  if (!filePath) return null;
  return _call('list_imports', { path: filePath });
}

/**
 * Check a file or directory for structural issues (unbalanced braces, duplicates).
 * Use in VERIFY phase to validate generated code quality.
 *
 * @param {string} targetPath - Relative path to file or directory within project root
 * @param {boolean} [strict] - Include warnings (default: false)
 * @returns {Promise<{ passed: boolean, text: string|null }>}
 */
async function checkDiagnostics(targetPath, strict = false) {
  if (!targetPath) return { passed: true, text: null };
  const text = await _call('check_diagnostics', { path: targetPath, strict });
  if (!text) return { passed: true, text: null };

  const hasErrors = /\[ERROR\]/.test(text) || /Unbalanced/.test(text) || /Duplicate require/.test(text);
  return { passed: !hasErrors, text };
}

/**
 * Build a compact codebase context block for injection into LLM system prompts.
 * Returns null if Serena is unavailable (fail-open).
 *
 * @param {string} root - Absolute path to project root
 * @param {{ shallow?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
async function buildContextBlock(root, opts = {}) {
  if (!root) return null;

  const shallow = opts.shallow === true;
  const analysis = shallow
    ? await analyzeSourceRepo(root)
    : await onboardProject(root);

  if (!analysis) return null;

  return [
    '=== SERENA CODEBASE INTELLIGENCE ===',
    '(Read before writing — understand what exists before generating new code)',
    '',
    analysis,
    '=== END SERENA CONTEXT ===',
  ].join('\n');
}

module.exports = {
  analyzeSourceRepo,
  onboardProject,
  getFileStructure,
  findSymbol,
  findReferences,
  listImports,
  checkDiagnostics,
  buildContextBlock,
};
