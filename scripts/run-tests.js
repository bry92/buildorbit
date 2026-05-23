#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0 ? requestedTargets : ['tests/unit', 'tests/integration'];

function collectJavaScriptFiles(target) {
  const absolute = path.resolve(repoRoot, target);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Test target does not exist: ${target}`);
  }

  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return absolute.endsWith('.js') ? [absolute] : [];
  }

  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        return collectJavaScriptFiles(path.relative(repoRoot, child));
      }
      return entry.isFile() && entry.name.endsWith('.js') ? [child] : [];
    })
    .sort((a, b) => a.localeCompare(b));
}

const files = targets.flatMap(collectJavaScriptFiles);

if (files.length === 0) {
  console.error('[tests] No JavaScript test files found.');
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'test',
  MOCK_MODE: process.env.MOCK_MODE || 'true',
  FORCE_MOCK_DB: process.env.FORCE_MOCK_DB || 'true',
};

let failed = 0;

for (const file of files) {
  const relative = path.relative(repoRoot, file);
  console.log(`\n[tests] ${relative}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    failed += 1;
    console.error(`[tests] FAILED: ${relative} (exit ${result.status})`);
  }
}

if (failed > 0) {
  console.error(`\n[tests] ${failed}/${files.length} test files failed.`);
  process.exit(1);
}

console.log(`\n[tests] ${files.length} test files passed.`);
