/**
 * Built-in MCP Server: PostgreSQL
 *
 * Owns: read/write SQL execution against a project Neon database.
 * Does NOT own: connection config (caller provides DATABASE_URL), auth, audit.
 *
 * Tools exposed:
 *   query        — Execute a SQL SELECT query, returns rows as JSON
 *   execute      — Execute a DML statement (INSERT/UPDATE/DELETE), returns rowCount
 *   list_tables  — List all tables and their columns in the connected DB
 *   describe     — Describe schema for a specific table
 *
 * Safety: SELECT-only mode is the default. DML requires opts.allowMutations = true
 * in the server config so callers explicitly opt in to writes.
 */

'use strict';

const { Pool } = require('pg');
const { InProcessMcpClient } = require('./in-process-client');

/**
 * Factory: creates a PostgreSQL built-in MCP client.
 * Reads DATABASE_URL from the environment at call time.
 *
 * @returns {InProcessMcpClient}
 */
function createPostgresServer(opts = {}) {
  const allowMutations = opts.allowMutations === true;
  // Use the app's own DATABASE_URL — the user's project database.
  // The MCP framework provides read (and optionally write) access to it.
  const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;

  let pool = null;

  const tools = [
    {
      name: 'query',
      description: 'Execute a SQL SELECT query against the project database. Returns rows as a JSON array.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT statement to execute.' },
          params: { type: 'array', description: 'Parameterized query values ($1, $2, ...).', items: {} },
        },
        required: ['sql'],
      },
    },
    {
      name: 'execute',
      description: 'Execute a SQL DML statement (INSERT, UPDATE, DELETE). Returns affected row count. Requires mutation permission.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL statement to execute.' },
          params: { type: 'array', description: 'Parameterized query values.', items: {} },
        },
        required: ['sql'],
      },
    },
    {
      name: 'list_tables',
      description: 'List all tables in the database with their column names and types.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'describe',
      description: 'Describe the schema of a specific table including columns, types, and constraints.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to describe.' },
        },
        required: ['table'],
      },
    },
  ];

  async function callTool(name, params) {
    if (!databaseUrl) {
      return _error('DATABASE_URL is not configured. Cannot connect to the project database.');
    }

    // Lazy-init connection pool
    if (!pool) {
      pool = new Pool({ connectionString: databaseUrl, max: 3 });
    }

    switch (name) {
      case 'query': {
        const { sql, params: queryParams = [] } = params;
        _assertSelect(sql);
        try {
          const { rows } = await pool.query(sql, queryParams);
          return _text(`${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`);
        } catch (err) {
          return _error(`Query failed: ${err.message}`);
        }
      }

      case 'execute': {
        if (!allowMutations) {
          return _error('Mutation access is not enabled for this MCP connection. Configure allowMutations: true to enable writes.');
        }
        const { sql, params: queryParams = [] } = params;
        _blockDangerousSql(sql);
        try {
          const result = await pool.query(sql, queryParams);
          return _text(`${result.rowCount} row(s) affected.`);
        } catch (err) {
          return _error(`Execute failed: ${err.message}`);
        }
      }

      case 'list_tables': {
        try {
          const { rows } = await pool.query(`
            SELECT
              t.table_name,
              array_agg(c.column_name || ' ' || c.data_type ORDER BY c.ordinal_position) AS columns
            FROM information_schema.tables t
            JOIN information_schema.columns c
              ON t.table_name = c.table_name AND t.table_schema = c.table_schema
            WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            GROUP BY t.table_name
            ORDER BY t.table_name
          `);
          const lines = rows.map(r => `${r.table_name}: ${r.columns.join(', ')}`);
          return _text(lines.join('\n'));
        } catch (err) {
          return _error(`list_tables failed: ${err.message}`);
        }
      }

      case 'describe': {
        const { table } = params;
        if (!table || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
          return _error(`Invalid table name: "${table}"`);
        }
        try {
          const { rows } = await pool.query(`
            SELECT
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
            FROM information_schema.columns c
            LEFT JOIN (
              SELECT kcu.column_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
              WHERE tc.table_schema = 'public'
                AND tc.table_name = $1
                AND tc.constraint_type = 'PRIMARY KEY'
            ) pk ON c.column_name = pk.column_name
            WHERE c.table_schema = 'public' AND c.table_name = $1
            ORDER BY c.ordinal_position
          `, [table]);

          if (rows.length === 0) return _error(`Table "${table}" not found.`);
          const lines = rows.map(r =>
            `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}${r.is_primary_key === 'YES' ? ' PRIMARY KEY' : ''}${r.column_default ? ` DEFAULT ${r.column_default}` : ''}`
          );
          return _text(`Table: ${table}\n${lines.join('\n')}`);
        } catch (err) {
          return _error(`describe failed: ${err.message}`);
        }
      }

      default:
        return _error(`Unknown tool: ${name}`);
    }
  }

  return new InProcessMcpClient({ name: 'postgres', tools, callTool });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _text(text) {
  return { content: [{ type: 'text', text }] };
}

function _error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function _assertSelect(sql) {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed via the query tool. Use execute for DML.');
  }
}

function _blockDangerousSql(sql) {
  const normalized = sql.trim().toUpperCase();
  // Block DDL and truncate — those go through migrations, not MCP
  if (/\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/.test(normalized)) {
    throw new Error('DDL statements (DROP, TRUNCATE, ALTER, CREATE) are not allowed via MCP. Use migrations.');
  }
}

module.exports = { createPostgresServer };
