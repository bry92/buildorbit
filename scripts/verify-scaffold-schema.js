#!/usr/bin/env node
/**
 * Verification script for scaffold schema polymorphism fix.
 * Tests that intent_class properly selects scaffold schema BEFORE generation.
 *
 * Run: node scripts/verify-scaffold-schema.js
 */

const { getScaffoldSchema, validateConstraintsAgainstSchema, SCAFFOLD_SCHEMAS } = require('../lib/scaffold-schemas');
const { classify, validateScaffoldAgainstContract } = require('../agents/intent-gate');
const { validateScaffoldManifest } = require('../stage-contracts');

let passed = 0;
let failed = 0;

// Support both sync and async test functions (classify() is async)
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runAllTests() {
  // ── Test 1: Schema Registry ─────────────────────────────────────────────────
  console.log('\n--- Schema Registry ---');

  await test('static_surface schema has entry=index.html', () => {
    const schema = getScaffoldSchema('static_surface');
    assert(schema.entry === 'index.html', `Got ${schema.entry}`);
  });

  await test('static_surface schema has techStack with html,css,js', () => {
    const schema = getScaffoldSchema('static_surface');
    assert(schema.techStack.includes('html') && schema.techStack.includes('css') && schema.techStack.includes('js'),
      `Got ${JSON.stringify(schema.techStack)}`);
  });

  await test('static_surface schema has server=false', () => {
    const schema = getScaffoldSchema('static_surface');
    assert(schema.server === false, `Got ${schema.server}`);
  });

  await test('full_product schema has entry=server.js', () => {
    const schema = getScaffoldSchema('full_product');
    assert(schema.entry === 'server.js', `Got ${schema.entry}`);
  });

  await test('light_app schema has entry=index.html', () => {
    const schema = getScaffoldSchema('light_app');
    assert(schema.entry === 'index.html', `Got ${schema.entry}`);
  });

  await test('unknown intent defaults to light_app', () => {
    const schema = getScaffoldSchema('unknown_class');
    assert(schema.entry === 'index.html', `Got ${schema.entry}`);
  });

  // ── Test 2: Schema Validation ───────────────────────────────────────────────
  console.log('\n--- Schema Validation ---');

  await test('static_surface + entry=server.js → INVALID', () => {
    const result = validateConstraintsAgainstSchema(
      { entry: 'server.js', techStack: ['html', 'css', 'js'], hasServer: false },
      'static_surface'
    );
    assert(!result.valid, 'Should be invalid');
    assert(result.violations.length > 0, 'Should have violations');
  });

  await test('static_surface + entry=index.html → VALID', () => {
    const result = validateConstraintsAgainstSchema(
      { entry: 'index.html', techStack: ['html', 'css', 'js'], hasServer: false },
      'static_surface'
    );
    assert(result.valid, `Violations: ${result.violations.join('; ')}`);
  });

  await test('static_surface + techStack with express → INVALID', () => {
    const result = validateConstraintsAgainstSchema(
      { entry: 'index.html', techStack: ['express', 'pg'], hasServer: false },
      'static_surface'
    );
    assert(!result.valid, 'Should detect prohibited techStack');
  });

  await test('full_product + entry=server.js → VALID', () => {
    const result = validateConstraintsAgainstSchema(
      { entry: 'server.js', techStack: ['express', 'pg'], hasServer: true },
      'full_product'
    );
    assert(result.valid, `Violations: ${result.violations.join('; ')}`);
  });

  // ── Test 3: Scaffold Manifest Validation (schema-aware) ────────────────────
  console.log('\n--- Scaffold Manifest Validation (schema-aware) ---');

  await test('static_surface scaffold with entry=index.html passes manifest validation', () => {
    const scaffold = {
      files: ['index.html', 'styles.css', 'script.js'],
      structure: { '/': ['index.html', 'styles.css', 'script.js'] },
      constraints: {
        hasServer: false,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'index.html',
        techStack: ['html', 'css', 'js'],
      },
    };
    // Should NOT throw
    validateScaffoldManifest(scaffold, 'static_surface');
  });

  await test('static_surface scaffold with entry=server.js FAILS manifest validation', () => {
    const scaffold = {
      files: ['index.html', 'styles.css', 'script.js'],
      structure: { '/': ['index.html', 'styles.css', 'script.js'] },
      constraints: {
        hasServer: false,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'server.js',
        techStack: ['html', 'css', 'js'],
      },
    };
    let threw = false;
    try {
      validateScaffoldManifest(scaffold, 'static_surface');
    } catch (e) {
      threw = true;
      assert(e.message.includes('entry'), `Expected entry violation, got: ${e.message}`);
    }
    assert(threw, 'Should have thrown ContractValidationError');
  });

  await test('full_product scaffold with entry=server.js passes manifest validation', () => {
    const scaffold = {
      files: ['server.js', 'package.json', 'routes/api.js', 'public/index.html'],
      structure: { '/': ['server.js', 'package.json'], '/routes': ['api.js'], '/public': ['index.html'] },
      constraints: {
        hasServer: true,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'server.js',
        techStack: ['express', 'pg'],
      },
    };
    validateScaffoldManifest(scaffold, 'full_product');
  });

  // ── Test 4: End-to-End (Intent Gate → Schema → Constraints) ────────────────
  console.log('\n--- End-to-End Flow ---');

  await test('"Build a landing page" → static_surface → entry=index.html', async () => {
    const contract = await classify('Build a landing page');
    assert(contract.intent_class === 'static_surface', `Got ${contract.intent_class}`);
    const schema = getScaffoldSchema(contract.intent_class);
    assert(schema.entry === 'index.html', `Schema entry: ${schema.entry}`);
    assert(schema.techStack.length > 0, 'techStack should not be empty');
  });

  await test('"Build SaaS dashboard with user accounts" → scope_locked (MVP) → light_app fallback', async () => {
    const contract = await classify('Build SaaS dashboard with user accounts');
    // full_product is scope-locked during MVP — falls back to light_app
    assert(contract.intent_class === 'light_app' || contract.intent_class === 'full_product',
      `Got ${contract.intent_class}`);
  });

  await test('"Build a waitlist form" → light_app → entry=index.html', async () => {
    const contract = await classify('Build a waitlist form');
    assert(contract.intent_class === 'light_app', `Got ${contract.intent_class}`);
    const schema = getScaffoldSchema(contract.intent_class);
    assert(schema.entry === 'index.html', `Schema entry: ${schema.entry}`);
  });

  await test('IMPOSSIBLE: force static_surface + entry=server.js → schema prevents it', () => {
    const schema = getScaffoldSchema('static_surface');
    const badConstraints = { entry: 'server.js', techStack: ['express'], hasServer: true };
    const check = validateConstraintsAgainstSchema(badConstraints, 'static_surface');
    assert(!check.valid, 'Must be invalid');
    assert(check.violations.length >= 2, `Expected multiple violations, got ${check.violations.length}`);
  });

  // ── Test 5: Contract + Scaffold Integration ────────────────────────────────
  console.log('\n--- Contract + Scaffold Integration ---');

  await test('static_surface scaffold passes both manifest + contract validation', async () => {
    const contract = await classify('Build a portfolio');
    const scaffold = {
      files: ['index.html', 'styles.css', 'script.js'],
      structure: { '/': ['index.html', 'styles.css', 'script.js'] },
      constraints: {
        hasServer: false,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'index.html',
        techStack: ['html', 'css', 'js'],
      },
    };
    validateScaffoldManifest(scaffold, contract.intent_class);
    const contractCheck = validateScaffoldAgainstContract(scaffold, contract);
    assert(contractCheck.valid, `Contract violations: ${contractCheck.violations.join('; ')}`);
  });

  // ── Test 6: Entry point normalization for server-based scaffolds ──────────
  console.log('\n--- Entry Point Normalization (NEW) ---');

  await test('light_app scaffold with entry=index.html + public/index.html in files passes', () => {
    const scaffold = {
      files: ['server.js', 'package.json', 'routes/api.js', 'public/index.html', 'public/styles.css', 'public/app.js'],
      structure: { '/': ['server.js', 'package.json'], '/routes': ['api.js'], '/public': ['index.html', 'styles.css', 'app.js'] },
      constraints: {
        hasServer: true,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'index.html',
        techStack: ['express', 'pg'],
      },
    };
    // Path normalization: entry=index.html should match public/index.html in files
    validateScaffoldManifest(scaffold, 'light_app');
  });

  await test('light_app scaffold with entry=public/index.html passes manifest validation', () => {
    const scaffold = {
      files: ['server.js', 'package.json', 'routes/api.js', 'public/index.html', 'public/styles.css', 'public/app.js'],
      structure: { '/': ['server.js', 'package.json'], '/routes': ['api.js'], '/public': ['index.html', 'styles.css', 'app.js'] },
      constraints: {
        hasServer: true,
        hasFrontend: true,
        hasAuth: false,
        hasDb: false,
        entry: 'public/index.html',
        techStack: ['express', 'pg'],
      },
    };
    // Entry IS directly in files list
    validateScaffoldManifest(scaffold, 'light_app');
  });

  await test('entry=index.html with no matching file in files list FAILS', () => {
    const scaffold = {
      files: ['server.js', 'package.json'],
      structure: { '/': ['server.js', 'package.json'] },
      constraints: {
        hasServer: true,
        hasFrontend: false,
        hasAuth: false,
        hasDb: false,
        entry: 'index.html',
        techStack: ['express', 'pg'],
      },
    };
    let threw = false;
    try {
      validateScaffoldManifest(scaffold, 'light_app');
    } catch (e) {
      threw = true;
      assert(e.message.includes('Entry point'), `Expected entry point violation, got: ${e.message}`);
    }
    assert(threw, 'Should have thrown when entry point truly missing');
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
