/**
 * Migration: Memory Schema (4-Layer)
 *
 * Implements the BuildOrbit self-improving intelligence backbone:
 *
 *   Layer 1 - RUNS:      Episodic memory + audit trail (runs, run_events)
 *   Layer 2 - MEMORY:    Semantic intelligence via pgvector (memory_items, memory_links)
 *   Layer 3 - ARTIFACTS: Execution output vault with rollback (artifacts, artifact_versions)
 *   Layer 4 - ENTITIES:  Business reality model (entities, entity_metrics)
 *
 * Requires: pgvector extension on Neon (CREATE EXTENSION IF NOT EXISTS vector)
 */
module.exports = {
  name: 'memory_schema',
  up: async (client) => {

    // ─────────────────────────────────────────────────────────────────────────
    // PREREQUISITE: pgvector extension
    // ─────────────────────────────────────────────────────────────────────────
    // Check if pgvector is available before proceeding — VECTOR(1536) column
    // in memory_items requires it. Fail fast with a clear message if missing.
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    } catch (err) {
      throw new Error(
        `pgvector extension is required but could not be enabled: ${err.message}. ` +
        `Enable it in your Neon project settings under "Extensions" before running this migration.`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 1: RUNS — Episodic Memory Backbone
    // ─────────────────────────────────────────────────────────────────────────

    // runs: top-level execution record — one row per pipeline run
    await client.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id  TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        current_phase TEXT,
        started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at    TIMESTAMPTZ,
        trigger     TEXT CHECK (trigger IN ('manual', 'scheduled', 'agent'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runs_company_id
        ON runs (company_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runs_status
        ON runs (status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runs_started_at
        ON runs (started_at DESC)
    `);

    // run_events: append-only audit log — every pipeline action is a traceable event
    // This is the replay engine. Cascade on run deletion keeps it clean.
    await client.query(`
      CREATE TABLE IF NOT EXISTS run_events (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        agent       TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        payload     JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_run_events_run_id
        ON run_events (run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_run_events_timestamp
        ON run_events (timestamp DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_run_events_event_type
        ON run_events (event_type)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 2: MEMORY — Semantic Intelligence Layer
    // ─────────────────────────────────────────────────────────────────────────

    // memory_items: where BuildOrbit gets smarter over time
    // Stores insights, patterns, rules, lessons — each with a vector embedding
    // for semantic retrieval. importance score drives context budget allocation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id     TEXT NOT NULL,
        type           TEXT NOT NULL CHECK (type IN ('insight', 'pattern', 'rule', 'lesson')),
        content        TEXT NOT NULL,
        embedding      VECTOR(1536),
        importance     FLOAT NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
        source_run_id  UUID REFERENCES runs(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_company_id
        ON memory_items (company_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_type
        ON memory_items (type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_importance
        ON memory_items (importance DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_company_importance
        ON memory_items (company_id, importance DESC)
    `);

    // Vector index for semantic similarity search (ivfflat — faster build, good recall)
    // lists=100 is appropriate for up to ~1M rows; scale up as corpus grows
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_embedding
        ON memory_items USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);

    // memory_links: relationship graph between memories
    // supports | contradicts | derived_from — turns a log into a reasoning graph
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        memory_id          UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        related_memory_id  UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        strength           FLOAT NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
        relation_type      TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'derived_from'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_links_memory_id
        ON memory_links (memory_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_links_related_memory_id
        ON memory_links (related_memory_id)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 3: ARTIFACTS — Execution Output Vault
    // ─────────────────────────────────────────────────────────────────────────

    // artifacts: everything agents produce — code, plans, markdown, UI, assets
    await client.query(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        agent       TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('code', 'markdown', 'json', 'ui', 'plan', 'asset')),
        name        TEXT NOT NULL,
        content     TEXT NOT NULL,
        version     INT NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_run_id
        ON artifacts (run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_agent
        ON artifacts (agent)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_type
        ON artifacts (type)
    `);

    // artifact_versions: full version history — enables rollback and QA comparison
    await client.query(`
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_id   UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version       INT NOT NULL,
        content       TEXT NOT NULL,
        change_reason TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_id
        ON artifact_versions (artifact_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_artifact_version
        ON artifact_versions (artifact_id, version)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 4: ENTITY MEMORY — Business Reality Model
    // ─────────────────────────────────────────────────────────────────────────

    // entities: the company simulation
    // Products, funnels, campaigns, experiments, user segments —
    // each with a mutable state JSONB blob for live tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id  TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('product', 'funnel', 'campaign', 'experiment', 'user_segment')),
        name        TEXT NOT NULL,
        state       JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_company_id
        ON entities (company_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_type
        ON entities (type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_company_type
        ON entities (company_id, type)
    `);

    // entity_metrics: time-series performance data — connects memory to business reality
    // Every metric reading for every entity. Cascade on entity delete keeps data consistent.
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_metrics (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metric_name  TEXT NOT NULL,
        value        FLOAT NOT NULL
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_metrics_entity_id
        ON entity_metrics (entity_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_metrics_timestamp
        ON entity_metrics (timestamp DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_metrics_metric_name
        ON entity_metrics (metric_name)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_metrics_entity_metric
        ON entity_metrics (entity_id, metric_name, timestamp DESC)
    `);

    /*
     * CONTEXT ASSEMBLY PATTERN (for agent pre-run context packing)
     *
     * Prime an agent's context window before each run using:
     *
     *   -- Top memories by importance (semantic anchor)
     *   SELECT id, type, content, importance
     *   FROM memory_items
     *   WHERE company_id = $1
     *   ORDER BY importance DESC
     *   LIMIT 20;
     *
     *   -- Nearest memories by vector similarity (semantic search)
     *   SELECT id, type, content, importance,
     *          embedding <=> $embedding AS distance
     *   FROM memory_items
     *   WHERE company_id = $1
     *   ORDER BY embedding <=> $embedding
     *   LIMIT 10;
     *
     *   -- Last 5 runs with outcome
     *   SELECT id, status, current_phase, started_at, ended_at, trigger
     *   FROM runs
     *   WHERE company_id = $1
     *   ORDER BY started_at DESC
     *   LIMIT 5;
     *
     *   -- Recent failure patterns (for error avoidance)
     *   SELECT re.event_type, re.payload, r.started_at
     *   FROM run_events re
     *   JOIN runs r ON re.run_id = r.id
     *   WHERE r.company_id = $1
     *     AND r.status = 'failed'
     *     AND re.event_type IN ('BUILD_FAILED', 'QA_REJECTED', 'DEPLOY_FAILED')
     *   ORDER BY r.started_at DESC
     *   LIMIT 10;
     *
     *   -- Latest artifacts for each type (recent outputs)
     *   SELECT DISTINCT ON (a.type) a.id, a.type, a.name, a.version, a.created_at
     *   FROM artifacts a
     *   JOIN runs r ON a.run_id = r.id
     *   WHERE r.company_id = $1
     *   ORDER BY a.type, a.created_at DESC;
     *
     *   -- Current entity state snapshot
     *   SELECT id, type, name, state
     *   FROM entities
     *   WHERE company_id = $1
     *   ORDER BY type, name;
     */

    console.log('[memory_schema] 8 tables created: runs, run_events, memory_items, memory_links, artifacts, artifact_versions, entities, entity_metrics');
  }
};
