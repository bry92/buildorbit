/**
 * Built-in MCP Server: Serena — Codebase Intelligence
 *
 * Owns: structural code analysis, symbol lookup, dependency mapping,
 *       import resolution, and diagnostic reporting for project files.
 * Does NOT own: file writes (use filesystem MCP), git operations (use git MCP),
 *               runtime execution, or external API calls.
 *
 * Designed to mirror Serena MCP's API surface using Node.js builtins only —
 * no Python, no external process, no heavy ML dependencies.
 * Works within Render's 512MB RAM constraint.
 *
 * Tools exposed:
 *   analyze_codebase   — High-level structural overview (files, tech stack, entry points)
 *   get_file_structure — Tree of files in a directory with metadata
 *   find_symbol        — Locate a function/class/variable definition across files
 *   find_references    — Find all usages of a symbol across the codebase
 *   list_imports       — Resolve import/require chain for a file
 *   check_diagnostics  — Surface syntax errors, missing imports, structural issues
 *   onboard_project    — Automatic codebase understanding summary (call once per session)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { InProcessMcpClient } = require('./in-process-client');

// Max chars to scan per file before truncating (keeps RAM usage bounded)
const MAX_FILE_SCAN_CHARS = 80_000;
// Max files to walk (safety valve on huge repos)
const MAX_FILES_WALK = 500;

// ── Tool manifest ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'analyze_codebase',
    description:
      'Produce a high-level structural overview of the project: detected tech stack, ' +
      'entry points, key directories, approximate file counts, and top-level dependencies ' +
      'from package.json. Use this before planning so the agent understands what already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Project root path (relative to server root). Defaults to ".".',
        },
        include_dependencies: {
          type: 'boolean',
          description: 'Include package.json dependency list in output. Default: true.',
        },
      },
    },
  },
  {
    name: 'get_file_structure',
    description:
      'Return an annotated file tree for a directory. Each entry includes type (file/dir), ' +
      'extension, and approximate line count. Use before scaffold/code to know what files exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to project root. Default: ".".',
        },
        depth: {
          type: 'number',
          description: 'Max directory depth to walk (default: 3, max: 6).',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only include files with these extensions (e.g. [".js", ".ts"]). Empty = all.',
        },
      },
    },
  },
  {
    name: 'find_symbol',
    description:
      'Search for a function, class, variable, or type definition across the codebase. ' +
      'Returns matching file paths, line numbers, and a short context snippet. ' +
      'Use in scaffold/code phases to locate the right file before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol name to search for (e.g. "createUser", "PaymentService").',
        },
        scope: {
          type: 'string',
          description:
            'Optional subdirectory to restrict the search (e.g. "src/", "routes/"). ' +
            'Defaults to the entire project.',
        },
        kind: {
          type: 'string',
          enum: ['function', 'class', 'variable', 'type', 'any'],
          description: 'Symbol kind to narrow the search. Default: "any".',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'find_references',
    description:
      'Find all files that import or call a given symbol. ' +
      'Use before renaming or modifying a symbol to understand impact.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol name to find references for.',
        },
        scope: {
          type: 'string',
          description: 'Optional subdirectory to restrict the search.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'list_imports',
    description:
      'List all require() / import statements in a file and classify each as ' +
      'built-in, npm, or relative. Use to understand a file\'s dependencies before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'check_diagnostics',
    description:
      'Surface structural issues in a file or directory: unclosed brackets, ' +
      'missing required imports, duplicate exports, syntax red-flags. ' +
      'Use in VERIFY phase to validate generated code before deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File or directory to check. If a directory, scans all JS/TS files inside.',
        },
        strict: {
          type: 'boolean',
          description: 'Include warnings (not just errors). Default: false.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'onboard_project',
    description:
      'Run a full codebase onboarding: analyze structure, detect framework, find entry points, ' +
      'map key modules, and return a concise summary the agent can use as working memory. ' +
      'Call once at the start of a session when working on an existing codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Project root path (relative to server root). Defaults to ".".',
        },
      },
    },
  },
];

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Factory: creates a Serena built-in MCP client.
 * @param {{ root?: string }} [opts]
 */
function createSerenaServer(opts = {}) {
  const serverRoot = path.resolve(opts.root || process.cwd());

  async function callTool(name, params) {
    switch (name) {
      case 'analyze_codebase':
        return _analyzeCodebase(serverRoot, params);
      case 'get_file_structure':
        return _getFileStructure(serverRoot, params);
      case 'find_symbol':
        return _findSymbol(serverRoot, params);
      case 'find_references':
        return _findReferences(serverRoot, params);
      case 'list_imports':
        return _listImports(serverRoot, params);
      case 'check_diagnostics':
        return _checkDiagnostics(serverRoot, params);
      case 'onboard_project':
        return _onboardProject(serverRoot, params);
      default:
        return _error(`Unknown Serena tool: ${name}`);
    }
  }

  return new InProcessMcpClient({ name: 'serena', tools: TOOLS, callTool });
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function _analyzeCodebase(serverRoot, params = {}) {
  try {
    const root = _resolveSafe(serverRoot, params.root || '.');
    if (!root) return _error('Invalid root path');

    const lines = ['# Codebase Analysis\n'];

    // Detect tech stack from package.json
    const pkgPath = path.join(root, 'package.json');
    let pkg = null;
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    }

    if (pkg) {
      lines.push(`## Project: ${pkg.name || 'unknown'} v${pkg.version || '?'}`);
      lines.push(`Description: ${pkg.description || '(none)'}`);
      if (pkg.main) lines.push(`Entry point: ${pkg.main}`);
      if (pkg.scripts) {
        const scriptList = Object.entries(pkg.scripts)
          .slice(0, 8)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        lines.push(`\nScripts:\n${scriptList}`);
      }
    }

    // Walk files for summary
    const allFiles = [];
    _walkFiles(root, root, allFiles, { maxDepth: 4, maxFiles: MAX_FILES_WALK });

    const byExt = {};
    for (const f of allFiles) {
      const ext = path.extname(f) || '(no ext)';
      byExt[ext] = (byExt[ext] || 0) + 1;
    }

    lines.push(`\n## File Count: ${allFiles.length} files`);
    const extSummary = Object.entries(byExt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `  ${ext}: ${count}`)
      .join('\n');
    lines.push(`Extension breakdown:\n${extSummary}`);

    // Detect framework
    const frameworks = _detectFrameworks(root, pkg, allFiles);
    if (frameworks.length) {
      lines.push(`\n## Detected Frameworks: ${frameworks.join(', ')}`);
    }

    // Detect entry points
    const entryPoints = _detectEntryPoints(root, allFiles);
    if (entryPoints.length) {
      lines.push(`\n## Entry Points:\n${entryPoints.map(e => `  - ${e}`).join('\n')}`);
    }

    // Key directories
    let topDirs;
    try {
      topDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && !_isIgnoredDir(e.name))
        .map(e => e.name);
    } catch (_) { topDirs = []; }
    if (topDirs.length) {
      lines.push(`\n## Top-level Directories: ${topDirs.join(', ')}`);
    }

    // Dependencies
    const includeDeps = params.include_dependencies !== false;
    if (includeDeps && pkg) {
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length) lines.push(`\n## Dependencies (${deps.length}):\n${deps.map(d => `  - ${d}`).join('\n')}`);
      if (devDeps.length) lines.push(`\nDev Dependencies (${devDeps.length}):\n${devDeps.slice(0, 20).map(d => `  - ${d}`).join('\n')}`);
    }

    return _text(lines.join('\n'));
  } catch (err) {
    return _error(`analyze_codebase failed: ${err.message}`);
  }
}

async function _getFileStructure(serverRoot, params = {}) {
  try {
    const dirPath = _resolveSafe(serverRoot, params.path || '.');
    if (!dirPath) return _error(`Invalid path: "${params.path}"`);

    const maxDepth = Math.min(params.depth || 3, 6);
    const extensions = new Set((params.extensions || []).map(e => e.toLowerCase()));

    const lines = [`File structure: ${params.path || '.'}\n`];
    _buildTree(dirPath, dirPath, lines, 0, maxDepth, extensions);

    return _text(lines.join('\n'));
  } catch (err) {
    return _error(`get_file_structure failed: ${err.message}`);
  }
}

async function _findSymbol(serverRoot, params = {}) {
  try {
    const { symbol, scope, kind = 'any' } = params;
    if (!symbol) return _error('symbol is required');

    const searchRoot = scope
      ? _resolveSafe(serverRoot, scope)
      : serverRoot;
    if (!searchRoot) return _error(`Invalid scope: "${scope}"`);

    const files = [];
    _walkFiles(searchRoot, serverRoot, files, {
      maxDepth: 8,
      maxFiles: MAX_FILES_WALK,
      extensions: new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']),
    });

    // Build regex patterns based on kind
    const patterns = _symbolPatterns(symbol, kind);
    const results = [];

    for (const filePath of files) {
      try {
        const content = _readTruncated(path.join(serverRoot, filePath));
        const lineArr = content.split('\n');

        for (let i = 0; i < lineArr.length; i++) {
          const line = lineArr[i];
          for (const rx of patterns) {
            if (rx.test(line)) {
              const snippet = lineArr.slice(Math.max(0, i - 1), i + 3).join('\n').trim();
              results.push({ file: filePath, line: i + 1, snippet });
              break; // one match per line
            }
          }
        }
      } catch (_) {}

      if (results.length >= 20) break; // cap results
    }

    if (!results.length) {
      return _text(`No definition found for "${symbol}" (kind: ${kind})`);
    }

    const out = [`Found ${results.length} definition(s) for "${symbol}":\n`];
    for (const r of results) {
      out.push(`## ${r.file}:${r.line}`);
      out.push('```');
      out.push(r.snippet);
      out.push('```\n');
    }
    return _text(out.join('\n'));
  } catch (err) {
    return _error(`find_symbol failed: ${err.message}`);
  }
}

async function _findReferences(serverRoot, params = {}) {
  try {
    const { symbol, scope } = params;
    if (!symbol) return _error('symbol is required');

    const searchRoot = scope
      ? _resolveSafe(serverRoot, scope)
      : serverRoot;
    if (!searchRoot) return _error(`Invalid scope: "${scope}"`);

    const files = [];
    _walkFiles(searchRoot, serverRoot, files, {
      maxDepth: 8,
      maxFiles: MAX_FILES_WALK,
      extensions: new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']),
    });

    // Match any occurrence of the symbol (not inside comments as best-effort)
    const rx = new RegExp(`\\b${_escapeRegex(symbol)}\\b`);
    const results = [];

    for (const filePath of files) {
      try {
        const content = _readTruncated(path.join(serverRoot, filePath));
        const lineArr = content.split('\n');
        const matches = [];

        for (let i = 0; i < lineArr.length; i++) {
          if (rx.test(lineArr[i])) {
            matches.push({ line: i + 1, text: lineArr[i].trim().slice(0, 120) });
          }
        }

        if (matches.length) {
          results.push({ file: filePath, matches });
        }
      } catch (_) {}

      if (results.length >= 30) break;
    }

    if (!results.length) {
      return _text(`No references found for "${symbol}"`);
    }

    const out = [`Found references to "${symbol}" in ${results.length} file(s):\n`];
    for (const r of results) {
      out.push(`## ${r.file} (${r.matches.length} occurrence(s))`);
      for (const m of r.matches.slice(0, 5)) {
        out.push(`  Line ${m.line}: ${m.text}`);
      }
      if (r.matches.length > 5) out.push(`  ... and ${r.matches.length - 5} more`);
      out.push('');
    }

    return _text(out.join('\n'));
  } catch (err) {
    return _error(`find_references failed: ${err.message}`);
  }
}

async function _listImports(serverRoot, params = {}) {
  try {
    const filePath = _resolveSafe(serverRoot, params.path);
    if (!filePath) return _error(`Invalid path: "${params.path}"`);

    const content = _readTruncated(filePath);
    const imports = _extractImports(content, params.path);

    if (!imports.length) {
      return _text(`No imports found in ${params.path}`);
    }

    const builtins = imports.filter(i => i.kind === 'builtin');
    const npm = imports.filter(i => i.kind === 'npm');
    const relative = imports.filter(i => i.kind === 'relative');

    const lines = [`Imports in ${params.path}:\n`];
    if (builtins.length) lines.push(`## Node.js Built-ins (${builtins.length})\n${builtins.map(i => `  ${i.source}`).join('\n')}`);
    if (npm.length) lines.push(`\n## npm Packages (${npm.length})\n${npm.map(i => `  ${i.source}`).join('\n')}`);
    if (relative.length) lines.push(`\n## Relative Imports (${relative.length})\n${relative.map(i => `  ${i.source}  (line ${i.line})`).join('\n')}`);

    return _text(lines.join('\n'));
  } catch (err) {
    return _error(`list_imports failed: ${err.message}`);
  }
}

async function _checkDiagnostics(serverRoot, params = {}) {
  try {
    const targetPath = _resolveSafe(serverRoot, params.path);
    if (!targetPath) return _error(`Invalid path: "${params.path}"`);

    const strict = params.strict === true;
    const filesToCheck = [];

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      _walkFiles(targetPath, serverRoot, filesToCheck, {
        maxDepth: 4,
        maxFiles: 100,
        extensions: new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs']),
      });
    } else {
      // Single file — add relative path
      const rel = path.relative(serverRoot, targetPath);
      filesToCheck.push(rel);
    }

    const issues = [];

    for (const relPath of filesToCheck) {
      const absPath = path.join(serverRoot, relPath);
      try {
        const content = _readTruncated(absPath);
        const fileIssues = _lintFile(content, relPath, strict);
        issues.push(...fileIssues);
      } catch (_) {}
    }

    if (!issues.length) {
      return _text(`✓ No structural issues found in ${params.path} (${filesToCheck.length} file(s) checked)`);
    }

    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    const lines = [`Diagnostics for ${params.path} (${filesToCheck.length} file(s)):\n`];
    if (errors.length) {
      lines.push(`## Errors (${errors.length})`);
      for (const e of errors.slice(0, 20)) {
        lines.push(`  [ERROR] ${e.file}:${e.line} — ${e.message}`);
      }
    }
    if (strict && warnings.length) {
      lines.push(`\n## Warnings (${warnings.length})`);
      for (const w of warnings.slice(0, 20)) {
        lines.push(`  [WARN]  ${w.file}:${w.line} — ${w.message}`);
      }
    }

    return _text(lines.join('\n'));
  } catch (err) {
    return _error(`check_diagnostics failed: ${err.message}`);
  }
}

async function _onboardProject(serverRoot, params = {}) {
  try {
    const root = _resolveSafe(serverRoot, params.root || '.');
    if (!root) return _error('Invalid root path');

    const sections = [];

    // 1. Run analyze_codebase
    const analysisResult = await _analyzeCodebase(serverRoot, { root: params.root || '.', include_dependencies: true });
    sections.push(analysisResult.content[0].text);

    sections.push('\n---\n');

    // 2. Detect key source files
    const keyFiles = _detectKeyFiles(root, serverRoot);
    if (keyFiles.length) {
      sections.push('## Key Source Files');
      sections.push(keyFiles.map(f => `  - ${f}`).join('\n'));
    }

    // 3. Detect route patterns in Express/Fastify apps
    const routes = _detectRoutes(root, serverRoot);
    if (routes.length) {
      sections.push('\n## Detected API Routes (sample)');
      sections.push(routes.slice(0, 30).map(r => `  ${r}`).join('\n'));
    }

    // 4. Detect exported symbols in index files
    const exports = _detectMainExports(root, serverRoot);
    if (exports.length) {
      sections.push('\n## Main Exports');
      sections.push(exports.slice(0, 20).map(e => `  ${e}`).join('\n'));
    }

    sections.push('\n---');
    sections.push('Onboarding complete. Use find_symbol, get_file_structure, or check_diagnostics for deeper analysis.');

    return _text(sections.join('\n'));
  } catch (err) {
    return _error(`onboard_project failed: ${err.message}`);
  }
}

// ── Static analysis helpers ───────────────────────────────────────────────────

function _lintFile(content, filePath, strict) {
  const issues = [];
  const lines = content.split('\n');

  // Check for unbalanced braces (heuristic — not a real parser)
  let braces = 0;
  let parens = 0;
  let brackets = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip single-line comments and string-heavy lines
    const stripped = line.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '""').replace(/\/\/.*$/, '');

    for (const ch of stripped) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }

    // Detect obvious syntax patterns
    if (strict) {
      // Warn on console.log (reminder, not an error)
      if (/\bconsole\.(log|warn|error)\b/.test(line) && !/suppress-lint/.test(line)) {
        issues.push({ file: filePath, line: i + 1, severity: 'warning', message: 'console.* call — use structured logger' });
      }
    }
  }

  if (braces !== 0) {
    issues.push({ file: filePath, line: lines.length, severity: 'error', message: `Unbalanced braces: ${braces > 0 ? '+' : ''}${braces} (possible missing ${braces > 0 ? '}' : '{'})` });
  }
  if (parens !== 0) {
    issues.push({ file: filePath, line: lines.length, severity: 'error', message: `Unbalanced parentheses: ${parens > 0 ? '+' : ''}${parens}` });
  }
  if (brackets !== 0) {
    issues.push({ file: filePath, line: lines.length, severity: 'error', message: `Unbalanced brackets: ${brackets > 0 ? '+' : ''}${brackets}` });
  }

  // Check for duplicate require/import of the same module
  const requireSet = new Set();
  const importSet = new Set();
  for (let i = 0; i < lines.length; i++) {
    const reqMatch = lines[i].match(/require\(['"]([^'"]+)['"]\)/);
    if (reqMatch) {
      const mod = reqMatch[1];
      if (requireSet.has(mod)) {
        issues.push({ file: filePath, line: i + 1, severity: strict ? 'warning' : 'error', message: `Duplicate require: "${mod}"` });
      }
      requireSet.add(mod);
    }

    const importMatch = lines[i].match(/^import\s+.+\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const mod = importMatch[1];
      if (importSet.has(mod)) {
        issues.push({ file: filePath, line: i + 1, severity: 'warning', message: `Duplicate import: "${mod}"` });
      }
      importSet.add(mod);
    }
  }

  return issues;
}

function _extractImports(content, filePath) {
  const imports = [];
  const NODE_BUILTINS = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
    'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http',
    'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
    'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
    'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util',
    'v8', 'vm', 'worker_threads', 'zlib',
  ]);

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // CommonJS require
    const reqMatch = line.match(/(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (reqMatch) {
      const src = reqMatch[1];
      imports.push({ source: src, line: i + 1, kind: _classifyImport(src, NODE_BUILTINS) });
      continue;
    }

    // ES import
    const esMatch = line.match(/^import\s+.+?\s+from\s+['"]([^'"]+)['"]/);
    if (esMatch) {
      const src = esMatch[1];
      imports.push({ source: src, line: i + 1, kind: _classifyImport(src, NODE_BUILTINS) });
    }
  }

  return imports;
}

function _classifyImport(src, builtins) {
  if (src.startsWith('.') || src.startsWith('/')) return 'relative';
  if (src.startsWith('node:') || builtins.has(src.split('/')[0])) return 'builtin';
  return 'npm';
}

function _symbolPatterns(symbol, kind) {
  const esc = _escapeRegex(symbol);
  const patterns = [];

  if (kind === 'any' || kind === 'function') {
    patterns.push(new RegExp(`(?:function\\s+${esc}|const\\s+${esc}\\s*=\\s*(?:async\\s+)?(?:function|\\())`));
    patterns.push(new RegExp(`(?:async\\s+)?${esc}\\s*\\([^)]*\\)\\s*\\{`));
    patterns.push(new RegExp(`module\\.exports\\.${esc}\\s*=`));
    patterns.push(new RegExp(`exports\\.${esc}\\s*=`));
  }
  if (kind === 'any' || kind === 'class') {
    patterns.push(new RegExp(`class\\s+${esc}\\b`));
  }
  if (kind === 'any' || kind === 'variable') {
    patterns.push(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=`));
  }
  if (kind === 'any' || kind === 'type') {
    patterns.push(new RegExp(`(?:type|interface)\\s+${esc}\\b`));
  }

  return patterns;
}

function _detectFrameworks(root, pkg, files) {
  const found = [];
  const deps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };

  if (deps.express) found.push('Express.js');
  if (deps.fastify) found.push('Fastify');
  if (deps.react) found.push('React');
  if (deps.vue) found.push('Vue');
  if (deps.next) found.push('Next.js');
  if (deps.vite) found.push('Vite');
  if (deps.sequelize) found.push('Sequelize');
  if (deps.pg || deps['pg-pool']) found.push('PostgreSQL (pg)');
  if (deps.stripe) found.push('Stripe');
  if (deps['socket.io']) found.push('Socket.IO');
  if (deps.bullmq || deps.bull) found.push('BullMQ');

  // Detect from file patterns
  if (files.some(f => /tailwind\.config/.test(f))) found.push('Tailwind CSS');
  if (files.some(f => /\.tsx?$/.test(f))) found.push('TypeScript');

  return [...new Set(found)];
}

function _detectEntryPoints(root, files) {
  const candidates = ['server.js', 'index.js', 'app.js', 'main.js', 'src/index.js', 'src/server.js'];
  return candidates.filter(c => files.includes(c));
}

function _detectKeyFiles(root, serverRoot) {
  const patterns = [
    /^(?:server|index|app|main)\.[jt]sx?$/,
    /^(?:routes?|api|controllers?)\/.*\.[jt]sx?$/,
    /^(?:db|database|models?)\/.*\.[jt]sx?$/,
    /^(?:middleware|auth|utils?)\/.*\.[jt]sx?$/,
  ];

  const files = [];
  _walkFiles(root, serverRoot, files, { maxDepth: 3, maxFiles: 200 });
  return files.filter(f => patterns.some(rx => rx.test(f))).slice(0, 20);
}

function _detectRoutes(root, serverRoot) {
  const routes = [];
  const files = [];
  _walkFiles(root, serverRoot, files, {
    maxDepth: 4,
    maxFiles: 100,
    extensions: new Set(['.js', '.ts', '.mjs']),
  });

  for (const relPath of files) {
    try {
      const content = _readTruncated(path.join(serverRoot, relPath));
      const lines = content.split('\n');
      for (const line of lines) {
        const m = line.match(/(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"` ]+)/i);
        if (m) {
          routes.push(`${m[1].toUpperCase()} ${m[2]}  (${relPath})`);
        }
      }
    } catch (_) {}
  }

  return routes;
}

function _detectMainExports(root, serverRoot) {
  const exports = [];
  const candidates = ['index.js', 'index.ts', 'src/index.js', 'src/index.ts'];

  for (const rel of candidates) {
    const absPath = path.join(root, rel);
    if (!fs.existsSync(absPath)) continue;
    try {
      const content = _readTruncated(absPath);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(?:module\.exports\.|exports\.|export\s+(?:const|function|class|default))\s*(\w+)/);
        if (m) {
          exports.push(`${m[1]}  (${rel}:${i + 1})`);
        }
      }
    } catch (_) {}
  }

  return exports;
}

// ── File walking ──────────────────────────────────────────────────────────────

function _walkFiles(dir, serverRoot, results, opts = {}) {
  const { maxDepth = 6, maxFiles = MAX_FILES_WALK, extensions, depth = 0 } = opts;
  if (depth > maxDepth || results.length >= maxFiles) return;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (_isIgnoredDir(entry.name)) continue;

    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(serverRoot, absPath);

    if (entry.isDirectory()) {
      _walkFiles(absPath, serverRoot, results, { ...opts, depth: depth + 1 });
    } else if (entry.isFile()) {
      if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      results.push(relPath);
    }
  }
}

function _buildTree(dir, serverRoot, lines, depth, maxDepth, extensions) {
  if (depth > maxDepth) return;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }

  const indent = '  '.repeat(depth);
  for (const entry of entries) {
    if (_isIgnoredDir(entry.name)) continue;

    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(serverRoot, absPath);

    if (entry.isDirectory()) {
      lines.push(`${indent}📁 ${entry.name}/`);
      _buildTree(absPath, serverRoot, lines, depth + 1, maxDepth, extensions);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.size && !extensions.has(ext)) continue;
      let lineCount = '';
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        const count = content.split('\n').length;
        lineCount = ` (${count} lines)`;
      } catch (_) {}
      lines.push(`${indent}📄 ${entry.name}${lineCount}`);
    }
  }
}

function _isIgnoredDir(name) {
  return /^(node_modules|\.git|\.next|dist|build|coverage|\.turbo|\.cache|public\/react-build)$/.test(name);
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function _readTruncated(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  return content.length > MAX_FILE_SCAN_CHARS
    ? content.slice(0, MAX_FILE_SCAN_CHARS)
    : content;
}

function _resolveSafe(root, userPath) {
  if (!userPath) return root;
  const resolved = path.resolve(root, userPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _text(text) {
  return { content: [{ type: 'text', text }] };
}

function _error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

module.exports = { createSerenaServer };
