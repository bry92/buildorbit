/**
 * MCP Registry — Manages MCP server configurations and active connections.
 *
 * Owns: mcp_connections table CRUD, per-user server lifecycle (connect/disconnect),
 *       tool routing (find which server owns a given tool name), built-in server catalog.
 * Does NOT own: tool invocation audit (mcp-audit), JSON-RPC transport (mcp-client).
 *
 * Per-user connection pool: MCP clients are kept alive across requests (expensive to
 * reconnect stdio processes). Keyed by `${userId}:${connectionId}`.
 */

'use strict';

const crypto = require('crypto');
const { McpClient } = require('./mcp-client');
const { createPostgresServer } = require('./built-ins/postgres');
const { createGitServer } = require('./built-ins/git');
const { createFilesystemServer } = require('./built-ins/filesystem');
const { createSerenaServer } = require('./built-ins/serena');

// Built-in server catalog — these are always available without DB config.
// Keyed by name, value is a factory function that returns McpClient config.
const BUILTIN_SERVERS = {
  postgres: createPostgresServer,
  git: createGitServer,
  filesystem: createFilesystemServer,
  serena: createSerenaServer,
};

class McpRegistry {
  /**
   * @param {{ pool: import('pg').Pool }} deps
   */
  constructor({ pool }) {
    this.pool = pool;
    // Active client pool: `${userId}:${connectionId}` → McpClient
    this._clients = new Map();
  }

  // ── Connection CRUD ───────────────────────────────────────────────────────

  /**
   * Register a new MCP server connection for a user.
   * @param {string} userId
   * @param {{ name: string, transport: 'stdio'|'sse', config: object }} opts
   * @returns {Promise<{ id: string, name: string, transport: string, enabled: boolean }>}
   */
  async registerConnection(userId, { name, transport, config }) {
    if (!name || !transport || !config) {
      throw new Error('name, transport, and config are required');
    }
    if (!['stdio', 'sse'].includes(transport)) {
      throw new Error('transport must be "stdio" or "sse"');
    }

    const id = `mcp_${crypto.randomBytes(12).toString('hex')}`;
    const { rows } = await this.pool.query(
      `INSERT INTO mcp_connections (id, user_id, name, transport, config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, transport, enabled, created_at`,
      [id, userId, name, transport, JSON.stringify(config)]
    );
    return rows[0];
  }

  /**
   * List registered connections for a user (does not include built-ins).
   */
  async listConnections(userId) {
    const { rows } = await this.pool.query(
      `SELECT id, name, transport, enabled, created_at, updated_at
       FROM mcp_connections
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  }

  /**
   * Delete a registered connection and disconnect it if active.
   */
  async deleteConnection(userId, connectionId) {
    const key = `${userId}:${connectionId}`;
    if (this._clients.has(key)) {
      try { this._clients.get(key).disconnect(); } catch (_) {}
      this._clients.delete(key);
    }

    const { rowCount } = await this.pool.query(
      `DELETE FROM mcp_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, userId]
    );
    return rowCount > 0;
  }

  /**
   * Enable or disable a registered connection.
   */
  async setEnabled(userId, connectionId, enabled) {
    await this.pool.query(
      `UPDATE mcp_connections SET enabled = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3`,
      [enabled, connectionId, userId]
    );
    // Disconnect active client when disabling
    if (!enabled) {
      const key = `${userId}:${connectionId}`;
      if (this._clients.has(key)) {
        try { this._clients.get(key).disconnect(); } catch (_) {}
        this._clients.delete(key);
      }
    }
  }

  // ── Tool Discovery ────────────────────────────────────────────────────────

  /**
   * List all tools available to a user across all enabled connections + built-ins.
   * Each entry includes the server name so callers can route back.
   *
   * @param {string} userId
   * @param {{ builtins?: string[] }} [opts] — which built-in servers to include
   * @returns {Promise<Array<{ server: string, connectionId: string, name, description, inputSchema }>>}
   */
  async listAllTools(userId, opts = {}) {
    const allTools = [];

    // Built-ins first (always available, no DB lookup needed)
    const builtinsToInclude = opts.builtins || Object.keys(BUILTIN_SERVERS);
    for (const builtinName of builtinsToInclude) {
      try {
        const client = await this._getBuiltinClient(builtinName);
        const tools = await client.listTools();
        for (const tool of tools) {
          allTools.push({ server: builtinName, connectionId: `builtin:${builtinName}`, ...tool });
        }
      } catch (_) {
        // Built-in not available — skip silently
      }
    }

    // User-registered connections
    const connections = await this.listConnections(userId);
    for (const conn of connections) {
      if (!conn.enabled) continue;
      try {
        const client = await this._getOrConnectClient(userId, conn);
        const tools = await client.listTools();
        for (const tool of tools) {
          allTools.push({ server: conn.name, connectionId: conn.id, ...tool });
        }
      } catch (_) {
        // Connection unavailable — skip
      }
    }

    return allTools;
  }

  // ── Tool Invocation ───────────────────────────────────────────────────────

  /**
   * Call a tool by name, routing to the correct server.
   * Searches built-ins first, then user connections.
   *
   * @param {string} userId
   * @param {string} toolName — may include server prefix: "postgres.query" or just "query"
   * @param {object} params
   * @param {{ connectionId?: string, timeoutMs?: number }} [opts]
   * @returns {Promise<{ content: Array<{type,text}>, isError?: boolean, server: string }>}
   */
  async callTool(userId, toolName, params = {}, opts = {}) {
    // Resolve server prefix if present (e.g., "postgres.query" → server=postgres, tool=query)
    let serverHint = null;
    let resolvedTool = toolName;
    if (toolName.includes('.')) {
      const [prefix, ...rest] = toolName.split('.');
      serverHint = prefix;
      resolvedTool = rest.join('.');
    }

    // If a specific connectionId was given, route directly
    if (opts.connectionId) {
      if (opts.connectionId.startsWith('builtin:')) {
        const builtinName = opts.connectionId.slice(8);
        const client = await this._getBuiltinClient(builtinName);
        const result = await client.callTool(resolvedTool, params, opts);
        return { ...result, server: builtinName };
      }

      const { rows } = await this.pool.query(
        `SELECT * FROM mcp_connections WHERE id = $1 AND user_id = $2 AND enabled = true`,
        [opts.connectionId, userId]
      );
      if (rows.length === 0) throw new Error(`MCP connection "${opts.connectionId}" not found or disabled`);
      const client = await this._getOrConnectClient(userId, rows[0]);
      const result = await client.callTool(resolvedTool, params, opts);
      return { ...result, server: rows[0].name };
    }

    // Try built-ins first (or the hinted built-in)
    const builtinsToCheck = serverHint
      ? (BUILTIN_SERVERS[serverHint] ? [serverHint] : [])
      : Object.keys(BUILTIN_SERVERS);

    for (const builtinName of builtinsToCheck) {
      try {
        const client = await this._getBuiltinClient(builtinName);
        const tools = await client.listTools();
        if (tools.some(t => t.name === resolvedTool)) {
          const result = await client.callTool(resolvedTool, params, opts);
          return { ...result, server: builtinName };
        }
      } catch (_) {}
    }

    // Search user connections
    const connections = await this.listConnections(userId);
    for (const conn of connections) {
      if (!conn.enabled) continue;
      if (serverHint && conn.name !== serverHint) continue;
      try {
        const client = await this._getOrConnectClient(userId, conn);
        const tools = await client.listTools();
        if (tools.some(t => t.name === resolvedTool)) {
          const result = await client.callTool(resolvedTool, params, opts);
          return { ...result, server: conn.name };
        }
      } catch (_) {}
    }

    throw new Error(`MCP tool "${toolName}" not found in any connected server`);
  }

  // ── Client Pool ───────────────────────────────────────────────────────────

  async _getOrConnectClient(userId, connRow) {
    const key = `${userId}:${connRow.id}`;
    if (this._clients.has(key)) {
      const existing = this._clients.get(key);
      if (existing.connected) return existing;
      // Stale connection — remove and reconnect
      this._clients.delete(key);
    }

    const config = typeof connRow.config === 'string'
      ? JSON.parse(connRow.config)
      : (connRow.config || {});

    const client = new McpClient({
      name: connRow.name,
      transport: connRow.transport,
      ...config,
    });

    await client.connect();
    this._clients.set(key, client);
    return client;
  }

  // Built-in clients keyed by name (shared, not per-user)
  _builtinClients = new Map();

  async _getBuiltinClient(name) {
    if (!BUILTIN_SERVERS[name]) throw new Error(`Unknown built-in MCP server: ${name}`);

    if (this._builtinClients.has(name)) {
      const existing = this._builtinClients.get(name);
      if (existing.connected) return existing;
      this._builtinClients.delete(name);
    }

    const factory = BUILTIN_SERVERS[name];
    const client = factory();
    await client.connect();
    this._builtinClients.set(name, client);
    return client;
  }

  /**
   * Disconnect all active clients. Call on server shutdown.
   */
  disconnectAll() {
    for (const client of this._clients.values()) {
      try { client.disconnect(); } catch (_) {}
    }
    this._clients.clear();

    for (const client of this._builtinClients.values()) {
      try { client.disconnect(); } catch (_) {}
    }
    this._builtinClients.clear();
  }
}

module.exports = { McpRegistry };
