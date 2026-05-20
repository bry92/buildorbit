/**
 * DB Evidence Classifier
 *
 * 3-tier forensic certainty model for detecting database integration in generated code.
 * Replaces binary string-match approaches ("CREATE TABLE found → pass, else fail").
 *
 * ## Why This Exists
 * The old checker caused false failures when:
 *   - Schema was moved to a separate migration file
 *   - Template literals hid SQL strings from plain includes() checks
 *   - An ORM (Sequelize, Prisma, Mongoose) abstracted away raw DDL
 *   - SQLite was wrapped in a db module with no visible "CREATE TABLE"
 *
 * ## Tier Definitions
 *
 * ### HARD (ground truth — schema unambiguously defined)
 *   - Explicit DDL: CREATE TABLE, ALTER TABLE, DROP TABLE
 *   - SQL migration files (.sql extension, files in migrations/)
 *   - Direct DB exec with schema intent: db.exec/db.prepare/pg.query("CREATE TABLE…")
 *
 * ### PROBABLE (structural evidence — DB clearly intended, schema may be abstracted)
 *   - DB engine imported: better-sqlite3, pg, sqlite3, mysql, mysql2, sequelize,
 *     knex, typeorm, mongoose, prisma, drizzle-orm
 *   - CRUD operations: db.run, db.prepare, pool.query, .insert, .findOne, .update, etc.
 *   - Init/bootstrap patterns: initDb(), setupDatabase(), createTables(), runMigrations()
 *   - Repository / DAO file structure
 *
 * ### INFERRED (weak signals — app logically needs a DB but no code evidence)
 *   - Keywords in comments/strings: "database", "persist", "store data"
 *   - UI pattern implies persistence: auth, todo list, CRUD app
 *
 * ## Scoring
 *   HARD:     DDL statement        = +5  (capped — no stacking)
 *             SQL migration file   = +5
 *             db.exec schema call  = +4
 *   PROBABLE: DB engine import     = +2
 *             CRUD ops             = +1 per distinct op type (max +4)
 *             initDb/bootstrap     = +2
 *             repo/DAO file        = +1
 *   INFERRED: keyword signals      = +0.5 each (max +1)
 *             UI implies persist   = +1
 *
 * ## Thresholds → Decision
 *   hardScore >= 5                 → tier=HARD      → PASS
 *   probableScore >= 3             → tier=PROBABLE  → PASS_WITH_RISK
 *   inferredScore >= 1 or probable → tier=INFERRED  → FAIL
 *   nothing                        → tier=NONE      → FAIL
 *
 * @module lib/db-evidence-classifier
 */

'use strict';

/**
 * Classify DB evidence in generated code using a 3-tier forensic model.
 *
 * @param {string} codeText  - All code file contents concatenated (for fast pattern matching)
 * @param {object} codeFiles - Map of { filePath: content } (for file-name-based signals)
 * @returns {{
 *   tier: 'HARD'|'PROBABLE'|'INFERRED'|'NONE',
 *   hardScore: number,
 *   probableScore: number,
 *   inferredScore: number,
 *   finalDecision: 'PASS'|'PASS_WITH_RISK'|'FAIL',
 *   evidences: Array<{ tier: string, type: string, confidence: number, [key: string]: any }>
 * }}
 */
function classifyDbEvidence(codeText, codeFiles) {
  const evidences = [];
  let hardScore = 0;
  let probableScore = 0;
  let inferredScore = 0;

  const fileNames = Object.keys(codeFiles || {});
  const allContent = codeText || '';

  // ── HARD evidence ──────────────────────────────────────────────────────────

  // Explicit DDL statements
  const ddlPatterns = [
    { pattern: /CREATE\s+TABLE\b/i, type: 'CREATE_TABLE', score: 5 },
    { pattern: /ALTER\s+TABLE\b/i,  type: 'ALTER_TABLE',  score: 5 },
    { pattern: /DROP\s+TABLE\b/i,   type: 'DROP_TABLE',   score: 5 },
  ];
  for (const { pattern, type, score } of ddlPatterns) {
    if (pattern.test(allContent)) {
      evidences.push({ tier: 'HARD', type, confidence: 0.95 });
      hardScore = Math.max(hardScore, score);
    }
  }

  // SQL migration files (.sql extension or files in migrations/ dir, or timestamp-prefixed .js)
  const migrationFiles = fileNames.filter(f =>
    f.endsWith('.sql') ||
    f.startsWith('migrations/') ||
    /\d+_.*\.js$/.test(f)  // e.g. 1700000000_create_users.js
  );
  if (migrationFiles.length > 0) {
    evidences.push({ tier: 'HARD', type: 'MIGRATION_FILE', confidence: 0.9, files: migrationFiles });
    hardScore = Math.max(hardScore, 5);
  }

  // Direct DB exec with schema intent in string/template args
  // Catches: db.exec(`CREATE TABLE`), db.prepare("CREATE TABLE"), pg.query("CREATE TABLE")
  const execSchemaPattern = /(?:db\.exec|db\.prepare|pg\.query|pool\.query|client\.query)\s*\(\s*[`'"]/i;
  if (execSchemaPattern.test(allContent) && /CREATE\s+TABLE/i.test(allContent)) {
    evidences.push({ tier: 'HARD', type: 'DB_EXEC_SCHEMA', confidence: 0.92 });
    hardScore = Math.max(hardScore, 4);
  }

  // ── PROBABLE evidence ──────────────────────────────────────────────────────

  // DB engine / driver / ORM imports
  const dbEngines = [
    'better-sqlite3', 'sqlite3', 'pg', 'postgres',
    'mysql', 'mysql2', 'sequelize', 'knex', 'typeorm',
    'mongoose', 'prisma', '@prisma/client', 'drizzle-orm',
  ];
  const hasEngineImport = dbEngines.some(engine => {
    const escaped = engine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`require\\(['"]${escaped}['"]\\)|from\\s+['"]${escaped}['"]`, 'i').test(allContent);
  });
  if (hasEngineImport) {
    evidences.push({ tier: 'PROBABLE', type: 'DB_ENGINE_IMPORT', confidence: 0.8 });
    probableScore += 2;
  }

  // CRUD operations — count distinct op types (cap at 4 to avoid stacking)
  const crudOps = {
    'db.run/exec/prepare': /\bdb\.(run|exec|prepare)\s*\(/i,
    'pool/client.query':   /\b(?:pool|client|db)\.query\s*\(/i,
    '.insert/.create':     /\.\s*(?:insert|create)\s*\(/i,
    '.select/.find*':      /\.\s*(?:select|find(?:One|All|By|Many)?)\s*\(/i,
    '.update/.save':       /\.\s*(?:update|save)\s*\(/i,
    '.delete/.remove':     /\.\s*(?:delete|remove|destroy)\s*\(/i,
  };
  let crudHits = 0;
  for (const [label, pattern] of Object.entries(crudOps)) {
    if (pattern.test(allContent)) {
      evidences.push({ tier: 'PROBABLE', type: 'CRUD_OP', label, confidence: 0.7 });
      crudHits++;
    }
  }
  if (crudHits > 0) {
    probableScore += Math.min(crudHits, 4); // cap at +4
  }

  // Init / bootstrap patterns
  const initPatterns = [
    /\b(?:initDb|initDatabase|setupDatabase|createTables?|runMigrations?|connectDb|bootstrapDb)\s*\(/i,
    /\bschema\s*\.\s*(?:create|sync|define)\s*\(/i,   // Sequelize schema.sync()
    /\bprisma\.\$(?:connect|disconnect|executeRaw)\s*\(/i,
  ];
  if (initPatterns.some(p => p.test(allContent))) {
    evidences.push({ tier: 'PROBABLE', type: 'DB_INIT_BOOTSTRAP', confidence: 0.75 });
    probableScore += 2;
  }

  // Repository / DAO file structure (weak but structural)
  const repoFiles = fileNames.filter(f =>
    /repositor|\.repo\.|\.dao\.|\.model\.|^models\//.test(f)
  );
  if (repoFiles.length > 0) {
    evidences.push({ tier: 'PROBABLE', type: 'REPOSITORY_PATTERN', confidence: 0.65, files: repoFiles });
    probableScore += 1;
  }

  // ── INFERRED evidence ──────────────────────────────────────────────────────

  // Keywords appearing anywhere (comments, strings, identifiers)
  const inferKeywords = ['database', 'persist', 'store data', 'users table', 'data store', 'sql'];
  let kwHits = 0;
  for (const kw of inferKeywords) {
    if (allContent.toLowerCase().includes(kw)) kwHits++;
  }
  if (kwHits > 0) {
    evidences.push({ tier: 'INFERRED', type: 'KEYWORD_SIGNAL', count: kwHits, confidence: 0.3 });
    inferredScore += Math.min(kwHits * 0.5, 1);
  }

  // UI/app patterns that strongly imply persistent state
  const persistencePatterns = [
    /\btodo\b|\btask(?:s)?\b|\bcheckbox\b/i,
    /\bauth(?:entication)?\b|\blogin\b|\bregister\b/i,
    /\bnote(?:s)?\s+app\b|\bcrud\s+app\b/i,
  ];
  if (persistencePatterns.some(p => p.test(allContent))) {
    evidences.push({ tier: 'INFERRED', type: 'UI_IMPLIES_PERSISTENCE', confidence: 0.25 });
    inferredScore += 1;
  }

  // ── Final decision ────────────────────────────────────────────────────────

  let tier;
  let finalDecision;

  if (hardScore >= 5) {
    tier = 'HARD';
    finalDecision = 'PASS';
  } else if (probableScore >= 3) {
    tier = 'PROBABLE';
    finalDecision = 'PASS_WITH_RISK';
  } else if (inferredScore >= 1 || probableScore > 0) {
    tier = 'INFERRED';
    finalDecision = 'FAIL';
  } else {
    tier = 'NONE';
    finalDecision = 'FAIL';
  }

  return { tier, hardScore, probableScore, inferredScore, finalDecision, evidences };
}

module.exports = { classifyDbEvidence };
