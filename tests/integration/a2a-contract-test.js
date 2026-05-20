#!/usr/bin/env node
/**
 * A2A Contract Stress Test — CCO Schema Validation
 *
 * Validates that the CCO (Constraint Contract Object) schema enforcement at the
 * Intent Gate ingestion boundary behaves correctly.
 *
 * Test categories:
 *   1. Missing required fields → hard rejection
 *   2. Malformed field values → hard rejection
 *   3. CCO immutability (hash stability)
 *   4. BuilderAgent secondary guard
 *   5. Valid contracts pass through (no false rejections)
 *   6. Credit 2 regression: well_formed, malformed_intent, partial_context
 *
 * Binary pass/fail. Reports a summary at exit.
 * Exit code: 0 = all pass, 1 = any failure.
 *
 * Run: node tests/validation/a2a-contract-test.js
 */

'use strict';

const path = require('path');
// Fix: was '../../lib/cco-validator' (pre-reorg root copy); now points to canonical src/ version
const { validateCCO, computeCCOHash, verifyCCOHash } = require(path.join(__dirname, '../../src/lib/cco-validator'));

// ── Test harness ──────────────────────────────────────────────────────────────

const results = [];
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    results.push({ name, pass: true });
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    results.push({ name, pass: false, detail });
    failed++;
  }
}

// ── Valid CCO fixtures ────────────────────────────────────────────────────────

const VALID_STATIC = {
  task_type: 'static_surface',
  intent_class: 'static_surface',
  constraints: { frontend: true, server: false, db: false, auth: false, api: false },
  allowed_artifacts: ['html', 'css', 'js'],
  prohibited_layers: ['database', 'migrations', 'backend_services', 'server', 'routes', 'middleware'],
  complexity_budget: 'low',
  expansion_lock: true,
};

const VALID_LIGHT = {
  task_type: 'light_app',
  intent_class: 'light_app',
  constraints: { frontend: true, server: true, db: 'maybe', auth: false, api: 'minimal' },
  allowed_artifacts: ['html', 'css', 'js', 'server.js', 'routes/api.js', 'package.json'],
  prohibited_layers: ['auth_middleware', 'jwt', 'bcrypt'],
  complexity_budget: 'medium',
  expansion_lock: true,
};

const VALID_FULL = {
  task_type: 'full_product',
  intent_class: 'full_product',
  constraints: { frontend: true, server: true, db: true, auth: true, api: true },
  allowed_artifacts: ['html', 'css', 'js', 'server.js', 'routes', 'db', 'migrations', 'middleware', 'package.json'],
  prohibited_layers: [],
  complexity_budget: 'high',
  expansion_lock: false,
};

// ── Section 1: Missing required fields → hard rejection ───────────────────────

console.log('\n── Section 1: Missing required fields (must reject) ──');

{
  // 1a. Missing intent_class
  const contract = { ...VALID_STATIC };
  delete contract.intent_class;
  const result = validateCCO(contract);
  check(
    'Missing intent_class → rejected',
    !result.valid && result.errors.some(e => e.includes('intent_class')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1b. Missing task_type
  const contract = { ...VALID_STATIC };
  delete contract.task_type;
  const result = validateCCO(contract);
  check(
    'Missing task_type → rejected',
    !result.valid && result.errors.some(e => e.includes('task_type')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1c. Missing constraints
  const contract = { ...VALID_STATIC };
  delete contract.constraints;
  const result = validateCCO(contract);
  check(
    'Missing constraints → rejected',
    !result.valid && result.errors.some(e => e.includes('constraints')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1d. Missing allowed_artifacts
  const contract = { ...VALID_STATIC };
  delete contract.allowed_artifacts;
  const result = validateCCO(contract);
  check(
    'Missing allowed_artifacts → rejected',
    !result.valid && result.errors.some(e => e.includes('allowed_artifacts')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1e. Missing prohibited_layers
  const contract = { ...VALID_STATIC };
  delete contract.prohibited_layers;
  const result = validateCCO(contract);
  check(
    'Missing prohibited_layers → rejected',
    !result.valid && result.errors.some(e => e.includes('prohibited_layers')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1f. Missing complexity_budget
  const contract = { ...VALID_STATIC };
  delete contract.complexity_budget;
  const result = validateCCO(contract);
  check(
    'Missing complexity_budget → rejected',
    !result.valid && result.errors.some(e => e.includes('complexity_budget')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 1g. Missing expansion_lock
  const contract = { ...VALID_STATIC };
  delete contract.expansion_lock;
  const result = validateCCO(contract);
  check(
    'Missing expansion_lock → rejected',
    !result.valid && result.errors.some(e => e.includes('expansion_lock')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

// ── Section 2: Malformed field values → hard rejection ───────────────────────

console.log('\n── Section 2: Malformed field values (must reject) ──');

{
  // 2a. intent_class not in enum
  const contract = { ...VALID_STATIC, intent_class: 'INVALID_CLASS' };
  const result = validateCCO(contract);
  check(
    'Invalid intent_class enum → rejected',
    !result.valid && result.errors.some(e => e.includes('intent_class')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2b. constraints.db is null (not boolean or valid string)
  const contract = { ...VALID_STATIC, constraints: { ...VALID_STATIC.constraints, db: null } };
  const result = validateCCO(contract);
  check(
    'constraints.db = null → rejected',
    !result.valid && result.errors.some(e => e.includes('constraints.db')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2c. constraints.auth is a number
  const contract = { ...VALID_STATIC, constraints: { ...VALID_STATIC.constraints, auth: 42 } };
  const result = validateCCO(contract);
  check(
    'constraints.auth = number → rejected',
    !result.valid && result.errors.some(e => e.includes('constraints.auth')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2d. constraints.api = object (not boolean/string)
  const contract = { ...VALID_STATIC, constraints: { ...VALID_STATIC.constraints, api: { foo: 'bar' } } };
  const result = validateCCO(contract);
  check(
    'constraints.api = object → rejected',
    !result.valid && result.errors.some(e => e.includes('constraints.api')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2e. allowed_artifacts is empty array
  const contract = { ...VALID_STATIC, allowed_artifacts: [] };
  const result = validateCCO(contract);
  check(
    'Empty allowed_artifacts → rejected',
    !result.valid && result.errors.some(e => e.includes('allowed_artifacts')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2f. complexity_budget is unknown string
  const contract = { ...VALID_STATIC, complexity_budget: 'extreme' };
  const result = validateCCO(contract);
  check(
    'Invalid complexity_budget → rejected',
    !result.valid && result.errors.some(e => e.includes('complexity_budget')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2g. expansion_lock is a string instead of boolean
  const contract = { ...VALID_STATIC, expansion_lock: 'yes' };
  const result = validateCCO(contract);
  check(
    'expansion_lock = string → rejected',
    !result.valid && result.errors.some(e => e.includes('expansion_lock')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

{
  // 2h. constraints is an array
  const contract = { ...VALID_STATIC, constraints: [true, false] };
  const result = validateCCO(contract);
  check(
    'constraints = array → rejected',
    !result.valid && result.errors.some(e => e.includes('constraints')),
    `valid=${result.valid}, errors=${JSON.stringify(result.errors)}`
  );
}

// ── Section 3: CCO immutability (hash stability) ─────────────────────────────

console.log('\n── Section 3: CCO immutability (hash verification) ──');

{
  // 3a. Hash is stable for the same contract
  const h1 = computeCCOHash(VALID_STATIC);
  const h2 = computeCCOHash(VALID_STATIC);
  check(
    'Hash is deterministic (same contract → same hash)',
    h1 === h2,
    `h1=${h1.slice(0, 16)} h2=${h2.slice(0, 16)}`
  );
}

{
  // 3b. Different contracts produce different hashes
  const h1 = computeCCOHash(VALID_STATIC);
  const h2 = computeCCOHash(VALID_LIGHT);
  check(
    'Different contracts → different hashes',
    h1 !== h2,
    `h1=${h1.slice(0, 16)} h2=${h2.slice(0, 16)}`
  );
}

{
  // 3c. Hash verify passes for unchanged contract
  const hash = computeCCOHash(VALID_LIGHT);
  const verify = verifyCCOHash(VALID_LIGHT, hash);
  check(
    'verifyCCOHash passes for unchanged contract',
    verify.valid,
    verify.error
  );
}

{
  // 3d. Hash verify fails when core field is mutated
  const hash = computeCCOHash(VALID_STATIC);
  // Simulate mutation: change intent_class
  const mutated = { ...VALID_STATIC, intent_class: 'light_app' };
  const verify = verifyCCOHash(mutated, hash);
  check(
    'verifyCCOHash detects intent_class mutation',
    !verify.valid && verify.error && verify.error.includes('MUTATION'),
    verify.error
  );
}

{
  // 3e. Metadata fields (_entropy, _ise) don't affect hash
  const base = computeCCOHash(VALID_STATIC);
  const withMeta = { ...VALID_STATIC, _entropy: 0.42, _ise: { surfaces: ['email_capture'] }, _candidates: [] };
  const withMetaHash = computeCCOHash(withMeta);
  check(
    'Metadata fields (_entropy, _ise) excluded from hash',
    base === withMetaHash,
    `base=${base.slice(0, 16)} withMeta=${withMetaHash.slice(0, 16)}`
  );
}

{
  // 3f. Missing expected hash → verification fails
  const verify = verifyCCOHash(VALID_STATIC, null);
  check(
    'verifyCCOHash fails with null expectedHash',
    !verify.valid,
    verify.error
  );
}

{
  // 3g. Missing contract → verification fails
  const verify = verifyCCOHash(null, 'some_hash');
  check(
    'verifyCCOHash fails with null contract',
    !verify.valid,
    verify.error
  );
}

// ── Section 4: Valid contracts pass through (no false rejections) ─────────────

console.log('\n── Section 4: Valid contracts pass through (no false rejections) ──');

{
  const result = validateCCO(VALID_STATIC);
  check(
    'Valid static_surface CCO → passes',
    result.valid && result.errors.length === 0,
    `errors=${JSON.stringify(result.errors)}`
  );
}

{
  const result = validateCCO(VALID_LIGHT);
  check(
    'Valid light_app CCO with db:maybe, api:minimal → passes',
    result.valid && result.errors.length === 0,
    `errors=${JSON.stringify(result.errors)}`
  );
}

{
  const result = validateCCO(VALID_FULL);
  check(
    'Valid full_product CCO → passes',
    result.valid && result.errors.length === 0,
    `errors=${JSON.stringify(result.errors)}`
  );
}

{
  // soft_expansion is a valid intent_class
  const softExpansion = {
    task_type: 'soft_expansion',
    intent_class: 'soft_expansion',
    constraints: { frontend: true, server: true, db: 'maybe', auth: false, api: 'minimal' },
    allowed_artifacts: ['html', 'css', 'js', 'server.js'],
    prohibited_layers: [],
    complexity_budget: 'medium',
    expansion_lock: true,
    // soft expansion metadata — does NOT affect core validation
    base_class: 'static_surface',
    expansion_candidate: 'light_app',
  };
  const result = validateCCO(softExpansion);
  check(
    'Valid soft_expansion CCO → passes',
    result.valid && result.errors.length === 0,
    `errors=${JSON.stringify(result.errors)}`
  );
}

// ── Section 5: Credit 2 regression (A2A contract stress test cases) ───────────

console.log('\n── Section 5: Credit 2 regression (well_formed, malformed_intent, partial_context) ──');

{
  // well_formed: complete, valid CCO — must pass
  const wellFormed = {
    task_type: 'static_surface',
    intent_class: 'static_surface',
    constraints: { frontend: true, server: false, db: false, auth: false, api: false },
    allowed_artifacts: ['html', 'css', 'js'],
    prohibited_layers: ['database', 'migrations', 'backend_services'],
    complexity_budget: 'low',
    expansion_lock: true,
  };
  const result = validateCCO(wellFormed);
  check(
    '[Credit 2] well_formed CCO → passes validation',
    result.valid,
    `errors=${JSON.stringify(result.errors)}`
  );
}

{
  // malformed_intent: missing intent_class — must reject
  const malformedIntent = {
    task_type: 'static_surface',
    // intent_class deliberately omitted
    constraints: { frontend: true, server: false, db: false, auth: false, api: false },
    allowed_artifacts: ['html', 'css', 'js'],
    prohibited_layers: [],
    complexity_budget: 'low',
    expansion_lock: true,
  };
  const result = validateCCO(malformedIntent);
  check(
    '[Credit 2] malformed_intent (missing intent_class) → rejected',
    !result.valid && result.errors.some(e => e.includes('intent_class')),
    `errors=${JSON.stringify(result.errors)}`
  );
}

{
  // partial_context: missing multiple required fields — must reject
  const partialContext = {
    task_type: 'light_app',
    intent_class: 'light_app',
    // constraints missing — partial context
    allowed_artifacts: ['html', 'css', 'js'],
    // prohibited_layers missing
    complexity_budget: 'medium',
    expansion_lock: true,
  };
  const result = validateCCO(partialContext);
  check(
    '[Credit 2] partial_context (missing constraints, prohibited_layers) → rejected',
    !result.valid,
    `errors=${JSON.stringify(result.errors)}`
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(60)}`);
console.log(`A2A Contract Test Results: ${passed}/${total} passed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED:`);
  for (const r of results.filter(r => !r.pass)) {
    console.error(`  ✗ ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  }
}

// Save report
const report = {
  run_at: new Date().toISOString(),
  total,
  passed,
  failed,
  pass_rate: `${((passed / total) * 100).toFixed(1)}%`,
  results,
};

const fs = require('fs');
const reportPath = path.join(__dirname, 'a2a-contract-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nReport saved to: ${reportPath}`);

process.exit(failed > 0 ? 1 : 0);
