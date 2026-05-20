/**
 * Migration 034: Orbit Conversations
 *
 * Creates the orbit_conversations table for Orbit persistent
 * conversation memory. Each row stores a full conversation history (JSONB)
 * plus a pointer to the latest pipeline run triggered from that conversation.
 */

'use strict';

module.exports = {
  name: 'orbit_conversations',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orbit_conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        history JSONB NOT NULL DEFAULT '[]'::jsonb,
        current_run_id TEXT,
        last_prompt TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orbit_user ON orbit_conversations (user_id)
    `);
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_orbit_user`);
    await client.query(`DROP TABLE IF EXISTS orbit_conversations`);
  },
};
