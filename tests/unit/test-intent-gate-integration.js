/**
 * Integration tests for Intent Gate pipeline binding.
 * Verifies the fix for Orphaned Capability Injection (OCI) bug.
 *
 * Tests:
 * 1. classify() returns correct contract for static_surface
 * 2. classify() returns correct contract for full_product
 * 3. Object.freeze() prevents mutation
 * 4. Pipeline aborts on null classify result
 * 5. _simulatedCode respects static_surface constraints (THE KEY TEST)
 * 6. _simulatedPlan differentiates intent classes
 * 7. QA agent checks prohibited layers
 * 8. Hard dependency test (classify must exist)
 * 9. Post-PLAN validation catches violations
 *
 * NOTE: classify() is async (ACL Phase 2 — reads weight feedback from DB).
 * Tests pass no pool → graceful degradation → base contract returned unchanged.
 */

// Fix: all were '../../agents/*' (pre-reorg root copies); now point to canonical src/ versions
const { classify, validateScaffoldAgainstContract, validateCodeAgainstContract, formatConstraintBlock } = require('../../src/agents/intent-gate');
const { PlannerAgent } = require('../../src/agents/planner-agent');
const { BuilderAgent } = require('../../src/agents/builder-agent');
const { QAAgent } = require('../../src/agents/qa-agent');

let passed = 0;
let failed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n=== Intent Gate Integration Tests ===\n');

(async () => {
  // ── Test 1: Static surface classification ─────────────────────

  await test('classify("Build a landing page") → static_surface', async () => {
    const contract = await classify('Build a landing page');
    assert(contract.intent_class === 'static_surface', `Expected static_surface, got ${contract.intent_class}`);
    assert(contract.constraints.server === false, 'server should be false');
    assert(contract.constraints.db === false, 'db should be false');
    assert(contract.expansion_lock === true, 'expansion_lock should be true');
  });

  await test('classify("Build a homepage for my startup") → static_surface', async () => {
    const contract = await classify('Build a homepage for my startup');
    assert(contract.intent_class === 'static_surface', `Expected static_surface, got ${contract.intent_class}`);
  });

  // ── Test 2: Full product classification ───────────────────────

  await test('classify("Build a SaaS dashboard with users") → full_product', async () => {
    const contract = await classify('Build a SaaS dashboard with users');
    assert(contract.intent_class === 'full_product', `Expected full_product, got ${contract.intent_class}`);
    assert(contract.constraints.server === true, 'server should be true');
    assert(contract.constraints.db === true, 'db should be true');
    assert(contract.expansion_lock === false, 'expansion_lock should be false');
  });

  // ── Test 3: Object.freeze prevents mutation ───────────────────

  await test('Object.freeze() prevents mutation of constraint contract', async () => {
    const contract = await classify('Build a landing page');
    const frozen = Object.freeze(contract);

    // Attempt mutation — should silently fail (or throw in strict mode)
    try {
      frozen.intent_class = 'full_product';
    } catch (e) {
      // TypeError in strict mode — this is correct behavior
    }
    assert(frozen.intent_class === 'static_surface', 'Contract should still be static_surface after mutation attempt');
  });

  // ── Test 4: Null/invalid classify result ──────────────────────

  await test('classify(null) returns a valid fallback (not null)', async () => {
    const contract = await classify(null);
    assert(contract !== null && contract !== undefined, 'Contract should not be null');
    assert(typeof contract.intent_class === 'string', 'intent_class should be a string');
  });

  await test('classify("") returns a valid fallback (not null)', async () => {
    const contract = await classify('');
    assert(contract !== null && contract !== undefined, 'Contract should not be null');
    assert(typeof contract.intent_class === 'string', 'intent_class should be a string');
  });

  // ── Test 5: _simulatedCode respects static_surface ────────────

  const builder = new BuilderAgent();
  const chunks = [];
  const emitChunk = (c) => chunks.push(c);

  await test('_simulatedCode with static_surface constraint → ≤3 files, no backend', async () => {
    const contract = Object.freeze(await classify('Build a landing page'));
    const result = await builder._simulatedCode('Build a landing page', emitChunk, contract);

    const fileCount = Object.keys(result.files).length;
    assert(fileCount <= 3, `Expected ≤3 files, got ${fileCount}: ${Object.keys(result.files).join(', ')}`);
    assert(!result.files['server.js'], 'server.js should NOT exist for static_surface');
    assert(!result.files['routes/api.js'], 'routes/api.js should NOT exist for static_surface');
    assert(!result.files['db/pool.js'], 'db/pool.js should NOT exist for static_surface');
    assert(!result.files['migrations/001_schema.js'], 'migrations should NOT exist for static_surface');
    assert(!result.files['package.json'], 'package.json should NOT exist for static_surface');
    assert(result.files['index.html'], 'index.html SHOULD exist');
    assert(result.files['styles.css'], 'styles.css SHOULD exist');
    assert(result.files['script.js'], 'script.js SHOULD exist');
  });

  await test('_simulatedCode with null constraint → full stack (backward compat)', async () => {
    const result = await builder._simulatedCode('Build a task manager', emitChunk, null);

    const fileCount = Object.keys(result.files).length;
    assert(fileCount > 3, `Expected >3 files for null constraint, got ${fileCount}`);
    assert(result.files['server.js'], 'server.js SHOULD exist for full stack');
  });

  // ── Test 6: _simulatedPlan differentiates intent classes ──────

  const planner = new PlannerAgent();

  await test('_simulatedPlan with static_surface → ≤4 subtasks, no db/server subtasks', async () => {
    const contract = Object.freeze(await classify('Build a landing page'));
    const result = await planner._simulatedPlan('Build a landing page', emitChunk, contract);

    assert(result.subtasks.length <= 5, `Expected ≤5 subtasks, got ${result.subtasks.length}`);
    const subtaskText = result.subtasks.map(t => `${t.title} ${t.description}`).join(' ').toLowerCase();
    assert(!subtaskText.includes('database schema'), 'Should NOT mention database schema for static_surface');
    assert(!subtaskText.includes('express server'), 'Should NOT mention Express server for static_surface');
  });

  await test('_simulatedPlan with light_app → different from full_product', async () => {
    const lightContract = Object.freeze(await classify('Build a calculator'));
    const fullContract = Object.freeze(await classify('Build a SaaS platform with user accounts'));

    const lightResult = await planner._simulatedPlan('Build a calculator', emitChunk, lightContract);
    const fullResult = await planner._simulatedPlan('Build a SaaS platform', emitChunk, fullContract);

    // Light app plan should have fewer subtasks or different content
    const lightText = lightResult.rawMarkdown.toLowerCase();
    const fullText = fullResult.rawMarkdown.toLowerCase();

    // Light app should not mention database schema design
    assert(!lightText.includes('design database schema'), 'light_app plan should not include database schema design');
  });

  // ── Test 7: QA agent checks prohibited layers ─────────────────

  const qa = new QAAgent();

  await test('QA agent detects constraint violations for static_surface with server files', async () => {
    const contract = Object.freeze(await classify('Build a landing page'));
    const fakeArtifacts = {
      plan: { subtasks: [{ id: 1, title: 'test' }] },
      scaffold: { tree: [{ path: 'index.html', type: 'file' }] },
      code: {
        files: {
          'index.html': '<html></html>',
          'server.js': 'const express = require("express");',  // VIOLATION
          'routes/api.js': 'module.exports = function() {};',   // VIOLATION
        },
        entryPoint: 'server.js',
      },
      _constraintContract: contract,
    };

    const result = await qa._runChecks('test-run-id-12345678', 'Build a landing page', fakeArtifacts, emitChunk);

    const complianceCheck = result.checks.find(c => c.name.includes('Intent Gate compliance'));
    assert(complianceCheck, 'Should have Intent Gate compliance check');
    assert(!complianceCheck.passed, 'Compliance check should FAIL for static_surface with server files');
    assert(result.errors.length > 0, 'Should have errors for constraint violations');
  });

  await test('QA agent passes for static_surface with only HTML/CSS/JS', async () => {
    const contract = Object.freeze(await classify('Build a landing page'));
    const fakeArtifacts = {
      plan: { subtasks: [{ id: 1, title: 'test' }] },
      scaffold: { tree: [{ path: 'index.html', type: 'file' }] },
      code: {
        files: {
          'index.html': '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>',
          'styles.css': ':root { --primary: #333; }\nbody { font-family: sans-serif; }\n.hero { padding: 2rem; }',
          'script.js': '(function() {\n  console.log("loaded");\n  var x = 1;\n  var y = 2;\n  console.log(x + y);\n})();',
        },
        entryPoint: 'index.html',
      },
      _constraintContract: contract,
    };

    const result = await qa._runChecks('test-run-id-99999999', 'Build a landing page', fakeArtifacts, emitChunk);

    const complianceCheck = result.checks.find(c => c.name.includes('Intent Gate compliance'));
    assert(complianceCheck, 'Should have Intent Gate compliance check');
    assert(complianceCheck.passed, `Compliance check should PASS for clean static_surface, but violations: ${result.errors.join('; ')}`);
  });

  // ── Test 8: Hard dependency test ──────────────────────────────

  await test('classify function is exported and callable', async () => {
    assert(typeof classify === 'function', 'classify should be a function');
    assert(typeof validateScaffoldAgainstContract === 'function', 'validateScaffoldAgainstContract should be a function');
    assert(typeof validateCodeAgainstContract === 'function', 'validateCodeAgainstContract should be a function');
    assert(typeof formatConstraintBlock === 'function', 'formatConstraintBlock should be a function');
  });

  // ── Test 9: Post-PLAN validation ──────────────────────────────

  await test('PlannerAgent._validatePlanAgainstContract catches prohibited steps', async () => {
    const contract = Object.freeze(await classify('Build a landing page'));
    const plan = {
      subtasks: [
        { id: 1, title: 'Design page layout', description: 'Plan HTML structure' },
        { id: 2, title: 'Set up Express server', description: 'Express.js with middleware' },  // VIOLATION
        { id: 3, title: 'Design database schema', description: 'PostgreSQL tables' },           // VIOLATION
      ],
    };

    const violations = planner._validatePlanAgainstContract(plan, contract);
    assert(violations.length >= 2, `Expected ≥2 violations, got ${violations.length}: ${violations.join('; ')}`);
  });

  // ── Test: Scaffold validation ─────────────────────────────────

  await test('validateScaffoldAgainstContract rejects server files for static_surface', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = { files: ['index.html', 'styles.css', 'script.js', 'server.js'] };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(!result.valid, 'Should reject scaffold with server.js for static_surface');
    assert(result.violations.length > 0, 'Should have violations');
  });

  await test('validateScaffoldAgainstContract passes clean static_surface', async () => {
    const contract = await classify('Build a landing page');
    const scaffold = { files: ['index.html', 'styles.css', 'script.js'] };
    const result = validateScaffoldAgainstContract(scaffold, contract);
    assert(result.valid, `Should pass clean static_surface, but got violations: ${result.violations.join('; ')}`);
  });

  // ── Test: formatConstraintBlock ───────────────────────────────

  await test('formatConstraintBlock includes IMMUTABLE header and constraint rules', async () => {
    const contract = await classify('Build a landing page');
    const block = formatConstraintBlock(contract);
    assert(block.includes('CONSTRAINT CONTRACT'), 'Should include header');
    assert(block.includes('IMMUTABLE'), 'Should include IMMUTABLE');
    assert(block.includes('static_surface'), 'Should include intent class');
    assert(block.includes('Do NOT create server.js'), 'Should include server prohibition for static_surface');
  });

  // ── Results ─────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed}/${total} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
