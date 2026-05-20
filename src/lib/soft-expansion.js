/**
 * Soft Expansion Budget — Phase 4
 *
 * Handles intent-time uncertainty before commitment.
 *
 * Instead of always locking a single classification, the system first computes
 * probabilities across all 3 intent classes. If the top class is confident
 * enough (≥ COMMITMENT_THRESHOLD), it commits as today. If not, it enters
 * "soft expansion" mode: a merged constraint contract that keeps the more
 * conservative base class but unlocks specific capabilities the expansion
 * candidate might need — gated behind mandatory PLAN justification.
 *
 * Decisions:
 *   entropy < REJECTION_ENTROPY  AND  top.prob ≥ COMMITMENT_THRESHOLD  → commit
 *   entropy < REJECTION_ENTROPY  AND  top.prob <  COMMITMENT_THRESHOLD  → soft expansion
 *   entropy ≥ REJECTION_ENTROPY                                          → reject
 *
 * Safety properties:
 *   ✔ Soft expansion is ADDITIVE — base constraints are never loosened
 *   ✔ Every soft expansion must be JUSTIFIED by PLAN (SCAFFOLD rejects unjustified)
 *   ✔ Unjustified/unused expansions become over_scoped violations → Phase 2 learning
 *   ✔ If this module throws for any reason, callers MUST fall back to single-class
 *     classification (current Phase 2 behavior) — failure is non-blocking
 *
 * Probability model:
 *   Each class is scored:
 *     full_product  score = -1.0 + 2.0 × full_pattern_matches   (strong signal required)
 *     static_surface score =  0.0 + 2.5 × static_pattern_matches (clear signal required)
 *     light_app      score =  0.8 + 1.0 × light_pattern_matches  (strong default prior)
 *   Then: softmax → probabilities, Shannon entropy in nats.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────

const COMMITMENT_THRESHOLD = 0.75;  // top-class probability needed to auto-commit
const REJECTION_ENTROPY    = 1.06;  // entropy (nats) above which task is rejected as too ambiguous
// NOTE: For 3 classes, max entropy = ln(3) ≈ 1.099 nats.
// Previous value (0.9) was too aggressive — single-pattern prompts produce entropy ~1.025,
// causing false rejections. Raised to 1.06 (~96% of max) so only truly near-uniform
// distributions are rejected.

// Max theoretical entropy for 3 classes: ln(3) ≈ 1.099 nats
// REJECTION_ENTROPY = 0.9 ≈ 82% of max — near-uniform distributions are rejected

// ── Pattern lists (mirrors intent-gate.js — imported for scoring, not re-exported) ──

const FULL_PRODUCT_PATTERNS = [
  /\bsaas\b/i,
  /\bplatform\b/i,
  /\bdashboard\s+with\s+user/i,
  /\buser\s+(accounts?|management|auth(entication)?)\b/i,
  /\bmulti[- ]tenant\b/i,
  /\b(sign\s*up|register)\b.*\b(log\s*in|login|sign\s*in)\b/i,   // sign up ... log in (any combo)
  /\b(log\s*in|login|sign\s*in)\b.*\b(sign\s*up|register)\b/i,   // log in ... sign up (reverse)
  /\b(log\s*in|login)\b.*\bregister\b/i,                           // login ... register
  /\bregister\b.*\b(log\s*in|login)\b/i,                           // register ... login
  /\bauth(entication|orize)?\s+(system|flow|layer)\b/i,
  /\bsubscription\s+(plan|billing|management)\b/i,
  /\bfull[-\s]?(stack|product)\b/i,
  /\bmulti[- ]user\b/i,
  /\badmin\s*(panel|dashboard|page|portal|interface)\b/i,           // admin panel/dashboard
  /\brole[- ]?based\s*(access|auth|control|permissions?)?\b/i,     // RBAC
];

const STATIC_SURFACE_PATTERNS = [
  /\blanding\s*page\b/i,
  /\bhomepage\b/i,
  /\bportfolio\b/i,
  /\bmarketing\s*(site|page|website)\b/i,
  /\bdocs?\s*page\b/i,
  /\bdocumentation\s*(page|site)\b/i,
  /\bstatic\s*site\b/i,
  /\bpromo(tional)?\s*page\b/i,
  /\bsplash\s*page\b/i,
  /\bone[- ]page\s*(site|website)?\b/i,
  /\bbrochure\s*site\b/i,
  /\binfo\s*page\b/i,
  // ── Static page types that were falling through to light_app (see Report #596913) ──
  /\bproduct\s*page\b/i,                          // "E-commerce product page"
  /\be[- ]?commerce\s+(product\s+)?page\b/i,       // "E-commerce page"
  /\bblog\b/i,                                     // "Blog with dark theme"
  /\bpricing\s*(page|section)\b/i,                 // "pricing page" or "pricing section"
  /\bshowcase\b/i,                                 // portfolio/showcase pages
  /\bservices?\s*page\b/i,                         // "services page"
];

const LIGHT_APP_PATTERNS = [
  /\bwaitlist\b/i,
  /\bsignup\s*form\b/i,
  /\bcontact\s*form\b/i,
  /\bcalculator\b/i,
  /\bsimple\s*dashboard\b/i,
  /\btracker\b/i,
  /\bcrud\b/i,
  /\btodo\s*(app|list)?\b/i,
  /\bform\b/i,
  /\bapp\b/i,
  /\bdashboard\b/i,
];

// ── Score weights ──────────────────────────────────────────────────────────────

const SCORE_CONFIG = {
  full_product:   { base: -1.0, perMatch: 2.0 },
  static_surface: { base:  0.0, perMatch: 2.5 },
  light_app:      { base:  0.8, perMatch: 1.0 },
};

// ── Soft expansion capability tables ──────────────────────────────────────────
//
// For each (base_class, expansion_candidate) pair, define what capabilities
// may be unlocked. These are NOT auto-included — PLAN must justify each usage.

const SOFT_EXPANSION_RULES = {
  // static_surface base → might need minimal server capability
  'static_surface+light_app': {
    server: { allowed: true, scope: 'minimal_handler_only' },
    api:    { allowed: true, scope: 'single_endpoint' },
  },
  // light_app base → might need auth or persistent db
  'light_app+full_product': {
    auth: { allowed: true, scope: 'minimal_auth_no_roles' },
    db:   { allowed: true, scope: 'single_table_only' },
  },
  // static_surface base → might need full product capabilities (e.g., "landing page for our SaaS platform")
  'static_surface+full_product': {
    server: { allowed: true, scope: 'minimal_handler_only' },
    api:    { allowed: true, scope: 'single_endpoint' },
    auth:   { allowed: false },   // auth still excluded for a landing page
  },
  // full_product → never needs to expand down (already has everything)
  // No rules needed for full_product base cases
};

// Budget interpolation between base and expansion candidate.
// Values MUST be valid enum values from VALID_COMPLEXITY_BUDGETS in lib/cco-validator.js:
// low, medium, high
const BUDGET_INTERPOLATION = {
  'low+medium':   'medium',   // soft expansion = elevated complexity beyond base
  'medium+high':  'high',
  'low+high':     'medium',
  'high+low':     'high',    // shouldn't happen but be safe
  'high+medium':  'high',
  'medium+low':   'medium',
};

const BASE_BUDGETS = {
  static_surface: 'low',
  light_app:      'medium',
  full_product:   'high',
};

// ── Core functions ─────────────────────────────────────────────────────────────

/**
 * Count pattern matches for a given prompt against a list of patterns.
 * Each pattern is counted at most once (distinct pattern match).
 *
 * @param {string}   prompt
 * @param {RegExp[]} patterns
 * @returns {number}
 */
function countMatches(prompt, patterns) {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(prompt)) count++;
  }
  return count;
}

/**
 * Softmax over an array of raw scores.
 *
 * @param {number[]} scores
 * @returns {number[]} probabilities that sum to 1
 */
function softmax(scores) {
  const maxScore = Math.max(...scores);  // numerical stability: shift by max
  const exps = scores.map(s => Math.exp(s - maxScore));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / total);
}

/**
 * Compute Shannon entropy in nats for a probability distribution.
 * Uses natural log. Max for 3 classes = ln(3) ≈ 1.099 nats.
 *
 * @param {number[]} probs
 * @returns {number} entropy in nats
 */
function shannonEntropy(probs) {
  return -probs.reduce((sum, p) => {
    return sum + (p > 0 ? p * Math.log(p) : 0);
  }, 0);
}

/**
 * Compute multi-candidate classification with probabilities and entropy.
 *
 * Returns candidates sorted descending by probability, plus entropy and
 * commitment decision.
 *
 * @param {string} prompt - User task description
 * @returns {{
 *   candidates: Array<{intent_class: string, probability: number}>,
 *   entropy: number,
 *   commitment_threshold: number,
 *   committed: boolean,
 *   rejected: boolean,
 * }}
 */
function computeCandidates(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    // Empty prompt → treat as light_app default, committed
    return {
      candidates: [
        { intent_class: 'light_app',      probability: 0.85 },
        { intent_class: 'static_surface', probability: 0.10 },
        { intent_class: 'full_product',   probability: 0.05 },
      ],
      entropy: 0.42,
      commitment_threshold: COMMITMENT_THRESHOLD,
      committed: true,
      rejected: false,
    };
  }

  const fullMatches   = countMatches(prompt, FULL_PRODUCT_PATTERNS);
  const staticMatches = countMatches(prompt, STATIC_SURFACE_PATTERNS);
  const lightMatches  = countMatches(prompt, LIGHT_APP_PATTERNS);

  const scores = [
    SCORE_CONFIG.full_product.base   + SCORE_CONFIG.full_product.perMatch   * fullMatches,
    SCORE_CONFIG.static_surface.base + SCORE_CONFIG.static_surface.perMatch * staticMatches,
    SCORE_CONFIG.light_app.base      + SCORE_CONFIG.light_app.perMatch      * lightMatches,
  ];

  const classes  = ['full_product', 'static_surface', 'light_app'];
  const probs    = softmax(scores);
  const entropy  = shannonEntropy(probs);

  // Sort candidates descending by probability
  const candidates = classes
    .map((cls, i) => ({ intent_class: cls, probability: parseFloat(probs[i].toFixed(4)) }))
    .sort((a, b) => b.probability - a.probability);

  const top       = candidates[0];
  const rejected  = entropy >= REJECTION_ENTROPY;
  const committed = !rejected && top.probability >= COMMITMENT_THRESHOLD;

  return {
    candidates,
    entropy:              parseFloat(entropy.toFixed(6)),
    commitment_threshold: COMMITMENT_THRESHOLD,
    committed,
    rejected,
  };
}

/**
 * Build a Soft Expansion Budget contract from a multi-candidate result.
 *
 * Only called when committed=false and rejected=false.
 *
 * Takes the intersection of constraints from the top-2 candidates, adds
 * a soft_expansion field with optionally-unlocked capabilities, and sets
 * a blended complexity budget.
 *
 * The base_class is always the more conservative of the two candidates
 * (static_surface < light_app < full_product).
 *
 * @param {object} candidateResult - Output of computeCandidates()
 * @param {object} contracts       - CONTRACTS from intent-gate (passed in to avoid circular dep)
 * @returns {object} Soft expansion constraint contract
 */
function buildSoftExpansionContract(candidateResult, contracts) {
  const { candidates } = candidateResult;
  const top    = candidates[0];
  const second = candidates[1];

  // Determine which is the base (conservative) and which is the expansion candidate
  const PRIORITY = { static_surface: 0, light_app: 1, full_product: 2 };
  const topPriority    = PRIORITY[top.intent_class]    ?? 1;
  const secondPriority = PRIORITY[second.intent_class] ?? 1;

  const baseClass       = topPriority <= secondPriority ? top.intent_class    : second.intent_class;
  const expansionClass  = topPriority <= secondPriority ? second.intent_class : top.intent_class;

  const baseContract = JSON.parse(JSON.stringify(contracts[baseClass]));
  const ruleKey      = `${baseClass}+${expansionClass}`;
  const softExpansion = SOFT_EXPANSION_RULES[ruleKey] || {};

  // Interpolate complexity budget
  const baseBudget      = BASE_BUDGETS[baseClass]      || 'medium';
  const expansionBudget = BASE_BUDGETS[expansionClass] || 'medium';
  const budgetKey       = `${baseBudget}+${expansionBudget}`;
  const complexityBudget = BUDGET_INTERPOLATION[budgetKey] || baseBudget;

  const contract = {
    task_type:          'soft_expansion',
    intent_class:       'soft_expansion',
    base_class:         baseClass,
    expansion_candidate: expansionClass,
    // Constraints come from the base class (conservative)
    constraints:        { ...baseContract.constraints },
    // Allowed artifacts from base class
    allowed_artifacts:  [...(baseContract.allowed_artifacts || [])],
    prohibited_layers:  [...(baseContract.prohibited_layers || [])],
    // Blended budget
    complexity_budget:  complexityBudget,
    expansion_lock:     true,   // still enforced — expansions must be justified
    // The expansion capabilities PLAN may use (with justification)
    soft_expansion:     softExpansion,
    // Metadata for observability
    _soft_expansion_meta: {
      base_probability:       candidates.find(c => c.intent_class === baseClass)?.probability,
      expansion_probability:  candidates.find(c => c.intent_class === expansionClass)?.probability,
      entropy:                candidateResult.entropy,
      all_candidates:         candidates,
    },
  };

  return contract;
}

/**
 * Check whether a used capability was pre-authorized in the soft_expansion field.
 *
 * @param {object} contract    - Soft expansion constraint contract
 * @param {string} capability  - e.g., 'server', 'db', 'auth', 'api'
 * @returns {boolean}
 */
function isExpansionAuthorized(contract, capability) {
  if (!contract || contract.intent_class !== 'soft_expansion') return false;
  const rule = (contract.soft_expansion || {})[capability];
  return !!(rule && rule.allowed !== false);
}

/**
 * Validate that all expansion justifications in a plan output refer to
 * authorized soft_expansion capabilities.
 *
 * Returns violations (empty = valid).
 *
 * @param {object} planOutput  - PLAN stage output (may include expansion_justifications)
 * @param {object} contract    - Soft expansion constraint contract
 * @returns {string[]} violation messages
 */
function validatePlanExpansionJustifications(planOutput, contract) {
  if (!contract || contract.intent_class !== 'soft_expansion') return [];
  if (!planOutput || !planOutput.expansion_justifications) return [];

  const violations = [];

  for (const justification of planOutput.expansion_justifications) {
    const { capability } = justification;
    if (!capability) {
      violations.push('expansion_justification missing "capability" field');
      continue;
    }
    if (!isExpansionAuthorized(contract, capability)) {
      violations.push(
        `PLAN justifies expansion of "${capability}" but it is NOT in the soft_expansion allowlist ` +
        `(allowed: ${Object.keys(contract.soft_expansion || {}).join(', ') || 'none'})`
      );
    }
  }

  return violations;
}

/**
 * Determine which soft expansion capabilities were ACTUALLY USED in the
 * generated code, by inspecting output files.
 *
 * Returns a map: capability → boolean (used or not)
 *
 * @param {object} codeOutput  - CODE stage output ({ files: { [path]: content } })
 * @param {object} contract    - Soft expansion constraint contract
 * @returns {Object.<string, boolean>}
 */
function detectUsedExpansions(codeOutput, contract) {
  if (!contract || contract.intent_class !== 'soft_expansion') return {};

  const fileKeys = Object.keys((codeOutput && codeOutput.files) ? codeOutput.files : {});
  const used     = {};

  const softExpansion = contract.soft_expansion || {};

  // server capability: server.js or routes/
  if ('server' in softExpansion) {
    used.server = fileKeys.some(f =>
      f === 'server.js' || f.startsWith('routes/') || f.startsWith('middleware/')
    );
  }

  // api capability: routes/ or /api.js
  if ('api' in softExpansion) {
    used.api = fileKeys.some(f =>
      f.startsWith('routes/') || f.startsWith('api/') ||
      f.includes('/api.js') || f.includes('/routes.js')
    );
  }

  // db capability: db/ or migrations/
  if ('db' in softExpansion) {
    used.db = fileKeys.some(f =>
      f.includes('db/') || f.includes('migrations/') ||
      f === 'migrate.js' || f.endsWith('queries.js') || f.endsWith('pool.js')
    );
  }

  // auth capability: auth files
  if ('auth' in softExpansion) {
    used.auth = fileKeys.some(f =>
      f.toLowerCase().includes('auth') || f.includes('jwt') || f.includes('bcrypt')
    );
  }

  return used;
}

/**
 * Run the expansion audit for VERIFY stage.
 *
 * Checks each authorized soft expansion to see:
 *   1. Was it justified by PLAN?      (missing justification → SCAFFOLD should have caught this)
 *   2. Was it actually used in CODE?  (not used → unnecessary_expansion violation, severity 0.6)
 *   3. Was scope exceeded?            (scope_exceeded flag → expansion_scope_exceeded, severity 0.9)
 *
 * Returns audit results and violations.
 *
 * @param {object} planOutput  - PLAN stage output
 * @param {object} codeOutput  - CODE stage output
 * @param {object} contract    - Soft expansion constraint contract
 * @returns {{
 *   audits: Array<{capability: string, justified: boolean, used: boolean, scopeExceeded: boolean}>,
 *   violations: Array<{type: string, capability: string, severity: number, message: string}>
 * }}
 */
function auditExpansions(planOutput, codeOutput, contract) {
  if (!contract || contract.intent_class !== 'soft_expansion') {
    return { audits: [], violations: [] };
  }

  const softExpansion = contract.soft_expansion || {};
  if (Object.keys(softExpansion).length === 0) {
    return { audits: [], violations: [] };
  }

  const justifications = (planOutput && planOutput.expansion_justifications) || [];
  const justifiedCaps  = new Set(justifications.map(j => j.capability).filter(Boolean));
  const usedMap        = detectUsedExpansions(codeOutput, contract);

  const audits     = [];
  const violations = [];

  for (const [capability, rule] of Object.entries(softExpansion)) {
    if (!rule || rule.allowed === false) continue;

    const justified    = justifiedCaps.has(capability);
    const used         = usedMap[capability] ?? false;
    // Scope exceeded detection: simple heuristic — if capability is used AND
    // multiple related files exist beyond minimal scope
    // (This is a best-effort check; more sophisticated analysis is a future enhancement)
    const scopeExceeded = used && _detectScopeExceeded(capability, rule, codeOutput);

    audits.push({ capability, justified, used, scopeExceeded });

    if (used && !scopeExceeded) {
      // Used within scope — no violation (good path)
      continue;
    }

    if (!used && justified) {
      // PLAN justified it but CODE didn't use it — unnecessary expansion
      violations.push({
        type:       'unnecessary_expansion',
        capability,
        severity:   0.6,
        message:    `soft expansion "${capability}" was justified by PLAN but not present in output`,
      });
    }

    if (scopeExceeded) {
      // Used beyond stated scope
      violations.push({
        type:       'expansion_scope_exceeded',
        capability,
        severity:   0.9,
        message:    `soft expansion "${capability}" used beyond stated scope "${rule.scope}"`,
      });
    }

    // Note: used but NOT justified is caught at SCAFFOLD stage, not here
    // (SCAFFOLD rejects unjustified expansions before CODE runs)
  }

  return { audits, violations };
}

/**
 * Heuristic: did the code use a capability beyond the stated minimal scope?
 *
 * This is a best-effort static analysis:
 *   - server: 'minimal_handler_only' → more than 2 route files = exceeded
 *   - api: 'single_endpoint' → more than 2 route files = exceeded
 *   - db: 'single_table_only' → more than 1 migration file = exceeded
 *   - auth: 'minimal_auth_no_roles' → role/permission files present = exceeded
 *
 * @private
 */
function _detectScopeExceeded(capability, rule, codeOutput) {
  const fileKeys = Object.keys((codeOutput && codeOutput.files) ? codeOutput.files : {});
  const scope    = rule.scope || '';

  switch (capability) {
    case 'server': {
      if (scope.includes('minimal_handler_only')) {
        const serverFiles = fileKeys.filter(f =>
          f === 'server.js' || f.startsWith('routes/') || f.startsWith('middleware/')
        );
        return serverFiles.length > 3; // > 1 server + 2 route files = exceeded
      }
      break;
    }
    case 'api': {
      if (scope.includes('single_endpoint')) {
        const routeFiles = fileKeys.filter(f => f.startsWith('routes/'));
        return routeFiles.length > 2; // > 2 route files = exceeded
      }
      break;
    }
    case 'db': {
      if (scope.includes('single_table_only')) {
        const migrationFiles = fileKeys.filter(f => f.includes('migrations/'));
        return migrationFiles.length > 1; // > 1 migration = exceeded
      }
      break;
    }
    case 'auth': {
      if (scope.includes('minimal_auth_no_roles')) {
        const roleFiles = fileKeys.filter(f =>
          f.includes('role') || f.includes('permission') || f.includes('rbac')
        );
        return roleFiles.length > 0;
      }
      break;
    }
  }
  return false;
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  computeCandidates,
  buildSoftExpansionContract,
  validatePlanExpansionJustifications,
  detectUsedExpansions,
  auditExpansions,
  isExpansionAuthorized,
  COMMITMENT_THRESHOLD,
  REJECTION_ENTROPY,
  // Exposed for testing
  countMatches,
  softmax,
  shannonEntropy,
  SOFT_EXPANSION_RULES,
};
