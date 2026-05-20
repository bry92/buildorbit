/**
 * MCP Client — Generic Model Context Protocol client
 *
 * Owns: connection lifecycle, tool listing, tool invocation for a single MCP server.
 * Does NOT own: which servers exist (registry), audit logging, auth.
 *
 * Implements a minimal JSON-RPC 2.0 over stdio or HTTP/SSE transport.
 * Does NOT require the @modelcontextprotocol/sdk package — uses Node.js builtins only.
 *
 * Transport modes:
 *   stdio — spawns a child process, speaks JSON-RPC over stdin/stdout
 *   sse   — speaks JSON-RPC over HTTP POST, with SSE for server-push notifications
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

// JSON-RPC 2.0 protocol version all MCP servers expect
const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ── McpClient ─────────────────────────────────────────────────────────────────

class McpClient extends EventEmitter {
  /**
   * @param {{ transport: 'stdio'|'sse', command?: string, args?: string[],
   *           url?: string, env?: object, name: string }} config
   */
  constructor(config) {
    super();
    this.name = config.name;
    this.transport = config.transport || 'stdio';
    this.config = config;

    // stdio state
    this._proc = null;
    this._pendingRequests = new Map(); // id → { resolve, reject, timeout }
    this._requestId = 1;
    this._buffer = '';
    this._connected = false;
    this._tools = null; // cached after listTools()
  }

  // ── Connection Lifecycle ──────────────────────────────────────────────────

  /**
   * Connect to the MCP server. Performs the MCP initialize handshake.
   * Must be called before any tool operations.
   */
  async connect() {
    if (this._connected) return;

    if (this.transport === 'stdio') {
      await this._connectStdio();
    } else if (this.transport === 'sse') {
      // SSE transport: stateless — each JSON-RPC request is a separate HTTP POST.
      // Nothing to set up beyond validation.
      if (!this.config.url) throw new Error(`MCP client "${this.name}": url is required for sse transport`);
      this._connected = true;
    } else {
      throw new Error(`MCP client "${this.name}": unsupported transport "${this.transport}"`);
    }

    await this._initialize();
  }

  async _connectStdio() {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new Error(`MCP client "${this.name}": command is required for stdio transport`);

    const mergedEnv = { ...process.env, ...env };
    // Remove DATABASE_URL and other credentials from child processes unless explicitly passed
    const safeEnv = _stripCredentials(mergedEnv, env);

    this._proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnv,
    });

    this._proc.on('error', (err) => {
      this.emit('error', new Error(`MCP "${this.name}" process error: ${err.message}`));
      this._rejectAllPending(err);
    });

    this._proc.on('exit', (code) => {
      this._connected = false;
      this._rejectAllPending(new Error(`MCP "${this.name}" process exited with code ${code}`));
    });

    // Parse newline-delimited JSON from stdout
    this._proc.stdout.on('data', (chunk) => {
      this._buffer += chunk.toString('utf8');
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop(); // keep partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this._handleMessage(msg);
        } catch (_) {
          // Ignore non-JSON lines (e.g., startup messages)
        }
      }
    });

    this._proc.stderr.on('data', (chunk) => {
      // Server stderr is informational — surface as debug event
      this.emit('server_log', chunk.toString('utf8').trim());
    });

    this._connected = true;
  }

  /**
   * MCP initialize handshake.
   * Must complete before tools/list or tools/call.
   */
  async _initialize() {
    await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'buildorbit-mcp-client', version: '1.0.0' },
    });

    // Send initialized notification (fire-and-forget)
    this._notify('notifications/initialized', {});
  }

  disconnect() {
    this._connected = false;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      this._proc = null;
    }
    this._rejectAllPending(new Error(`MCP "${this.name}" disconnected`));
  }

  get connected() {
    return this._connected;
  }

  // ── Tool Operations ───────────────────────────────────────────────────────

  /**
   * List available tools from this MCP server.
   * Caches result — call invalidateCache() to refresh.
   * @returns {Promise<Array<{ name, description, inputSchema }>>}
   */
  async listTools() {
    if (this._tools !== null) return this._tools;
    const result = await this._request('tools/list', {});
    this._tools = Array.isArray(result.tools) ? result.tools : [];
    return this._tools;
  }

  /**
   * Call a tool on this MCP server.
   * @param {string} toolName
   * @param {object} params
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ content: Array<{type, text}>, isError?: boolean }>}
   */
  async callTool(toolName, params = {}, opts = {}) {
    if (!this._connected) {
      throw new Error(`MCP "${this.name}": not connected. Call connect() first.`);
    }

    const result = await this._request(
      'tools/call',
      { name: toolName, arguments: params },
      { timeoutMs: opts.timeoutMs || 30000 }
    );

    return result;
  }

  invalidateCache() {
    this._tools = null;
  }

  // ── JSON-RPC Transport ────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and return the result.
   * Works for both stdio and sse transports.
   */
  async _request(method, params, opts = {}) {
    const id = this._requestId++;
    const message = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params: params || {},
    };

    if (this.transport === 'stdio') {
      return this._requestStdio(id, message, opts);
    } else {
      return this._requestHttp(message, opts);
    }
  }

  _requestStdio(id, message, opts = {}) {
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs || 30000;
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP "${this.name}": request "${message.method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer });

      try {
        this._proc.stdin.write(JSON.stringify(message) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(new Error(`MCP "${this.name}": failed to write to stdin: ${err.message}`));
      }
    });
  }

  async _requestHttp(message, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30000;
    const url = new URL(this.config.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const body = JSON.stringify(message);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };

    // Include auth header if configured
    if (this.config.auth_token) {
      headers['Authorization'] = `Bearer ${this.config.auth_token}`;
    }

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(`MCP "${this.name}" RPC error: ${parsed.error.message}`));
            } else {
              resolve(parsed.result);
            }
          } catch (_) {
            reject(new Error(`MCP "${this.name}": invalid JSON response from HTTP server`));
          }
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`MCP "${this.name}": HTTP request timed out`));
      });

      req.on('error', (err) => reject(new Error(`MCP "${this.name}": HTTP error: ${err.message}`)));
      req.write(body);
      req.end();
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  _notify(method, params) {
    const message = { jsonrpc: JSONRPC_VERSION, method, params };
    if (this.transport === 'stdio' && this._proc) {
      try { this._proc.stdin.write(JSON.stringify(message) + '\n'); } catch (_) {}
    }
    // SSE transport: notifications are fire-and-forget HTTP POST with no id
    else if (this.transport === 'sse') {
      this._requestHttp(message, {}).catch(() => {}); // suppress errors on notification
    }
  }

  /** Handle an incoming JSON-RPC message from the server. */
  _handleMessage(msg) {
    if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this._pendingRequests.get(msg.id);
      clearTimeout(timer);
      this._pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(`MCP "${this.name}" error [${msg.error.code}]: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      // Server notification — emit as event
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  _rejectAllPending(err) {
    for (const [id, { reject, timer }] of this._pendingRequests.entries()) {
      clearTimeout(timer);
      reject(err);
      this._pendingRequests.delete(id);
    }
  }

  /**
   * Health check — returns true if the server responds to tools/list.
   */
  async healthCheck() {
    try {
      await this.listTools();
      return true;
    } catch (_) {
      return false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip production credentials from child process env unless they were
 * explicitly included in the server's env config.
 * Prevents agent-spawned MCP processes from accessing production DB/Redis.
 */
function _stripCredentials(mergedEnv, explicitEnv = {}) {
  const BLOCKED = [
    'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'JWT_SECRET',
    'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'POLSIA_API_KEY', 'POLSIA_API_TOKEN', 'POLSIA_R2_BASE_URL',
    'GITHUB_CLIENT_SECRET', 'BROWSERBASE_API_KEY',
    'OPENAI_API_KEY', 'POSTMARK_SERVER_TOKEN',
  ];

  const safe = { ...mergedEnv };
  for (const key of BLOCKED) {
    // Only block if not explicitly passed in the server's env config
    if (!Object.prototype.hasOwnProperty.call(explicitEnv, key)) {
      delete safe[key];
    }
  }
  return safe;
}

module.exports = { McpClient };
