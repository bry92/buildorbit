/**
 * Cost Tracker
 *
 * Per-run economics layer for BuildOrbit pipelines.
 *
 * Tracks OpenAI token usage per agent per stage, converts to USD costs,
 * enforces budget caps, and persists cost data to the DB.
 *
 * GPT-4o-mini pricing (as of 2025):
 *   Input:  $0.150 / 1M tokens  ($0.00000015 per token)
 *   Output: $0.600 / 1M tokens  ($0.00000060 per token)
 *
 * Budget semantics:
 *   - budgetWarning: soft threshold — emits a warning event, pipeline continues
 *   - budgetCap:     hard limit    — pipeline stops after current stage
 *
 * Non-fatal design: all methods catch and log errors internally.
 * A cost-tracking failure never breaks pipeline execution.
 */

// GPT-4o-mini token pricing (USD per token)
const PRICING = {
  'gpt-4o-mini': {
    input:  0.150 / 1_000_000,   // $0.150 per 1M input tokens
    output: 0.600 / 1_000_000,   // $0.600 per 1M output tokens
  },
  // fallback for unknown models — use gpt-4o-mini rates
  default: {
    input:  0.150 / 1_000_000,
    output: 0.600 / 1_000_000,
  },
};

// Stage → agent name map (for display purposes)
const STAGE_AGENT_MAP = {
  plan:     'PlannerAgent',
  scaffold: 'BuilderAgent',
  code:     'BuilderAgent',
  save:     'OpsAgent',
  verify:   'QAAgent',
};

/**
 * Convert token counts to USD cost.
 *
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} Cost in USD
 */
function tokensToUsd(model, inputTokens, outputTokens) {
  const rates = PRICING[model] || PRICING.default;
  return (inputTokens * rates.input) + (outputTokens * rates.output);
}

class CostTracker {
  constructor() {
    // In-memory store: runId → RunCostRecord
    this._runs = new Map();
  }

  /**
   * Initialize cost tracking for a run.
   * Should be called when a run is enqueued.
   *
   * @param {string} runId
   * @param {{ budgetCap?: number, budgetWarning?: number }} opts
   */
  initRun(runId, { budgetCap = null, budgetWarning = null } = {}) {
    try {
      if (this._runs.has(runId)) return; // idempotent
      this._runs.set(runId, {
        runId,
        stages: {},       // { [stage]: { agentName, model, inputTokens, outputTokens, costUsd } }
        totalCostUsd: 0,
        budgetCap,
        budgetWarning,
        warningEmitted: false,
        startedAt: new Date().toISOString(),
      });
      console.log(`[CostTracker] Initialized run ${runId.slice(0,8)}... (cap: ${budgetCap ? `$${budgetCap}` : 'none'}, warn: ${budgetWarning ? `$${budgetWarning}` : 'none'})`);
    } catch (err) {
      console.warn('[CostTracker] initRun error (non-fatal):', err.message);
    }
  }

  /**
   * Record token usage for a stage.
   * Calculates cost and updates totals.
   *
   * @param {string} runId
   * @param {string} stage - 'plan' | 'scaffold' | 'code' | 'save' | 'verify'
   * @param {string} model - OpenAI model name
   * @param {number} inputTokens
   * @param {number} outputTokens
   */
  recordTokens(runId, stage, model, inputTokens, outputTokens) {
    try {
      if (!this._runs.has(runId)) {
        this.initRun(runId);
      }

      const run = this._runs.get(runId);
      const agentName = STAGE_AGENT_MAP[stage] || 'UnknownAgent';
      const costUsd = tokensToUsd(model, inputTokens, outputTokens);

      // If stage already has an entry (e.g., retry), accumulate
      if (run.stages[stage]) {
        run.stages[stage].inputTokens += inputTokens;
        run.stages[stage].outputTokens += outputTokens;
        run.stages[stage].costUsd += costUsd;
      } else {
        run.stages[stage] = { agentName, model, inputTokens, outputTokens, costUsd };
      }

      run.totalCostUsd += costUsd;

      console.log(`[CostTracker] ${stage} (${agentName}): ${inputTokens}in + ${outputTokens}out = $${costUsd.toFixed(6)} | run total: $${run.totalCostUsd.toFixed(6)}`);
    } catch (err) {
      console.warn('[CostTracker] recordTokens error (non-fatal):', err.message);
    }
  }

  /**
   * Check budget status for a run.
   * Returns current state relative to configured thresholds.
   *
   * @param {string} runId
   * @returns {{ exceeded: boolean, warning: boolean, totalCost: number, budgetCap: number|null, budgetWarning: number|null, shouldWarn: boolean }}
   */
  checkBudget(runId) {
    try {
      const run = this._runs.get(runId);
      if (!run) {
        return { exceeded: false, warning: false, totalCost: 0, budgetCap: null, budgetWarning: null, shouldWarn: false };
      }

      const { totalCostUsd, budgetCap, budgetWarning, warningEmitted } = run;

      const exceeded = budgetCap !== null && totalCostUsd >= budgetCap;
      const warning  = budgetWarning !== null && totalCostUsd >= budgetWarning;
      // shouldWarn = warning threshold crossed AND we haven't warned yet
      const shouldWarn = warning && !warningEmitted;

      if (shouldWarn) {
        run.warningEmitted = true;
      }

      return { exceeded, warning, shouldWarn, totalCost: totalCostUsd, budgetCap, budgetWarning };
    } catch (err) {
      console.warn('[CostTracker] checkBudget error (non-fatal):', err.message);
      return { exceeded: false, warning: false, shouldWarn: false, totalCost: 0, budgetCap: null, budgetWarning: null };
    }
  }

  /**
   * Get the full cost breakdown for a run.
   *
   * @param {string} runId
   * @returns {object|null} Cost breakdown, or null if run not found
   */
  getRunCosts(runId) {
    try {
      const run = this._runs.get(runId);
      if (!run) return null;

      // Build per-agent breakdown from stage data
      const byAgent = {};
      for (const [stage, data] of Object.entries(run.stages)) {
        const agent = data.agentName;
        if (!byAgent[agent]) {
          byAgent[agent] = { inputTokens: 0, outputTokens: 0, costUsd: 0, stages: [] };
        }
        byAgent[agent].inputTokens += data.inputTokens;
        byAgent[agent].outputTokens += data.outputTokens;
        byAgent[agent].costUsd += data.costUsd;
        byAgent[agent].stages.push(stage);
      }

      return {
        runId,
        totalCostUsd: run.totalCostUsd,
        budgetCap: run.budgetCap,
        budgetWarning: run.budgetWarning,
        byStage: run.stages,
        byAgent,
        startedAt: run.startedAt,
      };
    } catch (err) {
      console.warn('[CostTracker] getRunCosts error (non-fatal):', err.message);
      return null;
    }
  }

  /**
   * Persist run costs to the database.
   * Stores the full breakdown as JSONB in pipeline_runs.costs.
   *
   * @param {string} runId
   * @param {import('pg').Pool} pool
   */
  async persistRunCosts(runId, pool) {
    try {
      const costs = this.getRunCosts(runId);
      if (!costs) return;

      await pool.query(
        `UPDATE pipeline_runs SET costs = $1 WHERE id = $2`,
        [JSON.stringify(costs), runId]
      );

      console.log(`[CostTracker] Persisted costs for run ${runId.slice(0,8)}...: $${costs.totalCostUsd.toFixed(6)}`);
    } catch (err) {
      console.warn('[CostTracker] persistRunCosts error (non-fatal):', err.message);
    }
  }

  /**
   * Clean up in-memory data for a completed run.
   * Call after persisting.
   *
   * @param {string} runId
   */
  clearRun(runId) {
    try {
      this._runs.delete(runId);
    } catch (err) {
      // no-op
    }
  }

  /**
   * Get aggregate cost statistics across all runs (from DB).
   *
   * @param {import('pg').Pool} pool
   * @param {{ limit?: number }} opts
   * @returns {object} Summary statistics
   */
  static async getSummary(pool, { limit = 50, userId = null } = {}) {
    try {
      // userId is REQUIRED — never return unscoped data
      if (!userId) {
        return {
          totalRuns: 0, totalSpendUsd: 0, avgCostPerRunUsd: 0,
          avgCostPerSuccessfulRunUsd: 0, successRate: 0,
          costPerSuccessfulRunUsd: 0, runs: [],
        };
      }
      // Get recent runs with cost data (always scoped to user)
      const { rows } = await pool.query(`
        SELECT
          id,
          prompt,
          state,
          costs,
          budget_cap,
          budget_warning,
          created_at,
          completed_at
        FROM pipeline_runs
        WHERE costs IS NOT NULL
          AND costs != '{}'::JSONB
          AND user_id = $2
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit, userId]);

      if (rows.length === 0) {
        return {
          totalRuns: 0,
          totalSpendUsd: 0,
          avgCostPerRunUsd: 0,
          avgCostPerSuccessfulRunUsd: 0,
          successRate: 0,
          costPerSuccessfulRunUsd: 0,
          recentRuns: [],
          costTrend: [],
          agentBreakdown: {},
          phaseBreakdown: {},
        };
      }

      let totalSpend = 0;
      let successfulSpend = 0;
      let successfulCount = 0;
      const agentTotals = {};
      const phaseTotals = {};
      const recentRuns = [];
      const costTrend = [];

      for (const row of rows) {
        const costs = row.costs || {};
        const runCost = costs.totalCostUsd || 0;
        const isSuccess = row.state === 'completed';

        totalSpend += runCost;
        if (isSuccess) {
          successfulSpend += runCost;
          successfulCount++;
        }

        // Aggregate by agent
        if (costs.byAgent) {
          for (const [agent, data] of Object.entries(costs.byAgent)) {
            if (!agentTotals[agent]) agentTotals[agent] = { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 };
            agentTotals[agent].costUsd += data.costUsd || 0;
            agentTotals[agent].inputTokens += data.inputTokens || 0;
            agentTotals[agent].outputTokens += data.outputTokens || 0;
            agentTotals[agent].runs++;
          }
        }

        // Aggregate by phase/stage
        if (costs.byStage) {
          for (const [stage, data] of Object.entries(costs.byStage)) {
            if (!phaseTotals[stage]) phaseTotals[stage] = { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 };
            phaseTotals[stage].costUsd += data.costUsd || 0;
            phaseTotals[stage].inputTokens += data.inputTokens || 0;
            phaseTotals[stage].outputTokens += data.outputTokens || 0;
            phaseTotals[stage].runs++;
          }
        }

        recentRuns.push({
          id: row.id,
          prompt: row.prompt ? row.prompt.slice(0, 80) : '',
          state: row.state,
          totalCostUsd: runCost,
          budgetCap: row.budget_cap,
          createdAt: row.created_at,
        });

        costTrend.push({
          date: row.created_at,
          costUsd: runCost,
          state: row.state,
        });
      }

      const successRate = rows.length > 0 ? (successfulCount / rows.length) * 100 : 0;
      const avgCostPerRun = rows.length > 0 ? totalSpend / rows.length : 0;
      const costPerSuccessfulRun = successfulCount > 0 ? successfulSpend / successfulCount : 0;

      return {
        totalRuns: rows.length,
        totalSpendUsd: totalSpend,
        avgCostPerRunUsd: avgCostPerRun,
        successRate,
        costPerSuccessfulRunUsd: costPerSuccessfulRun,
        successfulRuns: successfulCount,
        recentRuns,
        costTrend: costTrend.reverse(), // oldest first for chart
        agentBreakdown: agentTotals,
        phaseBreakdown: phaseTotals,
      };
    } catch (err) {
      console.warn('[CostTracker] getSummary error (non-fatal):', err.message);
      return { error: err.message };
    }
  }

  /**
   * Get cost data for a specific run from DB.
   * Fallback if in-memory record is gone (e.g., after restart).
   *
   * @param {string} runId
   * @param {import('pg').Pool} pool
   * @returns {object|null}
   */
  static async getRunCostsFromDb(runId, pool) {
    try {
      const { rows } = await pool.query(
        `SELECT id, prompt, state, costs, budget_cap, budget_warning, created_at
         FROM pipeline_runs WHERE id = $1`,
        [runId]
      );
      if (!rows[0]) return null;

      return {
        runId,
        ...(rows[0].costs || {}),
        budgetCap: rows[0].budget_cap,
        budgetWarning: rows[0].budget_warning,
        runState: rows[0].state,
        createdAt: rows[0].created_at,
      };
    } catch (err) {
      console.warn('[CostTracker] getRunCostsFromDb error (non-fatal):', err.message);
      return null;
    }
  }
}

module.exports = { CostTracker, tokensToUsd, PRICING };
