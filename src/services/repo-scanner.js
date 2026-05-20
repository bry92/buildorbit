/**
 * Repo Scanner Service
 *
 * Owns: Scanning a connected GitHub repo's file tree to produce a structured
 *       tech stack profile BEFORE the pipeline runs. This profile drives
 *       intent classification, scaffold strategy, and VERIFY checks.
 *
 * Not owned: OAuth token management, repo file fetching (delegates to github-fetch),
 *            PR push, deploy logic.
 *
 * Usage: call scanRepoProfile({ pool, userId, repoFullName }) before enqueue.
 *        Returns a RepoProfile object stored in runConfig._repoProfile and
 *        passed through the pipeline via previousOutputs._repoProfile.
 *
 * Fallback: if GitHub API is unreachable or user has no token, returns null —
 *           pipeline continues with prompt-based detection only.
 */

const crypto = require('crypto');

// ── Token decryption ─────────────────────────────────────────────────────────
// Key derived from JWT_SECRET — must be set (validated at startup by auth module).
function getEncKey() {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET env var required for token decryption');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
}

function decryptToken(enc) {
  const [ivHex, tagHex, ctHex] = enc.split(':');
  const key = getEncKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), null, 'utf8') + decipher.final('utf8');
}

const GH_API = 'https://api.github.com';

async function ghFetch(token, path) {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return res;
}

// ── File signatures for tech stack detection ──────────────────────────────────

const STACK_SIGNATURES = [
  // C# / .NET / WPF / Xamarin
  { pattern: /\.csproj$/i,        language: 'csharp',  framework: 'dotnet',    platform: 'desktop' },
  { pattern: /\.sln$/i,           language: 'csharp',  framework: 'dotnet',    platform: 'desktop' },
  { pattern: /\.xaml$/i,          language: 'csharp',  framework: 'wpf',       platform: 'desktop' },
  { pattern: /\.cs$/i,            language: 'csharp',  framework: 'dotnet',    platform: 'desktop' },
  { pattern: /\.vbproj$/i,        language: 'vb',      framework: 'dotnet',    platform: 'desktop' },
  { pattern: /\.fsproj$/i,        language: 'fsharp',  framework: 'dotnet',    platform: 'desktop' },

  // Swift / iOS / macOS
  { pattern: /\.xcodeproj$/i,     language: 'swift',   framework: 'xcode',     platform: 'mobile'  },
  { pattern: /Package\.swift$/i,  language: 'swift',   framework: 'spm',       platform: 'desktop' },
  { pattern: /\.swift$/i,         language: 'swift',   framework: null,        platform: 'mobile'  },

  // Java / Android / Spring
  { pattern: /pom\.xml$/i,        language: 'java',    framework: 'maven',     platform: 'backend' },
  { pattern: /build\.gradle$/i,   language: 'java',    framework: 'gradle',    platform: 'backend' },
  { pattern: /AndroidManifest\.xml$/i, language: 'java', framework: 'android', platform: 'mobile' },
  { pattern: /\.java$/i,          language: 'java',    framework: null,        platform: 'backend' },
  { pattern: /\.kt$/i,            language: 'kotlin',  framework: null,        platform: 'mobile'  },

  // Rust
  { pattern: /Cargo\.toml$/i,     language: 'rust',    framework: 'cargo',     platform: 'native'  },
  { pattern: /\.rs$/i,            language: 'rust',    framework: null,        platform: 'native'  },

  // Go
  { pattern: /go\.mod$/i,         language: 'go',      framework: null,        platform: 'backend' },
  { pattern: /\.go$/i,            language: 'go',      framework: null,        platform: 'backend' },

  // Python
  { pattern: /requirements\.txt$/i, language: 'python', framework: null,       platform: 'backend' },
  { pattern: /pyproject\.toml$/i, language: 'python',  framework: null,        platform: 'backend' },
  { pattern: /setup\.py$/i,       language: 'python',  framework: null,        platform: 'backend' },
  { pattern: /setup\.cfg$/i,      language: 'python',  framework: null,        platform: 'backend' },
  { pattern: /\.py$/i,            language: 'python',  framework: null,        platform: 'backend' },

  // Ruby
  { pattern: /Gemfile$/i,         language: 'ruby',    framework: null,        platform: 'backend' },
  { pattern: /\.rb$/i,            language: 'ruby',    framework: null,        platform: 'backend' },

  // PHP
  { pattern: /composer\.json$/i,  language: 'php',     framework: null,        platform: 'backend' },
  { pattern: /\.php$/i,           language: 'php',     framework: null,        platform: 'backend' },

  // C / C++
  { pattern: /CMakeLists\.txt$/i, language: 'cpp',     framework: 'cmake',     platform: 'native'  },
  { pattern: /\.cpp$/i,           language: 'cpp',     framework: null,        platform: 'native'  },
  { pattern: /\.c$/i,             language: 'c',       framework: null,        platform: 'native'  },
  { pattern: /\.h$/i,             language: 'c',       framework: null,        platform: 'native'  },

  // Dart / Flutter
  { pattern: /pubspec\.yaml$/i,   language: 'dart',    framework: 'flutter',   platform: 'mobile'  },
  { pattern: /\.dart$/i,          language: 'dart',    framework: 'flutter',   platform: 'mobile'  },

  // Node.js (matched last — lower signal weight than lang-specific files)
  { pattern: /package\.json$/i,   language: 'javascript', framework: 'node',  platform: 'web'     },
];

// Platform types that are NOT web (skip React/HTML scaffolding)
const NON_WEB_PLATFORMS = new Set(['desktop', 'mobile', 'native']);

// Build systems per language
const BUILD_SYSTEMS = {
  csharp: 'msbuild',
  java:   'maven',
  kotlin: 'gradle',
  rust:   'cargo',
  go:     'go',
  python: 'pip',
  ruby:   'bundler',
  php:    'composer',
  dart:   'pub',
  cpp:    'cmake',
  c:      'make',
};

// Artifact extensions allowed per platform
const ALLOWED_ARTIFACTS = {
  csharp:     ['.cs', '.xaml', '.csproj', '.sln', '.resx', '.config'],
  java:       ['.java', '.xml', '.properties', '.gradle'],
  kotlin:     ['.kt', '.xml', '.gradle'],
  python:     ['.py', '.txt', '.toml', '.cfg', '.ini'],
  ruby:       ['.rb', '.gemspec', '.rake', '.yml'],
  go:         ['.go', '.mod', '.sum'],
  rust:       ['.rs', '.toml'],
  cpp:        ['.cpp', '.h', '.hpp', '.c', '.cmake', '.txt'],
  swift:      ['.swift', '.plist', '.xib', '.storyboard'],
  dart:       ['.dart', '.yaml', '.arb'],
  php:        ['.php', '.json', '.yaml'],
  javascript: ['.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.svg'],
};

// Artifacts that are PROHIBITED for non-web projects
const WEB_ONLY_ARTIFACTS = ['.jsx', '.tsx', '.html', '.css', '.scss', '.sass', '.vue', '.svelte'];

// ── Detect framework refinements from package.json content ───────────────────

function detectNodeFramework(pkgContent) {
  if (!pkgContent) return null;
  try {
    const pkg = JSON.parse(pkgContent);
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    if (deps['react'] || deps['react-dom'])    return 'react';
    if (deps['next'])                           return 'nextjs';
    if (deps['vue'])                            return 'vue';
    if (deps['@angular/core'])                  return 'angular';
    if (deps['svelte'])                         return 'svelte';
    if (deps['express'])                        return 'express';
    if (deps['fastify'])                        return 'fastify';
    if (deps['koa'])                            return 'koa';
    if (deps['nest'] || deps['@nestjs/core'])   return 'nestjs';
    if (deps['electron'])                       return 'electron';
    if (deps['react-native'])                   return 'react-native';
  } catch (_) {}
  return 'node';
}

// ── Detect .NET sub-framework from .csproj ────────────────────────────────────

function detectDotnetFramework(csprojContent) {
  if (!csprojContent) return 'dotnet';
  if (/<Project Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(csprojContent)) return 'aspnet';
  if (/UseWPF.*true/i.test(csprojContent) || /<UseWPF>/i.test(csprojContent)) return 'wpf';
  if (/UseWindowsForms.*true/i.test(csprojContent)) return 'winforms';
  if (/OutputType.*WinExe/i.test(csprojContent)) return 'wpf';
  if (/<MAUI>/i.test(csprojContent) || /UseMaui.*true/i.test(csprojContent)) return 'maui';
  return 'dotnet';
}

// ── Detect Python sub-framework ───────────────────────────────────────────────

function detectPythonFramework(files) {
  const allContent = Object.values(files).join(' ');
  if (allContent.includes('django'))     return 'django';
  if (allContent.includes('flask'))      return 'flask';
  if (allContent.includes('fastapi'))    return 'fastapi';
  if (allContent.includes('streamlit'))  return 'streamlit';
  if (allContent.includes('pytorch') || allContent.includes('torch')) return 'pytorch';
  if (allContent.includes('tensorflow')) return 'tensorflow';
  return 'python';
}

// ── Score language candidates from file tree ──────────────────────────────────

function scoreLanguageCandidates(fileTree) {
  // Weight: high-signal files get 10 pts, extension-only gets 1 pt
  const HIGH_SIGNAL = new Set([
    '.csproj', '.sln', 'Package.swift', 'pom.xml', 'build.gradle',
    'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Gemfile',
    'composer.json', 'pubspec.yaml', 'CMakeLists.txt',
  ]);

  const scores = {};
  for (const filePath of fileTree) {
    const basename = filePath.split('/').pop();
    const ext = basename.includes('.') ? '.' + basename.split('.').slice(1).join('.') : '';

    for (const sig of STACK_SIGNATURES) {
      if (sig.pattern.test(filePath) || sig.pattern.test(basename)) {
        const lang = sig.language;
        const isHighSignal = HIGH_SIGNAL.has(basename) || HIGH_SIGNAL.has(ext);
        scores[lang] = (scores[lang] || 0) + (isHighSignal ? 10 : 1);
        break; // first match wins per file
      }
    }
  }

  return scores;
}

// ── Fetch a few key files for deeper analysis ─────────────────────────────────

const ANALYSIS_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'README.md',
  'README',
];

async function fetchKeyFiles(token, repoFullName, fileTree) {
  const files = {};
  const toFetch = [];

  for (const name of ANALYSIS_FILES) {
    const match = fileTree.find(p => p === name || p.endsWith('/' + name));
    if (match) toFetch.push(match);
  }

  // Also look for any .csproj or pom.xml (first one found)
  const csproj = fileTree.find(p => p.endsWith('.csproj'));
  if (csproj && !toFetch.includes(csproj)) toFetch.push(csproj);

  const pom = fileTree.find(p => p === 'pom.xml' || p.endsWith('/pom.xml'));
  if (pom && !toFetch.includes(pom)) toFetch.push(pom);

  await Promise.all(
    toFetch.map(async (filePath) => {
      try {
        const res = await ghFetch(token, `/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.content) {
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          files[filePath.split('/').pop()] = content;
          files[filePath] = content; // also by full path
        }
      } catch (_) {
        // non-fatal — skip this file
      }
    })
  );

  return files;
}

// ── Build the RepoProfile ─────────────────────────────────────────────────────

function buildRepoProfile(repoFullName, fileTree, files) {
  const scores = scoreLanguageCandidates(fileTree);

  // Sort by score descending
  const ranked = Object.entries(scores).sort(([, a], [, b]) => b - a);

  let language = ranked.length > 0 ? ranked[0][0] : 'javascript';
  let platform = 'web';
  let framework = null;

  // Find the platform from highest-scored language's primary signature
  for (const [lang, score] of ranked) {
    if (score > 0) {
      // Find the highest-signal signature for this lang
      for (const sig of STACK_SIGNATURES) {
        if (sig.language === lang && sig.platform) {
          platform = sig.platform;
          if (!framework && sig.framework) framework = sig.framework;
          break;
        }
      }
      // Only use the top language
      language = lang;
      break;
    }
  }

  // Refine framework based on file contents
  if (language === 'javascript') {
    const detected = detectNodeFramework(files['package.json']);
    if (detected) {
      framework = detected;
      // Electron = desktop, React Native = mobile
      if (detected === 'electron')       platform = 'desktop';
      if (detected === 'react-native')   platform = 'mobile';
    }
  } else if (language === 'csharp') {
    const csproj = Object.values(files).find((_, i) => Object.keys(files)[i]?.endsWith('.csproj'));
    framework = detectDotnetFramework(csproj || '');
    // aspnet = web, others = desktop
    if (framework === 'aspnet') platform = 'web';
    else platform = 'desktop';
  } else if (language === 'python') {
    framework = detectPythonFramework(files);
    if (framework === 'streamlit' || framework === 'django' || framework === 'flask' || framework === 'fastapi') {
      platform = 'web';
    }
  }

  const isWebProject = !NON_WEB_PLATFORMS.has(platform);
  const buildSystem = BUILD_SYSTEMS[language] || null;

  // Entry points — common ones per language
  const entryPoints = fileTree.filter(f => {
    const base = f.split('/').pop();
    if (language === 'csharp') return /App\.xaml$|Program\.cs$|Startup\.cs$/i.test(base);
    if (language === 'java')   return /Main\.java$|Application\.java$/i.test(base);
    if (language === 'python') return /main\.py$|app\.py$|__main__\.py$/i.test(base);
    if (language === 'go')     return /main\.go$/i.test(base);
    if (language === 'rust')   return /main\.rs$/i.test(f);
    if (language === 'javascript') return /index\.js$|server\.js$|app\.js$|main\.js$/.test(base);
    return false;
  }).slice(0, 5);

  // Allowed artifacts
  const allowedArtifacts = ALLOWED_ARTIFACTS[language] || ALLOWED_ARTIFACTS.javascript;

  // Prohibited artifacts for non-web projects
  const prohibitedArtifacts = isWebProject ? [] : WEB_ONLY_ARTIFACTS;

  // Total files scanned
  const totalFiles = fileTree.length;

  // Score for detection confidence (0-100)
  const topScore = ranked.length > 0 ? ranked[0][1] : 0;
  const confidence = Math.min(100, Math.round((topScore / (topScore + 5)) * 100));

  return {
    language,
    framework,
    platform,
    buildSystem,
    isWebProject,
    entryPoints,
    fileTree,
    totalFiles,
    allowedArtifacts,
    prohibitedArtifacts,
    confidence,
    _scoredCandidates: ranked.slice(0, 5), // for debugging
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scan a GitHub repo's file tree and produce a structured tech stack profile.
 *
 * @param {object} opts
 * @param {object} opts.pool          - pg Pool
 * @param {number} opts.userId        - User ID (for GitHub token lookup)
 * @param {string} opts.repoFullName  - "owner/repo"
 * @returns {RepoProfile|null}        - null on failure (graceful degradation)
 *
 * RepoProfile:
 *   {
 *     language, framework, platform, buildSystem,
 *     isWebProject, entryPoints, fileTree, totalFiles,
 *     allowedArtifacts, prohibitedArtifacts, confidence
 *   }
 */
async function scanRepoProfile({ pool, userId, repoFullName }) {
  try {
    // Load encrypted token
    const { rows } = await pool.query(
      'SELECT access_token_enc FROM github_connections WHERE user_id = $1',
      [userId]
    );
    if (!rows.length) {
      console.log(`[RepoScanner] No GitHub token for user ${userId} — skipping scan`);
      return null;
    }

    const token = decryptToken(rows[0].access_token_enc);

    // 1. Get file tree (fast — one API call for the recursive tree)
    const repoRes = await ghFetch(token, `/repos/${repoFullName}`);
    if (!repoRes.ok) {
      console.warn(`[RepoScanner] Repo fetch failed (${repoRes.status}) for ${repoFullName}`);
      return null;
    }
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    const treeRes = await ghFetch(token, `/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`);
    if (!treeRes.ok) {
      console.warn(`[RepoScanner] Tree fetch failed (${treeRes.status}) for ${repoFullName}`);
      return null;
    }
    const treeData = await treeRes.json();
    const fileTree = (treeData.tree || [])
      .filter(item => item.type === 'blob')
      .map(item => item.path);

    // 2. Fetch key files for deeper analysis
    const files = await fetchKeyFiles(token, repoFullName, fileTree);

    // 3. Build the profile
    const profile = buildRepoProfile(repoFullName, fileTree, files);
    profile.repoFullName    = repoFullName;
    profile.defaultBranch   = defaultBranch;

    console.log(
      `[RepoScanner] ${repoFullName}: ` +
      `language=${profile.language}, framework=${profile.framework}, ` +
      `platform=${profile.platform}, isWeb=${profile.isWebProject}, ` +
      `confidence=${profile.confidence}%, files=${profile.totalFiles}`
    );

    return profile;
  } catch (err) {
    // Always graceful — repo scan failure never blocks the pipeline
    console.warn(`[RepoScanner] Scan failed for ${repoFullName} (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { scanRepoProfile };
