/**
 * Built-in MCP Server: Filesystem
 *
 * Owns: auditable read/write access to project files.
 * Does NOT own: auth, DB access, git operations (use git MCP for that).
 *
 * Tools exposed:
 *   read_file    — Read a file's contents
 *   list_dir     — List directory contents
 *   write_file   — Write or overwrite a file (requires allowWrites)
 *   delete_file  — Delete a file (requires allowWrites)
 *
 * All paths are sandboxed to the allowed root (defaults to process.cwd()).
 * Path traversal attempts (../) are rejected.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { InProcessMcpClient } = require('./in-process-client');

/**
 * Factory: creates a Filesystem built-in MCP client.
 * @param {{ allowWrites?: boolean, root?: string }} [opts]
 */
function createFilesystemServer(opts = {}) {
  const allowWrites = opts.allowWrites === true;
  const root = path.resolve(opts.root || process.cwd());

  const tools = [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the project.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_dir',
      description: 'List files and directories at a given path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root (default: ".").' },
        },
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed. Requires write permission.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root.' },
          content: { type: 'string', description: 'File content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file. Requires write permission.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root.' },
        },
        required: ['path'],
      },
    },
  ];

  async function callTool(name, params) {
    switch (name) {
      case 'read_file': {
        const filePath = _resolveSafe(root, params.path);
        if (!filePath) return _error(`Invalid path: "${params.path}"`);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          // Truncate very large files to avoid flooding the context window
          const MAX = 50000;
          const truncated = content.length > MAX;
          return _text(truncated ? content.slice(0, MAX) + `\n\n[Truncated — ${content.length} total chars]` : content);
        } catch (err) {
          return _error(`Cannot read "${params.path}": ${err.message}`);
        }
      }

      case 'list_dir': {
        const dirPath = _resolveSafe(root, params.path || '.');
        if (!dirPath) return _error(`Invalid path: "${params.path}"`);
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const lines = entries
            .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
            .map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
            .sort();
          return _text(lines.join('\n') || '(empty directory)');
        } catch (err) {
          return _error(`Cannot list "${params.path}": ${err.message}`);
        }
      }

      case 'write_file': {
        if (!allowWrites) {
          return _error('Write access is not enabled. Configure allowWrites: true.');
        }
        const filePath = _resolveSafe(root, params.path);
        if (!filePath) return _error(`Invalid path: "${params.path}"`);

        // Block writing to sensitive files
        const basename = path.basename(filePath);
        if (/^\.env$|^\.env\.[^.]+$/.test(basename)) {
          return _error('Writing .env files is not allowed via MCP.');
        }

        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, params.content || '', 'utf8');
          return _text(`Wrote ${(params.content || '').length} chars to ${params.path}`);
        } catch (err) {
          return _error(`Cannot write "${params.path}": ${err.message}`);
        }
      }

      case 'delete_file': {
        if (!allowWrites) {
          return _error('Write access is not enabled. Configure allowWrites: true.');
        }
        const filePath = _resolveSafe(root, params.path);
        if (!filePath) return _error(`Invalid path: "${params.path}"`);
        try {
          fs.unlinkSync(filePath);
          return _text(`Deleted ${params.path}`);
        } catch (err) {
          return _error(`Cannot delete "${params.path}": ${err.message}`);
        }
      }

      default:
        return _error(`Unknown tool: ${name}`);
    }
  }

  return new InProcessMcpClient({ name: 'filesystem', tools, callTool });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _text(text) {
  return { content: [{ type: 'text', text }] };
}

function _error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Resolve a user-provided path safely within the sandboxed root.
 * Returns null if the resolved path escapes the root.
 */
function _resolveSafe(root, userPath) {
  if (!userPath) return root;
  const resolved = path.resolve(root, userPath);
  // Must start with root (prevent directory traversal)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }
  return resolved;
}

module.exports = { createFilesystemServer };
