module.exports = {
  name: 'add_costs_and_budget',
  up: async (client) => {
    // Cost breakdown: JSONB keyed by stage, each entry has agent, tokens, cost
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS costs JSONB DEFAULT '{}'::JSONB
    `);

    // Budget controls — set at run creation, enforced during execution
    await client.query(`
      ALTER TABLE pipeline_runs
        ADD COLUMN IF NOT EXISTS budget_cap NUMERIC(10,6),
        ADD COLUMN IF NOT EXISTS budget_warning NUMERIC(10,6)
    `);

    // Index for cost-based queries (e.g., runs ordered by total cost)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_costs_total
        ON pipeline_runs ((costs->>'totalCostUsd'))
        WHERE costs IS NOT NULL
    `);
  }
};
