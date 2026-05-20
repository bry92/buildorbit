/**
 * Pipeline MCP Bridge — Helpers for pipeline phases to access MCP tools.
 *
 * Owns: utility functions that phases (plan, code, verify) use to call MCP tools.
 *       The bridge reads _mcpContext from previousOutputs (injected by the orchestrator)
 *       and provides a clean async interface.
 * Does NOT own: registry, audit, tool implementations, pipeline state.
 *
 * Usage in a phase agent:
 *   const { callMcpTool, listMcpTools } = require('../mcp/pipeline-mcp-bridge');
 *
 *   // In execute({ runId, stage, previousOutputs, ... }):
 *   const schema = await callMcpTool(previousOutputs, 'postgres.list_tables', {});
 *   // schema is null if no MCP context, or the text result if MCP is available
 *
 * Design intent:
 *   - All functions are fail-open — if no MCP context is injected, they return null.
 *   - Never throws unless the caller explicitly requests strict mode.
 *   - Results are plain strings (the text content of the first MCP result block).
 */

'use strict';

/**
 * Call a single MCP tool from within a pipeline phase.
 * Returns the text result or null if MCP is unavailable.
 *
 * @param {object} previousOutputs — the `previousOutputs` object passed to agent.execute()
 * @param {string} toolName — "postgres.query", "git.log", "filesystem.read_file", etc.
 * @param {object} params — tool parameters
 * @param {object} [opts]
 * @param {string} [opts.userId] — user ID for registry scoping (defaults to 'system')
 * @returns {Promise<string|null>}
 */
async function callMcpTool(previousOutputs, toolName, params = {}, opts = {}) {
  const mcpCtx = previousOutputs && previousOutputs._mcpContext;
  if (!mcpCtx || !mcpCtx.registry) return null;

  const { registry, audit, runId } = mcpCtx;
  const userId = opts.userId || 'system';
  const phase = opts.phase || 'pipeline';

  try {
    let result;
    if (audit) {
      result = await audit.call(registry, userId, runId, phase, toolName, params);
    } else {
      result = await registry.callTool(userId, toolName, params);
    }

    if (!result) return null;
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content.find(c => c.type === 'text');
    return first ? first.text : null;
  } catch (err) {
    // Fail-open: MCP unavailability must never block the pipeline
    console.warn(`[PipelineMcpBridge] callMcpTool("${toolName}") failed (non-fatal):`, err.message);
    return null;
  }
}

/**
 * List all available MCP tools from within a pipeline phase.
 * Returns empty array if MCP is unavailable.
 *
 * @param {object} previousOutputs
 * @param {object} [opts]
 * @param {string} [opts.userId]
 * @returns {Promise<Array<{ server, name, description }>>}
 */
async function listMcpTools(previousOutputs, opts = {}) {
  const mcpCtx = previousOutputs && previousOutputs._mcpContext;
  if (!mcpCtx || !mcpCtx.registry) return [];

  const { registry } = mcpCtx;
  const userId = opts.userId || 'system';

  try {
    return await registry.listAllTools(userId);
  } catch (err) {
    console.warn('[PipelineMcpBridge] listMcpTools failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Check if MCP is available in the current phase context.
 * Use this to gate MCP-enhanced behavior without try/catch at the call site.
 *
 * @param {object} previousOutputs
 * @returns {boolean}
 */
function isMcpAvailable(previousOutputs) {
  const mcpCtx = previousOutputs && previousOutputs._mcpContext;
  return !!(mcpCtx && mcpCtx.registry);
}

module.exports = { callMcpTool, listMcpTools, isMcpAvailable };
