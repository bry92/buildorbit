/**
 * MCP Management Routes — /api/mcp
 *
 * Owns: HTTP surface for user MCP connection management (register, list, delete,
 *       enable/disable) and ad-hoc tool invocation via the registry + audit layer.
 * Does NOT own: tool implementations, pipeline execution, auth.
 *
 * Endpoints:
 *   GET    /api/mcp/connections         — List user's registered MCP connections
 *   POST   /api/mcp/connections         — Register a new MCP connection
 *   DELETE /api/mcp/connections/:id     — Remove a connection
 *   PATCH  /api/mcp/connections/:id     — Enable/disable a connection
 *   GET    /api/mcp/tools               — List all available tools (built-ins + registered)
 *   POST   /api/mcp/call                — Invoke a tool ad-hoc (audited)
 *   GET    /api/mcp/audit/:runId        — Get MCP audit log for a specific run
 *
 * Auth: requires session cookie. All operations are scoped to req.user.userId.
 */

'use strict';

const express = require('express');

/**
 * Creates and returns the MCP Express router.
 *
 * @param {{ mcpRegistry, mcpAudit, auth }} deps
 * @returns {import('express').Router}
 */
function createMcpRouter({ mcpRegistry, mcpAudit, auth }) {
  const router = express.Router();

  // ── Auth middleware ───────────────────────────────────────────────────────

  function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[auth.COOKIE_NAME || 'bo_session'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const payload = auth.verifySession && auth.verifySession(token);
    if (!payload) return res.status(401).json({ error: 'Invalid session' });

    req.user = payload;
    next();
  }

  // ── GET /api/mcp/connections ──────────────────────────────────────────────

  router.get('/connections', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const connections = await mcpRegistry.listConnections(userId);
      res.json({ connections });
    } catch (err) {
      console.error('[MCP Route] listConnections error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/mcp/connections ─────────────────────────────────────────────

  router.post('/connections', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const { name, transport, config } = req.body;

      if (!name || !transport || !config) {
        return res.status(400).json({ error: 'name, transport, and config are required' });
      }

      const connection = await mcpRegistry.registerConnection(userId, { name, transport, config });
      res.status(201).json({ connection });
    } catch (err) {
      console.error('[MCP Route] registerConnection error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ── DELETE /api/mcp/connections/:id ──────────────────────────────────────

  router.delete('/connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const deleted = await mcpRegistry.deleteConnection(userId, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Connection not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('[MCP Route] deleteConnection error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PATCH /api/mcp/connections/:id ───────────────────────────────────────

  router.patch('/connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled (boolean) is required' });
      }

      await mcpRegistry.setEnabled(userId, req.params.id, enabled);
      res.json({ success: true, enabled });
    } catch (err) {
      console.error('[MCP Route] setEnabled error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/mcp/tools ────────────────────────────────────────────────────

  router.get('/tools', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const tools = await mcpRegistry.listAllTools(userId);
      res.json({ tools });
    } catch (err) {
      console.error('[MCP Route] listAllTools error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/mcp/call ────────────────────────────────────────────────────

  router.post('/call', requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.userId || req.user.id);
      const { tool, params = {}, run_id: runId = null, phase = 'api' } = req.body;

      if (!tool || typeof tool !== 'string') {
        return res.status(400).json({ error: 'tool (string) is required' });
      }

      let result;
      if (mcpAudit && runId) {
        result = await mcpAudit.call(mcpRegistry, userId, runId, phase, tool, params);
      } else {
        result = await mcpRegistry.callTool(userId, tool, params);
      }

      res.json({ result });
    } catch (err) {
      console.error('[MCP Route] callTool error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/mcp/audit/:runId ─────────────────────────────────────────────

  router.get('/audit/:runId', requireAuth, async (req, res) => {
    try {
      const history = await mcpAudit.getAuditHistory(req.params.runId);
      res.json({ history });
    } catch (err) {
      console.error('[MCP Route] getAuditHistory error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createMcpRouter };
