/**
 * Interaction Surface Extractor (ISE) — Phase 4.2
 *
 * Extracts structured interaction surfaces and transitions from the user's
 * prompt BEFORE Scaffold runs. Runs after Intent Gate classification and
 * enriches the Constraint Contract Object (CCO) with:
 *
 *   surfaces[]          — named UI surfaces detected from interaction verbs
 *   transitions[]       — flow graph edges connecting surfaces (A→B notation)
 *   interaction_verbs[] — raw verb tokens that triggered surface extraction
 *
 * Passthrough behaviour:
 *   Clean static pages with NO interaction verbs (e.g. "make a portfolio page")
 *   produce empty arrays for all three fields. Scaffold behaves exactly as today.
 *
 * Position in pipeline:
 *   INTENT GATE (classify) → ISE (enrichment) → PLAN → SCAFFOLD → CODE
 *
 * Key property: ISE is observation + enrichment only.
 *   - It does NOT modify classification decisions.
 *   - It does NOT change the intent_class or constraints.
 *   - It NEVER throws — any failure returns empty arrays (graceful passthrough).
 */

'use strict';

// ── Interaction Verb → Surface Rules ─────────────────────────────────────────
//
// Each rule maps one or more regex patterns to a canonical surface name and
// a normalised verb label. First match wins for a given rule (no duplicates).

const VERB_RULES = [
  // Signup / registration flow
  {
    patterns: [/\bsign\s*up\b/i, /\bsignup\b/i, /\bregist(er|ration)\b/i],
    surface: 'signup_capture',
    verb:    'signup',
  },
  // Email / newsletter capture
  {
    patterns: [/\bemail\s*(signup|capture|subscribe|list)\b/i, /\bnewsletter\b/i, /\bemail\b.*\bcollect\b/i],
    surface: 'email_capture',
    verb:    'collect',
  },
  // Waitlist
  {
    patterns: [/\bwaitlist\b/i, /\bwait\s*list\b/i, /\bjoin\s*the\s*list\b/i],
    surface: 'waitlist_capture',
    verb:    'collect',
  },
  // Lead capture
  {
    patterns: [/\blead[s]?\s*capture\b/i, /\bcapture\s*lead[s]?\b/i, /\blead[s]?\b/i],
    surface: 'lead_capture',
    verb:    'capture',
  },
  // Generic data collection / intake forms
  {
    patterns: [/\bcollect\b/i, /\bgather\b/i, /\bcapture\b/i],
    surface: 'data_capture',
    verb:    'collect',
  },
  // Subscription
  {
    patterns: [/\bsubscri(be|ption|bers?)\b/i],
    surface: 'subscription_capture',
    verb:    'subscribe',
  },
  // Contact / feedback forms
  {
    patterns: [
      /\bcontact\b.*\bform\b/i,
      /\bfeedback\b.*\bform\b/i,
      /\bsubmit\b.*\bfeedback\b/i,
      /\bfeedback\b/i,
      /\bcontact\s*us\b/i,
    ],
    surface: 'contact_form',
    verb:    'submit',
  },
  // Onboarding
  {
    patterns: [/\bonboard(ing)?\b/i],
    surface: 'onboarding_view',
    verb:    'onboard',
  },
  // Guided / wizard flow
  {
    patterns: [/\bguide\b/i, /\bwalkthrough\b/i, /\bwizard\b/i, /\bstep[- ]by[- ]step\b/i],
    surface: 'guided_flow',
    verb:    'guide',
  },
  // Checkout / purchase flow
  {
    patterns: [/\bcheckout\b/i, /\bpurchase\b/i, /\bbuy\s*(now)?\b/i, /\bpay(ment|ing)?\b/i, /\border\b/i],
    surface: 'checkout_flow',
    verb:    'buy',
  },
  // Confirmation state
  {
    patterns: [/\bconfirm(ation)?\b/i, /\bthank\s*you\b/i, /\bsuccess\s*(page|state|screen)?\b/i],
    surface: 'confirmation_state',
    verb:    'confirm',
  },
  // Dashboard / data view
  {
    patterns: [/\bdashboard\b/i, /\boverview\b/i, /\banalytics\b/i],
    surface: 'dashboard_view',
    verb:    'view',
  },
  // Evolve / update state
  {
    patterns: [/\bevolve\b/i, /\bupgrade\b/i, /\btransition\b/i],
    surface: 'entry_point',
    verb:    'evolve',
  },
];

// ── Surface Flow Positions ─────────────────────────────────────────────────────
// Defines a natural ordering for surfaces in a user flow.
// Lower index = earlier in the flow. Used to sort surfaces and build transitions.

const SURFACE_POSITION = {
  landing_view:          0,
  guided_flow:           1,
  onboarding_view:       1,
  signup_capture:        2,
  email_capture:         2,
  waitlist_capture:      2,
  lead_capture:          2,
  subscription_capture:  2,
  data_capture:          2,
  contact_form:          2,
  checkout_flow:         3,
  dashboard_view:        4,
  entry_point:           4,
  confirmation_state:    5,
};

// Surfaces that represent "capture" actions — they imply a confirmation afterward
const CAPTURE_SURFACES = new Set([
  'signup_capture',
  'email_capture',
  'waitlist_capture',
  'lead_capture',
  'data_capture',
  'subscription_capture',
  'contact_form',
  'checkout_flow',
]);

// ── Core Extraction ───────────────────────────────────────────────────────────

/**
 * Extract interaction surfaces from a user prompt.
 *
 * @param {string} prompt - User's original task description
 * @returns {{ surfaces: string[], transitions: string[], interaction_verbs: string[] }}
 *
 * On any error, returns empty arrays (passthrough — pipeline never blocked).
 */
function extractInteractionSurfaces(prompt) {
  // ── Safety guard ──────────────────────────────────────────────────────────
  if (!prompt || typeof prompt !== 'string') {
    return { surfaces: [], transitions: [], interaction_verbs: [] };
  }

  const safePrompt = prompt.trim();
  if (!safePrompt) {
    return { surfaces: [], transitions: [], interaction_verbs: [] };
  }

  // ── Verb detection + surface extraction ───────────────────────────────────
  const detectedSurfaces = [];   // ordered by detection (later deduplicated)
  const detectedVerbs    = [];   // raw verb tokens

  for (const rule of VERB_RULES) {
    // Check if any pattern in this rule matches the prompt
    const matched = rule.patterns.some(p => p.test(safePrompt));
    if (!matched) continue;

    // Add surface (deduplicate)
    if (!detectedSurfaces.includes(rule.surface)) {
      detectedSurfaces.push(rule.surface);
    }
    // Add verb (deduplicate)
    if (!detectedVerbs.includes(rule.verb)) {
      detectedVerbs.push(rule.verb);
    }
  }

  // ── Passthrough: no interaction verbs detected ────────────────────────────
  if (detectedSurfaces.length === 0) {
    return { surfaces: [], transitions: [], interaction_verbs: [] };
  }

  // ── Sort surfaces by flow position ────────────────────────────────────────
  const sortedSurfaces = [...detectedSurfaces].sort((a, b) => {
    const posA = SURFACE_POSITION[a] ?? 3;
    const posB = SURFACE_POSITION[b] ?? 3;
    return posA !== posB ? posA - posB : a.localeCompare(b);
  });

  // ── Implied surfaces ───────────────────────────────────────────────────────
  // If any capture surface is present and no confirmation_state was detected,
  // imply confirmation_state as the terminal surface.
  const hasCapture = sortedSurfaces.some(s => CAPTURE_SURFACES.has(s));
  const hasConfirmation = sortedSurfaces.includes('confirmation_state');

  const finalSurfaces = [...sortedSurfaces];
  if (hasCapture && !hasConfirmation) {
    finalSurfaces.push('confirmation_state');
  }

  // ── Build transitions ─────────────────────────────────────────────────────
  const transitions = buildTransitions(finalSurfaces);

  return {
    surfaces:          finalSurfaces,
    transitions,
    interaction_verbs: detectedVerbs,
  };
}

/**
 * Build a flow graph from an ordered list of surfaces.
 *
 * Transitions are expressed as "A→B" strings connecting consecutive surfaces.
 * Only adjacent pairs in the sorted surface list are connected.
 *
 * @param {string[]} surfaces - Ordered surface names
 * @returns {string[]}         Transition edges (e.g. ['view→signup', 'signup→confirmation'])
 */
function buildTransitions(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length < 2) return [];

  const transitions = [];
  for (let i = 0; i < surfaces.length - 1; i++) {
    transitions.push(`${surfaces[i]}→${surfaces[i + 1]}`);
  }
  return transitions;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  extractInteractionSurfaces,
  buildTransitions,
  // Exported for tests and introspection
  VERB_RULES,
  SURFACE_POSITION,
  CAPTURE_SURFACES,
};
