/**
 * MCP Audit Layer — Records every MCP tool call in the pipeline audit trail.
 *
 * Owns: writing mcp_tool_call events to pipeline_events, formatting audit records.
 * Does NOT own: tool invocation (registry), pipeline events schema, auth.
 *
 * Every MCP call that goes through this layer produces a pipeline_events row
 * with event_type='mcp_tool_call'. These appear in the phase card expansion UI
 * (PhaseDetail.tsx renders them as part of the phase's event log).
 *
 * Usage:
 *   const auditor = new McpAudit({ pool });
 *   const result = await auditor.call(registry, userId, runId, phase, toolName, params);
 */

'use strict';

const crypto = require('crypto');

class McpAudit {
  /**
   * @param {{ pool: import('pg').Pool }} deps
   */
  constructor({ pool }) {
    this.pool = pool;
  }

  /**
   * Call an MCP tool and record the interaction in pipeline_events.
   *
   * @param {import('./mcp-registry').McpRegistry} registry
   * @param {string} userId
   * @param {string|null} runId — the active pipeline run (null for ad-hoc calls)
   * @param {string|null} phase — the pipeline phase (intent_gate/plan/code/verify/etc)
   * @param {string} toolName
   * @param {object} params
   * @param {{ connectionId?: string, timeoutMs?: number }} [opts]
   * @returns {Promise<{ content, isError?, server, auditId }>}
   */
  async call(registry, userId, runId, phase, toolName, params = {}, opts = {}) {
    const auditId = `mca_${crypto.randomBytes(8).toString('hex')}`;
    const startedAt = Date.now();

    let result = null;
    let error = null;

    try {
      result = await registry.callTool(userId, toolName, params, opts);
    } catch (err) {
      error = err.message || String(err);
    }

    const durationMs = Date.now() - startedAt;
    const success = !error && !(result && result.isError);

    // Write audit entry to pipeline_events — fire and don't block the caller
    this._writeAuditEvent({
      auditId,
      runId,
      phase,
      userId,
      toolName,
      params,
      result,
      error,
      durationMs,
      success,
    }).catch((writeErr) => {
      // Audit write failure is non-fatal — log but never surface to caller
      console.error(`[McpAudit] Failed to write audit event for ${toolName}:`, writeErr.message);
    });

    if (error) throw new Error(error);
    return { ...result, auditId };
  }

  /**
   * Write the mcp_tool_call event to pipeline_events.
   * The payload matches what PhaseDetail.tsx expects for rendering.
   */
  async _writeAuditEvent({ auditId, runId, phase, userId, toolName, params, result, error, durationMs, success }) {
    if (!runId) return; // No active run — skip DB write (ad-hoc calls)

    const payload = {
      audit_id: auditId,
      tool: toolName,
      params: _sanitizeParams(params),
      result_preview: _previewResult(result),
      duration_ms: durationMs,
      success,
      error: error || null,
    };

    try {
      await this.pool.query(
        `INSERT INTO pipeline_events (run_id, stage, event_type, status, payload, created_at)
         VALUES ($1, $2, 'mcp_tool_call', $3, $4, CURRENT_TIMESTAMP)`,
        [
          runId,
          phase || 'unknown',
          success ? 'completed' : 'failed',
          JSON.stringify(payload),
        ]
      );
    } catch (dbErr) {
      // Non-fatal — surface as error log only
      throw dbErr;
    }
  }

  /**
   * Query audit history for a specific run.
   * @param {string} runId
   * @returns {Promise<Array>}
   */
  async getAuditHistory(runId) {
    const { rows } = await this.pool.query(
      `SELECT id, stage, status, payload, created_at
       FROM pipeline_events
       WHERE run_id = $1 AND event_type = 'mcp_tool_call'
       ORDER BY created_at ASC`,
      [runId]
    );
    return rows.map(row => ({
      id: row.id,
      phase: row.stage,
      status: row.status,
      createdAt: row.created_at,
      ...(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload),
    }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove sensitive param values from audit logs.
 * Params with keys containing 'password', 'secret', 'token', 'key' are redacted.
 */
function _sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params;
  const SENSITIVE = /password|secret|token|key|auth|credential/i;
  const safe = {};
  for (const [k, v] of Object.entries(params)) {
    safe[k] = SENSITIVE.test(k) ? '[REDACTED]' : v;
  }
  return safe;
}

/**
 * Extract a human-readable preview from MCP tool result.
 * Keeps the audit payload compact — full result is not stored.
 */
function _previewResult(result) {
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0) return null;

  // Return first text block, truncated to 500 chars
  const first = content.find(c => c.type === 'text');
  if (first) return (first.text || '').slice(0, 500);

  // Non-text content — just show the types
  return content.map(c => c.type).join(', ');
}

module.exports = { McpAudit };
