/**
 * Built-in MCP Server: Git
 *
 * Owns: read-only and limited write Git operations against a project repo.
 * Does NOT own: repo cloning, auth credentials, GitHub API (use github routes for that).
 *
 * Tools exposed:
 *   log          — Show recent commit history
 *   diff         — Show diff for a file or the working tree
 *   status       — Show working tree status
 *   show         — Show content of a specific commit or file at a commit
 *   create_commit — Stage all changes and create a commit (write, explicit opt-in)
 *
 * All git commands run against the CWD (process.cwd()), which is the repo root.
 * Write operations require opts.allowWrites = true in server config.
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { InProcessMcpClient } = require('./in-process-client');

const execFileAsync = promisify(execFile);

/**
 * Factory: creates a Git built-in MCP client.
 * @param {{ allowWrites?: boolean, repoPath?: string }} [opts]
 */
function createGitServer(opts = {}) {
  const allowWrites = opts.allowWrites === true;
  const repoPath = opts.repoPath || process.cwd();

  const tools = [
    {
      name: 'log',
      description: 'Show recent commit history. Returns commit hash, author, date, and message.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of commits to return (default 10).' },
          file: { type: 'string', description: 'Optional: filter to commits touching this file.' },
        },
      },
    },
    {
      name: 'diff',
      description: 'Show a git diff. If no arguments given, shows unstaged changes in the working tree.',
      inputSchema: {
        type: 'object',
        properties: {
          commit: { type: 'string', description: 'Commit hash or ref to diff against (optional).' },
          file: { type: 'string', description: 'Optional: limit diff to this file path.' },
          staged: { type: 'boolean', description: 'If true, diff staged changes (--cached).' },
        },
      },
    },
    {
      name: 'status',
      description: 'Show the current working tree status — which files are modified, staged, or untracked.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'show',
      description: 'Show content of a file at a specific commit, or show a commit\'s full diff.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Commit hash or ref (e.g., HEAD, HEAD~1).' },
          file: { type: 'string', description: 'Optional: show this file\'s content at ref.' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'create_commit',
      description: 'Stage all changes and create a git commit. Requires write permission.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message.' },
        },
        required: ['message'],
      },
    },
  ];

  async function callTool(name, params) {
    switch (name) {
      case 'log': {
        const limit = Math.min(Number(params.limit) || 10, 50);
        const args = ['log', `--oneline`, `-${limit}`, '--pretty=format:%h %ad %s <%an>', '--date=short'];
        if (params.file) args.push('--', _sanitizePath(params.file));
        return _run(args, repoPath);
      }

      case 'diff': {
        const args = ['diff'];
        if (params.staged) args.push('--cached');
        if (params.commit) args.push(_sanitizeRef(params.commit));
        if (params.file) args.push('--', _sanitizePath(params.file));
        return _run(args, repoPath);
      }

      case 'status': {
        return _run(['status', '--short'], repoPath);
      }

      case 'show': {
        const ref = _sanitizeRef(params.ref);
        const args = params.file
          ? ['show', `${ref}:${_sanitizePath(params.file)}`]
          : ['show', '--stat', ref];
        return _run(args, repoPath);
      }

      case 'create_commit': {
        if (!allowWrites) {
          return _error('Write access is not enabled for this Git MCP connection. Configure allowWrites: true.');
        }
        if (!params.message || !params.message.trim()) {
          return _error('Commit message is required.');
        }
        // Stage all modified tracked files (not new untracked files)
        await _runRaw(['add', '-u'], repoPath);
        return _run(['commit', '-m', params.message.trim()], repoPath);
      }

      default:
        return _error(`Unknown tool: ${name}`);
    }
  }

  return new InProcessMcpClient({ name: 'git', tools, callTool });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _run(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 15000 });
    const output = (stdout || '').trim() || (stderr || '').trim() || '(no output)';
    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    const message = err.stderr ? err.stderr.trim() : err.message;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function _runRaw(args, cwd) {
  return execFileAsync('git', args, { cwd, timeout: 10000 });
}

function _error(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

// Prevent path traversal — allow only relative paths within the repo
function _sanitizePath(p) {
  if (!p) return p;
  const cleaned = p.replace(/\.\./g, '').replace(/^\//, '');
  return cleaned;
}

// Allow only safe git refs (commit hashes, branch names, relative refs)
function _sanitizeRef(ref) {
  if (!ref) return ref;
  if (!/^[a-zA-Z0-9._\-/~^@{}:]+$/.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}"`);
  }
  return ref;
}

module.exports = { createGitServer };
