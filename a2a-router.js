/**
 * A2A (Agent-to-Agent) Router
 *
 * Placeholder implementation — provides the createA2ARouter export so server.js
 * can load without crashing while the full A2A feature is in development.
 * Replace this stub with the real implementation when ready.
 */

'use strict';

const express = require('express');

/**
 * Creates and returns the A2A Express router.
 *
 * @param {{ pool, pipeline, orchestrator, stateMachine, auth }} deps
 * @returns {import('express').Router}
 */
function createA2ARouter({ pool, pipeline, orchestrator, stateMachine, auth } = {}) {
  const router = express.Router();

  // Health / capability probe
  router.get('/health', (req, res) => {
    res.json({ success: true, status: 'a2a_stub', message: 'A2A router placeholder — full implementation pending' });
  });

  // Catch-all: return 501 for any unimplemented A2A endpoint
  router.use((req, res) => {
    res.status(501).json({ success: false, message: 'A2A endpoint not yet implemented' });
  });

  return router;
}

module.exports = { createA2ARouter };
