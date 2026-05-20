/**
 * Shared manifest enforcement constants.
 * Single source of truth for FRONTEND_ROOT_FILES and JS_EQUIVALENTS.
 * Consumed by: PipelineExecutor._enforceManifest, BuilderAgent._enforceManifest,
 * validateCodeAgainstScaffold, PipelineOrchestrator inline enforcement.
 * DO NOT duplicate these constants elsewhere — import from here.
 */

// Root-level frontend files that may appear as public/x in scaffold but x in CODE output.
// app.jsx included for React CDN builds where LLM generates JSX at root.
const FRONTEND_ROOT_FILES = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'script.js',
  'app.jsx',
]);

// Equivalence pairs: AI frequently swaps these names.
// [a, b] means "if manifest expects a but CODE generated b, rename b → a" (and vice versa).
// app.jsx ↔ app.js handles React CDN builds where LLM generates .js instead of .jsx.
const JS_EQUIVALENTS = [
  ['app.js', 'script.js'],
  ['app.jsx', 'app.js'],
];

/**
 * Build a canonical manifest set from a scaffold file list.
 * Normalizes public/x → x for frontend root files.
 * @param {string[]} scaffoldFiles
 * @returns {Set<string>}
 */
function buildManifestSet(scaffoldFiles) {
  const manifestSet = new Set();
  for (const f of scaffoldFiles) {
    if (f.startsWith('public/')) {
      const basename = f.replace('public/', '');
      if (FRONTEND_ROOT_FILES.has(basename)) {
        manifestSet.add(basename);
        continue;
      }
    }
    manifestSet.add(f);
  }
  return manifestSet;
}

/**
 * Apply JS equivalence renaming: if manifest expects one name but files have the equivalent,
 * rename to match the manifest.
 * @param {object} files - { [filename]: content }
 * @param {Set<string>} manifestSet - canonical manifest set
 * @param {string} logPrefix - e.g. '[Pipeline]' or '[BuilderAgent]'
 * @returns {object} files with renames applied (shallow copy)
 */
function applyEquivalenceRenames(files, manifestSet, logPrefix = '[Pipeline]') {
  const renamed = { ...files };
  for (const [a, b] of JS_EQUIVALENTS) {
    if (manifestSet.has(a) && !renamed[a] && renamed[b]) {
      console.log(`${logPrefix} Manifest enforcement: renaming ${b} → ${a} (equivalence mapping)`);
      renamed[a] = renamed[b];
      delete renamed[b];
    }
    if (manifestSet.has(b) && !renamed[b] && renamed[a]) {
      console.log(`${logPrefix} Manifest enforcement: renaming ${a} → ${b} (equivalence mapping)`);
      renamed[b] = renamed[a];
      delete renamed[a];
    }
  }
  return renamed;
}

module.exports = {
  FRONTEND_ROOT_FILES,
  JS_EQUIVALENTS,
  buildManifestSet,
  applyEquivalenceRenames,
};
