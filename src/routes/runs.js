/**
 * Runs Routes
 *
 * Owns: lightweight per-run read endpoints not covered by /api/pipeline/:id.
 * Not owned: pipeline execution, state machine transitions, event bus, auth setup.
 *
 * Endpoints:
 *   GET /api/runs/:id/reasoning — phase reasoning timeline (poll every 3s from client)
 */

'use strict';

const express = require('express');
const { getPhaseReasoning } = require('../lib/phase-reasoning');

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {object}            opts.auth  — auth module (requireAuth)
 * @param {object}            opts.pipeline — PipelineExecutor instance for ownership checks
 */
function createRunsRouter({ pool, auth, pipeline }) {
  const router = express.Router();

  // GET /api/runs/:id/reasoning
  // Returns the phase reasoning timeline for a run.
  // Polled every 3s by ReasoningCard while the run is active.
  // Returns [] for unknown runs or if no reasoning has been captured yet.
  router.get('/:id/reasoning', auth.requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
        return res.status(400).json({ success: false, message: 'Invalid run ID' });
      }

      // Ownership check: user must own the run (or be anonymous with API auth)
      const userId = req.user?.userId || null;
      const run = await pipeline.getRun(id, userId);
      if (!run) {
        return res.status(404).json({ success: false, message: 'Run not found' });
      }

      const timeline = await getPhaseReasoning(pool, id);
      res.json({ success: true, runId: id, timeline });
    } catch (err) {
      console.error('[RunsRouter] Error fetching reasoning:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch reasoning' });
    }
  });

  return router;
}

module.exports = { createRunsRouter };
