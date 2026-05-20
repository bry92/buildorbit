/**
 * scripts/migrate-and-start.js
 *
 * Runs all pending migrations before starting the server.
 * Called by Render via startCommand in render.yaml.
 * Ensures the schema is up-to-date on every deploy/restart.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runMigrations() {
  console.log('[migrate] Running pending migrations...');

  const client = await pool.connect();
  try {
    // Create tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT name FROM _migrations');
    const appliedNames = new Set(applied.map(r => r.name));

    // Read and run pending migrations
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    for (const file of files) {
      const migration = require(path.join(migrationsDir, file));
      const name = migration.name || file.replace('.js', '');

      if (appliedNames.has(name)) continue;

      console.log(`[migrate] Applying: ${name}`);
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied: ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed (${name}): ${err.message}`);
      }
    }

    console.log('[migrate] All migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migrations then start server
runMigrations()
  .then(() => {
    // eslint-disable-next-line global-require
    require('../server.js');
  })
  .catch(err => {
    console.error('[migrate] Fatal:', err.message);
    process.exit(1);
  });