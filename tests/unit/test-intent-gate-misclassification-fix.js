/**
 * Validation: Intent Gate Misclassification Fix (Report #596913)
 *
 * Tests the 13 prompts identified as STATIC_SURFACE misclassified to INTERACTIVE_LIGHT_APP.
 * After the fix, all of these should classify as static_surface (not soft_expansion or light_app).
 *
 * Also includes regression checks to ensure prompts that SHOULD be light_app or full_product
 * are not accidentally pulled into static_surface.
 */

const { classify } = require('../../src/agents/intent-gate');

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected "${expected}", got "${actual}"`);
  }
}

async function main() {
  // ── Misclassified prompts from Report #596913 ─────────────────────────────
  // These were all classified as INTERACTIVE_LIGHT_APP but should be STATIC_SURFACE.

  console.log('\n=== Misclassified Prompts → Now STATIC_SURFACE ===');

  await test('Landing page with email signup → static_surface', async () => {
    const c = await classify('Build a landing page for a fitness app with email signup and a pricing section');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
    assertEqual(c.constraints.server, false, 'server');
    assertEqual(c.constraints.db, false, 'db');
  });

  await test('Landing page with email signup (variant) → static_surface', async () => {
    const c = await classify('Build a landing page for a fitness app with email signup');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Modern landing page with signup → static_surface', async () => {
    const c = await classify('Modern landing page for a fitness app with email signup and a pricing section');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('E-commerce product page → static_surface', async () => {
    const c = await classify('E-commerce product page');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
    assertEqual(c.constraints.server, false, 'server');
    assertEqual(c.constraints.db, false, 'db');
  });

  await test('Blog with dark theme → static_surface', async () => {
    const c = await classify('Blog with dark theme');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
    assertEqual(c.constraints.server, false, 'server');
  });

  await test('Landing page with payment form → static_surface', async () => {
    const c = await classify('Create a landing page with a payment form that charges $49');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Fitness app with email signup (described as app) → static_surface', async () => {
    // "Build a a fitness app with email signup and a pricing section"
    // has "pricing section" which matches new STATIC_SURFACE pattern
    const c = await classify('Build a a fitness app with email signup and a pricing section');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Fitness app landing page with pricing → static_surface', async () => {
    const c = await classify('Build a fitness app with email signup and a pricing section');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Build a fullstack fitness app with email signup → static_surface via pricing', async () => {
    // This has "fullstack" which matches FULL_PRODUCT, so it should be full_product
    const c = await classify('Build a fullstack fitness app with email signup and a pricing section');
    assertEqual(c.intent_class, 'full_product', 'intent_class — "fullstack" is Priority 1');
  });

  // ── Regression: prompts that should NOT be static_surface ──────────────────

  console.log('\n=== Regression: Prompts That Must Stay As-Is ===');

  await test('Waitlist signup form → still light_app', async () => {
    const c = await classify('Build a waitlist signup form');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Calculator → still light_app', async () => {
    const c = await classify('Build a mortgage calculator');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Task tracker → still light_app', async () => {
    const c = await classify('Build a simple task tracker');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Todo app → still light_app', async () => {
    const c = await classify('Build a todo app');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Dashboard with user accounts → still full_product', async () => {
    const c = await classify('Build a dashboard with user accounts');
    assertEqual(c.intent_class, 'full_product', 'intent_class');
  });

  await test('SaaS platform → still full_product', async () => {
    const c = await classify('Build a SaaS subscription platform');
    assertEqual(c.intent_class, 'full_product', 'intent_class');
  });

  await test('Multi-entity project tracker → still full_product', async () => {
    const c = await classify('Build a project tracker with team members, task assignment, and kanban board');
    assertEqual(c.intent_class, 'full_product', 'intent_class');
  });

  await test('Task management with sign up + log in → still full_product', async () => {
    const c = await classify('Build a task management app where users can sign up, log in, create tasks');
    assertEqual(c.intent_class, 'full_product', 'intent_class');
  });

  await test('Blog platform with user accounts → full_product (Priority 1 wins over blog)', async () => {
    const c = await classify('Build a blog platform with user accounts and admin panel');
    assertEqual(c.intent_class, 'full_product', 'intent_class');
  });

  await test('Tip calculator → still light_app', async () => {
    const c = await classify('Build a tip calculator that splits the bill between multiple people with a clean UI');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Contact form → still light_app', async () => {
    const c = await classify('Build a contact form for my website');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Crypto price tracker → still light_app', async () => {
    const c = await classify('Crypto price tracker');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  await test('Real-time chat app → still light_app', async () => {
    const c = await classify('Build a real-time chat app with rooms and usernames');
    assertEqual(c.intent_class, 'light_app', 'intent_class');
  });

  // ── Edge cases for new patterns ────────────────────────────────────────────

  console.log('\n=== Edge Cases for New Patterns ===');

  await test('Showcase site → static_surface', async () => {
    const c = await classify('Build a showcase for my art portfolio');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Services page → static_surface', async () => {
    const c = await classify('Create a services page for my consulting business');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  await test('Pricing page → static_surface', async () => {
    const c = await classify('Build a pricing page with three tiers');
    assertEqual(c.intent_class, 'static_surface', 'intent_class');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
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
