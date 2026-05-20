/**
 * Migration 035: MCP Connections
 *
 * Creates the mcp_connections table for the MCP connector framework.
 * Each row stores a user-scoped MCP server configuration — transport,
 * connection details, and enabled flag. The config JSONB stores
 * transport-specific fields (command + args for stdio, url for SSE).
 */

'use strict';

module.exports = {
  name: 'mcp_connections',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_connections (user_id)
    `);
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_mcp_user`);
    await client.query(`DROP TABLE IF EXISTS mcp_connections`);
  },
};
