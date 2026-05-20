#!/usr/bin/env node
/**
 * Package the BuildOrbit CLI into a self-hosted tarball.
 * Output: public/cli/buildorbit.tar.gz (npm pack format — package/ prefix inside)
 * Serves: GET /cli/buildorbit.tar.gz from the Express static middleware
 *
 * Run during build: node scripts/package-cli.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cliDir = path.join(root, 'cli');
const outDir = path.join(root, 'public', 'cli');

// Ensure output dir exists
fs.mkdirSync(outDir, { recursive: true });

console.log('[CLI] Packaging CLI from', cliDir);

// npm pack outputs a tarball named like "buildorbit-1.0.0.tgz"
// The tarball uses npm pack format: all files prefixed with "package/"
const packResult = execSync('npm pack --json', {
  cwd: cliDir,
  encoding: 'utf8',
});

let packFileName;
try {
  const parsed = JSON.parse(packResult);
  packFileName = Array.isArray(parsed) ? parsed[0].filename : parsed.filename;
} catch {
  // Fallback: last non-empty line is the filename
  packFileName = packResult.trim().split('\n').filter(Boolean).pop();
}

const srcTarball = path.join(cliDir, packFileName);
const dstTarball = path.join(outDir, 'buildorbit.tar.gz');

fs.renameSync(srcTarball, dstTarball);

const stat = fs.statSync(dstTarball);
console.log(`[CLI] ✓ Packaged → public/cli/buildorbit.tar.gz (${Math.round(stat.size / 1024)}KB)`);
