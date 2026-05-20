'use strict';
/**
 * CLI Distribution Routes
 *
 * GET /cli/version     — returns the CLI version string (plain text)
 * GET /cli/install.sh  — shell installer script for curl | sh
 *
 * The tarball itself (GET /cli/buildorbit.tar.gz) is served by Express's
 * static middleware from public/cli/buildorbit.tar.gz — no route needed.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Read version once at startup
// Fix: was ('..', 'cli') → resolved to nonexistent src/cli/; needs two levels up to reach root cli/
const CLI_PKG_PATH = path.join(__dirname, '..', '..', 'cli', 'package.json');
let CLI_VERSION = '1.0.0';
try {
  CLI_VERSION = JSON.parse(fs.readFileSync(CLI_PKG_PATH, 'utf8')).version;
} catch {
  // fall through with default
}

const BASE_URL = process.env.APP_URL || 'https://buildorbit.polsia.app';

// ── GET /cli/version ──────────────────────────────────────────────────────────

router.get('/version', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.set('Cache-Control', 'no-cache');
  res.send(CLI_VERSION);
});

// ── GET /cli/install.sh ───────────────────────────────────────────────────────

router.get('/install.sh', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-cache');

  // Single-quoted heredoc variables (like $HOME, $PATH) are NOT expanded here —
  // they expand at runtime when the user runs the generated wrapper script.
  const script = `#!/bin/sh
# BuildOrbit CLI Installer v${CLI_VERSION}
# Usage: curl -sL ${BASE_URL}/cli/install.sh | sh
set -e

BASE_URL="${BASE_URL}"
VERSION="${CLI_VERSION}"
INSTALL_DIR="$HOME/.buildorbit/bin"

echo ""
echo "  BuildOrbit CLI v$VERSION"
echo "  Installing..."
echo ""

# ── Require Node.js >= 18 ──────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "  Error: Node.js is required (>= 18)"
  echo "  Install at: https://nodejs.org"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.version.slice(1)))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Error: Node.js >= 18 required. Current: $(node --version)"
  echo "  Install a newer version at: https://nodejs.org"
  echo ""
  exit 1
fi

# ── Require npm ────────────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  echo "  Error: npm is required. Install Node.js from https://nodejs.org"
  echo ""
  exit 1
fi

# ── Download tarball ───────────────────────────────────────────────────────
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "  Downloading tarball..."
curl -sL "$BASE_URL/cli/buildorbit.tar.gz" -o "$TMP_DIR/buildorbit.tar.gz"

# ── Extract (npm pack format: files inside package/ directory) ─────────────
tar -xzf "$TMP_DIR/buildorbit.tar.gz" -C "$TMP_DIR"

rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
mv "$TMP_DIR/package" "$INSTALL_DIR"

# ── Install production dependencies ───────────────────────────────────────
echo "  Installing dependencies..."
npm install --prefix "$INSTALL_DIR" --omit=dev --silent 2>/dev/null || \\
  npm install --prefix "$INSTALL_DIR" --production --silent

# ── Create wrapper script ──────────────────────────────────────────────────
WRAPPER_WRITTEN=0
for try_dir in "/usr/local/bin" "$HOME/.local/bin"; do
  if [ -d "$try_dir" ] && [ -w "$try_dir" ]; then
    printf '#!/bin/sh\\nexec node "%s/bin/buildorbit.js" "$@"\\n' "$INSTALL_DIR" > "$try_dir/buildorbit"
    chmod +x "$try_dir/buildorbit"
    WRAPPER_DIR="$try_dir"
    WRAPPER_WRITTEN=1
    break
  fi
done

if [ "$WRAPPER_WRITTEN" = "0" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\\nexec node "%s/bin/buildorbit.js" "$@"\\n' "$INSTALL_DIR" > "$HOME/.local/bin/buildorbit"
  chmod +x "$HOME/.local/bin/buildorbit"
  WRAPPER_DIR="$HOME/.local/bin"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo "  ✓ BuildOrbit CLI v$VERSION installed"
echo ""

# PATH check
case ":$PATH:" in
  *":$WRAPPER_DIR:"*)
    echo "  Get started:"
    echo "    buildorbit login"
    echo "    buildorbit run \\"Build a SaaS landing page\\""
    ;;
  *)
    echo "  Add to PATH (add this to ~/.bashrc or ~/.zshrc):"
    echo "    export PATH=\\"$WRAPPER_DIR:\\$PATH\\""
    echo ""
    echo "  Then:"
    echo "    buildorbit login"
    echo "    buildorbit run \\"Build a SaaS landing page\\""
    ;;
esac
echo ""
`;

  res.send(script);
});

// ── GET /cli/buildorbit.tar.gz (fallback route if static file missing) ────────

router.get('/buildorbit.tar.gz', (req, res) => {
  // Fix: was ('..', 'public') → resolved to nonexistent src/public/; needs two levels up
  const tarballPath = path.join(__dirname, '..', '..', 'public', 'cli', 'buildorbit.tar.gz');
  if (!fs.existsSync(tarballPath)) {
    return res.status(503).json({
      error: 'CLI tarball not yet built. Retry in a few moments.',
      install: 'curl -sL https://buildorbit.polsia.app/cli/install.sh | sh',
    });
  }
  res.download(tarballPath, 'buildorbit.tar.gz');
});

module.exports = router;
