/**
 * Intent Gate — Step 0 Pre-PLAN Scope Governor
 *
 * Classifies the user's task intent BEFORE planning begins.
 * Produces an immutable Constraint Contract that downstream stages
 * (PLAN, SCAFFOLD, CODE, VERIFY) must obey and cannot override.
 *
 * Classification is deterministic (keyword/pattern matching first).
 * This is a hard architectural boundary — not fuzzy AI guessing.
 *
 * Intent Classes:
 *   static_surface  — landing pages, portfolios, marketing sites, docs pages
 *   light_app       — forms, waitlists, calculators, simple dashboards (no auth)
 *   full_product    — SaaS, platforms, multi-user apps, auth-required systems
 *   soft_expansion  — (Phase 4) ambiguous classification: merged contract with optional capabilities
 *
 * Position in pipeline:
 *   USER INPUT → INTENT GATE → PLAN → SCAFFOLD → CODE → SAVE → VERIFY → ACL UPDATE
 *                   ↑___________________________________________weight feedback (Phase 2)
 *
 * Key property: PLAN cannot change constraints. It can only operate inside them.
 *
 * ACL Phase 2 — Bias Shaping (NOT rule evolution):
 *   classify() accepts an optional pool parameter. When provided, it reads
 *   constraint_feedback_weights and applies weight-driven adjustments to
 *   the base contract AFTER deterministic classification.
 *
 *   Safety properties:
 *   ✔ Adjusts constraint probabilities via accumulated weights
 *   ❌ Does NOT change classification logic
 *   ❌ Does NOT add/remove constraints
 *   ❌ Does NOT rewrite schema
 *
 *   Graceful degradation: if pool is absent or table has no rows for this
 *   task_type → classification returns unchanged (weights are adjustments,
 *   never replacements).
 *
 * Phase 4 — Soft Expansion Budget:
 *   classify() now computes multi-candidate probabilities and entropy.
 *   Three outcomes:
 *     1. entropy ≥ 0.9 nats       → _rejected=true (caller must surface clarification request)
 *     2. top.prob ≥ 0.75          → committed=true, single-class contract (current behavior)
 *     3. top.prob < 0.75          → soft_expansion contract with justified-only capabilities
 *
 *   Safety: if Phase 4 logic throws for any reason, falls back to single-class (Phase 2 behavior).
 *   CDK frozen check: if CDK has frozen the top class, soft expansion is disabled.
 */

const { getWeightsForTaskType } = require('../lib/constraint-learner');
const {
  computeCandidates,
  buildSoftExpansionContract,
  COMMITMENT_THRESHOLD,
  REJECTION_ENTROPY,
} = require('../lib/soft-expansion');

// Phase 4.2: ISE — loaded at module init, graceful fallback if not yet available
let _extractInteractionSurfaces = null;
try {
  _extractInteractionSurfaces = require('../lib/interaction-surface-extractor').extractInteractionSurfaces;
} catch (_iseLoadErr) {
  // ISE module not available — passthrough (empty surfaces on all contracts)
}

// ── Decomposition Telemetry Patterns ─────────────────────────────────────────
// Fine-grained capability patterns used only for decomposition analysis.
// These do NOT affect classification decisions — observation only.

const DECOMP_AUTH_PATTERNS = [
  /\bauth(entication|enticate|orize|orization)?\b/i,
  /\bsign\s*(in|up|out)\b/i,
  /\blogin\b/i,
  /\bregister\b/i,
  /\bjwt\b/i,
  /\bpassword\b/i,
  /\buser\s*account/i,
  /\bsession\b/i,
  /\boauth\b/i,
  /\btoken\b/i,
];

const DECOMP_DATABASE_PATTERNS = [
  /\bdatabase\b/i,
  /\b\bdb\b/i,
  /\bpostgres\b/i,
  /\bsql\b/i,
  /\bpersist(ence|ent)?\b/i,
  /\bsave\b.*\bdata\b/i,
  /\bstore\b.*\bdata\b/i,
  /\brecord(s)?\b/i,
  /\btable(s)?\b/i,
  /\bmigration\b/i,
];

const DECOMP_API_PATTERNS = [
  /\bapi\b/i,
  /\bendpoint(s)?\b/i,
  /\brest\b/i,
  /\bgraphql\b/i,
  /\bwebhook\b/i,
  /\bjson\b/i,
  /\bhttp\s*(request|call)\b/i,
  /\bbackend\b/i,
  /\bserver\s*side\b/i,
];

const DECOMP_STATIC_SURFACE_PATTERNS = [
  /\blanding\s*page\b/i,
  /\bhomepage\b/i,
  /\bportfolio\b/i,
  /\bmarketing\s*(site|page|website)\b/i,
  /\bdocs?\s*page\b/i,
  /\bstatic\s*site\b/i,
  /\bpromo(tional)?\s*page\b/i,
  /\bone[- ]page\b/i,
  /\bbrochure\b/i,
  /\binfo\s*page\b/i,
];

const DECOMP_LIGHT_APP_PATTERNS = [
  /\bwaitlist\b/i,
  /\bform\b/i,
  /\bcalculator\b/i,
  /\btracker\b/i,
  /\btodo\b/i,
  /\bdashboard\b/i,
  /\bapp\b/i,
  /\bcrud\b/i,
  /\bsimple\b/i,
  /\bminimal\b/i,
];

// ── Repo-Aware Intent Detection ─────────────────────────────────────────────
// Priority 0: Prompts that reference an existing codebase rather than building
// something new. These fire BEFORE greenfield classification (Priority 1-3)
// when a connected GitHub repo is available.

const REPO_AWARE_PATTERNS = [
  /\b(this|my|the|our)\s+(repo|repository|codebase|code\s*base|project)\b/i,
  /\b(my|the|our)\s+code\b/i,
  /\bmake\s+it\s+(production|prod)\s*ready\b/i,
  /\bproduction[- ]ready\b/i,
  /\bprod[- ]ready\b/i,
  /\bharden(ing)?\s+(the|my|this)?\s*(app|code|project|repo)?\b/i,
  /\brefactor\b/i,
  /\bclean\s*up\s+(the|my|this)?\s*(code|codebase|project)\b/i,
  /\bfix\s+(the\s+)?(bugs?|issues?|errors?)\s+(in|on|for)\s+(my|the|this)\b/i,
  /\bimprove\s+(the|my|this)?\s*(code|codebase|project|app)\b/i,
  /\badd\s+.+\s+to\s+(my|the|this)\s+(app|project|repo|codebase)\b/i,
  /\bupgrade\s+(my|the|this)\s+(app|project|repo|code)/i,
  /\boptimize\s+(my|the|this)/i,
  /\bexisting\s+(code|codebase|project|app|repo)\b/i,
  /\bcurrent\s+(code|codebase|project|app|repo)\b/i,
  /\bmodify\s+(my|the|this|existing)\b/i,
  /\bextend\s+(my|the|this)\b/i,
  /\bintegrate\s+.+\s+(into|with)\s+(my|the|this)\b/i,
  /\badd\s+(tests?|testing|linting|ci|cd|logging|monitoring)\b/i,
  /\bsecurity\s+(audit|review|hardening|scan)\b/i,
  /\bperformance\s+(audit|review|optimization)\b/i,
  /\bcode\s+(review|audit|quality)\b/i,
  /\bdebt\s+(reduction|cleanup)\b/i,
  /\btechnical\s+debt\b/i,
];

// Sub-classifiers for repo-aware intents — determines which repo intent class to assign
const REPO_HARDENING_PATTERNS = [
  /\bproduction[- ]?ready\b/i,
  /\bprod[- ]?ready\b/i,
  /\bharden(ing)?\b/i,
  /\bsecurity\s+(audit|review|hardening|scan)\b/i,
  /\bperformance\s+(audit|review|optimization)\b/i,
  /\badd\s+(tests?|testing|linting|ci|cd|logging|monitoring|error\s*handling)\b/i,
  /\bcode\s+(review|audit|quality)\b/i,
  /\btechnical\s+debt\b/i,
  /\bdebt\s+(reduction|cleanup)\b/i,
  /\bstabilize\b/i,
];

const REPO_REFACTOR_PATTERNS = [
  /\brefactor\b/i,
  /\bclean\s*up\b/i,
  /\brestructure\b/i,
  /\breorganize\b/i,
  /\bsimplify\b/i,
  /\bmodularize\b/i,
  /\bdecompose\b/i,
  /\bsplit\b.*\b(file|module|component)\b/i,
  /\bextract\b.*\b(function|module|component|class)\b/i,
];

const REPO_FIX_PATTERNS = [
  /\bfix\b/i,
  /\bbug\b/i,
  /\bbroken\b/i,
  /\bnot\s+working\b/i,
  /\berror\b/i,
  /\bcrash(es|ing)?\b/i,
  /\bregression\b/i,
  /\bpatch\b/i,
  /\bdebug\b/i,
  /\btroubleshoot\b/i,
];

/**
 * Determine the repo-aware sub-class from prompt patterns.
 * Priority: hardening > refactor > fix > feature (default)
 */
function _classifyRepoIntent(prompt) {
  for (const p of REPO_HARDENING_PATTERNS) {
    if (p.test(prompt)) return 'repo_hardening';
  }
  for (const p of REPO_REFACTOR_PATTERNS) {
    if (p.test(prompt)) return 'repo_refactor';
  }
  for (const p of REPO_FIX_PATTERNS) {
    if (p.test(prompt)) return 'repo_fix';
  }
  return 'repo_feature';
}

/**
 * Check if a prompt references an existing codebase.
 * Returns true if any REPO_AWARE_PATTERNS match.
 */
function isRepoAwarePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  return REPO_AWARE_PATTERNS.some(p => p.test(prompt));
}

// ── Keyword Pattern Matchers ──────────────────────────────────────────────────

// Priority 1: Full product signals (override static/light)
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

// Priority 2: Static surface signals (pure front-end, no backend)
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
  /\bblog\b/i,                                     // "Blog with dark theme" — static unless auth/multi-entity
  /\bpricing\s*(page|section)\b/i,                 // "pricing page" or "pricing section"
  /\bshowcase\b/i,                                 // portfolio/showcase pages
  /\bservices?\s*page\b/i,                         // "services page"
];

// Priority 3: Light app signals (interactive but no auth)
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
  /\bapp\b/i,          // generic "app" defaults to light_app
  /\bdashboard\b/i,    // dashboard without "user accounts" = light_app
];

// ── App Archetype Detection ───────────────────────────────────────────────────
// Secondary classification layer — runs AFTER intent_class detection.
// Produces app_archetype metadata that flows to CODE phase for component guidance.
// Does NOT affect intent_class, constraints, or scaffold decisions.

const ARCHETYPE_PATTERNS = {
  saas_dashboard: [
    /\badmin\s*(panel|dashboard|interface|portal)\b/i,
    /\banalytics\s*dashboard\b/i,
    /\bsaas\s*(dashboard|panel|control)\b/i,
    /\bmetrics?\s*(overview|dashboard|panel)\b/i,
    /\bcontrol\s*panel\b/i,
    /\bmanagement\s*(dashboard|console|panel)\b/i,
    /\buser\s*management\b/i,
    /\bsettings\s*(dashboard|panel)\b/i,
    /\bkpi\s*(dashboard|tracker)\b/i,
    /\bstat(s|istics)?\s*(dashboard|panel)\b/i,
  ],
  ai_operations: [
    /\bai\s*(agent|dashboard|operations?|command\s*center|ops)\b/i,
    /\bagent\s*(dashboard|monitor|management|console)\b/i,
    /\bml\s*(pipeline|monitor|dashboard)\b/i,
    /\bmodel\s*(management|monitor|dashboard)\b/i,
    /\bllm\s*(dashboard|monitor|ops)\b/i,
    /\bcopilot\s*(dashboard|panel)\b/i,
    /\binference\s*(monitor|dashboard)\b/i,
    /\bprompt\s*(management|dashboard)\b/i,
    /\bai\s+operations?\b/i,
    /\bmachine\s+learning\s*(dashboard|monitor|pipeline)\b/i,
  ],
  crm_sales: [
    /\bcrm\b/i,
    /\bsales\s*(pipeline|dashboard|crm|tracker|management)\b/i,
    /\blead(s)?\s*(management|tracker|pipeline|crm)\b/i,
    /\bdeal(s)?\s*(pipeline|tracker|management)\b/i,
    /\bcontact(s)?\s*(management|tracker|crm)\b/i,
    /\bcustomer\s*(relationship|tracker|management|crm)\b/i,
    /\bprospect(s)?\s*(tracker|pipeline|management)\b/i,
    /\bsales\s+funnel\b/i,
    /\bopportunity\s*(tracker|management|pipeline)\b/i,
    /\bclient\s*(management|tracker|portal|crm)\b/i,
  ],
  fintech: [
    /\bpayment(s)?\s*(dashboard|tracker|management|system)\b/i,
    /\bfinanci(al|e)\s*(dashboard|analytics|tracker|management)\b/i,
    /\bbilling\s*(dashboard|system|management)\b/i,
    /\btransaction(s)?\s*(tracker|monitor|dashboard|history)\b/i,
    /\binvoice(s)?\s*(management|tracker|dashboard|system)\b/i,
    /\brevenue\s*(tracker|dashboard|analytics|management)\b/i,
    /\bexpense(s)?\s*(tracker|management|dashboard)\b/i,
    /\bbudget\s*(tracker|management|dashboard|planner)\b/i,
    /\bfintech\b/i,
    /\baccounting\s*(dashboard|software|app|system)\b/i,
    /\bportfolio\s*(tracker|management|dashboard)\b/i,
    /\bcrypto\s*(dashboard|tracker|portfolio|monitor)\b/i,
  ],
  workflow_automation: [
    /\bworkflow\s*(automation|builder|management|engine|designer)\b/i,
    /\bautomation\s*(builder|dashboard|pipeline|platform)\b/i,
    /\bapproval\s*(workflow|flow|system|process)\b/i,
    /\bpipeline\s*(builder|management|automation)\b/i,
    /\bprocess\s*(automation|management|builder|designer)\b/i,
    /\btask\s*(automation|pipeline|workflow)\b/i,
    /\bno[- ]code\s*(automation|builder|workflow)\b/i,
    /\btrigger\s*(automation|workflow|builder)\b/i,
    /\bzapier[- ]like\b/i,
    /\bn8n[- ]like\b/i,
  ],
  analytics_platform: [
    /\banalytics\s*(platform|tool|app|suite|hub)\b/i,
    /\bdata\s*(visualization|analytics|explorer|dashboard)\b/i,
    /\breporting\s*(tool|dashboard|platform|app)\b/i,
    /\bchart(s)?\s*(dashboard|builder|explorer)\b/i,
    /\bmetric(s)?\s*(explorer|platform|tracker|app)\b/i,
    /\breal[- ]time\s*(analytics|dashboard|monitor)\b/i,
    /\bbusiness\s*(intelligence|analytics|dashboard)\b/i,
    /\bdata\s*(studio|explorer|platform|hub)\b/i,
    /\binsight(s)?\s*(dashboard|platform|tool)\b/i,
    /\bgoogle\s*analytics[- ]like\b/i,
  ],
  marketplace: [
    /\bmarketplace\b/i,
    /\bmulti[- ]vendor\b/i,
    /\blisting(s)?\s*(management|platform|site|marketplace)\b/i,
    /\bvendor\s*(management|portal|marketplace|dashboard)\b/i,
    /\bproduct\s*(catalog|listing|marketplace)\b/i,
    /\border\s*(management|system|marketplace)\b/i,
    /\be[- ]?commerce\s*(platform|marketplace|dashboard)\b/i,
    /\bshop(ping)?\s*(platform|marketplace|dashboard)\b/i,
    /\bstore\s*(management|platform|dashboard|builder)\b/i,
    /\bauction\s*(platform|site|marketplace)\b/i,
  ],
  devtools: [
    /\bdeployment\s*(dashboard|monitor|pipeline|management)\b/i,
    /\bci[/\s]?cd\s*(dashboard|monitor|pipeline)\b/i,
    /\bapi\s*(management|gateway|dashboard|explorer|monitor)\b/i,
    /\bdeveloper\s*(portal|dashboard|console|tools?)\b/i,
    /\binfrastructure\s*(dashboard|monitor|management)\b/i,
    /\bdevops\s*(dashboard|monitor|tools?|platform)\b/i,
    /\bserver\s*(monitor|management|dashboard)\b/i,
    /\blog(ging)?\s*(dashboard|viewer|monitor|explorer)\b/i,
    /\berror\s*(tracking|monitoring|dashboard)\b/i,
    /\bcloud\s*(management|dashboard|monitor|console)\b/i,
    /\bkubernetes\s*(dashboard|monitor|management)\b/i,
    /\bdocker\s*(dashboard|monitor|management)\b/i,
  ],
};

/**
 * Detect app archetype from user prompt using keyword/pattern matching.
 *
 * Secondary classification — runs independently of intent_class detection.
 * Returns one of: saas_dashboard, ai_operations, crm_sales, fintech,
 * workflow_automation, analytics_platform, marketplace, devtools, general.
 *
 * @param {string} prompt - User task description
 * @returns {string} Archetype identifier
 */
function detectArchetype(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'general';

  // Score each archetype — first match wins, but we check all for logging
  for (const [archetype, patterns] of Object.entries(ARCHETYPE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(prompt)) {
        console.log(`[IntentGate] app_archetype → ${archetype} (matched: ${pattern.source})`);
        return archetype;
      }
    }
  }

  console.log('[IntentGate] app_archetype → general (no archetype signal detected)');
  return 'general';
}

// ── Compound Product System Detection ────────────────────────────────────────
// Catches PRODUCT_SYSTEM signals that require combining multiple weaker signals.
// Runs as Priority 1b (after simple patterns, before static/light checks).
// Returns { match: true, reason: string, signals: string[] } or null.

const _AUTH_SIGNALS = [
  /\bsign\s*up\b/i,
  /\blog\s*in\b/i,
  /\blogin\b/i,
  /\bregister\b/i,
  /\buser\s*accounts?\b/i,
  /\bauthenticat(e|ion)\b/i,
];

const _DASHBOARD_SIGNALS = [
  /\bdashboard\b/i,
  /\badmin\s*panel\b/i,
];

const _ANALYTICS_SIGNALS = [
  /\b(stats?|statistics)\b/i,
  /\bmetrics?\b/i,
  /\banalytics\b/i,
  /\b(total|count|sum|average)\s+(of\s+)?\w+/i,
  /\b\w+\s+(count|total)\b/i,
  /\boverdue\s+count\b/i,
  /\bcompleted\s+count\b/i,
  /\bsummary\b/i,
];

const _CRUD_VERBS = [
  /\bcreate\b/i,
  /\bread\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bedit\b/i,
  /\bremove\b/i,
  /\bmodify\b/i,
];

const _ENTITY_PATTERN = /\b(users?|tasks?|projects?|clients?|invoices?|orders?|products?|items?|teams?|members?|posts?|comments?|categories?|tags?|roles?|tickets?|events?|appointments?|contacts?|messages?|notifications?|customers?|employees?|payments?|subscriptions?|schedules?|bookings?|boards?|columns?|issues?|assets?|documents?|folders?|notes?)\b/gi;

function _detectProductSystemCompound(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  const signals = [];

  // Count auth signals
  const authMatches = _AUTH_SIGNALS.filter(p => p.test(prompt));
  const hasAuth = authMatches.length > 0;
  const hasMultiAuth = authMatches.length >= 2;
  if (hasAuth) signals.push('auth:' + authMatches.map(p => p.source).join('+'));

  // Dashboard signals
  const hasDashboard = _DASHBOARD_SIGNALS.some(p => p.test(prompt));
  if (hasDashboard) signals.push('dashboard');

  // Analytics/stats signals
  const analyticsMatches = _ANALYTICS_SIGNALS.filter(p => p.test(prompt));
  const hasAnalytics = analyticsMatches.length > 0;
  if (hasAnalytics) signals.push('analytics:' + analyticsMatches.length);

  // CRUD verb count
  const crudCount = _CRUD_VERBS.filter(p => p.test(prompt)).length;
  if (crudCount > 0) signals.push('crud:' + crudCount);

  // Multi-entity detection (deduplicate singular/plural)
  const entities = new Set();
  let m;
  const entityRegex = new RegExp(_ENTITY_PATTERN.source, 'gi');
  while ((m = entityRegex.exec(prompt)) !== null) {
    entities.add(m[1].toLowerCase().replace(/s$/, ''));
  }
  if (entities.size > 0) signals.push('entities:' + [...entities].join(','));

  // Admin/role signals (already in simple patterns but compound catches edge cases)
  const hasAdmin = /\badmin\b/i.test(prompt);
  const hasRoles = /\broles?\b/i.test(prompt) && /\bpermissions?\b/i.test(prompt);
  if (hasAdmin) signals.push('admin');
  if (hasRoles) signals.push('roles+permissions');

  // ── Decision rules ────────────────────────────────────────────────────────
  // Rule 1: Two+ auth verbs (sign up + log in) → always PRODUCT_SYSTEM
  if (hasMultiAuth) {
    return { match: true, reason: 'multi_auth_verbs', signals };
  }

  // Rule 2: Auth + dashboard or analytics → PRODUCT_SYSTEM
  if (hasAuth && (hasDashboard || hasAnalytics)) {
    return { match: true, reason: 'auth_plus_dashboard_or_analytics', signals };
  }

  // Rule 3: Auth + CRUD operations (2+) → PRODUCT_SYSTEM
  if (hasAuth && crudCount >= 2) {
    return { match: true, reason: 'auth_plus_crud', signals };
  }

  // Rule 4: Dashboard + analytics → PRODUCT_SYSTEM
  if (hasDashboard && hasAnalytics) {
    return { match: true, reason: 'dashboard_plus_analytics', signals };
  }

  // Rule 5: Dashboard + multi-CRUD → PRODUCT_SYSTEM
  if (hasDashboard && crudCount >= 2) {
    return { match: true, reason: 'dashboard_plus_crud', signals };
  }

  // Rule 6: 3+ distinct entity types → PRODUCT_SYSTEM
  if (entities.size >= 3) {
    return { match: true, reason: 'multi_entity_' + entities.size, signals };
  }

  // Rule 7: Admin + roles/permissions → PRODUCT_SYSTEM
  if (hasRoles) {
    return { match: true, reason: 'role_based_access', signals };
  }

  // Rule 8: Multi-CRUD (3+ verbs) + multiple entities → PRODUCT_SYSTEM
  if (crudCount >= 3 && entities.size >= 2) {
    return { match: true, reason: 'multi_crud_multi_entity', signals };
  }

  return null;
}

// ── Constraint Contract Templates ─────────────────────────────────────────────

const CONTRACTS = {
  static_surface: {
    task_type: 'static_surface',
    intent_class: 'static_surface',
    constraints: {
      frontend: true,
      server: false,
      db: false,
      auth: false,
      api: false,
    },
    allowed_artifacts: ['html', 'css', 'js', 'jsx', 'src'],
    prohibited_layers: ['database', 'migrations', 'backend_services', 'server', 'routes', 'middleware'],
    complexity_budget: 'low',
    expansion_lock: true,
  },

  light_app: {
    task_type: 'light_app',
    intent_class: 'light_app',
    constraints: {
      frontend: true,
      server: true,
      db: 'maybe',      // only if state persistence is explicitly required
      auth: false,      // no auth unless explicitly requested
      api: 'minimal',
    },
    allowed_artifacts: ['html', 'css', 'js', 'jsx', 'server.js', 'routes/api.js', 'package.json', 'src'],
    prohibited_layers: ['auth_middleware', 'jwt', 'bcrypt'],
    complexity_budget: 'medium',
    expansion_lock: true,
  },

  full_product: {
    task_type: 'full_product',
    intent_class: 'full_product',
    constraints: {
      frontend: true,
      server: true,
      db: true,
      auth: true,
      api: true,
    },
    allowed_artifacts: ['html', 'jsx', 'js', 'server.js', 'routes', 'db', 'middleware', 'package.json', '.env.example', 'src'],
    prohibited_layers: [],
    complexity_budget: 'high',
    expansion_lock: false,
    output_stack: 'vite-react-tailwind',
    available_components: ['Card', 'Button', 'Badge', 'Input', 'Table', 'Tabs', 'Dialog', 'Select', 'Avatar', 'Sheet'],
  },

  // Repo-aware contract: used when prompt references an existing codebase.
  // All layers are allowed because the plan will determine what to change
  // based on the actual repo structure (read via Serena MCP).
  repo_aware: {
    task_type: 'full_product',
    intent_class: 'repo_feature',  // overridden by sub-classifier
    constraints: {
      frontend: true,
      server: true,
      db: true,
      auth: true,
      api: true,
      repo_aware: true,
    },
    allowed_artifacts: [],  // populated from repo file tree
    prohibited_layers: [],
    complexity_budget: 'high',
    expansion_lock: false,
    _repo_aware: true,
  },
};

// ── Decomposition Telemetry Helpers ──────────────────────────────────────────

/**
 * Compute decomposition telemetry payload for a rejected/soft-expanded intent.
 *
 * Runs an additional analysis pass AFTER the main classification decision has
 * been made. This is purely observational — it does NOT change the contract or
 * pipeline routing. The output feeds the IDL (Intent Decomposition Layer) design
 * backlog.
 *
 * @param {string} prompt      - Original user prompt
 * @param {object} contract    - The contract being returned (scope_locked or soft_expansion)
 * @returns {object}           - DECOMPOSITION_TELEMETRY payload
 */
function _computeDecompositionTelemetry(prompt, contract) {
  const safePrompt = (prompt && typeof prompt === 'string') ? prompt : '';

  // ── Count pattern matches per candidate class ─────────────────────────────
  let staticCount = 0;
  for (const p of DECOMP_STATIC_SURFACE_PATTERNS) { if (p.test(safePrompt)) staticCount++; }

  let lightCount = 0;
  for (const p of DECOMP_LIGHT_APP_PATTERNS) { if (p.test(safePrompt)) lightCount++; }

  // ── Count capability signal matches ──────────────────────────────────────
  let authCount = 0;
  for (const p of DECOMP_AUTH_PATTERNS) { if (p.test(safePrompt)) authCount++; }

  let dbCount = 0;
  for (const p of DECOMP_DATABASE_PATTERNS) { if (p.test(safePrompt)) dbCount++; }

  let apiCount = 0;
  for (const p of DECOMP_API_PATTERNS) { if (p.test(safePrompt)) apiCount++; }

  // ── Confidence scores: sigmoid-like normalization on match counts ─────────
  // Formula: confidence = 1 - exp(-0.5 * matches) — asymptotes toward 1.0
  // 0 matches → 0.00, 1 match → 0.39, 2 → 0.63, 3 → 0.78, 4 → 0.86, 5+ → ~0.92+
  const sigConf = (n) => parseFloat((1 - Math.exp(-0.5 * n)).toFixed(4));

  const staticConf = sigConf(staticCount);
  const lightConf  = sigConf(lightCount);
  const authConf   = sigConf(authCount);
  const dbConf     = sigConf(dbCount);
  const apiConf    = sigConf(apiCount);

  // ── Build ranked decomposition candidates list ────────────────────────────
  const candidates = [
    { class: 'static_surface', confidence: staticConf },
    { class: 'light_app',      confidence: lightConf  },
    { class: 'auth_module',    confidence: authConf   },
    { class: 'database',       confidence: dbConf     },
    { class: 'api_layer',      confidence: apiConf    },
  ]
    .filter(c => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  // ── Implied missing capabilities (present in prompt but locked by scope) ──
  const impliedMissing = [];
  if (authCount > 0) impliedMissing.push('auth');
  if (dbCount > 0)   impliedMissing.push('database');
  if (apiCount > 0)  impliedMissing.push('api');

  // ── What the system WOULD have done (without scope lock) ──────────────────
  let whatWouldHaveDone = 'light_app (default)';
  try {
    const candidateResult = computeCandidates(safePrompt);
    const { candidates: probCandidates, committed, rejected } = candidateResult;
    const top    = probCandidates[0];
    const second = probCandidates[1];
    if (rejected) {
      whatWouldHaveDone = 'rejected (INTENT_TOO_AMBIGUOUS)';
    } else if (committed) {
      whatWouldHaveDone = `${top.intent_class} (committed, p=${top.probability})`;
    } else {
      // soft expansion
      whatWouldHaveDone = `${top.intent_class} with soft_expansion to ${second.intent_class}`;
    }
  } catch (e) {
    // non-fatal — best-effort
    whatWouldHaveDone = 'could not determine (candidate computation failed)';
  }

  // ── Rejection reason ─────────────────────────────────────────────────────
  let actionTaken = 'unknown';
  let rejectionReason = 'unknown';

  if (contract._scope_locked) {
    actionTaken = 'scope_locked';
    rejectionReason = 'scope_lock_full_product';
  } else if (contract.intent_class === 'soft_expansion') {
    actionTaken = 'soft_expansion';
    rejectionReason = 'entropy_below_rejection_threshold_not_committed';
  }

  return {
    intent:                     contract._classified_as || contract.intent_class,
    action_taken:               actionTaken,
    decomposition_candidates:   candidates,
    implied_missing_capabilities: impliedMissing,
    rejection_reason:           rejectionReason,
    original_prompt:            safePrompt,
    what_system_would_have_done: whatWouldHaveDone,
    // Additional observability fields
    _pattern_match_counts: {
      static_surface: staticCount,
      light_app:      lightCount,
      auth:           authCount,
      database:       dbCount,
      api:            apiCount,
    },
  };
}

/**
 * Persist a DECOMPOSITION_TELEMETRY event to pipeline_events — fire and forget.
 *
 * NOTE: Uses pipeline_events (FK → pipeline_runs) NOT run_events (FK → runs).
 * The runId passed here originates from pipeline_runs, so inserting into
 * run_events caused a foreign key violation on every failed pipeline run.
 *
 * NON-BLOCKING: deliberately not awaited by callers. Any DB error is swallowed
 * with a warning. This must NEVER slow down or block the pipeline.
 *
 * @param {import('pg').Pool} pool   - PostgreSQL pool
 * @param {string}            runId  - UUID of the pipeline run (pipeline_runs.id)
 * @param {object}            payload
 */
function _logDecompositionTelemetry(pool, runId, payload) {
  if (!pool || !runId) return;  // no-op without both DB access + run context

  pool.query(
    `INSERT INTO pipeline_events (run_id, stage, status, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, 'intent_gate', 'DECOMPOSITION_TELEMETRY', JSON.stringify(payload)]
  ).catch(err => {
    console.warn('[IntentGate] DECOMPOSITION_TELEMETRY log failed (non-fatal):', err.message);
  });
}

// ── ISE Attachment ────────────────────────────────────────────────────────────

/**
 * Phase 4.2: Attach ISE (Interaction Surface Extractor) output to a contract.
 *
 * Mutates the contract in-place to add `_ise: { surfaces, transitions, interaction_verbs }`.
 * Called at every return point in classify() BEFORE the contract is returned to the
 * orchestrator. The orchestrator freezes the contract after ISE is attached.
 *
 * NON-BLOCKING: any ISE failure results in empty arrays — pipeline is never affected.
 *
 * @param {object} contract - Mutable contract object (not yet frozen)
 * @param {string} prompt   - Original user prompt
 * @returns {object} The same contract (mutated in-place, returned for chaining)
 */
function _attachISE(contract, prompt) {
  // Passthrough if ISE module not available
  if (!_extractInteractionSurfaces) {
    contract._ise = { surfaces: [], transitions: [], interaction_verbs: [] };
    return contract;
  }

  try {
    const ise = _extractInteractionSurfaces(prompt || '');
    contract._ise = ise;

    if (ise.interaction_verbs.length > 0) {
      console.log(
        `[IntentGate] ISE (Phase 4.2): verbs=[${ise.interaction_verbs.join(', ')}] ` +
        `surfaces=[${ise.surfaces.join(', ')}] ` +
        `transitions=[${ise.transitions.join(', ')}]`
      );
    }
  } catch (iseErr) {
    console.warn('[IntentGate] ISE enrichment failed (non-fatal):', iseErr.message);
    contract._ise = { surfaces: [], transitions: [], interaction_verbs: [] };
  }

  return contract;
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a task description and return a Constraint Contract.
 *
 * Classification order (deterministic):
 *   1. Full product signals (highest priority — override static/light)
 *   2. Static surface signals
 *   3. Light app signals
 *   4. Default: light_app (safe middle ground)
 *
 * ACL Phase 2 — Bias Shaping:
 *   When a pool is provided, reads accumulated constraint_feedback_weights for
 *   the classified task_type and applies weight-driven adjustments AFTER
 *   deterministic classification. This is bias shaping, not rule evolution.
 *
 *   Downgrade rules (for weight < -0.5):
 *     true    → "maybe"  (layer present but uncertain)
 *     "maybe" → false    (layer suppressed)
 *
 *   Upgrade rules (for weight > 0.5):
 *     Logged only — DO NOT auto-upgrade (Phase 3 / Conflict Resolver required)
 *
 *   If pool is absent or no weight rows exist → returns base contract unchanged.
 *
 * @param {string}            prompt - User's task description
 * @param {import('pg').Pool} [pool] - Optional: PostgreSQL pool for weight lookup (ACL Phase 2)
 * @param {string}            [runId] - Optional: UUID of the active pipeline run, used for
 *                                      DECOMPOSITION_TELEMETRY fire-and-forget logging.
 *                                      Has no effect on classification or routing.
 * @param {object}            [repoContext] - Optional: GitHub repo connection state
 * @param {boolean}           [repoContext.hasConnection] - User has a connected GitHub repo
 * @param {string}            [repoContext.repoFullName] - Connected repo (e.g. "user/repo")
 * @param {string[]}          [repoContext.repoFiles] - File paths from repo (if pre-scanned)
 * @param {object}            [repoContext.repoProfile] - Scanned tech stack profile
 * @returns {Promise<object>}          Constraint Contract (deep copy with optional weight_adjustments)
 */
async function classify(prompt, pool = null, runId = null, repoContext = null) {
  // ── Deterministic base classification (unchanged) ─────────────────────────

  if (!prompt || typeof prompt !== 'string') {
    console.warn('[IntentGate] Empty/invalid prompt — defaulting to light_app');
    const _defaultContract = deepCopy(CONTRACTS.light_app);
    _defaultContract.app_archetype = 'general';
    return _attachISE(_defaultContract, prompt);
  }

  let baseContract;

  // ── Priority 0: Repo-Aware Intent Detection ───────────────────────────────
  // When the user has a connected GitHub repo AND the prompt references an
  // existing codebase, classify as repo-aware. This produces a change plan
  // (modify existing files) instead of a greenfield scaffold.
  //
  // If the prompt references a repo but the user has NO connection, return a
  // special contract with _repo_connection_required=true so the orchestrator
  // can halt and surface the connection flow.
  const _promptReferencesRepo = isRepoAwarePrompt(prompt);
  const _hasRepoConnection = repoContext && repoContext.hasConnection;

  if (_promptReferencesRepo) {
    if (!_hasRepoConnection) {
      // Prompt references repo but no connection — halt pipeline
      console.warn('[IntentGate] → REPO_CONNECTION_REQUIRED: prompt references repo but no GitHub connection');
      const haltContract = deepCopy(CONTRACTS.light_app);
      haltContract._repo_connection_required = true;
      haltContract._rejection_reason = 'Your prompt references an existing repository, but no GitHub repo is connected. Please connect a GitHub repo first.';
      return _attachISE(haltContract, prompt);
    }

    // Connected + repo-referencing prompt → repo-aware classification
    const repoIntentClass = _classifyRepoIntent(prompt);
    baseContract = deepCopy(CONTRACTS.repo_aware);
    baseContract.intent_class = repoIntentClass;

    // Populate repo context on the contract
    baseContract.constraints.repo_aware = true;
    baseContract.repo_context = {
      repoFullName: repoContext.repoFullName || null,
      repoFiles: repoContext.repoFiles || [],
      framework: (repoContext.repoProfile && repoContext.repoProfile.framework) || null,
      language: (repoContext.repoProfile && repoContext.repoProfile.language) || null,
      isWebProject: repoContext.repoProfile ? repoContext.repoProfile.isWebProject : true,
    };

    // Carry the full file list for downstream phases
    if (repoContext.repoFiles && repoContext.repoFiles.length > 0) {
      baseContract.allowed_artifacts = repoContext.repoFiles;
    }

    console.log(
      `[IntentGate] → REPO_AWARE (${repoIntentClass}) | repo=${repoContext.repoFullName || 'unknown'} | ` +
      `files=${(repoContext.repoFiles || []).length} | framework=${baseContract.repo_context.framework || 'unknown'}`
    );
  }

  // Priority 1: Full product signals
  if (!baseContract) {
  for (const pattern of FULL_PRODUCT_PATTERNS) {
    if (pattern.test(prompt)) {
      console.log(`[IntentGate] → FULL_PRODUCT (matched: ${pattern.source})`);
      baseContract = deepCopy(CONTRACTS.full_product);
      break;
    }
  }
  }

  // Priority 1b: Compound product system detection
  // Catches multi-signal cases (auth + dashboard, auth + CRUD, multi-entity, etc.)
  if (!baseContract) {
    const compound = _detectProductSystemCompound(prompt);
    if (compound) {
      console.log(
        `[IntentGate] → FULL_PRODUCT (compound: ${compound.reason}) | signals=[${compound.signals.join(', ')}]`
      );
      baseContract = deepCopy(CONTRACTS.full_product);
    }
  }

  if (!baseContract) {
    // Priority 2: Static surface signals
    for (const pattern of STATIC_SURFACE_PATTERNS) {
      if (pattern.test(prompt)) {
        console.log(`[IntentGate] → STATIC_SURFACE (matched: ${pattern.source})`);
        baseContract = deepCopy(CONTRACTS.static_surface);
        break;
      }
    }
  }

  if (!baseContract) {
    // Priority 3: Light app signals
    for (const pattern of LIGHT_APP_PATTERNS) {
      if (pattern.test(prompt)) {
        console.log(`[IntentGate] → LIGHT_APP (matched: ${pattern.source})`);
        baseContract = deepCopy(CONTRACTS.light_app);
        break;
      }
    }
  }

  if (!baseContract) {
    // Default: light_app (safe middle ground — neither over-scoped nor under-scoped)
    console.log('[IntentGate] → LIGHT_APP (default — no strong signal detected)');
    baseContract = deepCopy(CONTRACTS.light_app);
  }

  // ── App Archetype Detection (secondary classification) ────────────────────
  // Compute once; attached to all contract paths below (including softContract,
  // rejectionContract). Runs AFTER intent_class is settled — archetype is purely
  // additive metadata and never affects constraints or scaffold decisions.
  const _appArchetype = detectArchetype(prompt);
  baseContract.app_archetype = _appArchetype;

  // ── Phase 4: Multi-candidate entropy modeling + soft expansion ───────────
  // Compute probabilistic candidates BEFORE Phase 2 bias shaping.
  // This runs even without a pool — entropy/candidates are always logged.
  //
  // Safety: entire block is wrapped in try/catch. Any failure falls back to
  // existing single-class behavior (Phase 2 path below).

  let _candidateResult = null;
  try {
    _candidateResult = computeCandidates(prompt);
  } catch (candidateErr) {
    console.warn('[IntentGate] Phase 4 candidate computation failed (non-fatal, falling back):', candidateErr.message);
    _candidateResult = null;
  }

  if (_candidateResult) {
    const { candidates, entropy, committed, rejected } = _candidateResult;

    console.log(
      `[IntentGate] Phase 4 entropy=${entropy.toFixed(4)} nats | ` +
      `candidates=${candidates.map(c => `${c.intent_class}:${(c.probability * 100).toFixed(1)}%`).join(', ')} | ` +
      `committed=${committed} | rejected=${rejected}`
    );

    // ── Hard rejection: near-uniform distribution ──────────────────────────
    if (rejected) {
      console.warn('[IntentGate] Phase 4: entropy too high — task rejected for clarification');
      const rejectionContract = deepCopy(CONTRACTS.light_app);
      rejectionContract._rejected           = true;
      rejectionContract._rejection_reason   = 'Classification too uncertain — please clarify your request.';
      rejectionContract._entropy            = entropy;
      rejectionContract._candidates         = candidates;
      rejectionContract._committed          = false;
      rejectionContract.app_archetype       = _appArchetype;
      return _attachISE(rejectionContract, prompt);
    }

    // ── Soft expansion: ambiguous but not rejected ─────────────────────────
    // Guard: if deterministic classification already chose full_product (Priority 1/1b)
    // OR static_surface (Priority 2), Phase 4 soft expansion must not override —
    // the deterministic signal is authoritative. Static pages with simple form
    // elements (email signup, contact form) should stay STATIC_SURFACE; soft expansion
    // was incorrectly overriding these to INTERACTIVE_LIGHT_APP (Report #596913).
    if (!committed && baseContract.task_type !== 'full_product' && baseContract.task_type !== 'static_surface') {
      // Check CDK freeze guard: if pool available and any involved class is frozen,
      // disable soft expansion (fall through to single-class path)
      let cdkFreezeActive = false;
      if (pool) {
        try {
          const topClass    = candidates[0].intent_class;
          const secondClass = candidates[1].intent_class;
          const freezeCheck = await pool.query(
            `SELECT task_type, constraint_key, frozen
               FROM constraint_feedback_weights
              WHERE task_type IN ($1, $2) AND frozen = true
              LIMIT 1`,
            [topClass, secondClass]
          );
          cdkFreezeActive = (freezeCheck.rowCount > 0);
          if (cdkFreezeActive) {
            console.log(`[IntentGate] Phase 4: CDK freeze detected — soft expansion disabled, using single class`);
          }
        } catch (freezeErr) {
          // Non-fatal — if we can't check freeze, assume not frozen
          console.warn('[IntentGate] Phase 4 CDK freeze check failed (non-fatal):', freezeErr.message);
        }
      }

      if (!cdkFreezeActive) {
        try {
          const softContract = buildSoftExpansionContract(_candidateResult, CONTRACTS);
          // Attach multi-candidate metadata to the contract
          softContract._committed    = false;
          softContract._candidates   = candidates;
          softContract._entropy      = entropy;
          softContract.app_archetype = _appArchetype;
          console.log(
            `[IntentGate] Phase 4 → SOFT_EXPANSION | base=${softContract.base_class} | ` +
            `expansion=${softContract.expansion_candidate} | ` +
            `budget=${softContract.complexity_budget}`
          );

          // ── Phase 4.1: Decomposition Telemetry (fire-and-forget, observation only) ──
          // Zero behavior change — purely logging enrichment.
          try {
            const decomp = _computeDecompositionTelemetry(prompt, softContract);
            softContract._decomposition_telemetry = decomp;
            _logDecompositionTelemetry(pool, runId, decomp);
            console.log(
              `[IntentGate] DECOMPOSITION_TELEMETRY (soft_expansion) | ` +
              `candidates=[${decomp.decomposition_candidates.map(c => `${c.class}:${c.confidence}`).join(', ')}] | ` +
              `implied_missing=[${decomp.implied_missing_capabilities.join(', ') || 'none'}]`
            );
          } catch (decompErr) {
            console.warn('[IntentGate] Decomposition telemetry failed (non-fatal):', decompErr.message);
          }

          return _attachISE(softContract, prompt);
        } catch (softErr) {
          console.warn('[IntentGate] Phase 4 soft expansion contract build failed (non-fatal, falling back):', softErr.message);
          // Fall through to single-class path
        }
      }
    }

    // Attach multi-candidate metadata to the committed single-class contract
    baseContract._committed  = true;
    baseContract._candidates = candidates;
    baseContract._entropy    = entropy;
  }

  // ── ACL Phase 2: Weight-driven bias shaping ───────────────────────────────
  // Graceful degradation: if pool is absent → return base contract unchanged.
  if (!pool) {
    return _attachISE(baseContract, prompt);
  }

  let weightRows;
  try {
    weightRows = await getWeightsForTaskType(pool, baseContract.task_type);
  } catch (weightErr) {
    console.warn('[IntentGate] Weight lookup failed (non-fatal):', weightErr.message);
    return _attachISE(baseContract, prompt);
  }

  // No learned weights yet → return base contract unchanged
  if (!weightRows || weightRows.length === 0) {
    return _attachISE(baseContract, prompt);
  }

  // Apply bias adjustments for each constraint key that has crossed the threshold
  const TIGHTEN_THRESHOLD = -0.5;  // weight must go below this to trigger downgrade
  const LOOSEN_THRESHOLD  =  0.5;  // weight above this = under-scoped signal (log only)
  const weightAdjustments = {};
  let anyAdjustment = false;

  for (const row of weightRows) {
    const { constraint_key, weight, sample_count } = row;

    // Only adjust keys that exist in this contract's constraints
    if (!(constraint_key in baseContract.constraints)) continue;

    if (weight < TIGHTEN_THRESHOLD) {
      // Over-scoped aversion: downgrade this constraint layer
      const original = baseContract.constraints[constraint_key];
      let adjusted = original;

      if (original === true) {
        adjusted = 'maybe';
      } else if (original === 'maybe') {
        adjusted = false;
      } else if (original === 'minimal') {
        adjusted = false;
      }
      // If original is already false, no further downgrade

      if (adjusted !== original) {
        baseContract.constraints[constraint_key] = adjusted;
        weightAdjustments[constraint_key] = {
          original,
          adjusted,
          weight: parseFloat(weight.toFixed(4)),
          reason: `${sample_count} over_scoped violation(s) accumulated`,
        };
        anyAdjustment = true;
        console.log(
          `[IntentGate] Weight bias: ${baseContract.task_type}.${constraint_key} ` +
          `${JSON.stringify(original)} → ${JSON.stringify(adjusted)} ` +
          `(weight=${weight.toFixed(4)}, n=${sample_count})`
        );
      }
    } else if (weight > LOOSEN_THRESHOLD) {
      // Under-scoped signal: log only — DO NOT auto-loosen (Phase 3 territory)
      console.log(
        `[IntentGate] Weight signal (under_scoped, flagged for review): ` +
        `${baseContract.task_type}.${constraint_key} weight=${weight.toFixed(4)}, n=${sample_count}`
      );
    }
  }

  // Attach weight_adjustments to the contract for full explainability
  if (anyAdjustment) {
    baseContract.weight_adjustments = weightAdjustments;
    console.log(
      `[IntentGate] Bias shaping applied for ${baseContract.task_type}: ` +
      `${Object.keys(weightAdjustments).join(', ')}`
    );
  }

  return _attachISE(baseContract, prompt);
}

// ── Scaffold Constraint Validation ───────────────────────────────────────────

/**
 * Validate that a scaffold manifest respects the constraint contract.
 *
 * Called by BuilderAgent after generating scaffold, and by the orchestrator
 * as a hard gate. Violation = reject scaffold.
 *
 * @param {object} scaffoldOutput - Output from SCAFFOLD stage ({ files[], tree[], ... })
 * @param {object} contract       - Constraint Contract from Intent Gate
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateScaffoldAgainstContract(scaffoldOutput, contract) {
  // Repo-aware contracts are permissive — the plan determines what to change
  if (!contract || contract.intent_class === 'full_product' || contract._repo_aware) {
    return { valid: true, violations: [] };
  }

  const violations = [];
  const files = (scaffoldOutput && scaffoldOutput.files) ? scaffoldOutput.files : [];

  // ── Phase 4: soft_expansion — check against soft_expansion allowlist ──────
  // When operating under soft_expansion, capabilities beyond the base class
  // constraints are ONLY allowed if:
  //   1. The capability is listed in contract.soft_expansion
  //   2. The plan explicitly justified its usage (expansion_justifications field)
  //
  // The plan output is not directly accessible here, so we check if the
  // scaffold includes any expanded capability WITHOUT justification being
  // passed in. The orchestrator validates justifications separately before
  // calling this function. If scaffold includes an expanded capability that
  // wasn't in plan justifications, it's a violation.
  //
  // Note: when called from orchestrator, it passes planExpansionJustifications
  // as a third parameter to enable full validation.
  const isSoftExpansion = contract.intent_class === 'soft_expansion';
  const softExpansion   = (isSoftExpansion && contract.soft_expansion) ? contract.soft_expansion : {};

  // Check: db=false → no DB files (unless soft_expansion allows it)
  const dbAllowed = isSoftExpansion && softExpansion.db && softExpansion.db.allowed !== false;
  if (contract.constraints.db === false && !dbAllowed) {
    const dbFiles = files.filter(f =>
      f.includes('db/') || f.includes('migrations/') ||
      f === 'migrate.js' || f.endsWith('/queries.js') || f.endsWith('/pool.js')
    );
    if (dbFiles.length > 0) {
      violations.push(`db=false but scaffold includes DB files: ${dbFiles.join(', ')}`);
    }
  }

  // Check: server=false → no server files (unless soft_expansion allows it)
  const serverAllowed = isSoftExpansion && softExpansion.server && softExpansion.server.allowed !== false;
  if (contract.constraints.server === false && !serverAllowed) {
    const serverFiles = files.filter(f =>
      f === 'server.js' || f === 'index.js' ||
      f.startsWith('routes/') || f.startsWith('middleware/')
    );
    if (serverFiles.length > 0) {
      violations.push(`server=false but scaffold includes server files: ${serverFiles.join(', ')}`);
    }
  }

  // Check: auth=false → no auth files (unless soft_expansion allows it)
  const authAllowed = isSoftExpansion && softExpansion.auth && softExpansion.auth.allowed !== false;
  if (contract.constraints.auth === false && !authAllowed) {
    const authFiles = files.filter(f =>
      f.toLowerCase().includes('auth') || f.includes('jwt') || f.includes('bcrypt')
    );
    if (authFiles.length > 0) {
      violations.push(`auth=false but scaffold includes auth files: ${authFiles.join(', ')}`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ── Code Constraint Validation ────────────────────────────────────────────────

/**
 * Validate that generated code output respects the constraint contract.
 *
 * Called by QAAgent in the VERIFY stage.
 *
 * @param {object} codeOutput - Output from CODE stage ({ files: { [path]: content } })
 * @param {object} contract   - Constraint Contract from Intent Gate
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateCodeAgainstContract(codeOutput, contract) {
  // Repo-aware contracts are permissive — the plan determines what to change
  if (!contract || contract.intent_class === 'full_product' || contract._repo_aware) {
    return { valid: true, violations: [] };
  }

  const violations = [];
  const fileKeys = Object.keys((codeOutput && codeOutput.files) ? codeOutput.files : {});

  // ── Phase 4: soft_expansion — allow soft expansion capabilities ───────────
  const isSoftExpansion = contract.intent_class === 'soft_expansion';
  const softExpansion   = (isSoftExpansion && contract.soft_expansion) ? contract.soft_expansion : {};

  // Check: db=false → no DB files (unless soft_expansion authorizes db)
  const dbAllowed = isSoftExpansion && softExpansion.db && softExpansion.db.allowed !== false;
  if (contract.constraints.db === false && !dbAllowed) {
    const dbFiles = fileKeys.filter(f =>
      f.includes('db/') || f.includes('migrations/') ||
      f === 'migrate.js' || f.endsWith('queries.js') || f.endsWith('pool.js')
    );
    if (dbFiles.length > 0) {
      violations.push(`db=false but CODE generated DB files: ${dbFiles.join(', ')}`);
    }
  }

  // Check: server=false → no server files (unless soft_expansion authorizes server)
  const serverAllowed = isSoftExpansion && softExpansion.server && softExpansion.server.allowed !== false;
  if (contract.constraints.server === false && !serverAllowed) {
    const serverFiles = fileKeys.filter(f =>
      f === 'server.js' || f.startsWith('routes/') || f.startsWith('middleware/')
    );
    if (serverFiles.length > 0) {
      violations.push(`server=false but CODE generated server files: ${serverFiles.join(', ')}`);
    }
  }

  // Check: auth=false → no auth files (unless soft_expansion authorizes auth)
  const authAllowed = isSoftExpansion && softExpansion.auth && softExpansion.auth.allowed !== false;
  if (contract.constraints.auth === false && !authAllowed) {
    const authFiles = fileKeys.filter(f =>
      f.toLowerCase().includes('auth') || f.includes('jwt') || f.includes('bcrypt')
    );
    if (authFiles.length > 0) {
      violations.push(`auth=false but CODE generated auth files: ${authFiles.join(', ')}`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ── Prompt Injection ──────────────────────────────────────────────────────────

/**
 * Format the Constraint Contract as an immutable rules block for AI system prompts.
 *
 * Injected into PLAN and CODE prompts as a hard constraint header.
 * AI agents are instructed they CANNOT override these rules.
 *
 * @param {object} contract - Constraint Contract from Intent Gate
 * @returns {string} Formatted block to prepend to system prompts
 */
function formatConstraintBlock(contract) {
  if (!contract) return '';

  const lines = [
    '=== CONSTRAINT CONTRACT (IMMUTABLE — DO NOT OVERRIDE) ===',
    `Intent Class:      ${contract.intent_class}`,
    `App Archetype:     ${contract.app_archetype || 'general'}`,
    `Complexity Budget: ${contract.complexity_budget}`,
    `Expansion Lock:    ${contract.expansion_lock}`,
  ];

  if (contract.output_stack) {
    lines.push(`Output Stack:      ${contract.output_stack}`);
  }
  if (contract.available_components && contract.available_components.length > 0) {
    lines.push(`UI Components:     ${contract.available_components.join(', ')} (shadcn-style, defined inline in app.jsx)`);
  }

  lines.push('');
  lines.push('Allowed Layers:');
  lines.push(`  frontend: ${contract.constraints.frontend}`);
  lines.push(`  server:   ${contract.constraints.server}`);
  lines.push(`  db:       ${contract.constraints.db}`);
  lines.push(`  auth:     ${contract.constraints.auth}`);
  lines.push(`  api:      ${contract.constraints.api}`);
  lines.push('');
  lines.push('Allowed Artifacts: ' + (contract.allowed_artifacts || []).join(', '));

  if (contract.prohibited_layers && contract.prohibited_layers.length > 0) {
    lines.push('Prohibited Layers: ' + contract.prohibited_layers.join(', '));
  }

  // ── Repo-Aware section ─────────────────────────────────────────────────────
  // When the pipeline is operating on an existing codebase, inject guidance so
  // PLAN and CODE produce change plans (diffs) rather than greenfield scaffolds.
  if (contract._repo_aware && contract.repo_context) {
    const rc = contract.repo_context;
    lines.push('');
    lines.push('REPO-AWARE MODE (EXISTING CODEBASE — READ BEFORE WRITING):');
    lines.push(`  Repository: ${rc.repoFullName || 'connected'}`);
    lines.push(`  Language:   ${rc.language || 'auto-detect'}`);
    lines.push(`  Framework:  ${rc.framework || 'auto-detect'}`);
    lines.push(`  Web Project: ${rc.isWebProject !== false ? 'yes' : 'no'}`);
    if (rc.repoFiles && rc.repoFiles.length > 0) {
      // Show top-level structure (limit to 30 entries to fit context window)
      const topFiles = rc.repoFiles.slice(0, 30);
      lines.push(`  Files (${rc.repoFiles.length} total): ${topFiles.join(', ')}${rc.repoFiles.length > 30 ? '...' : ''}`);
    }
    lines.push('');
    lines.push('REPO-AWARE RULES (MANDATORY):');
    lines.push('  • You are modifying an EXISTING codebase — NOT building from scratch');
    lines.push('  • Your plan MUST describe changes to existing files (which files to modify, what to add/change)');
    lines.push('  • Do NOT generate a greenfield scaffold — describe diffs to existing code');
    lines.push('  • Reference actual file paths from the repo when describing changes');
    lines.push('  • Respect existing architecture, naming conventions, and patterns');
    lines.push('  • New files should follow the existing project structure');
    lines.push(`  • Intent: ${contract.intent_class} — plan accordingly`);
  }

  // ── Phase 4: soft_expansion section ───────────────────────────────────────
  if (contract.intent_class === 'soft_expansion' && contract.soft_expansion) {
    const softExpansion = contract.soft_expansion;
    const allowedCaps   = Object.entries(softExpansion)
      .filter(([, rule]) => rule && rule.allowed !== false)
      .map(([cap, rule]) => `${cap} (${rule.scope || 'minimal'})`)
      .join(', ');

    lines.push('');
    lines.push(`Base Class:         ${contract.base_class}`);
    lines.push(`Expansion Candidate: ${contract.expansion_candidate}`);
    lines.push('');
    lines.push('SOFT EXPANSION CAPABILITIES (Phase 4):');
    lines.push(`  Available if needed: ${allowedCaps || 'none'}`);
    lines.push('');
    lines.push('SOFT EXPANSION RULES (MANDATORY):');
    lines.push('  • Base constraints above are the DEFAULT — do NOT exceed them automatically');
    lines.push('  • You MAY use an available soft expansion capability IF genuinely required');
    lines.push('  • Every soft expansion used MUST be justified in expansion_justifications[]');
    lines.push('  • Format: { "capability": "server", "reason": "...", "scope": "..." }');
    lines.push('  • Unjustified expansions will be rejected at SCAFFOLD');
    lines.push('  • When in doubt, stay with base constraints (more conservative = preferred)');
  }

  if (contract.expansion_lock) {
    lines.push('');
    lines.push('HARD RULES (you MUST follow these exactly):');
    if (contract.constraints.server === false) {
      const serverExpansion = contract.soft_expansion && contract.soft_expansion.server;
      if (serverExpansion && serverExpansion.allowed !== false) {
        lines.push(`  • server is NOT included by default, but MAY be used if needed: scope="${serverExpansion.scope}"`);
      } else {
        lines.push('  • Do NOT create server.js, routes/, or any backend server code');
        lines.push('  • Do NOT add Express.js, Node.js server, or any API endpoints');
      }
    }
    if (contract.constraints.db === false) {
      const dbExpansion = contract.soft_expansion && contract.soft_expansion.db;
      if (dbExpansion && dbExpansion.allowed !== false) {
        lines.push(`  • db is NOT included by default, but MAY be used if needed: scope="${dbExpansion.scope}"`);
      } else {
        lines.push('  • Do NOT create database files, migrations, or SQL queries');
        lines.push('  • Do NOT use PostgreSQL, SQLite, or any database layer');
      }
    }
    if (contract.constraints.auth === false) {
      const authExpansion = contract.soft_expansion && contract.soft_expansion.auth;
      if (authExpansion && authExpansion.allowed !== false) {
        lines.push(`  • auth is NOT included by default, but MAY be used if needed: scope="${authExpansion.scope}"`);
      } else {
        lines.push('  • Do NOT add authentication, login/signup, or JWT middleware');
      }
    }
    if (contract.intent_class === 'static_surface') {
      lines.push('  • Generate ONLY: index.html, styles.css, script.js (or equivalent)');
      lines.push('  • This is a static page — pure HTML/CSS/JS with no backend');
    }
    lines.push('  • Do NOT introduce systems beyond what is listed in "Allowed Layers"');
    lines.push('  • Expansion lock is ENABLED — stay within defined scope');
  }

  // ── Phase 4.2: ISE section ─────────────────────────────────────────────────
  // When interaction surfaces have been extracted, inject them into the constraint
  // block so PLAN and CODE agents know what surfaces to implement.
  if (contract._ise && contract._ise.surfaces && contract._ise.surfaces.length > 0) {
    const { surfaces, transitions, interaction_verbs } = contract._ise;
    lines.push('');
    lines.push('INTERACTION SURFACES (Phase 4.2 ISE — BUILD TARGETS):');
    lines.push('  The following surfaces MUST be implemented as distinct UI sections/views:');
    for (const surface of surfaces) {
      lines.push(`    • ${surface}`);
    }
    if (transitions.length > 0) {
      lines.push('  User flow transitions:');
      for (const t of transitions) {
        lines.push(`    → ${t}`);
      }
    }
    if (interaction_verbs.length > 0) {
      lines.push(`  Detected interaction verbs: ${interaction_verbs.join(', ')}`);
    }
    lines.push('  Do NOT collapse these into a generic feature grid.');
    lines.push('  Each surface maps to a concrete section, page, or component.');
  }

  // ── App Archetype: component composition guidance ──────────────────────────
  // Injected into PLAN and CODE prompts to guide the right visual/UX pattern.
  const _archetype = contract.app_archetype || 'general';
  if (_archetype !== 'general') {
    const ARCHETYPE_GUIDANCE = {
      saas_dashboard: 'Use sidebar navigation (.sidebar, .sidebar-item), stat cards row at top (.stat-card), data table in main area (.table), and chart/overview section. Clean operational layout with clear hierarchy.',
      ai_operations:  'Use command center layout: status indicator bar, real-time feed panel, agent/model cards with .badge status pills, log viewer with monospace font. Dark operational feel — minimal decoration, maximum signal.',
      crm_sales:      'Use pipeline kanban or filterable list view, contact/deal cards (.card-elevated), stage progression indicators (.badge), activity timeline. Data-dense but clean — every field visible at a glance.',
      fintech:        'Use number-heavy dashboard with large stat cards (.stat-card) for key metrics, transaction table (.table) with status badges, chart panels for trends. Trust signals: precise numbers, clear status, no ambiguity.',
      workflow_automation: 'Use pipeline/DAG visualizer or step-by-step flow list, trigger/action cards (.card), status badges for each step (.badge-success/.badge-warning), run history log. Clarity of sequence is the priority.',
      analytics_platform:  'Use chart-dominant layout with filter bar and date range selector at top, metric cards (.stat-card), data table below charts. Controls for filtering/grouping must be prominent and functional.',
      marketplace:    'Use product/listing grid or table view, vendor cards, order management table (.table), status filters. Multi-entity: buyers, sellers, items, orders — each has its own view section.',
      devtools:       'Use operational console layout: deployment status panel, log viewer (monospace), metric gauges, environment/service cards. Status clarity is critical — green/yellow/red states must be immediately visible.',
    };
    const guidance = ARCHETYPE_GUIDANCE[_archetype];
    if (guidance) {
      lines.push('');
      lines.push(`APP ARCHETYPE GUIDANCE (${_archetype.toUpperCase()}):`);
      lines.push(`  ${guidance}`);
      lines.push('  Use the Design DNA component classes (.card, .stat-card, .sidebar, .table, .badge, .btn-primary, etc.) appropriate for this archetype.');
    }
  }

  lines.push('=== END CONSTRAINT CONTRACT ===');

  return lines.join('\n');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Deep copy a contract object so mutations don't affect the template.
 */
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  classify,
  isRepoAwarePrompt,
  validateScaffoldAgainstContract,
  validateCodeAgainstContract,
  formatConstraintBlock,
  detectArchetype,
  CONTRACTS,
  // Exposed for testing and external introspection — not part of pipeline contract
  _computeDecompositionTelemetry,
  _attachISE,
  _classifyRepoIntent,
};
