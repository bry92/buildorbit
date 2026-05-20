/**
 * Orbit Semantic Memory Service
 *
 * Owns: write path (extract + embed + store memories from completed runs),
 *       read path (pgvector similarity search to retrieve relevant memories),
 *       per-user isolation (all queries filter by user_id).
 * Does NOT own: conversation history, pipeline execution, OpenAI chat completions.
 *
 * Architecture:
 *   - Write: after a completed run, extract lessons/patterns via GPT-4o,
 *     embed each item with text-embedding-3-small, insert into memory_items.
 *   - Read: embed the current conversation context, run pgvector cosine similarity
 *     search against user's memory_items, return top-k ranked by score + recency.
 *   - All DB access uses parameterized queries filtered by user_id.
 *   - Fail-open: every method catches and logs errors, never throws to callers.
 */

'use strict';

// Max memories injected into Orbit context per turn
const MAX_MEMORIES_IN_CONTEXT = 6;

// Minimum similarity score (cosine) to include a memory (0.0–1.0, lower = more similar)
// pgvector cosine distance: 0 = identical, 2 = opposite. We want distance < 0.5.
const MAX_COSINE_DISTANCE = 0.5;

// Max memories stored per user before oldest/lowest-importance are pruned
const MAX_MEMORIES_PER_USER = 500;

class OrbitMemory {
  /**
   * @param {{ pool: import('pg').Pool, openai: import('openai').OpenAI }} deps
   */
  constructor({ pool, openai }) {
    this.pool = pool;
    this.openai = openai; // may be null — all methods fail-open
  }

  // ── Read Path ─────────────────────────────────────────────────────────────

  /**
   * Retrieve semantically relevant memories for the current conversation turn.
   * Embeds the query text, runs pgvector similarity search, returns formatted
   * memory snippets ready for injection into the system prompt.
   *
   * @param {string} userId — strict isolation: only this user's memories returned
   * @param {string} queryText — current message + last few turns of context
   * @returns {Promise<string>} — formatted memory block, or '' if none
   */
  async recallRelevant(userId, queryText) {
    if (!userId || userId === 'anonymous' || !this.openai) return '';

    try {
      const embedding = await this._embed(queryText);
      if (!embedding) return '';

      // pgvector cosine distance: embedding <=> $2 (lower = more similar)
      const { rows } = await this.pool.query(
        `SELECT content, type, importance, created_at,
                embedding <=> $2 AS distance
         FROM memory_items
         WHERE user_id = $1
           AND embedding IS NOT NULL
           AND embedding <=> $2 < $3
         ORDER BY
           -- Blend similarity + recency + importance for ranking
           (embedding <=> $2) - (importance * 0.3) - (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 * -0.01)
         LIMIT $4`,
        [userId, JSON.stringify(embedding), MAX_COSINE_DISTANCE, MAX_MEMORIES_IN_CONTEXT]
      );

      if (rows.length === 0) return '';

      const lines = rows.map(r => {
        const typeLabel = { insight: '💡', pattern: '🔁', rule: '📋', lesson: '📝' }[r.type] || '•';
        return `${typeLabel} ${r.content}`;
      });

      return `MEMORY (${rows.length} relevant items from past sessions):\n${lines.join('\n')}`;
    } catch (err) {
      // Table may not have user_id column yet if migration hasn't run
      if (!err.message?.includes('column "user_id" does not exist')) {
        console.error('[OrbitMemory] recallRelevant error:', err.message);
      }
      return '';
    }
  }

  /**
   * Retrieve all memories for a user, ranked by importance.
   * Used for full context review, not injected per-turn.
   *
   * @param {string} userId
   * @param {number} limit
   * @returns {Promise<Array<{type, content, importance, created_at}>>}
   */
  async listMemories(userId, limit = 20) {
    if (!userId || userId === 'anonymous') return [];

    try {
      const { rows } = await this.pool.query(
        `SELECT type, content, importance, created_at
         FROM memory_items
         WHERE user_id = $1
         ORDER BY importance DESC, created_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      return rows;
    } catch (err) {
      if (!err.message?.includes('column "user_id" does not exist')) {
        console.error('[OrbitMemory] listMemories error:', err.message);
      }
      return [];
    }
  }

  // ── Write Path ────────────────────────────────────────────────────────────

  /**
   * After a completed pipeline run, extract lessons and store them as memories.
   * Called fire-and-forget from orbit-agent — never blocks the response.
   *
   * @param {string} userId
   * @param {string} runId
   * @param {object} runSummary — { prompt, status, phases, failedPhase?, errorMsg? }
   * @returns {Promise<void>}
   */
  async learnFromRun(userId, runId, runSummary) {
    if (!userId || userId === 'anonymous' || !this.openai) return;

    try {
      const { prompt, status, phases = [], failedPhase, errorMsg } = runSummary;

      const statusLabel = status === 'completed' ? 'succeeded' : `failed at ${failedPhase || 'unknown phase'}`;
      const runDesc =
        `Task: ${(prompt || '').slice(0, 300)}\n` +
        `Outcome: ${statusLabel}\n` +
        (errorMsg ? `Error: ${errorMsg.slice(0, 200)}\n` : '') +
        (phases.length > 0 ? `Phases: ${phases.map(p => `${p.stage}=${p.status}`).join(', ')}\n` : '');

      // Ask GPT-4o to extract 2-4 compact memory items from this run
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You are a memory curator for an AI build pipeline. Given a summary of a completed pipeline run, ' +
              'extract 2-4 compact memory items that will help the AI copilot be smarter on future runs.\n\n' +
              'Output ONLY a JSON array. Each item: { "type": "insight"|"pattern"|"rule"|"lesson", "content": "...", "importance": 0.0-1.0 }\n\n' +
              'Rules:\n' +
              '- insights: non-obvious observations about what this task required\n' +
              '- patterns: recurring structures in the user\'s requests or codebase\n' +
              '- rules: constraints the pipeline must respect (tech choices, naming, structure)\n' +
              '- lessons: what went wrong and why (failures only)\n' +
              '- content must be ≤120 chars, specific and actionable\n' +
              '- importance: 0.9 for critical failures/constraints, 0.6 for useful patterns, 0.3 for weak observations\n' +
              '- Skip trivial or generic items (e.g. "the task involved coding")\n' +
              '- Output ONLY the JSON array, no other text.',
          },
          { role: 'user', content: runDesc },
        ],
        temperature: 0.3,
        max_tokens: 600,
      });

      const raw = completion.choices[0]?.message?.content || '[]';
      let items;
      try {
        // Strip markdown code fences if present
        const cleaned = raw.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
        items = JSON.parse(cleaned);
        if (!Array.isArray(items)) items = [];
      } catch {
        items = [];
      }

      // Store each extracted memory item
      for (const item of items.slice(0, 4)) {
        if (!item.content || !item.type) continue;
        await this._storeMemory(userId, runId, item);
      }

      // Prune oldest/lowest-importance if user exceeds cap
      await this._pruneIfNeeded(userId);
    } catch (err) {
      // Fire-and-forget — log but never propagate
      console.error('[OrbitMemory] learnFromRun error:', err.message);
    }
  }

  /**
   * Store a single memory item with its embedding.
   *
   * @param {string} userId
   * @param {string} runId
   * @param {{ type, content, importance }} item
   */
  async _storeMemory(userId, runId, item) {
    const validTypes = ['insight', 'pattern', 'rule', 'lesson'];
    const type = validTypes.includes(item.type) ? item.type : 'insight';
    const importance = Math.max(0, Math.min(1, parseFloat(item.importance) || 0.5));
    const content = String(item.content).slice(0, 200);

    const embedding = await this._embed(content);

    await this.pool.query(
      `INSERT INTO memory_items
         (company_id, user_id, type, content, embedding, importance, source_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,        // company_id — kept for backward compat, set to userId
        userId,        // user_id — the actual isolation key
        type,
        content,
        embedding ? JSON.stringify(embedding) : null,
        importance,
        runId || null,
      ]
    );
  }

  /**
   * Prune oldest/lowest-importance memories when user exceeds MAX_MEMORIES_PER_USER.
   * Deletes the bottom-ranked rows by (importance ASC, created_at ASC).
   *
   * @param {string} userId
   */
  async _pruneIfNeeded(userId) {
    try {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*) AS cnt FROM memory_items WHERE user_id = $1`,
        [userId]
      );
      const count = parseInt(rows[0]?.cnt || 0, 10);
      if (count <= MAX_MEMORIES_PER_USER) return;

      const excess = count - MAX_MEMORIES_PER_USER;
      await this.pool.query(
        `DELETE FROM memory_items
         WHERE id IN (
           SELECT id FROM memory_items
           WHERE user_id = $1
           ORDER BY importance ASC, created_at ASC
           LIMIT $2
         )`,
        [userId, excess]
      );
    } catch (err) {
      console.error('[OrbitMemory] _pruneIfNeeded error:', err.message);
    }
  }

  // ── Embedding Helper ──────────────────────────────────────────────────────

  /**
   * Generate an embedding vector for the given text.
   * Returns null on failure (fail-open).
   *
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async _embed(text) {
    if (!this.openai || !text) return null;

    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8000), // stay within token limit
      });
      return response.data[0]?.embedding || null;
    } catch (err) {
      console.error('[OrbitMemory] embed error:', err.message);
      return null;
    }
  }
}

module.exports = { OrbitMemory };
