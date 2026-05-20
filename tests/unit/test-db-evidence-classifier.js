'use strict';

/**
 * Unit tests for src/lib/db-evidence-classifier.js
 *
 * Tests cover:
 *   - HARD tier: CREATE TABLE, migration files, db.exec schema calls
 *   - PROBABLE tier: engine imports, CRUD ops, init patterns
 *   - INFERRED tier: keyword signals, UI persistence patterns
 *   - Threshold edge cases: exactly at boundary scores
 *   - False positive prevention: non-DB code doesn't trigger
 *   - The class of false failures this was designed to fix
 */

const assert = require('assert');
const { classifyDbEvidence } = require('../../src/lib/db-evidence-classifier');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ label, error: err.message });
  }
}

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HARD tier ──────────────────────────────────────────────────────────────

console.log('\nHARD evidence:');

test('CREATE TABLE → HARD / PASS', () => {
  const result = classifyDbEvidence(
    `const db = require('better-sqlite3')('app.db');\ndb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');\n`,
    {}
  );
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
  assert(result.hardScore >= 5, `hardScore should be >= 5, got ${result.hardScore}`);
});

test('ALTER TABLE → HARD / PASS', () => {
  const result = classifyDbEvidence(
    `db.exec('ALTER TABLE users ADD COLUMN email TEXT');\n`,
    {}
  );
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
});

test('Migration file in file list → HARD / PASS', () => {
  const result = classifyDbEvidence(
    `// some code here`,
    { 'migrations/001_create_users.sql': 'CREATE TABLE users (id SERIAL PRIMARY KEY);' }
  );
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
});

test('Timestamp-prefixed migration .js file → HARD / PASS', () => {
  const result = classifyDbEvidence(
    `// server code`,
    {
      'server.js': '// express app',
      '1700000000_create_users.js': 'module.exports.up = db => db.query("CREATE TABLE users...")',
    }
  );
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
});

test('.sql file in migrations/ → HARD / PASS', () => {
  const result = classifyDbEvidence('', {
    'migrations/init.sql': 'CREATE TABLE items (id INT, name TEXT);',
  });
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
});

test('CREATE TABLE in template literal → HARD / PASS (regression: was binary false negative)', () => {
  // Old checker: codeText.includes('CREATE TABLE') would catch this.
  // New checker also catches it via regex — confirming no regression.
  const code = 'pool.query(`CREATE TABLE sessions (token TEXT NOT NULL)`);\n';
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'PASS');
  eq(result.tier, 'HARD');
});

// ── PROBABLE tier ──────────────────────────────────────────────────────────

console.log('\nPROBABLE evidence (PASS_WITH_RISK):');

test('pg import + CRUD ops → PROBABLE / PASS_WITH_RISK', () => {
  // Schema abstracted via ORM/migrations — no CREATE TABLE in code.
  const code = [
    "const { Pool } = require('pg');",
    "const pool = new Pool({ connectionString: process.env.DATABASE_URL });",
    "async function getUser(id) { return pool.query('SELECT * FROM users WHERE id=$1', [id]); }",
    "async function createUser(data) { return pool.query('INSERT INTO users...', [data.name]); }",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'PASS_WITH_RISK');
  eq(result.tier, 'PROBABLE');
  assert(result.probableScore >= 3, `probableScore should be >= 3, got ${result.probableScore}`);
});

test('better-sqlite3 import + initDb() + db.run → PROBABLE / PASS_WITH_RISK', () => {
  const code = [
    "const Database = require('better-sqlite3');",
    "const db = new Database('app.db');",
    "function initDb() { /* schema from external file */ }",
    "function insertItem(item) { db.run('INSERT INTO items VALUES (?)', [item.name]); }",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'PASS_WITH_RISK');
  eq(result.tier, 'PROBABLE');
});

test('Sequelize schema.sync() without DDL → PROBABLE / PASS_WITH_RISK', () => {
  const code = [
    "const { Sequelize } = require('sequelize');",
    "const sequelize = new Sequelize(process.env.DATABASE_URL);",
    "await sequelize.schema.sync({ force: false });",
    "const user = await User.findOne({ where: { id } });",
    "await user.save();",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'PASS_WITH_RISK');
  eq(result.tier, 'PROBABLE');
});

test('Prisma client import + findMany + create → PROBABLE / PASS_WITH_RISK', () => {
  const code = [
    "const { PrismaClient } = require('@prisma/client');",
    "const prisma = new PrismaClient();",
    "const todos = await prisma.todo.findMany();",
    "await prisma.todo.create({ data: { title } });",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'PASS_WITH_RISK');
  eq(result.tier, 'PROBABLE');
});

test('Repository file + db engine → PROBABLE / PASS_WITH_RISK', () => {
  const code = "const db = require('pg');\n";
  const files = {
    'server.js': "const db = require('pg');\nconst pool = new Pool();\npool.query('SELECT...');\npool.query('INSERT...');\n",
    'models/users.js': "class UserRepository { findOne() {} create() {} }",
  };
  const result = classifyDbEvidence(code + Object.values(files).join('\n'), files);
  eq(result.finalDecision, 'PASS_WITH_RISK');
  eq(result.tier, 'PROBABLE');
});

// ── INFERRED tier (FAIL) ──────────────────────────────────────────────────

console.log('\nINFERRED evidence (FAIL):');

test('Only keywords — no engine, no ops → INFERRED / FAIL', () => {
  const code = [
    '// This app will use a database to persist user data',
    '// We need a users table to store account information',
    'const express = require("express");',
    'const app = express();',
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'FAIL');
  eq(result.tier, 'INFERRED');
});

test('Todo UI without any DB code → INFERRED / FAIL', () => {
  const code = [
    '<!-- Todo App -->',
    '<ul id="todo-list"></ul>',
    '<input id="task-input" />',
    '<button onclick="addTask()">Add</button>',
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'FAIL');
  assert(['INFERRED', 'NONE'].includes(result.tier), `Expected INFERRED or NONE, got ${result.tier}`);
});

// ── NONE tier (FAIL) ──────────────────────────────────────────────────────

console.log('\nNONE evidence (FAIL):');

test('Empty code → NONE / FAIL', () => {
  const result = classifyDbEvidence('', {});
  eq(result.finalDecision, 'FAIL');
  eq(result.tier, 'NONE');
  eq(result.hardScore, 0);
  eq(result.probableScore, 0);
  eq(result.inferredScore, 0);
});

test('Static HTML only → NONE / FAIL', () => {
  const code = '<html><body><h1>Hello World</h1><p>Static page.</p></body></html>';
  const result = classifyDbEvidence(code, { 'index.html': code });
  eq(result.finalDecision, 'FAIL');
  eq(result.tier, 'NONE');
});

test('Express server without DB → NONE / FAIL', () => {
  const code = [
    "const express = require('express');",
    "const app = express();",
    "app.get('/api/hello', (req, res) => res.json({ message: 'hi' }));",
    "app.listen(3000);",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  eq(result.finalDecision, 'FAIL');
  eq(result.tier, 'NONE');
  eq(result.hardScore, 0);
  eq(result.probableScore, 0);
});

// ── False positive prevention ─────────────────────────────────────────────

console.log('\nFalse positive prevention:');

test('"Pool" uppercase class name alone does not pass (old bug repro)', () => {
  // The OLD checker had: codeText.includes('Pool') which matched any class named Pool.
  // This test ensures our new classifier doesn't false-positive on an unrelated "Pool" class.
  const code = [
    "class ConnectionPool {",
    "  constructor() { this.connections = []; }",
    "  get() { return this.connections.pop(); }",
    "}",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  // Should FAIL — "ConnectionPool" is not a DB engine import or DDL
  eq(result.finalDecision, 'FAIL');
});

test('"pool.query" in a non-DB context doesn\'t satisfy HARD alone', () => {
  // Demonstrates that pool.query without a DB engine import only gives PROBABLE credit.
  // Without CREATE TABLE or engine import, should not HARD PASS.
  const code = "pool.query('SELECT * FROM items');\n";
  const result = classifyDbEvidence(code, {});
  // pool.query hits CRUD_OP (probable +1) but no engine import or DDL
  assert(result.hardScore < 5, `hardScore should be < 5 (no DDL found), got ${result.hardScore}`);
});

// ── Threshold boundary tests ──────────────────────────────────────────────

console.log('\nThreshold boundary tests:');

test('probableScore exactly 3 → PASS_WITH_RISK', () => {
  // Engine import (+2) + 1 CRUD op type (+1) = exactly 3
  const code = [
    "const { Pool } = require('pg');",
    "const pool = new Pool();",
    "pool.query('SELECT * FROM users');",
  ].join('\n');
  const result = classifyDbEvidence(code, {});
  assert(result.probableScore >= 3, `probableScore should be >= 3, got ${result.probableScore}`);
  eq(result.finalDecision, 'PASS_WITH_RISK');
});

test('probableScore exactly 2 (engine only) → INFERRED / FAIL', () => {
  // Only import, no CRUD or init — score 2 < 3 threshold
  const code = "const db = require('better-sqlite3')('app.db');\n";
  const result = classifyDbEvidence(code, {});
  eq(result.probableScore, 2);
  eq(result.finalDecision, 'FAIL');
});

// ── Evidence array shape ──────────────────────────────────────────────────

console.log('\nEvidence array:');

test('Evidence objects have required shape: { tier, type, confidence }', () => {
  const result = classifyDbEvidence("CREATE TABLE users (id INT);", {});
  assert(result.evidences.length > 0, 'Should have at least one evidence entry');
  for (const ev of result.evidences) {
    assert(ev.tier, `Evidence missing .tier: ${JSON.stringify(ev)}`);
    assert(ev.type, `Evidence missing .type: ${JSON.stringify(ev)}`);
    assert(typeof ev.confidence === 'number', `Evidence .confidence should be number: ${JSON.stringify(ev)}`);
  }
});

test('HARD evidence has confidence >= 0.9', () => {
  const result = classifyDbEvidence("CREATE TABLE x (id INT);", {});
  const hardEvidence = result.evidences.filter(e => e.tier === 'HARD');
  assert(hardEvidence.length > 0, 'Should have HARD evidence');
  hardEvidence.forEach(e => {
    assert(e.confidence >= 0.9, `HARD evidence confidence should be >= 0.9, got ${e.confidence}`);
  });
});

// ── Print summary ─────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  ✗ ${f.label}`);
    console.log(`    ${f.error}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed ✓');
  process.exit(0);
}
