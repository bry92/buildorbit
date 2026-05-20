/**
 * InProcessMcpClient — MCP client backed by in-process logic.
 *
 * Owns: fulfilling the McpClient interface for built-in servers that run
 *       their tool logic in-process rather than as child processes or HTTP endpoints.
 * Does NOT own: JSON-RPC transport, DB connections, auth.
 *
 * This avoids spawning child processes for built-in tools while preserving
 * the same interface that McpRegistry and McpAudit expect from all clients.
 */

'use strict';

const { EventEmitter } = require('events');

class InProcessMcpClient extends EventEmitter {
  /**
   * @param {{ name: string, tools: Array<{name,description,inputSchema}>, callTool: Function }} opts
   *   tools     — static tool manifest
   *   callTool  — async (toolName, params) → { content, isError? }
   */
  constructor({ name, tools, callTool }) {
    super();
    this.name = name;
    this._toolManifest = tools;
    this._callToolFn = callTool;
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  async connect() {
    this._connected = true;
  }

  disconnect() {
    this._connected = false;
  }

  async listTools() {
    return this._toolManifest;
  }

  async callTool(toolName, params = {}, _opts = {}) {
    if (!this._connected) {
      throw new Error(`InProcessMcpClient "${this.name}": not connected`);
    }
    return await this._callToolFn(toolName, params);
  }

  invalidateCache() {
    // No cache to invalidate for in-process tools
  }

  async healthCheck() {
    return this._connected;
  }
}

module.exports = { InProcessMcpClient };
