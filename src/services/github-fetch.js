/**
 * GitHub Fetch Service
 *
 * Owns: Fetching existing repo file tree + content from GitHub API for
 *       "build from existing repo" pipeline mode.
 *
 * Not owned: OAuth token management, repo creation, PR push.
 *
 * Exports:
 *   fetchRepoContext({ pool, userId, repoFullName }) → RepoContext
 *   getRepoTree({ token, repoFullName }) → FileTree[]
 */

const crypto = require('crypto');

// ── Token decryption ───────────────────────────────────────────────────────
// Key derived from JWT_SECRET — must be set (validated at startup by auth module).
function getEncKey() {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET env var required for token decryption');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
}

function decryptToken(enc) {
  const [ivHex, tagHex, ctHex] = enc.split(':');
  const key = getEncKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), null, 'utf8') + decipher.final('utf8');
}

// GitHub API base
const GH_API = 'https://api.github.com';

// Max file size to fetch (50 KB) — larger files are skipped to keep context manageable
const MAX_FILE_SIZE_BYTES = 50 * 1024;

// Max total files to FETCH CONTENT for (avoid massive prompt blowup).
// FIX (#1497201): Raised from 40 → 80. The full file tree (paths only) is always
// included regardless — this cap only limits how many files get their content fetched.
const MAX_FILES = 80;

// File extensions worth reading (code, config)
const READABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml',
  '.html', '.css', '.scss', '.sass',
  '.md', '.txt',
  '.env.example', '.env.sample',
  '.sh', '.bash',
  '.py', '.rb', '.go', '.java', '.c', '.cpp', '.rs',
  '.sql',
  '.toml', '.ini', '.cfg',
]);

// Always-include files (even without a matching extension)
const PRIORITY_FILES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock',
  'requirements.txt', 'Gemfile', 'go.mod', 'Cargo.toml',
  'README.md', 'README',
  '.env.example', '.env.sample',
  'Makefile', 'Dockerfile',
  '.gitignore',
]);

// ── GitHub API helper ─────────────────────────────────────────────────────

async function ghFetch(token, path, method = 'GET') {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return res;
}

// ── Get flat file tree via Git Trees API ──────────────────────────────────

/**
 * Fetch the recursive file tree for a repo.
 * Returns a flat list of file paths.
 *
 * @param {string} token         - Decrypted GitHub access token
 * @param {string} repoFullName  - "owner/repo"
 * @returns {{ tree: { path, size, type }[], defaultBranch: string }}
 */
async function getRepoTree(token, repoFullName) {
  // 1. Get default branch
  const repoRes = await ghFetch(token, `/repos/${repoFullName}`);
  if (!repoRes.ok) {
    const err = new Error(`GitHub repo fetch failed: ${repoRes.status}`);
    err.code = repoRes.status === 404 ? 'NOT_FOUND' : 'GH_API_ERROR';
    throw err;
  }
  const repoData = await repoRes.json();
  const defaultBranch = repoData.default_branch || 'main';

  // 2. Get recursive tree
  const treeRes = await ghFetch(token, `/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`);
  if (!treeRes.ok) {
    const err = new Error(`GitHub tree fetch failed: ${treeRes.status}`);
    err.code = 'GH_API_ERROR';
    throw err;
  }
  const treeData = await treeRes.json();

  // Filter to blobs (files) only
  const tree = (treeData.tree || [])
    .filter(item => item.type === 'blob')
    .map(item => ({ path: item.path, size: item.size || 0 }));

  return { tree, defaultBranch };
}

// ── Decide which files to fetch ───────────────────────────────────────────

function shouldFetchFile(filePath, fileSize) {
  if (fileSize > MAX_FILE_SIZE_BYTES) return false;

  const basename = filePath.split('/').pop();
  if (PRIORITY_FILES.has(basename)) return true;

  const ext = basename.includes('.') ? '.' + basename.split('.').pop() : '';
  return READABLE_EXTENSIONS.has(ext.toLowerCase());
}

// ── Fetch a single file's content ─────────────────────────────────────────

async function fetchFileContent(token, repoFullName, filePath) {
  const res = await ghFetch(token, `/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.content) return null;

  try {
    // GitHub returns base64-encoded content
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Fetch a repo's structure and representative file contents to build pipeline context.
 *
 * @param {object} opts
 * @param {object} opts.pool          - pg Pool
 * @param {number} opts.userId        - User ID (for token lookup)
 * @param {string} opts.repoFullName  - "owner/repo"
 * @returns {RepoContext}
 *
 * RepoContext:
 *   { repoFullName, defaultBranch, totalFiles, fetchedFiles, fileTree, files, summary }
 *
 *   files: { [path]: content }  — content of fetched readable files
 *   summary: string             — markdown summary injected into PLAN prompt
 */
async function fetchRepoContext({ pool, userId, repoFullName }) {
  // Load encrypted token
  const { rows } = await pool.query(
    'SELECT access_token_enc FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) {
    const err = new Error('GitHub not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const token = decryptToken(rows[0].access_token_enc);

  // Get full file tree
  const { tree, defaultBranch } = await getRepoTree(token, repoFullName);

  // Decide which files to fetch (prioritize by importance, cap at MAX_FILES)
  const toFetch = tree
    .filter(f => shouldFetchFile(f.path, f.size))
    .slice(0, MAX_FILES);

  // Fetch file contents in parallel (batches of 5 to stay polite to GitHub API)
  const files = {};
  const BATCH = 5;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(f => fetchFileContent(token, repoFullName, f.path).then(c => [f.path, c]))
    );
    for (const [path, content] of results) {
      if (content !== null) files[path] = content;
    }
  }

  // Build a compact file tree listing (all files, not just fetched ones)
  const fileTree = tree.map(f => f.path);

  // Build context summary for the planner prompt
  const summary = buildContextSummary(repoFullName, defaultBranch, fileTree, files);

  return {
    repoFullName,
    defaultBranch,
    totalFiles: tree.length,
    fetchedFiles: Object.keys(files).length,
    fileTree,
    files,
    summary,
  };
}

// ── Build a compact context summary for the PLAN prompt ───────────────────

function buildContextSummary(repoFullName, defaultBranch, fileTree, files) {
  const lines = [
    `## Existing Repository: ${repoFullName}`,
    `Branch: ${defaultBranch} | ${fileTree.length} files total`,
    '',
  ];

  // Detect tech stack from file presence
  const stack = detectStack(fileTree, files);
  if (stack.length) {
    lines.push(`**Detected stack:** ${stack.join(', ')}`);
    lines.push('');
  }

  // File tree — include ALL paths (they're just strings, cheap to list).
  // FIX (#1497201): Was capped at 60 which silently dropped files from context.
  // Complete file tree is essential for the model to know what exists.
  lines.push('### File Structure');
  lines.push('```');
  const FILE_TREE_CAP = 200; // safety cap for truly massive repos
  fileTree.slice(0, FILE_TREE_CAP).forEach(f => lines.push(f));
  if (fileTree.length > FILE_TREE_CAP) lines.push(`... and ${fileTree.length - FILE_TREE_CAP} more files`);
  lines.push('```');
  lines.push('');

  // Key files content
  const SHOW_FILES = ['package.json', 'README.md', 'README'];
  for (const showPath of SHOW_FILES) {
    const match = Object.keys(files).find(p => p === showPath || p.endsWith('/' + showPath));
    if (match && files[match]) {
      const content = files[match].slice(0, 1500); // cap per file
      lines.push(`### ${match}`);
      lines.push('```');
      lines.push(content);
      if (files[match].length > 1500) lines.push('... (truncated)');
      lines.push('```');
      lines.push('');
    }
  }

  // Additional source files (entry points, main files)
  const entryFiles = Object.keys(files).filter(p => {
    const base = p.split('/').pop();
    return ['server.js', 'index.js', 'app.js', 'main.js', 'index.ts', 'app.ts', 'main.ts'].includes(base);
  });
  for (const ef of entryFiles.slice(0, 2)) {
    const content = files[ef].slice(0, 1000);
    lines.push(`### ${ef} (entry point)`);
    lines.push('```javascript');
    lines.push(content);
    if (files[ef].length > 1000) lines.push('... (truncated)');
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Detect tech stack from file presence ─────────────────────────────────

function detectStack(fileTree, files) {
  const stack = [];
  const allPaths = fileTree.join(' ');
  const pkgContent = files['package.json'] || '';

  if (pkgContent.includes('"react"')) stack.push('React');
  if (pkgContent.includes('"next"')) stack.push('Next.js');
  if (pkgContent.includes('"express"')) stack.push('Express.js');
  if (pkgContent.includes('"vue"')) stack.push('Vue.js');
  if (pkgContent.includes('"angular"')) stack.push('Angular');
  if (pkgContent.includes('"tailwindcss"') || allPaths.includes('tailwind')) stack.push('Tailwind CSS');
  if (pkgContent.includes('"typescript"') || allPaths.includes('.ts')) stack.push('TypeScript');
  if (allPaths.includes('.py') || files['requirements.txt']) stack.push('Python');
  if (files['go.mod']) stack.push('Go');
  if (files['Cargo.toml']) stack.push('Rust');
  if (pkgContent.includes('"pg"') || pkgContent.includes('"postgres"')) stack.push('PostgreSQL');
  if (pkgContent.includes('"sqlite"') || pkgContent.includes('better-sqlite3')) stack.push('SQLite');
  if (pkgContent.includes('"mongoose"') || pkgContent.includes('"mongodb"')) stack.push('MongoDB');

  return [...new Set(stack)]; // dedupe
}

// ── Infer human-readable intent from repo context ────────────────────────
//
// Returns a lightweight { stack, purpose, features, suggestion } object
// for pre-filling the new-build prompt when the user selects an existing repo.
// Uses deterministic signal extraction — no LLM call needed for the common cases.

/**
 * Analyze a repo and return a structured inferred context.
 *
 * @param {{ pool, userId, repoFullName }} opts
 * @returns {{ stack: string[], purpose: string, features: string[], suggestion: string, summary: string }}
 */
async function analyzeRepoIntent({ pool, userId, repoFullName }) {
  const { rows } = await pool.query(
    'SELECT access_token_enc FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) {
    const err = new Error('GitHub not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const token = decryptToken(rows[0].access_token_enc);

  // Get the file tree (fast — one API call)
  const { tree, defaultBranch } = await getRepoTree(token, repoFullName);
  const fileTree = tree.map(f => f.path);

  // Fetch only the highest-value files for quick analysis
  const ANALYSIS_PRIORITY = [
    'package.json', 'README.md', 'README',
    'server.js', 'index.js', 'app.js', 'main.js',
    'src/index.js', 'src/app.js', 'src/main.js',
  ];

  const files = {};
  const BATCH = 5;
  const toFetch = [];
  for (const priorityName of ANALYSIS_PRIORITY) {
    const match = tree.find(f => f.path === priorityName || f.path.endsWith('/' + priorityName));
    if (match) toFetch.push(match);
  }

  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(f => fetchFileContent(token, repoFullName, f.path).then(c => [f.path, c]))
    );
    for (const [path, content] of results) {
      if (content !== null) files[path] = content;
    }
  }

  const stack = detectStack(fileTree, files);
  const purpose = inferPurpose(repoFullName, fileTree, files);
  const features = inferFeatures(fileTree, files);
  const suggestion = buildSuggestion(repoFullName, stack, purpose, features);

  // Full summary (for pipeline context)
  const summary = buildContextSummary(repoFullName, defaultBranch, fileTree, files);

  return { stack, purpose, features, suggestion, summary, fileTree, defaultBranch, totalFiles: tree.length };
}

// Infer the purpose of the repo (1 sentence)
function inferPurpose(repoFullName, fileTree, files) {
  const repoName = repoFullName.split('/')[1] || repoFullName;
  const allPaths = fileTree.join(' ');
  const pkgContent = files['package.json'] || '';
  const readmeContent = (files['README.md'] || files['README'] || '').slice(0, 800);

  // If README starts with a clear description line, extract it
  if (readmeContent) {
    const lines = readmeContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length > 0) {
      const firstParagraph = lines[0].replace(/[*_`]/g, '').trim();
      if (firstParagraph.length > 20 && firstParagraph.length < 200) {
        return firstParagraph;
      }
    }
  }

  // Try package.json description
  try {
    const pkg = JSON.parse(pkgContent);
    if (pkg.description && pkg.description.length > 10) return pkg.description;
  } catch (_) {}

  // Infer from directory structure + repo name
  const cleanName = repoName.replace(/[-_]/g, ' ');
  if (allPaths.includes('dashboard') || allPaths.includes('admin')) return `${cleanName} — dashboard or admin panel application`;
  if (allPaths.includes('landing') || allPaths.includes('marketing')) return `${cleanName} — marketing or landing page site`;
  if (allPaths.includes('api') && allPaths.includes('routes')) return `${cleanName} — REST API backend service`;
  if (allPaths.includes('blog') || allPaths.includes('post')) return `${cleanName} — blog or content site`;
  if (allPaths.includes('shop') || allPaths.includes('product') || allPaths.includes('cart')) return `${cleanName} — e-commerce application`;
  if (allPaths.includes('auth') || allPaths.includes('login')) return `${cleanName} — web application with authentication`;

  return `${cleanName} — web application`;
}

// Infer high-value features from directory/file signals
function inferFeatures(fileTree, files) {
  const allPaths = fileTree.join(' ');
  const pkgContent = files['package.json'] || '';
  const features = [];

  if (allPaths.includes('auth') || pkgContent.includes('bcrypt') || pkgContent.includes('passport') || pkgContent.includes('jwt')) features.push('authentication');
  if (allPaths.includes('dashboard')) features.push('dashboard');
  if (allPaths.includes('migrations') || pkgContent.includes('sequelize') || pkgContent.includes('knex') || pkgContent.includes('"pg"')) features.push('database');
  if (pkgContent.includes('stripe')) features.push('payments (Stripe)');
  if (allPaths.includes('api/') || allPaths.includes('routes/')) features.push('REST API');
  if (pkgContent.includes('"react"') || pkgContent.includes('"vue"')) features.push('SPA frontend');
  if (pkgContent.includes('socket.io') || pkgContent.includes('ws')) features.push('real-time (WebSocket)');
  if (pkgContent.includes('nodemailer') || pkgContent.includes('sendgrid') || pkgContent.includes('postmark')) features.push('email notifications');
  if (allPaths.includes('admin')) features.push('admin panel');
  if (allPaths.includes('analytics') || pkgContent.includes('analytics')) features.push('analytics');

  return features.slice(0, 5); // cap at 5
}

// Build the pre-fill suggestion shown to the user
function buildSuggestion(repoFullName, stack, purpose, features) {
  const stackStr = stack.length ? stack.slice(0, 3).join(', ') : 'web app';
  const featureStr = features.length ? ` with ${features.slice(0, 2).join(' and ')}` : '';
  return `Looks like a ${stackStr} app${featureStr}. What do you want to improve or add?`;
}

module.exports = { fetchRepoContext, getRepoTree, analyzeRepoIntent };
