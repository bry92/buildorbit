#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const files = fs.readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.js'))
  .sort((a, b) => a.localeCompare(b));

let failed = false;
let expected = 1;
const seen = new Set();

for (const file of files) {
  const match = file.match(/^(\d{3})_[a-z0-9_]+\.js$/);
  if (!match) {
    console.error(`[migrations] Invalid migration filename: ${file}`);
    failed = true;
    continue;
  }

  const number = Number(match[1]);
  if (seen.has(number)) {
    console.error(`[migrations] Duplicate migration number: ${match[1]}`);
    failed = true;
  }
  seen.add(number);

  if (number !== expected) {
    console.error(`[migrations] Expected ${String(expected).padStart(3, '0')}, found ${match[1]} (${file})`);
    failed = true;
    expected = number;
  }

  expected += 1;
}

if (files.length === 0) {
  console.error('[migrations] No migration files found.');
  process.exit(1);
}

if (failed) {
  process.exit(1);
}

console.log(`[migrations] ${files.length} migrations are ordered and consistently named.`);
