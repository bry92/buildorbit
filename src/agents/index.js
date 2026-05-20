/**
 * Agent Registry
 *
 * Central registry that maps pipeline stages to their owning agents.
 * The orchestrator uses this to dispatch stage execution without knowing
 * which agent handles which stage.
 *
 * Stage → Agent mapping:
 *   plan              → PlannerAgent
 *   scaffold, code    → BuilderAgent
 *   save              → OpsAgent
 *   verify            → QAAgent
 *
 * All agents communicate ONLY through pipeline state (previousOutputs).
 * No direct agent-to-agent calls.
 */

const { PlannerAgent } = require('./planner-agent');
const { BuilderAgent } = require('./builder-agent');
const { QAAgent } = require('./qa-agent');
const { OpsAgent } = require('./ops-agent');

/**
 * AgentRegistry
 *
 * Holds references to all agents and routes stage execution.
 * Provides a clean interface to the orchestrator.
 */
class AgentRegistry {
  /**
   * @param {object} opts
   * @param {import('../agents/planner-agent').PlannerAgent} opts.plannerAgent
   * @param {import('../agents/builder-agent').BuilderAgent} opts.builderAgent
   * @param {import('../agents/qa-agent').QAAgent}          opts.qaAgent
   * @param {import('../agents/ops-agent').OpsAgent}        opts.opsAgent
   */
  constructor({ plannerAgent, builderAgent, qaAgent, opsAgent }) {
    this._agents = {};
    this._agentList = [plannerAgent, builderAgent, qaAgent, opsAgent];

    // Build stage → agent map from each agent's declared stages
    for (const agent of this._agentList) {
      for (const stage of agent.stages) {
        this._agents[stage] = agent;
      }
    }

    // Expose named agents for cross-cutting access
    this.planner = plannerAgent;
    this.builder = builderAgent;
    this.qa = qaAgent;
    this.ops = opsAgent;

    console.log('[AgentRegistry] Initialized with stage routing:');
    for (const [stage, agent] of Object.entries(this._agents)) {
      console.log(`  ${stage.padEnd(10)} → ${agent.constructor.name}`);
    }
  }

  /**
   * Get the agent responsible for a given stage.
   *
   * @param {string} stage - Pipeline stage name
   * @returns {object} Agent instance
   * @throws {Error} If no agent is registered for this stage
   */
  getAgent(stage) {
    const agent = this._agents[stage];
    if (!agent) {
      throw new Error(`[AgentRegistry] No agent registered for stage: "${stage}"`);
    }
    return agent;
  }

  /**
   * Check if a stage has a registered agent.
   *
   * @param {string} stage
   * @returns {boolean}
   */
  hasAgent(stage) {
    return !!this._agents[stage];
  }

  /**
   * Get all registered stage names.
   *
   * @returns {string[]}
   */
  getStages() {
    return Object.keys(this._agents);
  }

  /**
   * Get registry summary for debugging/health endpoints.
   *
   * @returns {object}
   */
  getStatus() {
    const mapping = {};
    for (const [stage, agent] of Object.entries(this._agents)) {
      mapping[stage] = agent.constructor.name;
    }
    return {
      agents: this._agentList.map(a => ({
        name: a.constructor.name,
        stages: a.stages,
      })),
      stageMapping: mapping,
    };
  }
}

/**
 * Factory: Create all agents and wire them into a registry.
 *
 * @param {import('pg').Pool} pool - PostgreSQL pool (required by OpsAgent for SAVE)
 * @returns {AgentRegistry}
 */
function createAgentRegistry(pool) {
  const plannerAgent = new PlannerAgent();
  const builderAgent = new BuilderAgent();
  // Pass pool to QAAgent so it can write ACL violation data (Phase 1 observation layer)
  const qaAgent = new QAAgent(pool);
  const opsAgent = new OpsAgent(pool);

  return new AgentRegistry({ plannerAgent, builderAgent, qaAgent, opsAgent });
}

module.exports = {
  AgentRegistry,
  PlannerAgent,
  BuilderAgent,
  QAAgent,
  OpsAgent,
  createAgentRegistry,
};
