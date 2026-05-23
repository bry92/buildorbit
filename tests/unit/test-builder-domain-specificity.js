const { BuilderAgent } = require('../../src/agents/builder-agent');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

const agent = new BuilderAgent();

console.log('\n=== Builder Domain Specificity ===');

test('photo sharing prompt maps to media domain, not tasks', () => {
  const domain = agent._deriveAppDomain('Build a photo sharing app with uploads, galleries, albums, likes, and profiles');
  assert(domain.type === 'media', `expected media, got ${domain.type}`);
  assert(domain.entity.name === 'photos', `expected photos entity, got ${domain.entity.name}`);
  assert(domain.addLabel.toLowerCase().includes('photo'), 'add label should be photo-specific');
});

test('real estate prompt maps to listing domain', () => {
  const domain = agent._deriveAppDomain('Create a real estate marketplace for property listings with prices, bedrooms, agents, and leases');
  assert(domain.type === 'real_estate', `expected real_estate, got ${domain.type}`);
  assert(domain.entity.name === 'listings', `expected listings entity, got ${domain.entity.name}`);
  assert(domain.fields.some(f => f.name === 'address'), 'listing domain should capture address');
});

test('legal prompt maps to case domain', () => {
  const domain = agent._deriveAppDomain('Build a legal case tracker for law firm matters, client intake, document review, and deadlines');
  assert(domain.type === 'legal', `expected legal, got ${domain.type}`);
  assert(domain.entity.name === 'cases', `expected cases entity, got ${domain.entity.name}`);
  assert(domain.fields.some(f => f.name === 'matter'), 'legal domain should capture matter');
});

test('healthcare prompt maps to appointment domain', () => {
  const domain = agent._deriveAppDomain('Build a healthcare clinic portal for patients, providers, appointments, and telehealth visits');
  assert(domain.type === 'healthcare', `expected healthcare, got ${domain.type}`);
  assert(domain.entity.name === 'appointments', `expected appointments entity, got ${domain.entity.name}`);
  assert(domain.fields.some(f => f.name === 'patient'), 'healthcare domain should capture patient');
});

test('unknown prompt derives prompt entity instead of task manager fallback', () => {
  const domain = agent._deriveAppDomain('Build a grant proposal review app for nonprofit funding applications');
  assert(domain.type !== 'tasks', `should not fall back to tasks, got ${domain.type}`);
  assert(domain.entity.name !== 'entries', 'should not use generic entries entity');
  assert(/grant|proposal|review|nonprofit|funding|application/.test(domain.entity.name), `entity should reflect prompt, got ${domain.entity.name}`);
});

test('Autonomos-style workspace prompt maps to businesses, not pronoun fallback', () => {
  const prompt = 'Autonomos manages 5 data types including businesses. Helps you organize, track, and share your work in 1 place for teams and solo users.';
  const domain = agent._deriveAppDomain(prompt);
  assert(domain.type === 'workspace_data', `expected workspace_data, got ${domain.type}`);
  assert(domain.entity.name === 'businesses', `expected businesses entity, got ${domain.entity.name}`);
  assert(!domain.fields.some(f => /your/i.test(f.label) || /your/i.test(f.placeholder)), 'fields should not use pronouns as entity labels');
});

test('light app fallback emits domain-specific files', () => {
  const files = agent._generateLightAppFiles('PropertyDesk', agent._deriveAppDomain('Build a real estate app for property listings and leases'));
  const combined = Object.values(files).join('\n').toLowerCase();
  assert(combined.includes('listings'), 'generated files should include listings');
  assert(combined.includes('address'), 'generated files should include address');
  assert(!combined.includes('/tasks'), 'generated files should not expose task routes');
});

test('Autonomos light app preview uses business/workspace labels', () => {
  const prompt = 'Autonomos manages 5 data types including businesses. Helps you organize, track, and share your work in 1 place for teams and solo users.';
  const files = agent._generateLightAppFiles('Autonomos', agent._deriveAppDomain(prompt));
  const combined = Object.values(files).join('\n').toLowerCase();
  assert(combined.includes('businesses'), 'generated files should include businesses');
  assert(combined.includes('business name'), 'generated files should include business-specific form labels');
  assert(!combined.includes('new your'), 'generated files should not contain the broken "New your" label');
  assert(!combined.includes('enter your title'), 'generated files should not contain pronoun-derived placeholders');
  assert(!combined.includes('[app]'), 'matched domain should not use generic [app] marker');
});

test('pronouns are never selected as inferred custom entities', () => {
  const domain = agent._deriveAppDomain('Build an operations app to organize and share your work with clients');
  assert(domain.entity.name !== 'yours', `pronoun should not be pluralized into entity, got ${domain.entity.name}`);
  assert(domain.entity.singular !== 'your', 'pronoun should not be singular entity');
});

if (failed > 0) {
  console.error(`\n${failed} builder domain specificity test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} builder domain specificity test(s) passed.`);
