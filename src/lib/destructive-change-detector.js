/**
 * Destructive Change Detector
 *
 * Owns: pre-commit safety analysis comparing generated CODE output against
 *       the existing repo file tree. Hard-blocks catastrophic rewrites.
 * Does NOT own: persisting results, GitHub push logic, pipeline routing.
 *
 * Design: pure functions, no I/O, no side effects. Call detectDestructiveChanges()
 * before any write/push and throw CatastrophicRewriteError if thresholds exceeded.
 *
 * Thresholds (hard limits):
 *   - deletedFiles > 20        → blocked
 *   - rewrittenRatio > 0.4     → blocked (>40% of existing files overwritten)
 *   - topologyDelta > 0.5      → blocked (>50% of existing directories would change)
 *   - removedPackages > 5      → blocked (major dependency removal)
 *
 * extend_existing mode always runs full analysis. scaffold_new mode skips
 * topology + deletion checks (no existing tree to compare against) but still
 * validates package integrity on the generated output.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const HARD_LIMITS = {
  deletedFiles:       20,   // max files that can be deleted
  rewrittenRatio:     0.40, // max fraction of existing files that can be overwritten
  topologyDelta:      0.50, // max fraction of existing dirs that can disappear
  removedPackages:    5,    // max dependency removals
};

// ── Error class ───────────────────────────────────────────────────────────────

class CatastrophicRewriteError extends Error {
  /**
   * @param {string} reason  - Human-readable summary e.g. "23 deletions, 65% rewrite ratio"
   * @param {object} stats   - Full analysis output for surfacing to the user
   */
  constructor(reason, stats) {
    super(`Blocked: ${reason}`);
    this.name = 'CatastrophicRewriteError';
    this.reason = reason;
    this.stats = stats;
  }
}

// ── Core analysis ─────────────────────────────────────────────────────────────

/**
 * Normalise a file path so comparisons are consistent.
 * Strips leading ./ and lowercases for cross-platform safety.
 */
function normalisePath(p) {
  return String(p).replace(/^\.\//, '').toLowerCase();
}

/**
 * Extract unique top-level directory prefixes from a list of paths.
 * 'src/lib/foo.js' → 'src'
 * 'routes/auth.js' → 'routes'
 * 'server.js'      → '' (root)
 */
function extractDirectories(filePaths) {
  const dirs = new Set();
  for (const p of filePaths) {
    const norm = normalisePath(p);
    const slash = norm.indexOf('/');
    dirs.add(slash === -1 ? '' : norm.slice(0, slash));
  }
  return dirs;
}

/**
 * Compute similarity between two file contents.
 * Uses a simple byte-length ratio as a cheap proxy.
 * Returns 0.0 (completely different) to 1.0 (identical length).
 * A rewritten file is anything below 0.5 similarity.
 */
function isLikelyRewritten(existingContent, generatedContent) {
  if (typeof existingContent !== 'string' || typeof generatedContent !== 'string') return false;
  const elen = existingContent.length;
  const glen = generatedContent.length;
  if (elen === 0) return false;
  const ratio = Math.min(elen, glen) / Math.max(elen, glen);
  // < 50% size match → likely rewritten from scratch
  return ratio < 0.5;
}

/**
 * Extract package names from a package.json string (dependencies + devDependencies).
 * Returns a Set of package names. Returns empty Set on parse failure.
 */
function parsePackageNames(pkgJsonString) {
  const result = new Set();
  if (!pkgJsonString || typeof pkgJsonString !== 'string') return result;
  try {
    const parsed = JSON.parse(pkgJsonString);
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const name of Object.keys(deps)) result.add(name);
  } catch (_) { /* malformed JSON — return empty */ }
  return result;
}

/**
 * Main analysis function.
 *
 * @param {string[]} existingFileTree  - Paths from the source repo (may include content blobs)
 * @param {object}   generatedFiles    - { [filename]: content } from CODE output
 * @param {object}   [existingContent] - Optional { [filename]: content } for rewrite ratio. If
 *                                       not provided, rewrite ratio is estimated from path overlap.
 * @param {string}   [repoMode]        - 'extend_existing' | 'scaffold_new'
 * @returns {ChangeAnalysis}
 */
function analyseChanges(existingFileTree, generatedFiles, existingContent = {}, repoMode = 'scaffold_new') {
  const generated = generatedFiles || {};
  const genPaths = new Set(Object.keys(generated).map(normalisePath));

  // ── 1. Build existing path set ────────────────────────────────────────────
  // existingFileTree may be: string[] of paths, or objects with {path, content}
  const existingPaths = new Set();
  const existingContentMap = { ...existingContent };

  for (const entry of (existingFileTree || [])) {
    if (typeof entry === 'string') {
      existingPaths.add(normalisePath(entry));
    } else if (entry && typeof entry.path === 'string') {
      existingPaths.add(normalisePath(entry.path));
      if (entry.content) existingContentMap[normalisePath(entry.path)] = entry.content;
    }
  }

  const existingCount = existingPaths.size;

  // ── 2. Deleted files (in existing but not in generated) ───────────────────
  const deletedFiles = [];
  for (const ep of existingPaths) {
    if (!genPaths.has(ep)) deletedFiles.push(ep);
  }

  // ── 3. Rewritten files (in both sets, but content radically changed) ──────
  const rewrittenFiles = [];
  for (const ep of existingPaths) {
    if (!genPaths.has(ep)) continue; // deleted, not rewritten
    const existContent = existingContentMap[ep];
    const genContent = generated[ep] || generated[Object.keys(generated).find(k => normalisePath(k) === ep)] || '';
    if (existContent && isLikelyRewritten(existContent, genContent)) {
      rewrittenFiles.push(ep);
    }
  }
  const rewrittenRatio = existingCount > 0
    ? (rewrittenFiles.length + deletedFiles.length) / existingCount
    : 0;

  // ── 4. Topology delta (directories) ──────────────────────────────────────
  const existingDirs = extractDirectories(Array.from(existingPaths));
  const generatedDirs = extractDirectories(Object.keys(generated).map(normalisePath));
  const disappearedDirs = [];
  for (const d of existingDirs) {
    if (d && !generatedDirs.has(d)) disappearedDirs.push(d);
  }
  const topologyDelta = existingDirs.size > 0
    ? disappearedDirs.length / existingDirs.size
    : 0;

  // ── 5. Package removal count ──────────────────────────────────────────────
  let removedPackages = [];
  const existingPkgContent = existingContentMap['package.json'];
  const generatedPkgContent = generated['package.json'];

  if (existingPkgContent && generatedPkgContent) {
    const existingPkgs = parsePackageNames(existingPkgContent);
    const generatedPkgs = parsePackageNames(generatedPkgContent);
    for (const pkg of existingPkgs) {
      if (!generatedPkgs.has(pkg)) removedPackages.push(pkg);
    }
  }

  // ── 6. Violations check ────────────────────────────────────────────────────
  // In scaffold_new mode: skip deletion and topology checks (no existing tree)
  const violations = [];
  const isExtendExisting = repoMode === 'extend_existing';

  if (isExtendExisting) {
    if (deletedFiles.length > HARD_LIMITS.deletedFiles) {
      violations.push({
        type: 'excessive_deletions',
        message: `${deletedFiles.length} files deleted (limit: ${HARD_LIMITS.deletedFiles})`,
        value: deletedFiles.length,
        limit: HARD_LIMITS.deletedFiles,
      });
    }
    if (rewrittenRatio > HARD_LIMITS.rewrittenRatio) {
      violations.push({
        type: 'excessive_rewrites',
        message: `${(rewrittenRatio * 100).toFixed(0)}% of existing files rewritten (limit: ${HARD_LIMITS.rewrittenRatio * 100}%)`,
        value: rewrittenRatio,
        limit: HARD_LIMITS.rewrittenRatio,
      });
    }
    if (topologyDelta > HARD_LIMITS.topologyDelta) {
      violations.push({
        type: 'topology_destruction',
        message: `${(topologyDelta * 100).toFixed(0)}% of directory structure would disappear (limit: ${HARD_LIMITS.topologyDelta * 100}%)`,
        value: topologyDelta,
        limit: HARD_LIMITS.topologyDelta,
      });
    }
  }

  if (removedPackages.length > HARD_LIMITS.removedPackages) {
    violations.push({
      type: 'excessive_package_removals',
      message: `${removedPackages.length} packages removed (limit: ${HARD_LIMITS.removedPackages}): ${removedPackages.slice(0, 5).join(', ')}${removedPackages.length > 5 ? '...' : ''}`,
      value: removedPackages.length,
      limit: HARD_LIMITS.removedPackages,
    });
  }

  return {
    // Summary numbers
    existingFileCount:  existingCount,
    generatedFileCount: Object.keys(generated).length,
    deletedFileCount:   deletedFiles.length,
    rewrittenFileCount: rewrittenFiles.length,
    rewrittenRatio:     Math.round(rewrittenRatio * 1000) / 1000,
    topologyDelta:      Math.round(topologyDelta * 1000) / 1000,
    removedPackageCount: removedPackages.length,
    // Detail lists (for user-facing explanation)
    deletedFiles:       deletedFiles.slice(0, 30), // cap list for readability
    rewrittenFiles:     rewrittenFiles.slice(0, 30),
    disappearedDirs,
    removedPackages:    removedPackages.slice(0, 20),
    // Verdict
    violations,
    isCatastrophic:     violations.length > 0,
    repoMode,
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run destructive change detection and throw CatastrophicRewriteError if
 * the computed stats exceed hard limits.
 *
 * @param {string[]} existingFileTree  - From _sourceRepoFileTree
 * @param {object}   generatedFiles    - { [path]: content } from previousOutputs.code.files
 * @param {object}   [existingContent] - Optional per-file existing content map
 * @param {string}   [repoMode]        - 'extend_existing' | 'scaffold_new'
 * @throws {CatastrophicRewriteError}  - If hard limits are exceeded
 * @returns {ChangeAnalysis}           - Full stats (safe to proceed)
 */
function detectDestructiveChanges(existingFileTree, generatedFiles, existingContent = {}, repoMode = 'scaffold_new') {
  const analysis = analyseChanges(existingFileTree, generatedFiles, existingContent, repoMode);

  if (analysis.isCatastrophic) {
    const reasons = analysis.violations.map(v => v.message).join('; ');
    throw new CatastrophicRewriteError(reasons, analysis);
  }

  return analysis;
}

/**
 * Format a safe, user-readable summary of a change analysis.
 * Used for log output and SSE terminal display.
 */
function formatAnalysisSummary(analysis) {
  const lines = [
    `🔍 Change analysis (${analysis.repoMode}):`,
    `   Existing files: ${analysis.existingFileCount} | Generated: ${analysis.generatedFileCount}`,
    `   Deleted: ${analysis.deletedFileCount} | Rewritten: ${analysis.rewrittenFileCount} (${(analysis.rewrittenRatio * 100).toFixed(0)}%)`,
    `   Topology delta: ${(analysis.topologyDelta * 100).toFixed(0)}% | Packages removed: ${analysis.removedPackageCount}`,
  ];
  if (analysis.isCatastrophic) {
    lines.push('   ⛔ CATASTROPHIC REWRITE DETECTED:');
    for (const v of analysis.violations) {
      lines.push(`     • ${v.message}`);
    }
  } else {
    lines.push('   ✓ Change analysis passed');
  }
  return lines.join('\n');
}

module.exports = {
  detectDestructiveChanges,
  analyseChanges,
  formatAnalysisSummary,
  CatastrophicRewriteError,
  HARD_LIMITS,
};
