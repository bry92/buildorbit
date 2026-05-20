/**
 * previewAssets — extracts HTML / CSS / JS from pipeline CODE phase output.
 * Owns: parsing code artifacts into preview-renderable buckets.
 * Not owned: pipeline execution, component rendering.
 *
 * Handles two architecture patterns:
 *   1. Plain HTML + JS (static_surface) — HTML with <script src="app.js">
 *   2. React CDN + Babel standalone — HTML with <script type="text/babel" src="app.jsx">
 * For pattern 2, external Babel script refs are inlined so the iframe preview works
 * without a file server. JSX files are NOT extracted as plain JS (they need Babel).
 */

export interface PreviewAssets {
  html: string;
  css: string;
  js: string;
}

/** File extensions that indicate a server-side / non-renderable project */
const SERVER_EXTENSIONS = ['.py', '.go', '.rs', '.java', '.rb', '.php', '.cs'];
const SERVER_FILES = ['server.js', 'server.ts', 'app.js', 'app.ts', 'main.py', 'main.go', 'Dockerfile', 'docker-compose.yml'];

/** File extensions that are CSS-like */
const CSS_EXTENSIONS = ['.css'];
/** File extensions that are client-side JS (non-JSX only — JSX needs Babel) */
const JS_EXTENSIONS = ['.js', '.ts'];
/** File extensions that require Babel compilation (React CDN builds) */
const JSX_EXTENSIONS = ['.jsx', '.tsx'];
/** Files that are server-side despite having JS extensions */
const SERVER_JS_FILES = ['server.js', 'server.ts', 'app.js', 'app.ts', 'index.js', 'index.ts'];

/**
 * Determine if a set of files represents a server-side project
 * (not previewable in an iframe).
 */
export function isServerProject(
  files: Record<string, unknown> | undefined,
  intentClass: string | null | undefined,
): boolean {
  // PRODUCT_SYSTEM and FULL_PRODUCT are always server-side
  if (intentClass === 'PRODUCT_SYSTEM' || intentClass === 'FULL_PRODUCT') return true;

  if (!files || typeof files !== 'object') return false;

  const filenames = Object.keys(files);

  // If there's an index.html, it's previewable
  if (filenames.some(f => f.endsWith('.html'))) return false;

  // If all files are server-side extensions, it's a server project
  const hasOnlyServer = filenames.every(f => {
    const lower = f.toLowerCase();
    return SERVER_EXTENSIONS.some(ext => lower.endsWith(ext)) ||
           SERVER_FILES.includes(lower.split('/').pop() || '') ||
           lower.endsWith('.json') ||
           lower.endsWith('.md') ||
           lower.endsWith('.sql') ||
           lower.endsWith('.env') ||
           lower.endsWith('.yml') ||
           lower.endsWith('.yaml');
  });

  return hasOnlyServer;
}

/**
 * Detect if an HTML string uses React CDN with Babel standalone.
 * Looks for <script type="text/babel" ...> tags — signature of CDN builds.
 */
function isReactCdnBuild(html: string): boolean {
  return /type\s*=\s*["']text\/babel["']/i.test(html);
}

/**
 * Inline external Babel script references in HTML.
 * Replaces <script type="text/babel" src="app.jsx"></script> with
 * <script type="text/babel">[actual file content]</script>.
 *
 * Without this, the iframe preview can't resolve relative file paths
 * because there's no file server — the HTML is injected via doc.write().
 *
 * Returns { html: modified HTML, inlinedFiles: set of filenames that were inlined }.
 */
function inlineBabelScripts(
  html: string,
  files: Record<string, unknown>,
): { html: string; inlinedFiles: Set<string> } {
  const inlinedFiles = new Set<string>();

  // Match <script type="text/babel" src="..."></script> — captures the src path
  const babelSrcPattern = /<script\s+[^>]*type\s*=\s*["']text\/babel["'][^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;

  const modified = html.replace(babelSrcPattern, (_match, srcPath: string) => {
    // Normalize the path — strip leading ./ if present
    const normalizedPath = srcPath.replace(/^\.\//, '');

    // Find the file content — try exact path, then basename
    let content: string | null = null;
    if (typeof files[normalizedPath] === 'string') {
      content = files[normalizedPath] as string;
      inlinedFiles.add(normalizedPath);
    } else if (typeof files[srcPath] === 'string') {
      content = files[srcPath] as string;
      inlinedFiles.add(srcPath);
    } else {
      // Try matching by basename (in case files use paths like components/foo.jsx)
      const basename = normalizedPath.split('/').pop() || '';
      const match = Object.entries(files).find(([name]) =>
        name.split('/').pop() === basename && typeof files[name] === 'string'
      );
      if (match) {
        content = match[1] as string;
        inlinedFiles.add(match[0]);
      }
    }

    if (content) {
      return `<script type="text/babel">\n${content}\n</script>`;
    }
    // If file not found, leave the tag as-is (will fail gracefully in preview)
    return _match;
  });

  // Also handle the reversed attribute order: src before type
  const reversedPattern = /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*type\s*=\s*["']text\/babel["'][^>]*>\s*<\/script>/gi;
  const finalHtml = modified.replace(reversedPattern, (_match, srcPath: string) => {
    const normalizedPath = srcPath.replace(/^\.\//, '');
    if (inlinedFiles.has(normalizedPath) || inlinedFiles.has(srcPath)) {
      // Already handled by the first pass
      return _match;
    }

    let content: string | null = null;
    if (typeof files[normalizedPath] === 'string') {
      content = files[normalizedPath] as string;
      inlinedFiles.add(normalizedPath);
    } else if (typeof files[srcPath] === 'string') {
      content = files[srcPath] as string;
      inlinedFiles.add(srcPath);
    }

    if (content) {
      return `<script type="text/babel">\n${content}\n</script>`;
    }
    return _match;
  });

  return { html: finalHtml, inlinedFiles };
}

/**
 * Inline regular <script src="..."> references that point to local files.
 * Handles non-Babel scripts (plain JS in static_surface builds).
 * Returns { html: modified, inlinedFiles: set of filenames inlined }.
 */
function inlinePlainScripts(
  html: string,
  files: Record<string, unknown>,
  alreadyInlined: Set<string>,
): { html: string; inlinedFiles: Set<string> } {
  const inlinedFiles = new Set<string>();

  // Match <script src="..."></script> without type="text/babel"
  // Exclude CDN URLs (http:// or https://)
  const scriptSrcPattern = /<script\s+(?!.*type\s*=\s*["']text\/babel["'])([^>]*)src\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi;

  const modified = html.replace(scriptSrcPattern, (_match, _before: string, srcPath: string, _after: string) => {
    // Skip CDN / external URLs
    if (srcPath.startsWith('http://') || srcPath.startsWith('https://') || srcPath.startsWith('//')) {
      return _match;
    }

    const normalizedPath = srcPath.replace(/^\.\//, '');
    if (alreadyInlined.has(normalizedPath) || alreadyInlined.has(srcPath)) {
      return _match;
    }

    let content: string | null = null;
    if (typeof files[normalizedPath] === 'string') {
      content = files[normalizedPath] as string;
      inlinedFiles.add(normalizedPath);
    } else if (typeof files[srcPath] === 'string') {
      content = files[srcPath] as string;
      inlinedFiles.add(srcPath);
    } else {
      const basename = normalizedPath.split('/').pop() || '';
      const match = Object.entries(files).find(([name]) =>
        name.split('/').pop() === basename && typeof files[name] === 'string'
      );
      if (match) {
        content = match[1] as string;
        inlinedFiles.add(match[0]);
      }
    }

    if (content) {
      return `<script>\n${content}\n</script>`;
    }
    return _match;
  });

  return { html: modified, inlinedFiles };
}

/**
 * Inline <link rel="stylesheet" href="..."> references to local CSS files.
 */
function inlineStylesheetLinks(
  html: string,
  files: Record<string, unknown>,
): { html: string; inlinedFiles: Set<string> } {
  const inlinedFiles = new Set<string>();

  const linkPattern = /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;

  const modified = html.replace(linkPattern, (_match, hrefPath: string) => {
    if (hrefPath.startsWith('http://') || hrefPath.startsWith('https://') || hrefPath.startsWith('//')) {
      return _match;
    }

    const normalizedPath = hrefPath.replace(/^\.\//, '');
    let content: string | null = null;
    if (typeof files[normalizedPath] === 'string') {
      content = files[normalizedPath] as string;
      inlinedFiles.add(normalizedPath);
    } else if (typeof files[hrefPath] === 'string') {
      content = files[hrefPath] as string;
      inlinedFiles.add(hrefPath);
    }

    if (content) {
      return `<style>\n${content}\n</style>`;
    }
    return _match;
  });

  return { html: modified, inlinedFiles };
}

/**
 * Extract HTML, CSS, and JS from a code phase output's files map.
 * Returns null if no renderable HTML is found.
 *
 * For React CDN builds (Babel standalone), inlines external script/style refs
 * directly into the HTML so the iframe preview is fully self-contained.
 * The returned html is a complete document — css and js are empty because
 * everything is already embedded in the HTML.
 */
export function extractPreviewAssets(
  files: Record<string, unknown> | undefined,
): PreviewAssets | null {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;

  const entries = Object.entries(files);

  // Find index.html or any .html file
  let htmlFile = entries.find(([name]) => {
    const base = name.split('/').pop()?.toLowerCase() || '';
    return base === 'index.html';
  });

  if (!htmlFile) {
    htmlFile = entries.find(([name]) => name.toLowerCase().endsWith('.html'));
  }

  if (!htmlFile || typeof htmlFile[1] !== 'string') return null;

  let html = htmlFile[1];
  const allInlinedFiles = new Set<string>();

  // ── Self-contained inlining: resolve ALL local file refs in the HTML ──
  // The iframe preview uses doc.write() — no file server exists, so relative
  // paths like <script src="app.jsx"> or <link href="styles.css"> break.
  // We inline everything so the HTML document is fully self-contained.

  // 1. Inline stylesheet links
  const cssResult = inlineStylesheetLinks(html, files);
  html = cssResult.html;
  cssResult.inlinedFiles.forEach(f => allInlinedFiles.add(f));

  // 2. Inline Babel script refs (React CDN builds)
  const isCdnBuild = isReactCdnBuild(html);
  if (isCdnBuild) {
    const babelResult = inlineBabelScripts(html, files);
    html = babelResult.html;
    babelResult.inlinedFiles.forEach(f => allInlinedFiles.add(f));
  }

  // 3. Inline plain script refs (both CDN and static builds)
  const scriptResult = inlinePlainScripts(html, files, allInlinedFiles);
  html = scriptResult.html;
  scriptResult.inlinedFiles.forEach(f => allInlinedFiles.add(f));

  // For CDN builds: everything is now inlined in the HTML document.
  // No additional CSS/JS extraction needed — return the self-contained HTML.
  if (isCdnBuild) {
    return { html, css: '', js: '' };
  }

  // ── Non-CDN builds: extract remaining CSS and plain JS files ──

  // Collect CSS files that weren't already inlined via <link>
  const cssFiles = entries.filter(([name]) => {
    if (allInlinedFiles.has(name)) return false;
    return CSS_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));
  });
  const css = cssFiles
    .map(([, content]) => (typeof content === 'string' ? content : ''))
    .join('\n');

  // Collect client-side JS files — exclude server files, JSX (needs Babel),
  // and anything already inlined via <script src="...">
  const jsFiles = entries.filter(([name]) => {
    if (allInlinedFiles.has(name)) return false;
    const lower = name.toLowerCase();
    const base = lower.split('/').pop() || '';
    if (SERVER_JS_FILES.includes(base)) return false;
    if (lower.startsWith('routes/') || lower.startsWith('db/') ||
        lower.startsWith('migrations/') || lower.startsWith('api/')) return false;
    // Skip JSX/TSX — they contain React syntax that browsers can't parse without Babel
    if (JSX_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
    return JS_EXTENSIONS.some(ext => lower.endsWith(ext));
  });
  const js = jsFiles
    .map(([, content]) => (typeof content === 'string' ? content : ''))
    .join('\n');

  return { html, css, js };
}

/**
 * Extract preview assets from a single code string (monolithic output).
 * Attempts to parse as HTML; returns null if it doesn't look like HTML.
 */
export function extractPreviewFromCodeString(code: string): PreviewAssets | null {
  if (!code || typeof code !== 'string') return null;

  const trimmed = code.trim();

  // Must look like HTML (starts with DOCTYPE or <html or <!)
  if (!trimmed.match(/^<!doctype|^<html|^<!/i)) return null;

  return { html: trimmed, css: '', js: '' };
}

/**
 * Get file list for server-side projects (for the file tree display).
 */
export function getFileList(files: Record<string, unknown> | undefined): string[] {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
  return Object.keys(files).sort();
}
