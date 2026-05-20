/**
 * Orbit Route — POST /a2a/orbit/chat
 *
 * Owns: Orbit HTTP surface, per-user agent instance caching,
 *       SSE streaming for inline pipeline execution.
 * Does NOT own: auth, pipeline execution internals, conversation DB queries,
 *               embedding computation (OrbitMemory handles that).
 *
 * Response modes:
 *   - For build/modify actions: SSE stream (text/event-stream) that emits
 *     phase_start / phase_complete / complete / pipeline_error events
 *     while the pipeline executes inline, then ends with a final JSON message.
 *   - For all other actions (query, chat, explain): plain JSON response.
 *
 * Requires: req.pool, req.pipeline, req.orchestrator, req.stateMachine
 * Auth: optional for chat, required for pipeline actions — tries session cookie /
 *       Bearer API token, falls back to anonymous for non-build messages only.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { Orbit } = require('../agents/orbit-agent');
const { OrbitMemory } = require('../../services/orbit-memory');

// Shared OrbitMemory instance — holds no per-user state itself;
// all DB queries inside OrbitMemory are already filtered by user_id.
let _sharedMemory = null;

function getMemoryInstance(pool) {
  if (_sharedMemory) return _sharedMemory;
  try {
    const { OpenAI } = require('openai');
    if (!process.env.OPENAI_API_KEY) {
      return null; // semantic memory disabled without key
    }
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
    _sharedMemory = new OrbitMemory({ pool, openai });
    return _sharedMemory;
  } catch {
    return null;
  }
}

// Per-user Orbit instances (in-memory cache, scoped to process lifetime).
// Keyed by userId — reuses the same instance across requests so the pool stays bounded.
const agentCache = new Map();

function getOrCreateAgent(userId, { pool, pipeline, orchestrator, stateMachine, mcpRegistry, mcpAudit }) {
  const key = userId;
  if (!agentCache.has(key)) {
    const memory = getMemoryInstance(pool);
    agentCache.set(key, new Orbit({ pool, pipeline, orchestrator, stateMachine, mcpRegistry, mcpAudit, memory }));
  }
  return agentCache.get(key);
}

/**
 * Creates and returns the orbit chat Express router.
 *
 * @param {{ pool, pipeline, orchestrator, stateMachine, auth, mcpRegistry?, mcpAudit? }} deps
 * @returns {import('express').Router}
 */
function createOrbitRouter({ pool, pipeline, orchestrator, stateMachine, auth, mcpRegistry = null, mcpAudit = null }) {
  const router = express.Router();

  // Optional auth — attempts session cookie and Bearer token auth but never rejects.
  // Unauthenticated requests pass through with req.user unset (anonymous fallback).
  async function optionalAuth(req, res, next) {
    // 1. Try Bearer API token (bo_live_ / bo_mock_ prefix)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer bo_') && auth.validateApiToken) {
      try {
        const tokenData = await auth.validateApiToken(pool, authHeader.slice(7).trim());
        if (tokenData) {
          req.user = { userId: tokenData.userId, apiTokenId: tokenData.id };
          return next();
        }
      } catch (_) { /* fall through */ }
    }

    // 2. Try session cookie
    const token = req.cookies && req.cookies[auth.COOKIE_NAME || 'bo_session'];
    if (token && auth.verifySession) {
      const payload = auth.verifySession(token);
      if (payload) {
        req.user = payload;
        return next();
      }
    }

    // 3. No valid credentials — proceed as anonymous
    next();
  }

  /**
   * POST /a2a/orbit/chat
   *
   * Body:
   *   { message: string, conversationId?: string, context?: { runId, currentPhase, phases, logs } }
   *
   * For build/modify intents: streams SSE events then closes with a final `done` event.
   * For chat/query intents: returns JSON immediately.
   *
   * SSE events (build/modify only):
   *   run_start     — { runId, message }
   *   phase_start   — { phase, label, message }
   *   phase_complete — { phase, label, message }
   *   complete      — { runId, passed, checksTotal, checksPassed, message }
   *   pipeline_error — { phase, message, runId }
   *   done          — { type, message, runId?, conversationId } ← final JSON result
   *   error         — { message } ← fatal error
   *
   * JSON response (chat/query):
   *   { type, message, runId?, conversationId }
   */
  router.post('/chat', optionalAuth, async (req, res) => {
    try {
      const { message, conversationId, context: runContext } = req.body;

      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required and must be a non-empty string' });
      }

      // Generate a stable conversationId if caller omitted it
      const convId = conversationId || `orbit_${crypto.randomBytes(12).toString('hex')}`;
      const userId = req.user?.userId || req.user?.id || null;

      // Quick-scan the message to decide if we need SSE before calling agent.chat()
      // The agent will make the authoritative decision, but we need to set up
      // the response mode (SSE vs JSON) before we start.
      // We detect build/modify intent with a lightweight heuristic — the agent
      // will re-evaluate with full LLM reasoning internally.
      const looksLikePipelineAction = _looksLikePipelineAction(message);

      // ── Auth gate: pipeline actions require authentication ────────────
      // Anonymous users can chat but cannot trigger builds. This prevents
      // credit bypass via optionalAuth + _looksLikePipelineAction (POL-1536452).
      if (looksLikePipelineAction && !userId) {
        return res.status(401).json({
          error: 'Authentication required to build. Please sign in first.',
          code: 'auth_required_for_build',
          sign_in_url: '/signup',
        });
      }

      const effectiveUserId = String(userId || 'anonymous');
      const agent = getOrCreateAgent(effectiveUserId, { pool, pipeline, orchestrator, stateMachine, mcpRegistry, mcpAudit });

      if (looksLikePipelineAction && stateMachine) {
        // ── SSE streaming mode ────────────────────────────────────────────
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        let closed = false;
        req.on('close', () => { closed = true; });

        // SSE emitter helper — throws on write failure so callers can react.
        // Without throwing, silent SSE failures leave the client stuck on "Starting pipeline..."
        // while the orchestrator continues processing invisibly (POL-1585358).
        const emitEvent = (event, data) => {
          if (closed) return;
          const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          const ok = res.write(encoded);
          if (!ok) {
            throw new Error(`SSE write blocked for event "${event}" — client buffer full or disconnected`);
          }
        };

        try {
          const result = await agent.chat(effectiveUserId, convId, message.trim(), runContext || null, emitEvent);

          // Emit the final result as a `done` event so the frontend knows the
          // full response including conversationId and can persist it
          emitEvent('done', { ...result, conversationId: convId });
        } catch (err) {
          console.error('[Orbit Route] SSE error:', err.message);
          emitEvent('error', { message: err.message || 'Internal server error' });
        } finally {
          if (!closed) res.end();
        }
      } else {
        // ── Plain JSON mode ───────────────────────────────────────────────
        const response = await agent.chat(effectiveUserId, convId, message.trim(), runContext || null, null);
        res.json(response);
      }
    } catch (err) {
      console.error('[Orbit Route] Error:', err.message);
      if (res.headersSent) {
        // SSE mode: try to send an error event before giving up.
        // If the SSE stream is still open, this gives the client a chance to
        // display the error instead of hanging on "Starting pipeline..." forever.
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        } catch (_) { /* stream already dead — nothing to do */ }
        if (!res.writableEnded) res.end();
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  return router;
}

/**
 * Lightweight heuristic: does this message look like a build/modify request?
 * Used only to decide SSE vs JSON response mode before the full LLM routing.
 * The agent's LLM decision is authoritative — this just sets response headers.
 *
 * @param {string} message
 * @returns {boolean}
 */
function _looksLikePipelineAction(message) {
  const text = message.toLowerCase();
  return /\b(build|create|make|new app|generate|add|fix|change|update|modify|improve|refactor|remove|implement|add feature|rewrite)\b/.test(text);
}

module.exports = { createOrbitRouter };
