/**
 * CCO Schema Validator
 *
 * Hard schema validation for the Constraint Contract Object (CCO).
 * This runs at Intent Gate EXIT — after classify() returns a rawContract
 * but BEFORE Object.freeze() locks it.
 *
 * Design principle: binary pass/fail. A CCO is either valid or rejected.
 * No defaults, no fallbacks, no "best effort" repair. Invalid → pipeline stops.
 *
 * Also provides hash utilities for CCO immutability enforcement:
 * - computeCCOHash(contract) → deterministic SHA-256 of core fields
 * - verifyCCOHash(contract, expectedHash) → boolean
 */

'use strict';

const crypto = require('crypto');

// ── Valid enum values ─────────────────────────────────────────────────────────

const VALID_INTENT_CLASSES = new Set([
  'static_surface',
  'light_app',
  'full_product',
  'soft_expansion',
  // Repo-aware intent classes (pipeline modifies existing codebase)
  'repo_hardening',
  'repo_refactor',
  'repo_feature',
  'repo_fix',
]);

const VALID_TASK_TYPES = new Set([
  'static_surface',
  'light_app',
  'full_product',
  'soft_expansion',
]);

const VALID_COMPLEXITY_BUDGETS = new Set(['low', 'medium', 'high']);

// Constraint values allowed per field.
// Booleans are always valid. These strings are also accepted for gradual
// constraint levels (e.g. light_app uses db:'maybe', api:'minimal').
const VALID_CONSTRAINT_STRING_VALUES = new Set(['maybe', 'minimal', 'optional']);

// Required constraint keys — every CCO must define all of these.
const REQUIRED_CONSTRAINT_KEYS = ['db', 'auth', 'api'];

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate a CCO against the hard schema.
 *
 * @param {object} contract - The raw CCO returned by classify()
 * @returns {{ valid: boolean, errors: string[] }}
 *
 * HARD gate — any error means pipeline must not proceed.
 */
function validateCCO(contract) {
  const errors = [];

  // ── 1. Top-level type ─────────────────────────────────────────────────────
  if (contract === null || contract === undefined) {
    return { valid: false, errors: ['CCO is null or undefined'] };
  }
  if (typeof contract !== 'object' || Array.isArray(contract)) {
    return { valid: false, errors: ['CCO must be a plain object'] };
  }

  // ── 2. task_type ──────────────────────────────────────────────────────────
  if (contract.task_type === undefined || contract.task_type === null) {
    errors.push('Missing required field: task_type');
  } else if (typeof contract.task_type !== 'string') {
    errors.push(`task_type must be a string, got: ${typeof contract.task_type}`);
  } else if (!VALID_TASK_TYPES.has(contract.task_type)) {
    errors.push(`task_type "${contract.task_type}" is not a valid value. Must be one of: ${[...VALID_TASK_TYPES].join(', ')}`);
  }

  // ── 3. intent_class ───────────────────────────────────────────────────────
  if (contract.intent_class === undefined || contract.intent_class === null) {
    errors.push('Missing required field: intent_class');
  } else if (typeof contract.intent_class !== 'string') {
    errors.push(`intent_class must be a string, got: ${typeof contract.intent_class}`);
  } else if (!VALID_INTENT_CLASSES.has(contract.intent_class)) {
    errors.push(`intent_class "${contract.intent_class}" is not a valid value. Must be one of: ${[...VALID_INTENT_CLASSES].join(', ')}`);
  }

  // ── 4. constraints ────────────────────────────────────────────────────────
  if (contract.constraints === undefined || contract.constraints === null) {
    errors.push('Missing required field: constraints');
  } else if (typeof contract.constraints !== 'object' || Array.isArray(contract.constraints)) {
    errors.push('constraints must be a plain object');
  } else {
    // Check required constraint keys
    for (const key of REQUIRED_CONSTRAINT_KEYS) {
      if (!(key in contract.constraints)) {
        errors.push(`constraints.${key} is required but missing`);
      } else {
        const val = contract.constraints[key];
        const isBoolean = typeof val === 'boolean';
        const isValidString = typeof val === 'string' && VALID_CONSTRAINT_STRING_VALUES.has(val);
        if (!isBoolean && !isValidString) {
          errors.push(
            `constraints.${key} must be boolean or one of [${[...VALID_CONSTRAINT_STRING_VALUES].join(', ')}], ` +
            `got: ${JSON.stringify(val)}`
          );
        }
      }
    }
  }

  // ── 5. allowed_artifacts ─────────────────────────────────────────────────
  if (contract.allowed_artifacts === undefined || contract.allowed_artifacts === null) {
    errors.push('Missing required field: allowed_artifacts');
  } else if (!Array.isArray(contract.allowed_artifacts)) {
    errors.push('allowed_artifacts must be an array');
  } else if (contract.allowed_artifacts.length === 0) {
    errors.push('allowed_artifacts must be non-empty');
  }

  // ── 6. prohibited_layers ─────────────────────────────────────────────────
  if (contract.prohibited_layers === undefined || contract.prohibited_layers === null) {
    errors.push('Missing required field: prohibited_layers');
  } else if (!Array.isArray(contract.prohibited_layers)) {
    errors.push('prohibited_layers must be an array (can be empty)');
  }

  // ── 7. complexity_budget ─────────────────────────────────────────────────
  if (contract.complexity_budget === undefined || contract.complexity_budget === null) {
    errors.push('Missing required field: complexity_budget');
  } else if (!VALID_COMPLEXITY_BUDGETS.has(contract.complexity_budget)) {
    errors.push(
      `complexity_budget "${contract.complexity_budget}" is not valid. ` +
      `Must be one of: ${[...VALID_COMPLEXITY_BUDGETS].join(', ')}`
    );
  }

  // ── 8. expansion_lock ─────────────────────────────────────────────────────
  if (contract.expansion_lock === undefined || contract.expansion_lock === null) {
    errors.push('Missing required field: expansion_lock');
  } else if (typeof contract.expansion_lock !== 'boolean') {
    errors.push(`expansion_lock must be boolean, got: ${typeof contract.expansion_lock}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Hash utilities ────────────────────────────────────────────────────────────

/**
 * Core fields that define the CCO's binding contract.
 * Metadata fields (_entropy, _candidates, _ise, etc.) are intentionally
 * excluded — they don't affect constraint enforcement and change across
 * phases as observability data accumulates.
 */
const CCO_HASH_FIELDS = [
  'task_type',
  'intent_class',
  'constraints',
  'allowed_artifacts',
  'prohibited_layers',
  'complexity_budget',
  'expansion_lock',
];

/**
 * Compute a deterministic SHA-256 hash of the CCO's core constraint fields.
 *
 * Hash is computed over sorted, stable JSON of the core fields only.
 * This excludes `_*` metadata fields that are observability-only.
 *
 * @param {object} contract - CCO object (frozen or not)
 * @returns {string} - hex-encoded SHA-256 hash
 */
function computeCCOHash(contract) {
  const core = {};
  for (const field of CCO_HASH_FIELDS) {
    core[field] = contract[field] !== undefined ? contract[field] : null;
  }
  // Stable JSON: sort keys recursively
  const serialized = stableStringify(core);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Verify that a contract's current hash matches the expected hash.
 *
 * Used at every phase transition to detect CCO mutations.
 *
 * @param {object} contract - CCO object
 * @param {string} expectedHash - Hash computed at Intent Gate exit
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyCCOHash(contract, expectedHash) {
  if (!contract) {
    return { valid: false, error: 'CCO is missing — cannot verify hash' };
  }
  if (!expectedHash) {
    return { valid: false, error: 'Expected CCO hash is missing — immutability not initialized' };
  }
  const currentHash = computeCCOHash(contract);
  if (currentHash !== expectedHash) {
    return {
      valid: false,
      error: `CCO MUTATION DETECTED: hash mismatch at phase transition. ` +
             `Expected: ${expectedHash.slice(0, 16)}... Got: ${currentHash.slice(0, 16)}...`,
    };
  }
  return { valid: true };
}

// ── Stable JSON serialization ─────────────────────────────────────────────────

/**
 * Produce deterministic JSON with sorted keys (handles nested objects/arrays).
 * Arrays are serialized in order (order matters for allowed_artifacts etc).
 */
function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  validateCCO,
  computeCCOHash,
  verifyCCOHash,
  VALID_INTENT_CLASSES,
  VALID_TASK_TYPES,
  VALID_COMPLEXITY_BUDGETS,
};
