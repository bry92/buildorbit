/**
 * Tests — Interaction Surface Extractor (ISE) — Phase 4.2
 *
 * Covers:
 *   1. Verb detection (each major verb family)
 *   2. Surface extraction from real-world prompts
 *   3. Transition mapping (A→B chains)
 *   4. CCO enrichment via _attachISE (intent-gate integration)
 *   5. Scaffold surfaces read-through (builder-agent integration)
 *   6. Passthrough for non-interactive prompts
 *   7. Edge cases (empty / null / invalid input)
 *   8. No duplicate surfaces on repeated verb matches
 */

'use strict';

const path = require('path');
const {
  extractInteractionSurfaces,
  buildTransitions,
  CAPTURE_SURFACES,
// Fix: was '../..' + 'lib' (pre-reorg root copy); now points to canonical src/ version
} = require(path.join(__dirname, '../..', 'src', 'lib', 'interaction-surface-extractor'));

const {
  classify,
  _attachISE,
  formatConstraintBlock,
// Fix: was '../..' + 'agents' (pre-reorg root copy); now points to canonical src/ version
} = require(path.join(__dirname, '../..', 'src', 'agents', 'intent-gate'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'expected match'}: got "${actual}", expected "${expected}"`);
  }
}

function assertIncludes(arr, item, msg) {
  if (!Array.isArray(arr) || !arr.includes(item)) {
    throw new Error(`${msg || `expected "${item}" in array`}: got [${(arr || []).join(', ')}]`);
  }
}

function assertEmpty(arr, msg) {
  if (!Array.isArray(arr) || arr.length !== 0) {
    throw new Error(`${msg || 'expected empty array'}: got [${(arr || []).join(', ')}]`);
  }
}

function assertNonEmpty(arr, msg) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(msg || 'expected non-empty array');
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

async function main() {

// ── Section 1: Verb Detection ─────────────────────────────────────────────────

console.log('\n=== ISE: Verb Detection ===');

await runTest('signup verb → signup_capture surface', () => {
  const r = extractInteractionSurfaces('build a signup form for my app');
  assertIncludes(r.surfaces, 'signup_capture', 'surfaces');
  assertIncludes(r.interaction_verbs, 'signup', 'verbs');
});

await runTest('sign up (spaced) verb → signup_capture surface', () => {
  const r = extractInteractionSurfaces('users can sign up here');
  assertIncludes(r.surfaces, 'signup_capture', 'surfaces');
});

await runTest('waitlist verb → waitlist_capture surface', () => {
  const r = extractInteractionSurfaces('build a waitlist for my AI tool');
  assertIncludes(r.surfaces, 'waitlist_capture', 'surfaces');
  assertIncludes(r.interaction_verbs, 'collect', 'verbs');
});

await runTest('newsletter → email_capture surface', () => {
  const r = extractInteractionSurfaces('page with newsletter subscription');
  assertIncludes(r.surfaces, 'email_capture', 'surfaces');
});

await runTest('email signup → email_capture surface', () => {
  const r = extractInteractionSurfaces('I need a landing page with email signup');
  assertIncludes(r.surfaces, 'email_capture', 'surfaces');
});

await runTest('capture leads → lead_capture surface', () => {
  const r = extractInteractionSurfaces('make something that captures leads');
  assertIncludes(r.surfaces, 'lead_capture', 'surfaces');
  assertIncludes(r.interaction_verbs, 'capture', 'verbs');
});

await runTest('feedback form → contact_form surface', () => {
  const r = extractInteractionSurfaces('create a form where people can submit feedback');
  assertIncludes(r.surfaces, 'contact_form', 'surfaces');
  assertIncludes(r.interaction_verbs, 'submit', 'verbs');
});

await runTest('onboarding → onboarding_view surface', () => {
  const r = extractInteractionSurfaces('build an onboarding flow for new users');
  assertIncludes(r.surfaces, 'onboarding_view', 'surfaces');
  assertIncludes(r.interaction_verbs, 'onboard', 'verbs');
});

await runTest('buy / checkout → checkout_flow surface', () => {
  const r = extractInteractionSurfaces('build a product page with a buy button');
  assertIncludes(r.surfaces, 'checkout_flow', 'surfaces');
  assertIncludes(r.interaction_verbs, 'buy', 'verbs');
});

await runTest('subscribe → subscription_capture surface', () => {
  const r = extractInteractionSurfaces('users can subscribe to premium');
  assertIncludes(r.surfaces, 'subscription_capture', 'surfaces');
  assertIncludes(r.interaction_verbs, 'subscribe', 'verbs');
});

await runTest('dashboard → dashboard_view surface', () => {
  const r = extractInteractionSurfaces('make a simple dashboard app');
  assertIncludes(r.surfaces, 'dashboard_view', 'surfaces');
  assertIncludes(r.interaction_verbs, 'view', 'verbs');
});

// ── Section 2: Surface Extraction from Real-World Prompts ─────────────────────

console.log('\n=== ISE: Real-World Prompt Surface Extraction ===');

await runTest('"onboarding flow + signup capture" → 2+ surfaces', () => {
  const r = extractInteractionSurfaces('build an onboarding flow with signup capture');
  assertIncludes(r.surfaces, 'onboarding_view', 'onboarding_view surface');
  assertIncludes(r.surfaces, 'signup_capture', 'signup_capture surface');
  assert(r.surfaces.length >= 2, `expected >=2 surfaces, got ${r.surfaces.length}`);
});

await runTest('waitlist page → surfaces includes waitlist_capture + confirmation', () => {
  const r = extractInteractionSurfaces('build a waitlist for my AI tool');
  assertIncludes(r.surfaces, 'waitlist_capture', 'waitlist_capture');
  assertIncludes(r.surfaces, 'confirmation_state', 'confirmation_state implied');
});

await runTest('signup form → confirmation_state auto-implied', () => {
  const r = extractInteractionSurfaces('build a signup form');
  assertIncludes(r.surfaces, 'confirmation_state', 'confirmation_state should be implied');
});

await runTest('email capture with buy button → both surfaces present', () => {
  const r = extractInteractionSurfaces('landing page with email signup and a buy button');
  assertIncludes(r.surfaces, 'email_capture', 'email_capture');
  assertIncludes(r.surfaces, 'checkout_flow', 'checkout_flow');
});

await runTest('no duplicate surfaces even with multiple matching verb patterns', () => {
  const r = extractInteractionSurfaces('sign up and register here');
  const signupCount = r.surfaces.filter(s => s === 'signup_capture').length;
  assertEqual(signupCount, 1, 'signup_capture should appear once');
});

// ── Section 3: Transition Mapping ─────────────────────────────────────────────

console.log('\n=== ISE: Transition Mapping ===');

await runTest('buildTransitions: empty input → empty output', () => {
  assertEmpty(buildTransitions([]), 'empty transitions');
});

await runTest('buildTransitions: 1 surface → empty output', () => {
  assertEmpty(buildTransitions(['signup_capture']), 'single surface has no transitions');
});

await runTest('buildTransitions: 2 surfaces → 1 transition', () => {
  const t = buildTransitions(['signup_capture', 'confirmation_state']);
  assertEqual(t.length, 1, 'should have 1 transition');
  assertEqual(t[0], 'signup_capture→confirmation_state', 'transition string');
});

await runTest('buildTransitions: 3 surfaces → 2 transitions', () => {
  const t = buildTransitions(['landing_view', 'signup_capture', 'confirmation_state']);
  assertEqual(t.length, 2, 'should have 2 transitions');
  assertEqual(t[0], 'landing_view→signup_capture', 'first transition');
  assertEqual(t[1], 'signup_capture→confirmation_state', 'second transition');
});

await runTest('transitions are ordered by surface position in flow', () => {
  const r = extractInteractionSurfaces('build an onboarding flow with signup capture and a dashboard');
  // Expected order: onboarding_view (pos 1), signup_capture (pos 2), dashboard_view (pos 4), confirmation_state (pos 5)
  const surfaceOrder = r.surfaces;
  const onboardIdx  = surfaceOrder.indexOf('onboarding_view');
  const signupIdx   = surfaceOrder.indexOf('signup_capture');
  const confirmIdx  = surfaceOrder.indexOf('confirmation_state');
  assert(onboardIdx < signupIdx, `onboarding should come before signup (got indices ${onboardIdx}, ${signupIdx})`);
  assert(signupIdx < confirmIdx, `signup should come before confirmation (got indices ${signupIdx}, ${confirmIdx})`);
});

await runTest('transitions from real waitlist prompt connect surfaces correctly', () => {
  const r = extractInteractionSurfaces('build a waitlist for my AI tool');
  assertNonEmpty(r.transitions, 'transitions should be non-empty');
  // waitlist_capture should transition to confirmation_state
  const hasWaitlistToConfirm = r.transitions.some(t => t.includes('waitlist_capture') && t.includes('confirmation_state'));
  assert(hasWaitlistToConfirm, `expected waitlist→confirmation transition, got: [${r.transitions.join(', ')}]`);
});

// ── Section 4: CCO Enrichment via _attachISE ──────────────────────────────────

console.log('\n=== ISE: CCO Enrichment via _attachISE ===');

await runTest('_attachISE adds _ise to a contract', () => {
  const contract = { intent_class: 'light_app', constraints: {} };
  _attachISE(contract, 'build a signup form');
  assert(contract._ise !== undefined, '_ise should be attached');
  assert(Array.isArray(contract._ise.surfaces), 'surfaces should be array');
  assert(Array.isArray(contract._ise.transitions), 'transitions should be array');
  assert(Array.isArray(contract._ise.interaction_verbs), 'interaction_verbs should be array');
});

await runTest('_attachISE on interactive prompt → non-empty surfaces', () => {
  const contract = { intent_class: 'light_app', constraints: {} };
  _attachISE(contract, 'build a signup form for my app');
  assertNonEmpty(contract._ise.surfaces, '_ise.surfaces should be non-empty');
  assertIncludes(contract._ise.surfaces, 'signup_capture', 'signup_capture in _ise.surfaces');
});

await runTest('_attachISE on static prompt → empty surfaces (passthrough)', () => {
  const contract = { intent_class: 'static_surface', constraints: {} };
  _attachISE(contract, 'make a portfolio page');
  assertEmpty(contract._ise.surfaces, '_ise.surfaces should be empty for static page');
  assertEmpty(contract._ise.transitions, '_ise.transitions should be empty for static page');
  assertEmpty(contract._ise.interaction_verbs, '_ise.verbs should be empty for static page');
});

await runTest('_attachISE with null prompt → empty surfaces (safe passthrough)', () => {
  const contract = { intent_class: 'light_app', constraints: {} };
  _attachISE(contract, null);
  assertEmpty(contract._ise.surfaces, 'null prompt → empty surfaces');
});

// ── Section 5: classify() attaches _ise to all contract paths ─────────────────

console.log('\n=== ISE: classify() Integration ===');

await runTest('classify() attaches _ise on static_surface', async () => {
  const contract = await classify('create a portfolio site');
  assert(contract._ise !== undefined, '_ise should be on static_surface contract');
  assertEmpty(contract._ise.surfaces, 'portfolio has no interaction surfaces');
});

await runTest('classify() attaches _ise on light_app with signup', async () => {
  const contract = await classify('build a waitlist signup form');
  assert(contract._ise !== undefined, '_ise should be on light_app contract');
  assertNonEmpty(contract._ise.surfaces, 'signup form should have surfaces');
});

await runTest('classify() _ise includes transitions for interactive prompts', async () => {
  const contract = await classify('build a waitlist for my AI tool');
  assert(contract._ise !== undefined, '_ise attached');
  assertNonEmpty(contract._ise.transitions, 'waitlist should have flow transitions');
});

await runTest('classify() _ise.surfaces does not affect intent_class', async () => {
  const contract = await classify('build a landing page with email signup');
  // email signup may produce surfaces, but landing page should still be static or light
  assert(
    contract.intent_class === 'static_surface' || contract.intent_class === 'light_app' || contract.intent_class === 'soft_expansion',
    `expected static/light/soft intent, got ${contract.intent_class}`
  );
  assert(contract._ise !== undefined, '_ise attached regardless of intent_class');
});

// ── Section 6: formatConstraintBlock includes ISE surfaces ────────────────────

console.log('\n=== ISE: formatConstraintBlock Output ===');

await runTest('formatConstraintBlock includes ISE surfaces section when surfaces present', () => {
  const contract = {
    intent_class: 'light_app',
    complexity_budget: 'medium',
    expansion_lock: true,
    constraints: { frontend: true, server: true, db: 'maybe', auth: false, api: 'minimal' },
    allowed_artifacts: ['html', 'css', 'js'],
    prohibited_layers: ['auth_middleware'],
    _ise: {
      surfaces: ['signup_capture', 'confirmation_state'],
      transitions: ['signup_capture→confirmation_state'],
      interaction_verbs: ['signup'],
    },
  };
  const block = formatConstraintBlock(contract);
  assert(block.includes('INTERACTION SURFACES'), 'should include ISE section header');
  assert(block.includes('signup_capture'), 'should include signup_capture surface');
  assert(block.includes('confirmation_state'), 'should include confirmation_state surface');
  assert(block.includes('signup_capture→confirmation_state'), 'should include transition');
});

await runTest('formatConstraintBlock skips ISE section when no surfaces (passthrough)', () => {
  const contract = {
    intent_class: 'static_surface',
    complexity_budget: 'low',
    expansion_lock: true,
    constraints: { frontend: true, server: false, db: false, auth: false, api: false },
    allowed_artifacts: ['html', 'css', 'js'],
    prohibited_layers: [],
    _ise: { surfaces: [], transitions: [], interaction_verbs: [] },
  };
  const block = formatConstraintBlock(contract);
  assert(!block.includes('INTERACTION SURFACES'), 'should NOT include ISE section for passthrough');
});

// ── Section 7: Passthrough for Non-Interactive Prompts ────────────────────────

console.log('\n=== ISE: Passthrough Verification ===');

const STATIC_PROMPTS = [
  'create a portfolio site',
  'build me a page for my startup',
  'I want a page that shows pricing',
  'build a homepage for a SaaS product',
  'build a product page with a buy button',   // "buy" triggers checkout — NOT passthrough
];

// Only truly static prompts (no interaction verbs) should passthrough
await runTest('portfolio site → passthrough (no interaction verbs)', () => {
  const r = extractInteractionSurfaces('create a portfolio site');
  assertEmpty(r.surfaces, 'portfolio is static — no surfaces');
  assertEmpty(r.transitions, 'portfolio is static — no transitions');
  assertEmpty(r.interaction_verbs, 'portfolio is static — no verbs');
});

await runTest('startup page → passthrough', () => {
  const r = extractInteractionSurfaces('build me a page for my startup');
  assertEmpty(r.surfaces, 'startup page is static');
});

await runTest('pricing page → passthrough', () => {
  const r = extractInteractionSurfaces('I want a page that shows pricing');
  assertEmpty(r.surfaces, 'pricing page is static');
});

await runTest('homepage → passthrough when no capture verbs', () => {
  const r = extractInteractionSurfaces('build a homepage for a SaaS product');
  // "homepage" alone has no interaction verbs
  assertEmpty(r.surfaces, 'homepage without verbs is static');
});

await runTest('product page with buy button → checkout_flow (NOT passthrough)', () => {
  const r = extractInteractionSurfaces('build a product page with a buy button');
  assertIncludes(r.surfaces, 'checkout_flow', 'buy button = checkout_flow surface');
  assert(r.surfaces.length > 0, 'should have surfaces');
});

await runTest('calculator app → passthrough (calc is a tool, no capture verbs)', () => {
  const r = extractInteractionSurfaces('make a simple calculator app');
  assertEmpty(r.surfaces, 'calculator has no interaction capture verbs');
});

// ── Section 8: Edge Cases ─────────────────────────────────────────────────────

console.log('\n=== ISE: Edge Cases ===');

await runTest('empty string → empty ISE output', () => {
  const r = extractInteractionSurfaces('');
  assertEmpty(r.surfaces, 'empty string surfaces');
  assertEmpty(r.transitions, 'empty string transitions');
  assertEmpty(r.interaction_verbs, 'empty string verbs');
});

await runTest('null input → empty ISE output (no throw)', () => {
  const r = extractInteractionSurfaces(null);
  assertEmpty(r.surfaces, 'null input surfaces');
});

await runTest('non-string input → empty ISE output (no throw)', () => {
  const r = extractInteractionSurfaces(42);
  assertEmpty(r.surfaces, 'numeric input surfaces');
});

await runTest('CAPTURE_SURFACES set contains expected surfaces', () => {
  assertIncludes([...CAPTURE_SURFACES], 'signup_capture', 'signup_capture in CAPTURE_SURFACES');
  assertIncludes([...CAPTURE_SURFACES], 'email_capture', 'email_capture in CAPTURE_SURFACES');
  assertIncludes([...CAPTURE_SURFACES], 'waitlist_capture', 'waitlist_capture in CAPTURE_SURFACES');
  assertIncludes([...CAPTURE_SURFACES], 'checkout_flow', 'checkout_flow in CAPTURE_SURFACES');
});

await runTest('CAPTURE_SURFACES triggers confirmation_state implication', () => {
  for (const captureSurface of CAPTURE_SURFACES) {
    // Use a prompt that produces each capture surface in isolation
    const verbMap = {
      signup_capture:       'signup',
      email_capture:        'newsletter',
      waitlist_capture:     'waitlist',
      lead_capture:         'capture leads',
      data_capture:         'collect data',
      subscription_capture: 'subscribe',
      contact_form:         'feedback',
      checkout_flow:        'checkout',
    };
    const verb = verbMap[captureSurface];
    if (!verb) continue;

    const r = extractInteractionSurfaces(`build something that lets users ${verb}`);
    // If the capture surface is detected, confirmation should be implied
    if (r.surfaces.includes(captureSurface)) {
      assertIncludes(r.surfaces, 'confirmation_state', `${captureSurface} should imply confirmation_state`);
    }
  }
});

// ── Final Report ──────────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(60));
  console.log(`  ISE Tests: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60) + '\n');
  if (failed > 0) process.exitCode = 1;

} // end main()

main().catch(err => {
  console.error('[ISE Tests] Fatal error:', err);
  process.exit(1);
});
