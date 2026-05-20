/**
 * Trace Store
 *
 * Persists per-stage decision traces for every pipeline run.
 * All writes are non-fatal — if a trace insert fails, the run continues.
 *
 * Data captured per stage:
 *   - Agent name (PlannerAgent, BuilderAgent, OpsAgent, QAAgent)
 *   - Prompt sent to the agent
 *   - Reasoning / streamed chunks captured during execution
 *   - Action taken (stage name)
 *   - Validated output payload (structured JSON)
 *   - Latency in milliseconds
 *   - Token cost { model, inputTokens, outputTokens, costUsd }
 *
 * Diffs:
 *   - Computed on-the-fly from stored output payloads
 *   - Represents what each stage added/changed from the previous state
 */

const AGENT_FOR_STAGE = {
  intent_gate: 'IntentGate',
  plan:        'PlannerAgent',
  scaffold:    'BuilderAgent',
  code:        'BuilderAgent',
  save:        'OpsAgent',
  verify:      'QAAgent',
};

const AGENT_COLOR = {
  IntentGate:   '#ec4899',  // pink
  PlannerAgent: '#6366f1',  // blue/indigo
  BuilderAgent: '#22c55e',  // green
  QAAgent:      '#f59e0b',  // orange/amber
  OpsAgent:     '#a855f7',  // purple
};

const STAGE_ORDER = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];

class TraceStore {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Add a trace entry for a single stage execution.
   * Non-fatal: logs warning on failure and returns null.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {object} data
   * @param {string}  data.agentName
   * @param {string}  [data.promptSent]
   * @param {string}  [data.reasoning]     - Streamed output chunks joined
   * @param {string}  [data.actionTaken]
   * @param {object}  [data.outputPayload] - Validated stage output
   * @param {number}  [data.latencyMs]
   * @param {object}  [data.tokenCost]     - { model, inputTokens, outputTokens, costUsd }
   * @returns {Promise<number|null>} Inserted trace id, or null on failure
   */
  async addTrace(runId, stage, data) {
    try {
      const {
        agentName   = AGENT_FOR_STAGE[stage] || 'Unknown',
        promptSent  = null,
        reasoning   = null,
        actionTaken = stage,
        outputPayload = null,
        latencyMs   = null,
        tokenCost   = null,
      } = data;

      // Generate a concise output summary
      const outputSummary = this._summarizeOutput(stage, outputPayload);

      const { rows } = await this.pool.query(
        `INSERT INTO pipeline_traces
          (run_id, stage, agent_name, step_type, prompt_sent, reasoning, action_taken,
           output_summary, output_payload, latency_ms, token_cost)
         VALUES ($1, $2, $3, 'stage_execution', $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          runId,
          stage,
          agentName,
          promptSent,
          reasoning ? reasoning.slice(0, 50000) : null, // cap at 50k chars
          actionTaken,
          outputSummary,
          outputPayload ? JSON.stringify(outputPayload) : null,
          latencyMs,
          tokenCost ? JSON.stringify(tokenCost) : null,
        ]
      );

      return rows[0]?.id || null;
    } catch (err) {
      console.warn(`[TraceStore] Failed to write trace for ${stage} (non-fatal):`, err.message);
      return null;
    }
  }

  /**
   * Get the full decision trace for a run (all stages, chronological).
   *
   * @param {string} runId
   * @returns {Promise<object>} { runId, steps: TraceStep[], agentColors }
   */
  async getTrace(runId) {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, stage, agent_name, step_type, prompt_sent, reasoning,
                action_taken, output_summary, output_payload, latency_ms, token_cost, created_at
         FROM pipeline_traces
         WHERE run_id = $1
         ORDER BY id ASC`,
        [runId]
      );

      const steps = rows.map(row => this._formatStep(row));
      const totalCostUsd = steps.reduce((sum, s) => sum + (s.tokenCost?.costUsd || 0), 0);

      return {
        runId,
        stageCount: steps.length,
        totalLatencyMs: steps.reduce((sum, s) => sum + (s.latencyMs || 0), 0),
        totalCostUsd,
        agentColors: AGENT_COLOR,
        steps,
      };
    } catch (err) {
      console.error('[TraceStore] Error fetching trace:', err.message);
      return { runId, steps: [], agentColors: AGENT_COLOR, error: err.message };
    }
  }

  /**
   * Get the trace for a specific stage.
   *
   * @param {string} runId
   * @param {string} stage
   * @returns {Promise<object>}
   */
  async getStageTrace(runId, stage) {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, stage, agent_name, step_type, prompt_sent, reasoning,
                action_taken, output_summary, output_payload, latency_ms, token_cost, created_at
         FROM pipeline_traces
         WHERE run_id = $1 AND stage = $2
         ORDER BY id ASC`,
        [runId, stage]
      );

      const steps = rows.map(row => this._formatStep(row));

      return {
        runId,
        stage,
        agentName: AGENT_FOR_STAGE[stage] || 'Unknown',
        agentColor: AGENT_COLOR[AGENT_FOR_STAGE[stage]] || '#888',
        steps,
      };
    } catch (err) {
      console.error('[TraceStore] Error fetching stage trace:', err.message);
      return { runId, stage, steps: [], error: err.message };
    }
  }

  /**
   * Compute before/after diffs for each stage.
   * Reads from the pipeline_traces output_payloads and compares chronologically.
   *
   * @param {string} runId
   * @returns {Promise<object[]>} Array of diff objects per stage
   */
  async getDiffs(runId) {
    try {
      const { rows } = await this.pool.query(
        `SELECT stage, output_payload, latency_ms, created_at
         FROM pipeline_traces
         WHERE run_id = $1
         ORDER BY id ASC`,
        [runId]
      );

      if (rows.length === 0) {
        // Fallback: build diffs from pipeline_events
        return await this._getDiffsFromEvents(runId);
      }

      const diffs = [];
      let previousPayload = null;

      for (const row of rows) {
        const current = row.output_payload
          ? (typeof row.output_payload === 'string' ? JSON.parse(row.output_payload) : row.output_payload)
          : null;

        const diff = this._computeDiff(row.stage, previousPayload, current);
        diffs.push({
          stage: row.stage,
          agentName: AGENT_FOR_STAGE[row.stage] || 'Unknown',
          agentColor: AGENT_COLOR[AGENT_FOR_STAGE[row.stage]] || '#888',
          latencyMs: row.latency_ms,
          createdAt: row.created_at,
          before: previousPayload,
          after: current,
          diff,
        });

        previousPayload = current;
      }

      return diffs;
    } catch (err) {
      console.error('[TraceStore] Error computing diffs:', err.message);
      return [];
    }
  }

  // ── Private helpers ──────────────────────────────────────

  _formatStep(row) {
    const outputPayload = row.output_payload
      ? (typeof row.output_payload === 'string' ? JSON.parse(row.output_payload) : row.output_payload)
      : null;

    const tokenCost = row.token_cost
      ? (typeof row.token_cost === 'string' ? JSON.parse(row.token_cost) : row.token_cost)
      : null;

    return {
      id: row.id,
      stage: row.stage,
      agentName: row.agent_name,
      agentColor: AGENT_COLOR[row.agent_name] || '#888',
      stepType: row.step_type,
      promptSent: row.prompt_sent,
      reasoning: row.reasoning,
      actionTaken: row.action_taken,
      outputSummary: row.output_summary,
      outputPayload,
      latencyMs: row.latency_ms,
      tokenCost,
      createdAt: row.created_at,
    };
  }

  _summarizeOutput(stage, payload) {
    if (!payload) return null;

    try {
      switch (stage) {
        case 'plan': {
          const count = payload.subtasks?.length || 0;
          const complexity = payload.estimatedComplexity || 'unknown';
          return `${count} subtasks, complexity: ${complexity}`;
        }
        case 'scaffold': {
          const files = (payload.tree || []).filter(t => t.type === 'file').length;
          const dirs = (payload.tree || []).filter(t => t.type === 'dir').length;
          const stack = (payload.techStack || []).join(', ');
          return `${dirs} dirs, ${files} files — ${stack}`;
        }
        case 'code': {
          const fileCount = Object.keys(payload.files || {}).length;
          const lines = payload.totalLines || 0;
          return `${fileCount} files, ${lines} lines — entry: ${payload.entryPoint || 'unknown'}`;
        }
        case 'save': {
          return `Persisted: ${payload.persisted ? 'yes' : 'no'} — version: ${payload.versionId || 'unknown'}`;
        }
        case 'verify': {
          const total = payload.checks?.length || 0;
          const passed = (payload.checks || []).filter(c => c.passed).length;
          const status = payload.passed ? 'PASSED' : 'FAILED';
          return `${status} — ${passed}/${total} checks passed`;
        }
        default:
          return JSON.stringify(payload).slice(0, 200);
      }
    } catch {
      return null;
    }
  }

  _computeDiff(stage, before, after) {
    if (!after) return { type: 'empty', changes: [] };

    const changes = [];

    try {
      switch (stage) {
        case 'plan': {
          const tasks = after.subtasks || [];
          changes.push({ type: 'added', label: 'Execution Plan', value: after.rawMarkdown });
          tasks.forEach(t => {
            changes.push({
              type: 'added',
              label: `Subtask #${t.id}: ${t.title}`,
              value: `${t.description} (${t.estimatedHours}h)`
            });
          });
          changes.push({ type: 'info', label: 'Complexity', value: after.estimatedComplexity });
          break;
        }
        case 'scaffold': {
          const files = (after.tree || []).filter(t => t.type === 'file');
          const dirs = (after.tree || []).filter(t => t.type === 'dir');
          dirs.forEach(d => changes.push({ type: 'added', label: 'Directory', value: d.path }));
          files.forEach(f => changes.push({ type: 'added', label: 'File', value: `${f.path} — ${f.description}` }));
          changes.push({ type: 'info', label: 'Tech Stack', value: (after.techStack || []).join(', ') });
          break;
        }
        case 'code': {
          Object.entries(after.files || {}).forEach(([filename, content]) => {
            const lineCount = typeof content === 'string' ? content.split('\n').length : 0;
            changes.push({ type: 'added', label: filename, value: `${lineCount} lines`, content });
          });
          break;
        }
        case 'save': {
          changes.push({ type: 'info', label: 'Version ID', value: after.versionId });
          changes.push({ type: 'info', label: 'Timestamp', value: after.timestamp });
          changes.push({ type: 'info', label: 'Persisted', value: after.persisted ? 'Yes' : 'No' });
          break;
        }
        case 'verify': {
          (after.checks || []).forEach(check => {
            changes.push({
              type: check.passed ? 'passed' : 'failed',
              label: check.name,
              value: check.passed ? '✓ Passed' : '✗ Failed'
            });
          });
          if ((after.errors || []).length > 0) {
            changes.push({ type: 'error', label: 'Errors', value: after.errors.join(', ') });
          }
          if ((after.warnings || []).length > 0) {
            changes.push({ type: 'warning', label: 'Warnings', value: after.warnings.join(', ') });
          }
          break;
        }
      }
    } catch {
      changes.push({ type: 'info', label: 'Output', value: JSON.stringify(after).slice(0, 500) });
    }

    return { type: 'structured', changes };
  }

  async _getDiffsFromEvents(runId) {
    try {
      const { rows } = await this.pool.query(
        `SELECT stage, payload, created_at
         FROM pipeline_events
         WHERE run_id = $1 AND status = 'completed' AND payload IS NOT NULL
         ORDER BY id ASC`,
        [runId]
      );

      const diffs = [];
      let prev = null;

      for (const row of rows) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const diff = this._computeDiff(row.stage, prev, payload);
        diffs.push({
          stage: row.stage,
          agentName: AGENT_FOR_STAGE[row.stage] || 'Unknown',
          agentColor: AGENT_COLOR[AGENT_FOR_STAGE[row.stage]] || '#888',
          createdAt: row.created_at,
          before: prev,
          after: payload,
          diff,
        });
        prev = payload;
      }

      return diffs;
    } catch (err) {
      console.error('[TraceStore] Error building diffs from events:', err.message);
      return [];
    }
  }
}

module.exports = { TraceStore, AGENT_FOR_STAGE, AGENT_COLOR, STAGE_ORDER };
