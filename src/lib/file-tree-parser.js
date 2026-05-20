/**
 * File Tree Parser — extracts user-provided file trees from prompt text.
 *
 * Detects indented directory trees, path-per-line lists, and explicit file paths
 * pasted into a build prompt. When found, returns structured scaffold data so the
 * scaffold phase uses the user's tree verbatim instead of generating a default one.
 *
 * NOT responsible for: scaffold generation, tech stack selection beyond inference,
 * or any AI calls.
 */

// File extensions → language/tech stack mapping
const EXT_TO_LANG = {
  '.ts':    'typescript',
  '.tsx':   'typescript',
  '.js':    'javascript',
  '.jsx':   'javascript',
  '.py':    'python',
  '.cs':    'csharp',
  '.go':    'go',
  '.rs':    'rust',
  '.java':  'java',
  '.kt':    'kotlin',
  '.swift': 'swift',
  '.rb':    'ruby',
  '.php':   'php',
  '.cpp':   'cpp',
  '.c':     'c',
  '.h':     'c',
  '.hpp':   'cpp',
  '.lua':   'lua',
  '.r':     'r',
  '.scala': 'scala',
  '.dart':  'dart',
  '.vue':   'vue',
  '.svelte':'svelte',
};

// Known config/build files that confirm a tech stack even without an extension-based signal
const CONFIG_FILES = {
  'tsconfig.json':    'typescript',
  'package.json':     'javascript',
  'cargo.toml':       'rust',
  'go.mod':           'go',
  'pom.xml':          'java',
  'build.gradle':     'java',
  'requirements.txt': 'python',
  'pyproject.toml':   'python',
  'setup.py':         'python',
  'gemfile':          'ruby',
  'composer.json':    'php',
  'pubspec.yaml':     'dart',
};

/**
 * Parse a user-provided file tree from the prompt text.
 *
 * Handles three formats:
 *   1. Indented tree (spaces/tabs, optional tree chars like ├── └──)
 *   2. Path-per-line (one file path per line, with / separators)
 *   3. Inline paths in prose (multiple paths with extensions mentioned in text)
 *
 * @param {string} prompt - The user's build prompt
 * @returns {{ tree: Array<{path: string, type: string, description: string}>, techStack: string[], language: string|null, isUserProvided: boolean } | null}
 *   Returns null if no file tree is detected in the prompt.
 */
function extractFileTree(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  // Strategy 1: Detect indented tree or path-per-line blocks
  const treeBlock = _extractTreeBlock(prompt);
  if (treeBlock && treeBlock.length >= 2) {
    return _buildResult(treeBlock);
  }

  // Strategy 2: Detect multiple explicit file paths in the text
  const inlinePaths = _extractInlinePaths(prompt);
  if (inlinePaths && inlinePaths.length >= 2) {
    return _buildResult(inlinePaths);
  }

  return null;
}

/**
 * Extract a tree block from the prompt. Looks for consecutive lines that
 * look like file/directory paths — indented with spaces/tabs, possibly
 * prefixed with tree drawing characters (├── └── │).
 */
function _extractTreeBlock(prompt) {
  const lines = prompt.split('\n');
  const filePaths = [];
  let inBlock = false;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip tree drawing characters and leading whitespace
    const cleaned = raw
      .replace(/[├└│┌┐┘┤┬┴┼─╌╎╏═║╔╗╚╝╠╣╦╩╬]/g, '')
      .replace(/^\s+/, '')
      .trim();

    if (!cleaned) {
      // Empty line — end of block if we were in one
      if (inBlock && filePaths.length >= 2) break;
      inBlock = false;
      continue;
    }

    // Does this line look like a file/directory path?
    if (_looksLikeFilePath(cleaned, raw)) {
      if (!inBlock) {
        inBlock = true;
        blockStart = i;
      }
      filePaths.push(_normalizePath(cleaned, raw, lines, i));
    } else if (inBlock) {
      // Non-path line after a block started — end the block
      if (filePaths.length >= 2) break;
      // Too few paths, reset
      filePaths.length = 0;
      inBlock = false;
    }
  }

  return filePaths.length >= 2 ? filePaths : null;
}

/**
 * Extract file paths mentioned inline in prose text.
 * Looks for strings that look like file paths with extensions.
 */
function _extractInlinePaths(prompt) {
  // Match paths like "server/core/agent.ts" or "src/main.py" embedded in text
  const pathRegex = /(?:^|\s|["`'(,])([a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-.]+)+\.[a-zA-Z0-9]+)/gm;
  const found = new Set();
  let match;

  while ((match = pathRegex.exec(prompt)) !== null) {
    const p = match[1].trim();
    // Must have a recognizable file extension
    const ext = _getExtension(p);
    if (ext && (EXT_TO_LANG[ext] || ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.xml' || ext === '.md' || ext === '.txt' || ext === '.html' || ext === '.css' || ext === '.sql')) {
      found.add(p);
    }
  }

  return found.size >= 2 ? Array.from(found) : null;
}

/**
 * Determine if a cleaned line looks like a file or directory path.
 */
function _looksLikeFilePath(cleaned, rawLine) {
  // Must not be too long (prose sentence)
  if (cleaned.length > 120) return false;
  // Must not contain multiple spaces (prose)
  if (/\s{2,}/.test(cleaned) && !rawLine.match(/[├└│─]/)) return false;

  // Directory: ends with /
  if (/^[a-zA-Z0-9_\-.]+\/$/.test(cleaned)) return true;
  // Directory: single word that looks like a dir name (in context of tree)
  if (/^[a-zA-Z0-9_\-.]+$/.test(cleaned) && rawLine.match(/^\s{2,}|[├└│─]/)) return true;
  // File with extension
  if (/^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(cleaned)) return true;
  // Path with / separators
  if (/^[a-zA-Z0-9_\-.]+\//.test(cleaned) && !cleaned.includes(' ')) return true;

  return false;
}

/**
 * Normalize a path from a tree line, reconstructing the full path from
 * indentation context.
 */
function _normalizePath(cleaned, rawLine, allLines, lineIndex) {
  // Remove trailing / for consistency, we'll add it back for dirs
  let p = cleaned.replace(/\/$/, '');

  // If the path already contains /, it's a full relative path
  if (p.includes('/')) return p;

  // Otherwise, reconstruct from indentation hierarchy
  const indent = _getIndentLevel(rawLine);
  if (indent === 0) return p;

  // Walk backward to find parent directories
  const parents = [];
  let targetIndent = indent;

  for (let j = lineIndex - 1; j >= 0; j--) {
    const prevRaw = allLines[j];
    const prevCleaned = prevRaw
      .replace(/[├└│┌┐┘┤┬┴┼─╌╎╏═║╔╗╚╝╠╣╦╩╬]/g, '')
      .replace(/^\s+/, '')
      .trim();
    if (!prevCleaned) continue;

    const prevIndent = _getIndentLevel(prevRaw);
    if (prevIndent < targetIndent) {
      const prevPath = prevCleaned.replace(/\/$/, '');
      // Only use single-segment names as parent dirs (not full paths)
      if (!prevPath.includes('/') && !_getExtension(prevPath)) {
        parents.unshift(prevPath);
        targetIndent = prevIndent;
        if (prevIndent === 0) break;
      } else {
        break;
      }
    }
  }

  return parents.length > 0 ? parents.join('/') + '/' + p : p;
}

/**
 * Get indentation level of a line (counting leading spaces/tabs and tree chars).
 */
function _getIndentLevel(line) {
  // Count leading whitespace + tree characters as indent
  const match = line.match(/^([\s├└│┌┐┘┤┬┴┼─╌╎╏═║╔╗╚╝╠╣╦╩╬]*)/);
  if (!match) return 0;
  // Normalize: each tab = 2 spaces, tree chars count as 1 each
  const prefix = match[1];
  let level = 0;
  for (const ch of prefix) {
    if (ch === '\t') level += 2;
    else if (ch === ' ') level += 1;
    else level += 1; // tree drawing char
  }
  return level;
}

/**
 * Get file extension (lowercase) from a path.
 */
function _getExtension(filepath) {
  const match = filepath.match(/(\.[a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Build the structured result from an array of file paths.
 */
function _buildResult(filePaths) {
  const tree = [];
  const dirs = new Set();

  for (const fp of filePaths) {
    const ext = _getExtension(fp);
    const isFile = !!ext;

    if (isFile) {
      // Ensure parent directories are in the tree
      const parts = fp.split('/');
      if (parts.length > 1) {
        let dirPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
          dirPath += (dirPath ? '/' : '') + parts[i];
          const dirKey = dirPath + '/';
          if (!dirs.has(dirKey)) {
            dirs.add(dirKey);
            tree.push({ path: dirKey, type: 'dir', description: `Directory: ${dirPath}` });
          }
        }
      }
      tree.push({ path: fp, type: 'file', description: `User-specified: ${fp}` });
    } else {
      // Directory entry
      const dirKey = fp.endsWith('/') ? fp : fp + '/';
      if (!dirs.has(dirKey)) {
        dirs.add(dirKey);
        tree.push({ path: dirKey, type: 'dir', description: `Directory: ${fp}` });
      }
    }
  }

  // Infer tech stack from file extensions
  const { techStack, language } = _inferTechStack(filePaths);

  const fileCount = tree.filter(t => t.type === 'file').length;
  const dirCount = tree.filter(t => t.type === 'dir').length;
  const summary = `User-provided file tree — ${dirCount} directories, ${fileCount} files` +
    (language ? ` (${language})` : '');

  return {
    tree,
    techStack,
    language,
    summary,
    files: tree.filter(t => t.type === 'file').map(t => t.path),
    isUserProvided: true,
  };
}

/**
 * Infer tech stack and primary language from file extensions in the tree.
 */
function _inferTechStack(filePaths) {
  const langCounts = {};

  for (const fp of filePaths) {
    const ext = _getExtension(fp);
    if (ext && EXT_TO_LANG[ext]) {
      const lang = EXT_TO_LANG[ext];
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    // Check config files
    const basename = fp.split('/').pop().toLowerCase();
    if (CONFIG_FILES[basename]) {
      const lang = CONFIG_FILES[basename];
      langCounts[lang] = (langCounts[lang] || 0) + 2; // Weight config files higher
    }
  }

  // Primary language is the one with most files
  const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
  const language = sorted.length > 0 ? sorted[0][0] : null;

  // Build tech stack array
  const techStack = sorted.map(([lang]) => lang);

  return { techStack, language };
}

module.exports = { extractFileTree };
