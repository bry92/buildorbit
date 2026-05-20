/**
 * Verification script for task #951327
 * Bug: CCO schema rejects "low-medium" complexity_budget in SOFT_EXPANSION path
 *
 * Fix: BUDGET_INTERPOLATION in lib/soft-expansion.js now maps to valid enum values.
 */

const { buildSoftExpansionContract } = require('./src/lib/soft-expansion.js');
const { validateCCO } = require('./src/lib/cco-validator.js');
const { CONTRACTS } = require('./src/agents/intent-gate.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Simulate soft_expansion case: static_surface + light_app
// This was the case that produced 'low-medium' (invalid)
const staticToLight = {
  candidates: [
    { intent_class: 'static_surface', probability: 0.45 },
    { intent_class: 'light_app', probability: 0.35 },
    { intent_class: 'full_product', probability: 0.20 },
  ],
  entropy: 0.83,
  committed: false,
  rejected: false,
};

// Simulate soft_expansion case: light_app + full_product
const lightToFull = {
  candidates: [
    { intent_class: 'light_app', probability: 0.40 },
    { intent_class: 'full_product', probability: 0.38 },
    { intent_class: 'static_surface', probability: 0.22 },
  ],
  entropy: 0.85,
  committed: false,
  rejected: false,
};

// Simulate soft_expansion case: static_surface + full_product
const staticToFull = {
  candidates: [
    { intent_class: 'static_surface', probability: 0.42 },
    { intent_class: 'full_product', probability: 0.40 },
    { intent_class: 'light_app', probability: 0.18 },
  ],
  entropy: 0.88,
  committed: false,
  rejected: false,
};

console.log('\n--- Bug Fix Verification: soft_expansion complexity_budget ---\n');

test('static_surface + light_app soft_expansion produces valid CCO', () => {
  const contract = buildSoftExpansionContract(staticToLight, CONTRACTS);
  const validation = validateCCO(contract);
  assert(validation.valid, `CCO should be valid but got: ${validation.errors.join('; ')}`);
  assert(contract.complexity_budget === 'medium', `budget should be 'medium', got '${contract.complexity_budget}'`);
  assert(contract.intent_class === 'soft_expansion', `intent_class should be 'soft_expansion'`);
  assert(contract.base_class === 'static_surface', `base_class should be 'static_surface'`);
  assert(contract.expansion_candidate === 'light_app', `expansion_candidate should be 'light_app'`);
});

test('light_app + full_product soft_expansion produces valid CCO', () => {
  const contract = buildSoftExpansionContract(lightToFull, CONTRACTS);
  const validation = validateCCO(contract);
  assert(validation.valid, `CCO should be valid but got: ${validation.errors.join('; ')}`);
  assert(contract.complexity_budget === 'high', `budget should be 'high', got '${contract.complexity_budget}'`);
  assert(contract.base_class === 'light_app', `base_class should be 'light_app'`);
  assert(contract.expansion_candidate === 'full_product', `expansion_candidate should be 'full_product'`);
});

test('static_surface + full_product soft_expansion produces valid CCO', () => {
  const contract = buildSoftExpansionContract(staticToFull, CONTRACTS);
  const validation = validateCCO(contract);
  assert(validation.valid, `CCO should be valid but got: ${validation.errors.join('; ')}`);
  assert(contract.complexity_budget === 'medium', `budget should be 'medium', got '${contract.complexity_budget}'`);
  assert(contract.base_class === 'static_surface', `base_class should be 'static_surface'`);
  assert(contract.expansion_candidate === 'full_product', `expansion_candidate should be 'full_product'`);
});

test('budget is never low-medium or medium-high (the bug values)', () => {
  const cases = [staticToLight, lightToFull, staticToFull];
  for (const c of cases) {
    const contract = buildSoftExpansionContract(c, CONTRACTS);
    assert(contract.complexity_budget !== 'low-medium', `budget should never be 'low-medium', got '${contract.complexity_budget}'`);
    assert(contract.complexity_budget !== 'medium-high', `budget should never be 'medium-high', got '${contract.complexity_budget}'`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\nAll checks passed. Bug fix verified.');
  process.exit(0);
}