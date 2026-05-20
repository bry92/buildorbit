/**
 * Intent Gate Tests
 *
 * Covers all 7 test cases from the spec:
 *
 * | Test Case       | Input                                   | Expected              | Key Constraint |
 * |-----------------|-----------------------------------------|-----------------------|----------------|
 * | Landing page    | "Build a landing page for BuildOrbit"  | static_surface        | db=false, api=false, server=false |
 * | Waitlist form   | "Build a waitlist signup form"          | light_app             | server=true, db=maybe, auth=false |
 * | SaaS dashboard  | "Build a dashboard with user accounts" | full_product          | all=true |
 * | Docs site       | "Create a documentation page"          | static_surface        | db=false, server=false |
 * | Calculator      | "Build a mortgage calculator"           | light_app             | server=false, db=false |
 * | PLAN override   | PLAN tries to add db to static_surface | REJECTED              | Guardrail fires |
 * | SCAFFOLD violation | Scaffold includes migrations/ for static | REJECTED           | Constraint validation fires |
 *
 * NOTE: classify() is async (ACL Phase 2 — reads weight feedback from DB).
 * Tests pass no pool → graceful degradation → base contract returned unchanged.
 */

const {
  classify,
  validateScaffoldAgainstContract,
  validateCodeAgainstContract,
  formatConstraintBlock,
  CONTRACTS,
// Fix: was '../../agents/intent-gate' (pre-reorg root copy); now points to canonical src/ version
} = require('../../src/agents/intent-gate');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected "${expected}", got "${actual}"`);
  }
}

// ── Classification Tests ─────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Intent Gate Classification ===');

  await test('Landing page → static_surface', async () => {
    const contract = await classify('Build a landing page for BuildOrbit');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server');
    assertEqual(contract.constraints.db, false, 'db');
    assertEqual(contract.constraints.auth, false, 'auth');
    assertEqual(contract.constraints.api, false, 'api');
    assertEqual(contract.expansion_lock, true, 'expansion_lock');
    assertEqual(contract.complexity_budget, 'low', 'complexity_budget');
  });

  await test('Homepage → static_surface', async () => {
    const contract = await classify('Create a homepage for my startup');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server');
  });

  await test('Portfolio → static_surface', async () => {
    const contract = await classify('Build me a portfolio website');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
  });

  await test('Documentation page → static_surface', async () => {
    const contract = await classify('Create a documentation page for my API');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server');
    assertEqual(contract.constraints.db, false, 'db');
  });

  await test('Marketing site → static_surface', async () => {
    const contract = await classify('Build a marketing site for BuildOrbit');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
  });

  await test('Waitlist signup form → light_app', async () => {
    const contract = await classify('Build a waitlist signup form');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
    assertEqual(contract.constraints.server, true, 'server=true');
    assertEqual(contract.constraints.auth, false, 'auth=false');
    assertEqual(contract.expansion_lock, true, 'expansion_lock');
  });

  await test('Calculator → light_app', async () => {
    const contract = await classify('Build a mortgage calculator');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
  });

  await test('Contact form → light_app', async () => {
    const contract = await classify('Build a contact form for my website');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
    assertEqual(contract.constraints.auth, false, 'auth=false');
  });

  // Full product classification — PRODUCT_SYSTEM prompts must classify as full_product
  await test('Dashboard with user accounts → full_product', async () => {
    const contract = await classify('Build a dashboard with user accounts');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
    assertEqual(contract.constraints.auth, true, 'auth=true for full_product');
    assertEqual(contract.constraints.db, true, 'db=true for full_product');
    assertEqual(contract.constraints.server, true, 'server=true for full_product');
  });

  await test('SaaS app → full_product', async () => {
    const contract = await classify('Build a SaaS subscription platform');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
    assertEqual(contract.constraints.auth, true, 'auth=true');
    assertEqual(contract.expansion_lock, false, 'expansion_lock=false for full_product');
  });

  await test('Multi-tenant platform → full_product', async () => {
    const contract = await classify('Build a multi-tenant SaaS platform');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
    assertEqual(contract.complexity_budget, 'high', 'complexity_budget=high');
  });

  // Compound detection: PRODUCT_SYSTEM via multi-signal analysis
  await test('Auth + dashboard + stats → full_product (compound)', async () => {
    const contract = await classify('Build a task management app where users can sign up, log in, create tasks with titles and due dates, mark them complete, and delete them. Include a dashboard showing total tasks, completed count, and overdue count.');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
    assertEqual(contract.constraints.auth, true, 'auth=true');
    assertEqual(contract.constraints.db, true, 'db=true');
  });

  await test('Multi-entity (3+) → full_product (compound)', async () => {
    const contract = await classify('Build a project tracker with team members, task assignment, and kanban board');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
  });

  await test('Invoice generator with clients → full_product (compound)', async () => {
    const contract = await classify('Build an invoice generator with clients, line items, and payment status');
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
  });

  await test('Empty prompt → defaults to light_app', async () => {
    const contract = await classify('');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
  });

  await test('Null prompt → defaults to light_app', async () => {
    const contract = await classify(null);
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
  });

  // ── Misclassification regression tests (Report #596913) ──────────────────
  // These prompts were incorrectly classified as INTERACTIVE_LIGHT_APP (via
  // soft_expansion or light_app default). Fix: Phase 4 guard now protects
  // static_surface from soft expansion override, and new static surface
  // patterns catch product pages, blogs, and pricing pages.

  console.log('\n=== Misclassification Regression Tests (Report #596913) ===');

  await test('Landing page with email signup → static_surface (NOT soft_expansion)', async () => {
    const contract = await classify('Build a landing page for a fitness app with email signup');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server=false');
    assertEqual(contract.constraints.db, false, 'db=false');
  });

  await test('Landing page with email signup and pricing → static_surface', async () => {
    const contract = await classify('Build a landing page for a fitness app with email signup and a pricing section');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server=false');
    assertEqual(contract.constraints.db, false, 'db=false');
  });

  await test('Modern landing page variant → static_surface', async () => {
    const contract = await classify('Moder landing page for a fitness app with email signup and a pricing section');
    // "Moder" is a typo for "Modern" — still matches "landing page"
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
  });

  await test('Landing page with payment form → static_surface', async () => {
    const contract = await classify('Create a landing page with a payment form that charges $49');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server=false');
  });

  await test('E-commerce product page → static_surface', async () => {
    const contract = await classify('E-commerce product page');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server=false');
    assertEqual(contract.constraints.db, false, 'db=false');
  });

  await test('Blog with dark theme → static_surface', async () => {
    const contract = await classify('Blog with dark theme');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
    assertEqual(contract.constraints.server, false, 'server=false');
  });

  await test('Pricing page → static_surface', async () => {
    const contract = await classify('Build a pricing page for our service');
    assertEqual(contract.intent_class, 'static_surface', 'intent_class');
  });

  // ── Verify NO regression: prompts that should NOT be static_surface ──────

  await test('Task tracker app → still light_app (not static)', async () => {
    const contract = await classify('Build a task tracker app');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
  });

  await test('Calculator → still light_app (not static)', async () => {
    const contract = await classify('Build a tip calculator');
    assertEqual(contract.intent_class, 'light_app', 'intent_class');
  });

  await test('Blog with user accounts → still full_product (auth signal)', async () => {
    const contract = await classify('Build a blog with user accounts and sign up');
    // "user accounts" triggers FULL_PRODUCT_PATTERNS; blog pattern is Priority 2, not reached
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
  });

  await test('E-commerce with cart and checkout → still full_product', async () => {
    const contract = await classify('Build a full e-commerce platform with products, cart, checkout, and user accounts');
    // Multi-entity (products, cart, user) + auth triggers compound detection
    assertEqual(contract.intent_class, 'full_product', 'intent_class');
  });

  await test('Contract is deep copy — mutations do not affect template', async () => {
    const c1 = await classify('Build a landing page');
    const c2 = await classify('Build a landing page');
    c1.constraints.server = true; // mutate c1
    assertEqual(c2.constraints.server, false, 'c2 should be unaffected by c1 mutation');
    assertEqual(CONTRACTS.static_surface.constraints.server, false, 'template should be unaffected');
  });

  // ── Scaffold Constraint Validation ───────────────────────────────────────────

  console.log('\n=== Scaffold Constraint Validation ===');

  await test('Static surface scaffold with only HTML/CSS/JS → valid', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = { files: ['index.html', 'styles.css', 'script.js'] };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(result.valid, `Expected valid scaffold, got violations: ${result.violations.join('; ')}`);
    assertEqual(result.violations.length, 0, 'violations');
  });

  await test('Static surface scaffold with db/ files → REJECTED (constraint violation)', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = {
      files: ['index.html', 'styles.css', 'script.js', 'db/queries.js', 'migrations/001_schema.js']
    };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(!result.valid, 'Expected invalid — scaffold includes db files for static_surface');
    assert(result.violations.length > 0, 'Expected violations array to be non-empty');
    assert(result.violations[0].includes('db=false'), `Expected db=false in violation, got: ${result.violations[0]}`);
  });

  await test('Static surface scaffold with server.js → REJECTED', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = { files: ['index.html', 'styles.css', 'script.js', 'server.js', 'routes/api.js'] };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(!result.valid, 'Expected invalid — scaffold includes server.js for static_surface');
    assert(result.violations.some(v => v.includes('server=false')), 'Expected server=false violation');
  });

  await test('Static surface scaffold with auth files → REJECTED', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = { files: ['index.html', 'styles.css', 'middleware/auth.js'] };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(!result.valid, 'Expected invalid — auth=false but scaffold includes auth files');
  });

  await test('Light app scaffold with server.js → valid (server=true)', async () => {
    const contract = await classify('Build a waitlist signup form');
    const scaffold = {
      files: ['server.js', 'routes/api.js', 'package.json', 'index.html', 'styles.css', 'app.js']
    };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(result.valid, `Expected valid scaffold for light_app, got: ${result.violations.join('; ')}`);
  });

  await test('Full product scaffold is always valid (expansion_lock=false) — using CONTRACTS directly', async () => {
    // full_product is scope-locked via classify() during MVP, but the validation
    // logic itself still accepts full_product contracts (for internal/direct use).
    // Use CONTRACTS.full_product directly to test the validator in isolation.
    const contract = JSON.parse(JSON.stringify(CONTRACTS.full_product));
    const scaffold = {
      files: ['server.js', 'db/queries.js', 'migrations/001_schema.js', 'middleware/auth.js', 'routes/auth.js']
    };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(result.valid, `Expected valid scaffold for full_product, got: ${result.violations.join('; ')}`);
  });

  // ── Code Constraint Validation ────────────────────────────────────────────────

  console.log('\n=== Code Constraint Validation ===');

  await test('Static surface code with only HTML/CSS/JS → valid', async () => {
    const contract = await classify('Build a landing page');
    const code = {
      files: { 'index.html': '<html>...</html>', 'styles.css': '* {}', 'script.js': '// js' }
    };
    const result = validateCodeAgainstContract(code, contract);
    assert(result.valid, `Expected valid code output, got: ${result.violations.join('; ')}`);
  });

  await test('Static surface code with migrations/ → REJECTED (CONSTRAINT_VIOLATION_DETECTED)', async () => {
    const contract = await classify('Build a landing page');
    const code = {
      files: {
        'index.html': '<html>...</html>',
        'styles.css': '* {}',
        'script.js': '// js',
        'migrations/001_schema.js': 'exports.up = () => {}',
      }
    };
    const result = validateCodeAgainstContract(code, contract);
    assert(!result.valid, 'Expected invalid — migrations for static_surface');
    assert(result.violations.some(v => v.includes('db=false')), 'Expected db=false violation');
  });

  await test('Static surface code with server.js → REJECTED', async () => {
    const contract = await classify('Build a landing page');
    const code = {
      files: {
        'index.html': '<html>...',
        'server.js': 'const express = require("express");',
      }
    };
    const result = validateCodeAgainstContract(code, contract);
    assert(!result.valid, 'Expected invalid — server.js for static_surface');
    assert(result.violations.some(v => v.includes('server=false')), 'Expected server=false violation');
  });

  await test('Full product code with all layers → valid — using CONTRACTS directly', async () => {
    // full_product is scope-locked via classify() during MVP, but the code validator
    // still accepts full_product contracts. Use CONTRACTS directly to test in isolation.
    const contract = JSON.parse(JSON.stringify(CONTRACTS.full_product));
    const code = {
      files: {
        'server.js': 'const express = require("express");',
        'db/queries.js': 'module.exports = {};',
        'migrations/001_schema.js': 'exports.up = () => {};',
        'middleware/auth.js': 'module.exports = (req, res, next) => next();',
      }
    };
    const result = validateCodeAgainstContract(code, contract);
    assert(result.valid, 'Expected valid code output for full_product');
  });

  // ── formatConstraintBlock ─────────────────────────────────────────────────────

  console.log('\n=== formatConstraintBlock ===');

  await test('formatConstraintBlock returns non-empty string for static_surface', async () => {
    const contract = await classify('Build a landing page');
    const block = formatConstraintBlock(contract);
    assert(typeof block === 'string' && block.length > 0, 'Expected non-empty string');
    assert(block.includes('CONSTRAINT CONTRACT'), 'Expected header');
    assert(block.includes('static_surface'), 'Expected intent class');
    assert(block.includes('server:') && block.includes('false'), 'Expected server: false in constraints');
    assert(block.includes('db:') && block.includes('false'), 'Expected db: false in constraints');
    assert(block.includes('HARD RULES'), 'Expected HARD RULES section for expansion_lock');
  });

  await test('formatConstraintBlock includes expansion lock warning when lock=true', async () => {
    const contract = await classify('Build a landing page');
    const block = formatConstraintBlock(contract);
    assert(block.includes('expansion_lock') || block.includes('Expansion Lock'), 'expansion_lock present');
    assert(block.includes('HARD RULES'), 'Hard rules section present for locked contract');
  });

  await test('formatConstraintBlock returns empty string for null contract', async () => {
    const block = formatConstraintBlock(null);
    assertEqual(block, '', 'Expected empty string for null');
  });

  await test('formatConstraintBlock for full_product has no prohibited layers — using CONTRACTS directly', async () => {
    // full_product is scope-locked via classify() during MVP, but formatConstraintBlock
    // still works on full_product contracts (for reference/display). Use CONTRACTS directly.
    const contract = JSON.parse(JSON.stringify(CONTRACTS.full_product));
    const block = formatConstraintBlock(contract);
    assert(!block.includes('Prohibited Layers'), 'No prohibited layers for full_product');
  });

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('\n');
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
  console.log('');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
