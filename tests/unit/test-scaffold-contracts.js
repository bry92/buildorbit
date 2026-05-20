// Fix: was '../../stage-contracts' (pre-reorg root copy); now points to canonical src/core/ version
const { validateScaffoldManifest, validateCodeAgainstScaffold, ContractValidationError, buildStageInput } = require('../../src/core/stage-contracts');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

const validScaffold = {
  tree: [],
  techStack: ['express', 'pg'],
  summary: 'test',
  files: ['server.js', 'package.json', 'routes/api.js'],
  structure: { '/': ['server.js', 'package.json'], '/routes': ['api.js'] },
  constraints: { hasServer: true, hasFrontend: false, entry: 'server.js', techStack: ['express', 'pg'] }
};

console.log('\n=== Scaffold Manifest Validation ===');

test('Valid scaffold manifest passes', () => {
  validateScaffoldManifest(validScaffold);
});

test('Empty files[] is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, files: [] });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Missing constraints is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: null });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Missing entry in constraints is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: { ...validScaffold.constraints, entry: '' } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Entry point not in files list is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: { ...validScaffold.constraints, entry: 'nonexistent.js' } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.violations.some(v => v.includes('not found')), 'should mention entry not found');
  }
});

console.log('\n=== CODE Input Hard Gate ===');

test('CODE blocked without scaffold', () => {
  try {
    buildStageInput('code', 'test', { plan: { subtasks: [] } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations[0].includes('SCAFFOLD manifest missing'), 'wrong message');
  }
});

test('CODE blocked with empty scaffold.files', () => {
  try {
    buildStageInput('code', 'test', { plan: {}, scaffold: { files: [] } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('CODE passes with valid scaffold', () => {
  buildStageInput('code', 'test', { plan: {}, scaffold: validScaffold });
});

console.log('\n=== Post-CODE Validation Against Scaffold ===');

test('All files present = valid', () => {
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'routes/api.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid, 'should be valid');
  assert(result.missingFiles.length === 0, 'no missing files');
});

test('Missing file detected', () => {
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid === false, 'should be invalid');
  assert(result.missingFiles.includes('routes/api.js'), 'should report missing file');
});

test('Frontend path normalization: public/x matches x', () => {
  const scaffold = { ...validScaffold, files: ['server.js', 'public/index.html', 'public/styles.css'] };
  const codeOutput = { files: { 'server.js': 'code', 'index.html': 'code', 'styles.css': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.valid, 'should be valid with normalized paths — missing: ' + result.missingFiles.join(','));
});

test('Reverse normalization: x matches public/x', () => {
  const scaffold = { ...validScaffold, files: ['server.js', 'index.html', 'styles.css'] };
  const codeOutput = { files: { 'server.js': 'code', 'public/index.html': 'code', 'public/styles.css': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.valid, 'should be valid with reverse normalized paths — missing: ' + result.missingFiles.join(','));
});

test('Entry point missing from CODE output detected', () => {
  const codeOutput = { files: { 'package.json': 'code', 'routes/api.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid === false, 'should be invalid');
  assert(result.errors.some(e => e.includes('Entry point')), 'should mention entry point');
});

test('Entry point public/index.html normalizes to index.html in CODE output', () => {
  const scaffold = {
    ...validScaffold,
    files: ['server.js', 'package.json', 'public/index.html', 'public/styles.css', 'public/app.js'],
    constraints: { ...validScaffold.constraints, entry: 'public/index.html' }
  };
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'index.html': 'code', 'styles.css': 'code', 'app.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(!result.errors.some(e => e.includes('Entry point')), 'should NOT report entry point missing when public/index.html matches index.html — errors: ' + result.errors.join('; '));
});

test('PRODUCT_SYSTEM scaffold with migrate.js and db/queries.js detects missing files', () => {
  const scaffold = {
    ...validScaffold,
    files: ['server.js', 'package.json', 'migrate.js', 'routes/api.js', 'db/queries.js', 'migrations/001_schema.js', 'public/index.html', 'public/styles.css', 'public/app.js'],
    constraints: { ...validScaffold.constraints, entry: 'public/index.html' }
  };
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'routes/api.js': 'code', 'migrations/001_schema.js': 'code', 'index.html': 'code', 'styles.css': 'code', 'app.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.missingFiles.includes('migrate.js'), 'should detect missing migrate.js');
  assert(result.missingFiles.includes('db/queries.js'), 'should detect missing db/queries.js');
  assert(!result.errors.some(e => e.includes('Entry point')), 'should NOT report entry point missing — errors: ' + result.errors.join('; '));
});

console.log('\n=== Builder Agent Scaffold Contract Block ===');

test('Builder agent generates scaffold contract block', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const block = agent._buildScaffoldContractBlock(
    ['server.js', 'package.json'],
    { hasServer: true, hasFrontend: true, entry: 'server.js', techStack: ['express', 'pg'] },
    { '/': ['server.js', 'package.json'] }
  );
  assert(block.includes('SCAFFOLD CONTRACT'), 'should contain contract header');
  assert(block.includes('server.js'), 'should list files');
  assert(block.includes('DO NOT DEVIATE'), 'should be binding language');
  assert(block.includes('Entry point: server.js'), 'should mention entry');
});

test('Builder agent scaffold output includes manifest fields', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const plan = { estimatedComplexity: 'medium' };

  const result = await agent._executeScaffold('test app', plan, emitChunk);

  // Verify new manifest fields exist
  assert(Array.isArray(result.files), 'should have files array');
  assert(result.files.length > 0, 'files should not be empty');
  assert(typeof result.structure === 'object', 'should have structure object');
  assert(Object.keys(result.structure).length > 0, 'structure should not be empty');
  assert(typeof result.constraints === 'object', 'should have constraints object');
  assert(result.constraints.hasServer === true, 'should detect server');
  assert(result.constraints.entry === 'server.js', 'entry should be server.js');
  assert(Array.isArray(result.constraints.techStack), 'techStack should be array');

  // Verify backward-compatible fields still exist
  assert(Array.isArray(result.tree), 'should have tree array');
  assert(Array.isArray(result.techStack), 'should have techStack array');
  assert(typeof result.summary === 'string', 'should have summary string');

  // Verify manifest passes deep validation
  validateScaffoldManifest(result);
});

console.log('\n=== PRODUCT_SYSTEM (full_product) Schema Validation ===');

// Full valid full_product scaffold — includes all required_files
const validFullProduct = {
  tree: [],
  techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'],
  summary: 'SaaS app',
  files: [
    'server.js', 'package.json', '.env.example', 'migrate.js',
    'routes/api.js', 'routes/auth.js',
    'middleware/auth.js', 'middleware/error.js',
    'models/index.js',
    'db/queries.js', 'db/pool.js',
    'migrations/001_schema.js',
    'public/index.html', 'public/styles.css', 'public/app.js',
  ],
  structure: {
    '/': ['server.js', 'package.json', '.env.example', 'migrate.js'],
    '/routes': ['api.js', 'auth.js'],
    '/middleware': ['auth.js', 'error.js'],
    '/models': ['index.js'],
    '/db': ['queries.js', 'pool.js'],
    '/migrations': ['001_schema.js'],
    '/public': ['index.html', 'styles.css', 'app.js'],
  },
  constraints: {
    hasServer: true,
    hasFrontend: true,
    hasAuth: true,
    hasDb: true,
    entry: 'server.js',
    techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'],
  },
};

test('PRODUCT_SYSTEM scaffold with all required files passes', () => {
  validateScaffoldManifest(validFullProduct, 'full_product');
});

test('PRODUCT_SYSTEM scaffold missing server.js is rejected', () => {
  // Remove server.js — violates both entry-point check AND required_files
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== 'server.js'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type: ' + e.name);
  }
});

test('PRODUCT_SYSTEM scaffold missing package.json is rejected', () => {
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== 'package.json'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations.some(v => v.includes('package.json')), 'should mention package.json');
  }
});

test('PRODUCT_SYSTEM scaffold missing .env.example is rejected', () => {
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== '.env.example'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations.some(v => v.includes('.env.example')), 'should mention .env.example');
  }
});

test('full_product schema has required_files defined', () => {
  const { SCAFFOLD_SCHEMAS } = require('../../src/lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(Array.isArray(schema.required_files), 'required_files should be array');
  assert(schema.required_files.includes('server.js'), 'should require server.js');
  assert(schema.required_files.includes('package.json'), 'should require package.json');
  assert(schema.required_files.includes('.env.example'), 'should require .env.example');
});

test('full_product schema directories include models', () => {
  const { SCAFFOLD_SCHEMAS } = require('../../src/lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(schema.directories.includes('models'), 'models should be in directories');
});

test('full_product schema techStack includes dotenv', () => {
  const { SCAFFOLD_SCHEMAS } = require('../../src/lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(schema.techStack.includes('dotenv'), 'dotenv should be in techStack');
});

test('Builder agent high-complexity scaffold includes required PRODUCT_SYSTEM files', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  // Force high complexity to get the full_product tree
  const plan = { estimatedComplexity: 'high' };

  const result = await agent._executeScaffold('SaaS app with user auth and dashboard', plan, emitChunk);

  assert(result.files.includes('server.js'), 'missing server.js');
  assert(result.files.includes('package.json'), 'missing package.json');
  assert(result.files.includes('.env.example'), 'missing .env.example');
  assert(result.files.includes('middleware/auth.js'), 'missing middleware/auth.js');
  assert(result.files.includes('middleware/error.js'), 'missing middleware/error.js');
  assert(result.files.includes('models/index.js'), 'missing models/index.js');
  assert(result.files.includes('migrations/001_schema.js'), 'missing migrations/001_schema.js');
  assert(result.constraints.techStack.includes('dotenv'), 'techStack missing dotenv');
  // Validate it passes the full manifest validation as a full_product schema
  validateScaffoldManifest(result, 'full_product');
});

console.log('\n=== Soft Expansion DB Scaffold (task #1278754 regression) ===');

// Minimal soft_expansion contract: light_app base + full_product candidate + db authorized
const makeSoftExpansionContract = (justifiedCaps = []) => ({
  task_type:            'soft_expansion',
  intent_class:         'soft_expansion',
  base_class:           'light_app',
  expansion_candidate:  'full_product',
  constraints:          { server: true, db: false, auth: false },
  allowed_artifacts:    [],
  prohibited_layers:    [],
  complexity_budget:    'high',
  expansion_lock:       true,
  soft_expansion: {
    auth: { allowed: true, scope: 'minimal_auth_no_roles' },
    db:   { allowed: true, scope: 'single_table_only' },
  },
  // Simulated plan justifications injected directly into contract for test
  _test_plan_justifications: justifiedCaps,
});

test('soft_expansion with db justified → scaffold includes db/database.js', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeSoftExpansionContract(['db']);

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [
      { capability: 'db', reason: 'Task manager requires persistent storage', scope: 'single_table_only' },
    ],
    subtasks: [
      { id: 1, title: 'Build task CRUD API', description: 'REST endpoints for task management with database' },
    ],
  };

  const result = await agent._executeScaffold('Build a task manager with user authentication', plan, emitChunk, contract);

  assert(result.files.includes('db/database.js'), 'missing db/database.js — soft_expansion db contract not honored');
  assert(result.files.includes('server.js'), 'missing server.js');
  assert(result.files.includes('routes/api.js'), 'missing routes/api.js');
  assert(result.constraints.hasDb === true, 'hasDb should be true');
  assert(result.constraints.techStack.includes('better-sqlite3'), 'techStack missing better-sqlite3');
  assert(!result.files.includes('middleware/auth.js'), 'auth not justified — should not include auth middleware');
});

test('soft_expansion with db + auth justified → scaffold includes db AND auth files', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeSoftExpansionContract(['db', 'auth']);

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [
      { capability: 'db',   reason: 'Persistent task storage',     scope: 'single_table_only' },
      { capability: 'auth', reason: 'User login required',         scope: 'minimal_auth_no_roles' },
    ],
    subtasks: [
      { id: 1, title: 'Build auth system', description: 'User login with JWT and database' },
    ],
  };

  const result = await agent._executeScaffold('Build a task manager with user authentication', plan, emitChunk, contract);

  assert(result.files.includes('db/database.js'), 'missing db/database.js');
  assert(result.files.includes('routes/auth.js'), 'missing routes/auth.js — auth expansion not honored');
  assert(result.files.includes('middleware/auth.js'), 'missing middleware/auth.js');
  assert(result.constraints.hasAuth === true, 'hasAuth should be true');
  assert(result.constraints.techStack.includes('jsonwebtoken'), 'techStack missing jsonwebtoken');
  assert(result.constraints.techStack.includes('bcrypt'), 'techStack missing bcrypt');
});

test('soft_expansion WITHOUT db justified → no db files (light_app scaffold)', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeSoftExpansionContract([]);  // no justifications

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [],  // PLAN did not justify db
    subtasks: [
      { id: 1, title: 'Build simple form', description: 'Contact form with in-memory storage' },
    ],
  };

  const result = await agent._executeScaffold('A simple contact form app', plan, emitChunk, contract);

  // Should stay on light_app scaffold (no db files)
  assert(!result.files.some(f => f.includes('db/')), 'db/ files should NOT be present when db not justified');
  assert(!result.files.includes('db/database.js'), 'db/database.js should not exist when db not justified');
});

test('soft_expansion db scaffold passes validateScaffoldManifest', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeSoftExpansionContract(['db']);

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [
      { capability: 'db', reason: 'Task storage', scope: 'single_table_only' },
    ],
    subtasks: [{ id: 1, title: 'Setup DB', description: 'Create database schema' }],
  };

  const result = await agent._executeScaffold('Build a full-stack SEO tool', plan, emitChunk, contract);

  // Manifest must pass basic validation (entry point, constraints, file list)
  validateScaffoldManifest(result);
  assert(result.constraints.hasDb === true, 'hasDb should be true');
  assert(result.files.length >= 5, `should have at least 5 files, got ${result.files.length}`);
});

console.log('\n=== Entry Point Mismatch Fix (task #1279684 regression) ===');

// Soft expansion contract with static_surface base + server expansion
const makeStaticSurfaceExpansionContract = (justifiedCaps = []) => ({
  task_type:            'soft_expansion',
  intent_class:         'soft_expansion',
  base_class:           'static_surface',
  expansion_candidate:  'light_app',
  constraints:          { frontend: true, server: false, db: false, auth: false },
  allowed_artifacts:    ['html', 'css', 'js'],
  prohibited_layers:    ['database', 'migrations', 'backend_services'],
  complexity_budget:    'medium',
  expansion_lock:       true,
  soft_expansion: {
    server: { allowed: true, scope: 'minimal_handler_only' },
    api:    { allowed: true, scope: 'single_endpoint' },
  },
  _test_plan_justifications: justifiedCaps,
});

test('soft_expansion static_surface+server → light_app scaffold (not fullstack default)', async () => {
  // This is the PRIMARY fix for task #1279684: before the fix, soft_expansion with
  // base_class='static_surface' + server justified (no db) fell through ALL scaffold
  // conditions to the default fullstack branch, generating migrate.js, db/queries.js,
  // and public/index.html — causing 20 pipeline crashes.
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeStaticSurfaceExpansionContract(['server']);

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [
      { capability: 'server', reason: 'Need Express server for API endpoint', scope: 'minimal_handler_only' },
    ],
    subtasks: [
      { id: 1, title: 'Build tip calculator', description: 'Interactive calculator with minimal API' },
    ],
  };

  const result = await agent._executeScaffold('Build a tip calculator', plan, emitChunk, contract);

  // MUST NOT have fullstack-only files (the crash pattern)
  assert(!result.files.includes('migrate.js'), 'migrate.js must NOT be in light_app scaffold (was crashing before fix)');
  assert(!result.files.includes('db/queries.js'), 'db/queries.js must NOT be in light_app scaffold (was crashing before fix)');
  assert(!result.files.includes('db/pool.js'), 'db/pool.js must NOT be in light_app scaffold');
  assert(!result.files.includes('migrations/001_schema.js'), 'migrations must NOT be in light_app scaffold');

  // MUST have light_app files
  assert(result.files.includes('server.js'), 'missing server.js');
  assert(result.files.includes('package.json'), 'missing package.json');
  assert(result.files.includes('index.html'), 'missing index.html (root-level, not public/index.html)');
  assert(result.files.includes('routes/api.js'), 'missing routes/api.js');

  // Entry point must be index.html (not public/index.html or server.js)
  assert(result.constraints.entry === 'index.html', `entry should be "index.html", got "${result.constraints.entry}"`);
});

test('soft_expansion static_surface+server scaffold passes validateScaffoldManifest', async () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const contract = makeStaticSurfaceExpansionContract(['server']);

  const plan = {
    estimatedComplexity: 'medium',
    expansion_justifications: [
      { capability: 'server', reason: 'API endpoint needed', scope: 'minimal_handler_only' },
    ],
    subtasks: [{ id: 1, title: 'Build form', description: 'Contact form with API' }],
  };

  const result = await agent._executeScaffold('Build a SaaS dashboard', plan, emitChunk, contract);
  validateScaffoldManifest(result);
  assert(result.files.length >= 5, `should have at least 5 files, got ${result.files.length}`);
});

test('_detectEntryPoint prefers scaffold entry hint over server.js', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  // When scaffold says 'index.html' and both server.js and index.html exist
  const files = {
    'server.js': 'const express = require("express");',
    'index.html': '<!DOCTYPE html>',
    'styles.css': 'body {}',
    'app.js': 'console.log("hi");',
  };

  // Without hint: prefers server.js (old behavior)
  const noHint = agent._detectEntryPoint(files);
  assert(noHint === 'server.js', `without hint should return server.js, got "${noHint}"`);

  // With hint: prefers scaffold entry
  const withHint = agent._detectEntryPoint(files, 'index.html');
  assert(withHint === 'index.html', `with hint should return index.html, got "${withHint}"`);

  // With public/ hint: normalizes to bare filename
  const publicHint = agent._detectEntryPoint(files, 'public/index.html');
  assert(publicHint === 'index.html', `public/ hint should normalize to index.html, got "${publicHint}"`);
});

test('_detectEntryPoint falls back when scaffold entry not in files', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const files = {
    'server.js': 'const express = require("express");',
    'styles.css': 'body {}',
  };

  // Scaffold says index.html but it doesn't exist → fall back to server.js
  const result = agent._detectEntryPoint(files, 'index.html');
  assert(result === 'server.js', `should fall back to server.js, got "${result}"`);
});

// === _enforceManifest: throwOnMissing behavior ===
console.log('\n=== _enforceManifest: throwOnMissing behavior ===');

test('_enforceManifest throws by default when manifest files are missing', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const files = {
    'server.js': 'const express = require("express");',
    'package.json': '{}',
    'index.html': '<!DOCTYPE html>',
    'styles.css': 'body {}',
    'app.js': 'console.log("hi");',
    'routes/api.js': 'module.exports = router;',
  };
  const manifest = ['server.js', 'package.json', '.env.example', 'routes/api.js', 'db/database.js', 'index.html', 'styles.css', 'app.js'];

  try {
    agent._enforceManifest(files, manifest);
    throw new Error('should have thrown PARITY VIOLATION');
  } catch (e) {
    assert(e.message.includes('SCAFFOLD MANIFEST PARITY VIOLATION'), 'should throw parity violation, got: ' + e.message);
    assert(e.message.includes('.env.example'), 'error should mention .env.example');
    assert(e.message.includes('db/database.js'), 'error should mention db/database.js');
  }
});

test('_enforceManifest with throwOnMissing=false does NOT throw when manifest files are missing', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const files = {
    'server.js': 'const express = require("express");',
    'package.json': '{}',
    'index.html': '<!DOCTYPE html>',
    'styles.css': 'body {}',
    'app.js': 'console.log("hi");',
    'routes/api.js': 'module.exports = router;',
  };
  const manifest = ['server.js', 'package.json', '.env.example', 'routes/api.js', 'db/database.js', 'index.html', 'styles.css', 'app.js'];

  // Should NOT throw — returns partial file set for downstream gap-fill
  const result = agent._enforceManifest(files, manifest, { throwOnMissing: false });
  assert(Object.keys(result).length === 6, `should return 6 files, got ${Object.keys(result).length}`);
  assert(!result['.env.example'], 'should not magically create .env.example');
  assert(!result['db/database.js'], 'should not magically create db/database.js');
  assert(result['server.js'], 'should keep server.js');
  assert(result['routes/api.js'], 'should keep routes/api.js');
});

test('_enforceManifest with throwOnMissing=false still strips non-manifest files', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const files = {
    'server.js': 'code',
    'package.json': '{}',
    'index.html': 'html',
    'styles.css': 'css',
    'app.js': 'js',
    'extra-file.js': 'should be stripped',
    'config/secret.js': 'should be stripped',
  };
  const manifest = ['server.js', 'package.json', 'index.html', 'styles.css', 'app.js'];

  const result = agent._enforceManifest(files, manifest, { throwOnMissing: false });
  assert(Object.keys(result).length === 5, `should return 5 files, got ${Object.keys(result).length}`);
  assert(!result['extra-file.js'], 'should strip extra-file.js');
  assert(!result['config/secret.js'], 'should strip config/secret.js');
});

test('_enforceManifest with throwOnMissing=false still applies equivalence mapping', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  // Manifest wants app.js but CODE generated script.js
  const files = {
    'server.js': 'code',
    'package.json': '{}',
    'index.html': 'html',
    'styles.css': 'css',
    'script.js': 'js code',
  };
  const manifest = ['server.js', 'package.json', 'index.html', 'styles.css', 'app.js'];

  const result = agent._enforceManifest(files, manifest, { throwOnMissing: false });
  assert(result['app.js'] === 'js code', 'should rename script.js → app.js');
  assert(!result['script.js'], 'script.js should be gone after rename');
});

test('_enforceManifest with throwOnMissing=true (default) still works for complete manifests', () => {
  const { BuilderAgent } = require('../../src/agents/builder-agent');
  const agent = new BuilderAgent();

  const files = {
    'server.js': 'code',
    'package.json': '{}',
    '.env.example': 'DATABASE_URL=...',
    'routes/api.js': 'router code',
    'db/database.js': 'db code',
    'index.html': 'html',
    'styles.css': 'css',
    'app.js': 'js',
  };
  const manifest = ['server.js', 'package.json', '.env.example', 'routes/api.js', 'db/database.js', 'index.html', 'styles.css', 'app.js'];

  // Should NOT throw — all files present
  const result = agent._enforceManifest(files, manifest);
  assert(Object.keys(result).length === 8, `should return all 8 files, got ${Object.keys(result).length}`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
