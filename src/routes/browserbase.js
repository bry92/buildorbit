/**
 * Browserbase Routes
 *
 * Owns: Cloud browser session API and screenshot retrieval endpoints.
 * Does NOT own: pipeline execution, preview HTML generation, deployments.
 *
 * Endpoints:
 *   GET /api/runs/:runId/screenshot  — Returns the PNG screenshot taken during VERIFY phase
 *   POST /api/browserbase/screenshot — Manual on-demand screenshot of an arbitrary URL (admin)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const browserbase = require('../services/browserbase');

// Preview files are stored at src/phases/preview/{runId}/
const PREVIEW_BASE = path.join(__dirname, '..', 'phases', 'preview');

function createBrowserbaseRouter(authMiddleware) {
  const router = Router();

  /**
   * GET /api/runs/:runId/screenshot
   * Returns the Browserbase PNG screenshot captured during VERIFY.
   * Returns 404 if no screenshot exists (Browserbase not configured, or
   * VERIFY hasn't completed yet).
   */
  router.get('/runs/:runId/screenshot', authMiddleware, (req, res) => {
    const { runId } = req.params;

    // Basic UUID validation to prevent path traversal
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ error: 'Invalid run ID format' });
    }

    const screenshotPath = path.join(PREVIEW_BASE, runId, 'screenshot.png');

    if (!fs.existsSync(screenshotPath)) {
      return res.status(404).json({
        error: 'Screenshot not found',
        hint: browserbase.isAvailable()
          ? 'VERIFY phase may not have completed yet'
          : 'BROWSERBASE_API_KEY is not configured'
      });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(screenshotPath);
  });

  /**
   * GET /api/browserbase/status
   * Returns whether Browserbase is configured in this environment.
   * Safe to expose to authenticated users — no credentials leak.
   */
  router.get('/browserbase/status', authMiddleware, (req, res) => {
    res.json({
      available: browserbase.isAvailable(),
      configured: Boolean(process.env.BROWSERBASE_API_KEY),
      projectId: Boolean(process.env.BROWSERBASE_PROJECT_ID),
    });
  });

  return router;
}

module.exports = { createBrowserbaseRouter };
