/**
 * Migration 039: Add user_id to memory_items for per-user isolation
 *
 * The memory_items table was originally keyed by company_id (TEXT).
 * Orbit semantic memory requires strict per-user scoping so that no user
 * ever sees another user's memories. This migration adds user_id (TEXT)
 * as the primary isolation key, backfills NULL for existing rows (which
 * were company-level), and adds a covering index for the pgvector similarity
 * search path (user_id + importance).
 *
 * Existing rows retain company_id for backward compatibility with any
 * non-Orbit code that reads memory_items by company_id.
 */

'use strict';

module.exports = {
  name: 'memory_items_user_id',
  up: async (client) => {
    // Add user_id column — nullable to avoid breaking existing rows
    await client.query(`
      ALTER TABLE memory_items
        ADD COLUMN IF NOT EXISTS user_id TEXT
    `);

    // Index for per-user lookups and similarity search gating
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_user_id
        ON memory_items (user_id)
    `);

    // Covering index: user_id + importance DESC for ranked memory retrieval
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_user_importance
        ON memory_items (user_id, importance DESC)
    `);

    console.log('[039_memory_items_user_id] user_id column + indexes added to memory_items');
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_memory_items_user_importance`);
    await client.query(`DROP INDEX IF EXISTS idx_memory_items_user_id`);
    await client.query(`ALTER TABLE memory_items DROP COLUMN IF EXISTS user_id`);
  },
};
