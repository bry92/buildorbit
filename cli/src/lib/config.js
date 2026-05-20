/**
 * Config — manages ~/.buildorbit/config.json and ~/.buildorbit/history.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.buildorbit');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = join(CONFIG_DIR, 'history.json');

export const BASE_URL = 'https://buildorbit.polsia.app';

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ── Config ─────────────────────────────────────────────────────────────────

export function readConfig() {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(data) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function getToken() {
  return readConfig().token || null;
}

export function setToken(token) {
  const cfg = readConfig();
  cfg.token = token;
  writeConfig(cfg);
}

export function clearToken() {
  const cfg = readConfig();
  delete cfg.token;
  writeConfig(cfg);
}

// ── History ────────────────────────────────────────────────────────────────

export function readHistory() {
  ensureDir();
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function appendHistory(entry) {
  const history = readHistory();
  history.unshift(entry); // newest first
  // Keep last 50 runs
  const trimmed = history.slice(0, 50);
  ensureDir();
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

export function getLastRun() {
  const history = readHistory();
  return history[0] || null;
}
