/**
 * Stage Contracts — Strict Input/Output Schemas
 *
 * Every pipeline stage has a typed contract enforced at runtime.
 * If validation fails, the stage throws immediately (fail-fast).
 *
 * Contracts:
 *   PLAN     → Input: { prompt: string }
 *              Output: { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
 *
 *   SCAFFOLD → Input: { plan: PlanOutput }
 *              Output: { tree[], techStack[], summary, files[], structure{}, constraints{} }
 *              The scaffold output is a BINDING MANIFEST — CODE cannot proceed without it.
 *
 *   CODE     → Input: { scaffold: ScaffoldOutput (validated manifest), plan: PlanOutput }
 *              Output: { files: { [filename]: string }, entryPoint, totalLines }
 *
 *   SAVE     → Input: { code: CodeOutput, runId: string }
 *              Output: { persisted: true, runId, versionId, timestamp }
 *
 *   VERIFY   → Input: { save: SaveOutput, plan: PlanOutput, code: CodeOutput }
 *              Output: { checks[], passed: boolean, errors[], warnings[] }
 */

const { getScaffoldSchema } = require('./src/lib/scaffold-schemas');
const { FRONTEND_ROOT_FILES, JS_EQUIVALENTS } = require('./src/lib/manifest-constants');

// ── Schema Definitions ───────────────────────────────────

const STAGE_SCHEMAS = {
  plan: {
    input: {
      required: ['prompt'],
      types: { prompt: 'string' },
    },
    output: {
      required: ['subtasks', 'estimatedComplexity', 'rawMarkdown'],
      types: {
        subtasks: 'array',
        dependencies: 'object',
        estimatedComplexity: 'string',
        rawMarkdown: 'string',
      },
    },
  },

  scaffold: {
    input: {
      required: ['plan'],
      types: { plan: 'object' },
    },
    output: {
      required: ['tree', 'techStack', 'summary', 'files', 'structure', 'constraints'],
      types: {
        tree: 'array',
        techStack: 'array',
        summary: 'string',
        files: 'array',              // Flat list of file paths (source of truth)
        structure: 'object',         // Directory → files mapping
        constraints: 'object',       // Inferred constraints (hasServer, hasFrontend, entry, techStack)
        interaction_contract: 'object', // Optional: polymorphic behavior contract (what each component must DO)
        //   static_surface  → { interactions: [], routing: [], forms: [] }
        //   light_app       → { interactions: [...], forms: [...] }
        //   full_product    → { interactions: [...], routing: [...], forms: [...] }
        // CODE phase validates against this; VERIFY checks fulfillment.
      },
    },
  },

  code: {
    input: {
      required: ['scaffold', 'plan'],
      types: { scaffold: 'object', plan: 'object' },
    },
    output: {
      required: ['files', 'entryPoint'],
      types: {
        files: 'object',
        entryPoint: 'string',
        totalLines: 'number',
      },
    },
  },

  save: {
    input: {
      required: ['code', 'runId'],
      types: { code: 'object', runId: 'string' },
    },
    output: {
      required: ['persisted', 'runId', 'versionId', 'timestamp'],
      types: {
        persisted: 'boolean',
        runId: 'string',
        versionId: 'string',
        timestamp: 'string',
      },
    },
  },

  verify: {
    input: {
      required: ['save', 'plan', 'code'],
      types: { save: 'object', plan: 'object', code: 'object' },
    },
    output: {
      required: ['checks', 'passed', 'errors', 'warnings'],
      types: {
        checks: 'array',
        passed: 'boolean',
        errors: 'array',
        warnings: 'array',
      },
    },
  },
};

// ── Validation Engine ────────────────────────────────────

class ContractValidationError extends Error {
  constructor(stage, direction, violations) {
    const msg = `[Contract] ${stage}.${direction} failed: ${violations.join('; ')}`;
    super(msg);
    this.name = 'ContractValidationError';
    this.stage = stage;
    this.direction = direction;
    this.violations = violations;
  }
}

/**
 * Validate a payload against a stage contract.
 *
 * @param {string} stage    - Stage name (plan, scaffold, code, save, verify)
 * @param {string} direction - 'input' or 'output'
 * @param {object} payload  - The data to validate
 * @throws {ContractValidationError} if validation fails
 * @returns {object} The validated payload (pass-through)
 */
function validateContract(stage, direction, payload) {
  const schema = STAGE_SCHEMAS[stage];
  if (!schema) {
    throw new ContractValidationError(stage, direction, [`Unknown stage: ${stage}`]);
  }

  const contract = schema[direction];
  if (!contract) {
    throw new ContractValidationError(stage, direction, [`No ${direction} contract for stage: ${stage}`]);
  }

  if (payload === null || payload === undefined || typeof payload !== 'object') {
    throw new ContractValidationError(stage, direction, ['Payload must be a non-null object']);
  }

  const violations = [];

  // Check required fields
  for (const field of contract.required) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
      violations.push(`Missing required field: ${field}`);
    }
  }

  // Check types (only for present fields)
  for (const [field, expectedType] of Object.entries(contract.types)) {
    if (field in payload && payload[field] !== undefined && payload[field] !== null) {
      const value = payload[field];
      if (expectedType === 'array') {
        if (!Array.isArray(value)) {
          violations.push(`Field "${field}" must be array, got ${typeof value}`);
        }
      } else if (expectedType === 'object') {
        if (typeof value !== 'object' || Array.isArray(value)) {
          violations.push(`Field "${field}" must be object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        }
      } else if (typeof value !== expectedType) {
        violations.push(`Field "${field}" must be ${expectedType}, got ${typeof value}`);
      }
    }
  }

  if (violations.length > 0) {
    throw new ContractValidationError(stage, direction, violations);
  }

  return payload;
}

/**
 * Build the typed input for a stage from available context.
 *
 * @param {string} stage - Stage name
 * @param {string} prompt - Original user prompt
 * @param {object} previousOutputs - { plan, scaffold, code, save } from completed stages
 * @returns {object} Validated input for the stage
 */
function buildStageInput(stage, prompt, previousOutputs = {}) {
  let input;

  switch (stage) {
    case 'plan':
      input = { prompt };
      break;

    case 'scaffold':
      input = { plan: previousOutputs.plan || {} };
      break;

    case 'code':
      // HARD GATE: scaffold MUST exist and have a valid manifest.
      // No fallback to {} — if scaffold is missing, this is a pipeline error.
      if (!previousOutputs.scaffold || !previousOutputs.scaffold.files || !Array.isArray(previousOutputs.scaffold.files) || previousOutputs.scaffold.files.length === 0) {
        throw new ContractValidationError('code', 'input', [
          'SCAFFOLD manifest missing or invalid — CODE cannot proceed without a valid scaffold. ' +
          'Scaffold must contain a non-empty "files" array.'
        ]);
      }

      // HARD GATE: schema completeness — enforce required_files from the intent schema.
      // This is the primary SCAFFOLD→CODE gate (defense-in-depth for any code path that
      // calls buildStageInput without going through the orchestrator's validateScaffoldManifest).
      // If intent_class is unknown, we cannot validate completeness — halt with explicit error.
      const constraintContract = previousOutputs._constraintContract;
      const intentClass = constraintContract ? constraintContract.intent_class : null;
      if (intentClass) {
        const schema = getScaffoldSchema(intentClass);
        if (schema.required_files && Array.isArray(schema.required_files) && schema.required_files.length > 0) {
          const scaffoldFiles = previousOutputs.scaffold.files;
          const missingFiles = schema.required_files.filter(f => !scaffoldFiles.includes(f));
          if (missingFiles.length > 0) {
            throw new ContractValidationError('code', 'input', [
              `SCAFFOLD manifest incomplete: missing [${missingFiles.join(', ')}] required by \"${intentClass}\" schema. Pipeline halted. ` +
              `CODE cannot execute without valid SCAFFOLD output — this is a hard gate with no bypass.`
            ]);
          }
        }
      }

      input = {
        scaffold: previousOutputs.scaffold,
        plan: previousOutputs.plan || {},
      };
      break;

    case 'save':
      input = {
        code: previousOutputs.code || {},
        runId: previousOutputs._runId || '',
      };
      break;

    case 'verify':
      input = {
        save: previousOutputs.save || {},
        plan: previousOutputs.plan || {},
        code: previousOutputs.code || {},
      };
      break;

    default:
      throw new Error(`Unknown stage: ${stage}`);
  }

  return validateContract(stage, 'input', input);
}

/**
 * Validate stage output after execution.
 *
 * @param {string} stage - Stage name
 * @param {object} output - Raw output from the stage executor
 * @returns {object} Validated output
 */
function validateStageOutput(stage, output) {
  return validateContract(stage, 'output', output);
}

// ── Scaffold Manifest Deep Validation ────────────────────

/**
 * Deep-validate the scaffold manifest beyond basic type checks.
 * This is the HARD GATE — if this fails, the pipeline STOPS.
 *
 * Validates:
 *   - files[] is non-empty and contains valid file paths (strings with extensions)
 *   - structure{} has at least one directory mapping
 *   - constraints{} has required fields (hasServer, entry, techStack)
 *   - Entry point file exists in the files list
 *
 * @param {object} scaffold - The scaffold output to validate
 * @throws {ContractValidationError} if manifest is invalid
 * @returns {object} The validated scaffold (pass-through)
 */
function validateScaffoldManifest(scaffold, intentClass) {
  const violations = [];

  // Schema-aware: static_surface has different validation rules than server-based schemas
  const isStaticSurface = intentClass === 'static_surface';

  // 1. files[] must be non-empty array of strings
  if (!scaffold.files || !Array.isArray(scaffold.files) || scaffold.files.length === 0) {
    violations.push('Scaffold manifest must have a non-empty "files" array');
  } else {
    const invalidFiles = scaffold.files.filter(f => typeof f !== 'string' || !f.includes('.'));
    if (invalidFiles.length > 0) {
      violations.push(`Scaffold files contain invalid entries (must be file paths with extensions): ${invalidFiles.join(', ')}`);
    }
  }

  // 2. structure{} must have at least one directory key
  if (!scaffold.structure || typeof scaffold.structure !== 'object' || Object.keys(scaffold.structure).length === 0) {
    violations.push('Scaffold manifest must have a non-empty "structure" object mapping directories to files');
  }

  // 3. constraints{} must have required fields
  if (!scaffold.constraints || typeof scaffold.constraints !== 'object') {
    violations.push('Scaffold manifest must have a "constraints" object');
  } else {
    if (typeof scaffold.constraints.hasServer !== 'boolean') {
      violations.push('Scaffold constraints must specify "hasServer" (boolean)');
    }
    if (typeof scaffold.constraints.entry !== 'string' || !scaffold.constraints.entry) {
      violations.push('Scaffold constraints must specify "entry" (string — the entry point file)');
    }
    // techStack validation is schema-aware:
    // - static_surface: techStack like ['html', 'css', 'js'] is valid
    // - server-based: techStack like ['express', 'pg'] is valid
    // Both must be non-empty arrays.
    if (!Array.isArray(scaffold.constraints.techStack) || scaffold.constraints.techStack.length === 0) {
      violations.push('Scaffold constraints must specify "techStack" (non-empty array)');
    }

    // Schema-specific: static_surface MUST NOT have server entry point
    if (isStaticSurface) {
      if (scaffold.constraints.entry === 'server.js' || scaffold.constraints.entry === 'index.js') {
        violations.push(`Static surface schema requires entry="index.html" but got "${scaffold.constraints.entry}"`);
      }
      if (scaffold.constraints.hasServer === true) {
        violations.push('Static surface schema requires hasServer=false');
      }
    }
  }

  // 4. Entry point must exist in files list (with path normalization)
  //    Server-based trees may store entry as 'public/index.html' while the schema
  //    defines it as 'index.html'. Check both bare and public/ variants.
  if (scaffold.constraints && scaffold.constraints.entry && Array.isArray(scaffold.files)) {
    const entry = scaffold.constraints.entry;
    const directMatch = scaffold.files.includes(entry);
    const publicMatch = scaffold.files.includes('public/' + entry);
    const reverseMatch = entry.startsWith('public/') && scaffold.files.includes(entry.replace('public/', ''));
    if (!directMatch && !publicMatch && !reverseMatch) {
      violations.push(`Entry point "${entry}" not found in scaffold files list`);
    }
  }

  // 5. Schema required_files: certain intent classes mandate specific files.
  //    For example, full_product (PRODUCT_SYSTEM) requires server.js, package.json,
  //    and .env.example in every scaffold manifest — these are non-negotiable.
  if (intentClass && Array.isArray(scaffold.files)) {
    const schema = getScaffoldSchema(intentClass);
    if (schema.required_files && Array.isArray(schema.required_files)) {
      for (const requiredFile of schema.required_files) {
        if (!scaffold.files.includes(requiredFile)) {
          violations.push(
            `Schema "${intentClass}" requires file "${requiredFile}" in scaffold manifest — it is missing`
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new ContractValidationError('scaffold', 'manifest', violations);
  }

  return scaffold;
}

// ── Post-CODE Validation Against Scaffold ────────────────

/**
 * Validate CODE output against the scaffold manifest.
 * This is a HARD CHECK — mismatches are returned as structured errors.
 *
 * Checks:
 *   - All scaffold files are present in CODE output
 *   - Entry point exists and is valid
 *   - File paths match scaffold structure
 *
 * @param {object} codeOutput  - { files: { [filename]: content }, entryPoint }
 * @param {object} scaffold    - The scaffold manifest (with files[], structure{}, constraints{})
 * @returns {{ valid: boolean, missingFiles: string[], unexpectedFiles: string[], errors: string[] }}
 */
function validateCodeAgainstScaffold(codeOutput, scaffold) {
  const result = {
    valid: true,
    missingFiles: [],
    unexpectedFiles: [],
    errors: [],
  };

  if (!codeOutput || !codeOutput.files || !scaffold || !scaffold.files) {
    result.valid = false;
    result.errors.push('CODE output or scaffold manifest is missing');
    return result;
  }

  const codeFiles = new Set(Object.keys(codeOutput.files));
  const scaffoldFiles = new Set(scaffold.files);

  // FRONTEND_ROOT_FILES and JS_EQUIVALENTS imported from lib/manifest-constants.js
  // to stay in sync with _enforceManifest. If they conflict, _enforceManifest wins
  // (it runs later in the pipeline), but sharing constants prevents the conflict.

  // Check all scaffold files are present in CODE output
  for (const expected of scaffoldFiles) {
    let found = codeFiles.has(expected);

    // Normalize: public/index.html should match index.html in CODE output
    if (!found && expected.startsWith('public/')) {
      const basename = expected.replace('public/', '');
      if (FRONTEND_ROOT_FILES.has(basename)) {
        found = codeFiles.has(basename);
      }
    }

    // Reverse normalize: check if CODE has public/x when scaffold expects x
    if (!found && FRONTEND_ROOT_FILES.has(expected)) {
      found = codeFiles.has('public/' + expected);
    }

    // JS equivalence: app.js ↔ script.js (AI frequently generates one when manifest expects the other)
    if (!found) {
      for (const [a, b] of JS_EQUIVALENTS) {
        if (expected === a && codeFiles.has(b) && !scaffoldFiles.has(b)) { found = true; break; }
        if (expected === b && codeFiles.has(a) && !scaffoldFiles.has(a)) { found = true; break; }
      }
    }

    if (!found) {
      result.missingFiles.push(expected);
    }
  }

  // Check for unexpected files (not in scaffold)
  for (const generated of codeFiles) {
    let expected = scaffoldFiles.has(generated);

    // Normalize both directions
    if (!expected && generated.startsWith('public/')) {
      const basename = generated.replace('public/', '');
      if (FRONTEND_ROOT_FILES.has(basename)) {
        expected = scaffoldFiles.has(basename) || scaffoldFiles.has(generated);
      }
    }
    if (!expected && FRONTEND_ROOT_FILES.has(generated)) {
      expected = scaffoldFiles.has('public/' + generated) || scaffoldFiles.has(generated);
    }

    // JS equivalence: if CODE generated app.js but manifest expects script.js (or vice versa),
    // it's not unexpected — it's an equivalence match
    if (!expected) {
      for (const [a, b] of JS_EQUIVALENTS) {
        if (generated === a && scaffoldFiles.has(b) && !scaffoldFiles.has(a)) { expected = true; break; }
        if (generated === b && scaffoldFiles.has(a) && !scaffoldFiles.has(b)) { expected = true; break; }
      }
    }

    if (!expected) {
      result.unexpectedFiles.push(generated);
    }
  }

  // Check entry point (with public/ normalization — same as scaffold file checks above)
  if (scaffold.constraints && scaffold.constraints.entry) {
    const entry = scaffold.constraints.entry;
    let entryFound = codeFiles.has(entry);

    // Normalize: public/index.html should match index.html in CODE output
    if (!entryFound && entry.startsWith('public/')) {
      const basename = entry.replace('public/', '');
      if (FRONTEND_ROOT_FILES.has(basename)) {
        entryFound = codeFiles.has(basename);
      }
    }

    // Reverse normalize: index.html should match public/index.html
    if (!entryFound && FRONTEND_ROOT_FILES.has(entry)) {
      entryFound = codeFiles.has('public/' + entry);
    }

    if (!entryFound) {
      result.errors.push(`Entry point "${entry}" missing from CODE output`);
    }
  }

  if (result.missingFiles.length > 0) {
    result.valid = false;
    result.errors.push(`Missing ${result.missingFiles.length} scaffold files: ${result.missingFiles.join(', ')}`);
  }

  // HARD GATE: ANY unexpected files = invalid. Zero tolerance.
  // The orchestrator strips unexpected files BEFORE this validator runs,
  // so if unexpected files still appear here, something is seriously wrong.
  // Previous soft threshold (unexpectedFiles > scaffoldFiles.size) allowed
  // violations to slip through — this is now absolute.
  if (result.unexpectedFiles.length > 0) {
    result.valid = false;
    result.errors.push(`CODE generated ${result.unexpectedFiles.length} unexpected files not in scaffold manifest: ${result.unexpectedFiles.join(', ')}`);
  }

  return result;
}

module.exports = {
  STAGE_SCHEMAS,
  ContractValidationError,
  validateContract,
  buildStageInput,
  validateStageOutput,
  validateScaffoldManifest,
  validateCodeAgainstScaffold,
};
