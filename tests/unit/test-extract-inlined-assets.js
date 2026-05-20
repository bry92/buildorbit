/**
 * Tests for Phase 2.5: Inline Asset Extraction
 *
 * Verifies that _extractInlinedAssets correctly de-inlines CSS and JS
 * from HTML blobs when the AI ignores the scaffold manifest and generates
 * everything as a single file.
 */
// Fix: was '../../agents/builder-agent' (pre-reorg root copy); now points to canonical src/ version
const { BuilderAgent } = require('../../src/agents/builder-agent');

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

const agent = new BuilderAgent();
const STATIC_MANIFEST = ['index.html', 'styles.css', 'script.js'];

console.log('\n=== Phase 2.5: Inline CSS Extraction ===');

test('Extracts <style> block into styles.css', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .fade-in { opacity: 0; transition: opacity 0.5s; }
    .fade-in.visible { opacity: 1; }
  </style>
</head>
<body>
  <div class="hero">Hello</div>
  <script>console.log("hello world from inline script that is long enough");</script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['styles.css'], 'styles.css should be created');
  assert(result['styles.css'].includes('.hero'), 'styles.css should contain extracted CSS');
  assert(result['styles.css'].includes('.fade-in'), 'styles.css should contain all CSS rules');
  assert(!result['index.html'].includes('<style>'), 'HTML should NOT contain <style> block after extraction');
  assert(result['index.html'].includes('href="styles.css"'), 'HTML should link to styles.css');
});

test('Extracts multiple <style> blocks', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <style>.a { color: red; }</style>
  <style>.b { color: blue; }</style>
</head>
<body><script>document.addEventListener("DOMContentLoaded", function() { console.log("loaded") });</script></body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['styles.css'], 'styles.css should be created');
  assert(result['styles.css'].includes('.a'), 'should contain first CSS block');
  assert(result['styles.css'].includes('.b'), 'should contain second CSS block');
});

test('Creates minimal styles.css when no <style> blocks but manifest requires it', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div class="bg-blue-500 p-4">Tailwind only</div>
  <script>document.addEventListener("DOMContentLoaded", function() { console.log("loaded") });</script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['styles.css'], 'styles.css should be created even without <style> blocks');
  assert(result['styles.css'].length > 0, 'styles.css should not be empty');
  assert(result['index.html'].includes('href="styles.css"'), 'HTML should link to styles.css');
});

console.log('\n=== Phase 2.5: Inline JS Extraction ===');

test('Extracts inline <script> block into script.js', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">Hello</div>
  <script>
    (function() {
      var cards = document.querySelectorAll(".card");
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) entry.target.classList.add("visible");
        });
      });
      cards.forEach(function(card) { observer.observe(card); });
    })();
  </script>
</body>
</html>`,
    'styles.css': '.card { opacity: 0; }'
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['script.js'], 'script.js should be created');
  assert(result['script.js'].includes('IntersectionObserver'), 'script.js should contain extracted JS');
  assert(!result['index.html'].match(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]{21,}<\/script>/i), 'HTML should NOT contain substantial inline scripts after extraction');
  assert(result['index.html'].includes('src="script.js"'), 'HTML should reference script.js');
});

test('Preserves external <script src="..."> references', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      console.log("this is an inline script with sufficient content to trigger extraction");
    });
  </script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['index.html'].includes('src="https://cdn.tailwindcss.com"'), 'External script src should be preserved');
  assert(result['script.js'], 'script.js should be created');
});

test('Creates minimal script.js when no inline scripts but manifest requires it', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div>Static content</div>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['script.js'], 'script.js should be created even without inline scripts');
  assert(result['script.js'].length > 0, 'script.js should not be empty');
  assert(result['index.html'].includes('src="script.js"'), 'HTML should reference script.js');
});

console.log('\n=== Phase 2.5: Combined Extraction ===');

test('Extracts both CSS and JS from a single HTML blob', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .hero { min-height: 100vh; }
    .card { opacity: 0; transform: translateY(20px); }
    .card.visible { opacity: 1; transform: none; transition: all 0.5s; }
  </style>
</head>
<body>
  <section class="hero bg-gradient-to-r from-indigo-600 to-purple-600">
    <h1>My Portfolio</h1>
  </section>
  <div class="card">Card 1</div>
  <script>
    (function() {
      var cards = document.querySelectorAll(".card");
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) entry.target.classList.add("visible");
        });
      }, { threshold: 0.1 });
      cards.forEach(function(card) { observer.observe(card); });
    })();
  </script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);

  // All 3 files should exist
  assert(result['index.html'], 'index.html should exist');
  assert(result['styles.css'], 'styles.css should exist');
  assert(result['script.js'], 'script.js should exist');

  // CSS extracted
  assert(result['styles.css'].includes('.hero'), 'CSS should contain .hero');
  assert(result['styles.css'].includes('.card'), 'CSS should contain .card');

  // JS extracted
  assert(result['script.js'].includes('IntersectionObserver'), 'JS should contain observer code');

  // HTML cleaned
  assert(!result['index.html'].includes('<style>'), 'HTML should not have <style>');
  assert(result['index.html'].includes('href="styles.css"'), 'HTML should link to styles.css');
  assert(result['index.html'].includes('src="script.js"'), 'HTML should link to script.js');
});

test('No-op when all files already exist separately', () => {
  const files = {
    'index.html': '<html><head><link rel="stylesheet" href="styles.css"></head><body><script src="script.js"></script></body></html>',
    'styles.css': '.hero { color: red; }',
    'script.js': 'console.log("hello");'
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['index.html'] === files['index.html'], 'HTML should be unchanged');
  assert(result['styles.css'] === files['styles.css'], 'CSS should be unchanged');
  assert(result['script.js'] === files['script.js'], 'JS should be unchanged');
});

test('No-op when manifest does not include styles.css or script.js', () => {
  const manifest = ['index.html', 'server.js', 'package.json'];
  const files = {
    'index.html': '<html><head><style>.x { color: red; }</style></head><body><script>alert("hi")</script></body></html>',
    'server.js': 'const express = require("express");',
    'package.json': '{}'
  };

  const result = agent._extractInlinedAssets(files, manifest);
  assert(!result['styles.css'], 'styles.css should NOT be created for server manifest');
  assert(!result['script.js'], 'script.js should NOT be created for server manifest');
});

test('Handles app.js manifest entry (not just script.js)', () => {
  const manifest = ['index.html', 'styles.css', 'app.js'];
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head></head>
<body>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      console.log("this is an inline script with sufficient content to extract");
    });
  </script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, manifest);
  assert(result['app.js'], 'app.js should be created from inline extraction');
  assert(!result['script.js'], 'script.js should NOT be created when manifest says app.js');
});

console.log('\n=== Phase 2.5: Edge Cases ===');

test('Skips Tailwind CDN config scripts (short scripts)', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={}</script>
</head>
<body>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      console.log("this is a real inline script with enough content to extract");
    });
  </script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  assert(result['script.js'], 'script.js should be created');
  // The tailwind config is only 19 chars, should be skipped (threshold is 20)
  assert(!result['script.js'].includes('tailwind.config'), 'Short Tailwind config should NOT be extracted');
});

test('Does not double-add link/script tags if already present', () => {
  const files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="styles.css">
  <style>.hero { color: red; }</style>
</head>
<body>
  <script src="script.js"></script>
  <script>
    (function() {
      console.log("this is a substantial inline script that should be extracted ok");
    })();
  </script>
</body>
</html>`
  };

  const result = agent._extractInlinedAssets(files, STATIC_MANIFEST);
  // Count occurrences of href="styles.css" — should be exactly 1
  const cssLinkCount = (result['index.html'].match(/href="styles\.css"/g) || []).length;
  assert(cssLinkCount === 1, `Should have exactly 1 CSS link, got ${cssLinkCount}`);
  const jsScriptCount = (result['index.html'].match(/src="script\.js"/g) || []).length;
  assert(jsScriptCount === 1, `Should have exactly 1 JS script ref, got ${jsScriptCount}`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
