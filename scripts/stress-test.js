#!/usr/bin/env node
/**
 * BuildOrbit — Real-Prompt Stress Test Harness
 *
 * Runs 10 messy, real-world prompts through the full constraint pipeline
 * (Intent Gate → Schema → Constraint Contract) and optionally through the
 * live API for full pipeline execution (PLAN → SCAFFOLD → CODE → VERIFY).
 *
 * Usage:
 *   # Classification + constraint analysis only (fast, no API needed)
 *   node scripts/stress-test.js
 *
 *   # Full pipeline runs via live server
 *   BUILDORBIT_URL=http://localhost:3000 node scripts/stress-test.js
 *
 *   # Full pipeline with auth token
 *   BUILDORBIT_URL=https://buildorbit.polsia.app AUTH_TOKEN=xxx node scripts/stress-test.js
 *
 * Phase 4 Observation (soft expansion):
 *   If soft-expansion.js has shipped, this harness logs when soft expansion
 *   WOULD have activated — without letting it influence decisions.
 *   Appended to the summary report as: "soft_expansion_would_trigger: X/10"
 *
 * Scope lock observation:
 *   Prompts that classify as full_product will show as SCOPE_LOCKED.
 *   These are the ones the gate correctly rejects during MVP.
 */

'use strict';

const path   = require('path');
const http   = require('http');
const https  = require('https');

// ── Load pipeline modules ─────────────────────────────────────────────────────
const { classify }          = require(path.join(__dirname, '..', 'agents', 'intent-gate'));
const { getScaffoldSchema } = require(path.join(__dirname, '..', 'lib', 'scaffold-schemas'));

// Phase 4 soft expansion — loaded with graceful fallback
let computeCandidates = null;
let COMMITMENT_THRESHOLD = 0.75;
let REJECTION_ENTROPY    = 0.9;
try {
  const softExpansion   = require(path.join(__dirname, '..', 'lib', 'soft-expansion'));
  computeCandidates     = softExpansion.computeCandidates;
  COMMITMENT_THRESHOLD  = softExpansion.COMMITMENT_THRESHOLD ?? 0.75;
  REJECTION_ENTROPY     = softExpansion.REJECTION_ENTROPY    ?? 0.9;
  console.log('[StressTest] Phase 4 (soft-expansion.js) loaded — entropy observation enabled');
} catch (e) {
  console.log('[StressTest] Phase 4 not available — skipping entropy observation');
}

// Phase 4.2 ISE — loaded with graceful fallback
let extractInteractionSurfaces = null;
try {
  extractInteractionSurfaces = require(path.join(__dirname, '..', 'lib', 'interaction-surface-extractor')).extractInteractionSurfaces;
  console.log('[StressTest] Phase 4.2 (interaction-surface-extractor.js) loaded — ISE validation enabled');
} catch (e) {
  console.log('[StressTest] Phase 4.2 not available — skipping ISE validation');
}

// ── Real-World Test Prompts ───────────────────────────────────────────────────
// These are intentionally messy — the kind users actually type.
const STRESS_PROMPTS = [
  'build me a page for my startup',
  'I need a landing page with email signup',
  'make a simple calculator app',
  'create a portfolio site',
  'build a waitlist for my AI tool',
  'I want a page that shows pricing',
  'make something that captures leads',
  'build a homepage for a SaaS product',
  'create a form where people can submit feedback',
  'build a product page with a buy button',
];

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL   = process.env.BUILDORBIT_URL || null;
const AUTH_TOKEN   = process.env.AUTH_TOKEN     || null;
const FULL_PIPELINE = Boolean(SERVER_URL);
const PIPELINE_TIMEOUT_MS = 120_000; // 2 min per run

// ── Utilities ─────────────────────────────────────────────────────────────────
function separator(char = '─', len = 72) {
  return char.repeat(len);
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(PIPELINE_TIMEOUT_MS, () => { req.destroy(new Error('Request timed out')); });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function triggerPipelineRun(prompt) {
  const headers = {
    'Content-Type': 'application/json',
    ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
  };

  const resp = await httpRequest(
    `${SERVER_URL}/api/pipeline`,
    { method: 'POST', headers },
    { prompt }
  );

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`Pipeline start failed: ${resp.status} — ${JSON.stringify(resp.body)}`);
  }

  const runId = resp.body?.run_id || resp.body?.id;
  if (!runId) throw new Error(`No run_id in response: ${JSON.stringify(resp.body)}`);
  return runId;
}

async function pollPipelineResult(runId, timeoutMs = PIPELINE_TIMEOUT_MS) {
  const headers = {
    ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
  };

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 3000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      const resp = await httpRequest(
        `${SERVER_URL}/api/pipeline/${runId}`,
        { method: 'GET', headers }
      );

      const run = resp.body?.run || resp.body;
      const status = run?.status || '';

      if (['completed', 'failed', 'rejected'].includes(status)) {
        return run;
      }
    } catch (pollErr) {
      // non-fatal — keep polling until deadline
    }
  }

  throw new Error(`Pipeline run ${runId} timed out after ${timeoutMs}ms`);
}

// ── Per-Prompt Analysis ───────────────────────────────────────────────────────
async function analyzePrompt(prompt, idx) {
  const result = {
    idx:                     idx + 1,
    prompt,
    intent_class:            null,
    complexity_budget:       null,
    schema_name:             null,
    constraint_contract:     null,
    scope_locked:            false,
    rejected_ambiguous:      false,
    // Phase 4 soft expansion observation
    phase4_entropy:          null,
    phase4_committed:        null,
    phase4_top_class:        null,
    phase4_top_prob:         null,
    soft_expansion_would_trigger: false,
    // Phase 4.1 decomposition telemetry (present on scope_locked and soft_expansion)
    decomposition_telemetry: null,
    // Phase 4.2 ISE — interaction surface extraction
    ise_surfaces:            null,   // string[] or null if ISE not run
    ise_transitions:         null,   // string[] or null if ISE not run
    ise_verbs:               null,   // string[] or null if ISE not run
    ise_passthrough:         null,   // true if ISE ran but found no surfaces
    // Full pipeline (if SERVER_URL set)
    pipeline_run_id:         null,
    pipeline_status:         null,
    pipeline_files_count:    null,
    pipeline_violations:     null,
    pipeline_verify_passed:  null,
    pipeline_output_url:     null,
    error:                   null,
  };

  // ── Intent Gate classification (no pool = Phase 2 disabled) ──────────────
  let contract;
  try {
    contract = await classify(prompt, null);
  } catch (classifyErr) {
    result.error = `classify() threw: ${classifyErr.message}`;
    return result;
  }

  result.intent_class        = contract.intent_class;
  result.complexity_budget   = contract.complexity_budget;
  result.scope_locked        = Boolean(contract._scope_locked);
  result.rejected_ambiguous  = Boolean(contract._rejected && !contract._scope_locked);
  result.constraint_contract = {
    frontend: contract.constraints?.frontend,
    server:   contract.constraints?.server,
    db:       contract.constraints?.db,
    auth:     contract.constraints?.auth,
    api:      contract.constraints?.api,
  };

  // Phase 4.1: Decomposition telemetry (attached by intent-gate on scope_locked + soft_expansion)
  if (contract._decomposition_telemetry) {
    result.decomposition_telemetry = contract._decomposition_telemetry;
  }

  // ── Phase 4.2: ISE — read from contract (attached by intent-gate on all paths) ──
  // ISE is always attached to the contract now. Read from contract._ise first.
  // Also run independently for cross-validation if ISE module is available.
  if (contract._ise) {
    result.ise_surfaces   = contract._ise.surfaces;
    result.ise_transitions = contract._ise.transitions;
    result.ise_verbs      = contract._ise.interaction_verbs;
    result.ise_passthrough = contract._ise.surfaces.length === 0;
  } else if (extractInteractionSurfaces) {
    // Fallback: run ISE directly if not in contract (older intent-gate version)
    try {
      const ise = extractInteractionSurfaces(prompt);
      result.ise_surfaces    = ise.surfaces;
      result.ise_transitions = ise.transitions;
      result.ise_verbs       = ise.interaction_verbs;
      result.ise_passthrough = ise.surfaces.length === 0;
    } catch (iseErr) {
      // non-fatal — skip ISE observation
    }
  }

  // Schema selection
  if (!result.scope_locked && !result.rejected_ambiguous) {
    const effectiveClass = contract.base_class || contract.intent_class;
    try {
      const schema = getScaffoldSchema(effectiveClass);
      result.schema_name = effectiveClass;
      result.schema_entry = schema.entry;
    } catch (schemaErr) {
      result.schema_name = effectiveClass;
    }
  }

  // Phase 4 metadata from contract (if computed)
  if (contract._candidates) {
    const top = contract._candidates[0];
    result.phase4_entropy    = contract._entropy    ?? null;
    result.phase4_committed  = contract._committed  ?? null;
    result.phase4_top_class  = top?.intent_class    ?? null;
    result.phase4_top_prob   = top?.probability     ?? null;
  }

  // ── Phase 4 Observation: would soft expansion have triggered? ─────────────
  // Compute independently (observation only — does NOT influence pipeline decision)
  if (computeCandidates) {
    try {
      const candidateResult = computeCandidates(prompt);
      const { entropy, committed, rejected, candidates } = candidateResult;
      const top = candidates[0];

      // Soft expansion triggers when: not rejected AND not committed
      const wouldTrigger = !rejected && !committed;
      result.soft_expansion_would_trigger = wouldTrigger;

      // Always capture phase4 data from direct computation if not already set
      if (result.phase4_entropy === null) {
        result.phase4_entropy   = entropy;
        result.phase4_committed = committed;
        result.phase4_top_class = top?.intent_class;
        result.phase4_top_prob  = top?.probability;
      }
    } catch (seErr) {
      // Non-fatal — just skip observation
    }
  }

  // ── Full pipeline run (if server available) ───────────────────────────────
  if (FULL_PIPELINE && !result.scope_locked && !result.rejected_ambiguous) {
    try {
      const runId = await triggerPipelineRun(prompt);
      result.pipeline_run_id = runId;

      const run = await pollPipelineResult(runId);
      result.pipeline_status = run?.status || 'unknown';

      // Extract artifacts metadata
      const verifyOutput = run?.stage_outputs?.verify || run?.outputs?.verify;
      const codeOutput   = run?.stage_outputs?.code   || run?.outputs?.code;

      if (codeOutput?.files) {
        result.pipeline_files_count = Object.keys(codeOutput.files).length;
      }

      const violations = verifyOutput?.violations || verifyOutput?.constraint_violations || [];
      result.pipeline_violations   = violations.length;
      result.pipeline_verify_passed = result.pipeline_violations === 0 &&
        result.pipeline_status === 'completed';

      result.pipeline_output_url = `${SERVER_URL}/pipeline/${runId}`;
    } catch (pipeErr) {
      result.error = `Full pipeline error: ${pipeErr.message}`;
    }
  }

  return result;
}

// ── Main Runner ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + separator('═'));
  console.log('  BuildOrbit — Real-Prompt Stress Test Harness');
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Mode: ${FULL_PIPELINE ? `Full pipeline → ${SERVER_URL}` : 'Classification + constraint analysis'}`);
  if (computeCandidates) {
    console.log(`  Phase 4: Soft expansion entropy observation ENABLED`);
    console.log(`    Commitment threshold: ${COMMITMENT_THRESHOLD} | Rejection entropy: ${REJECTION_ENTROPY}`);
  } else {
    console.log('  Phase 4: Not available — entropy observation SKIPPED');
  }
  console.log(separator('═') + '\n');

  const results = [];

  for (let i = 0; i < STRESS_PROMPTS.length; i++) {
    const prompt = STRESS_PROMPTS[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${STRESS_PROMPTS.length}] "${prompt}" ... `);

    const result = await analyzePrompt(prompt, i);
    results.push(result);

    // One-line status
    let statusTag;
    if (result.scope_locked)       statusTag = '🔒 SCOPE_LOCKED (full_product)';
    else if (result.rejected_ambiguous) statusTag = '❓ REJECTED (ambiguous)';
    else if (result.error)         statusTag = `❌ ERROR`;
    else                           statusTag = `✅ ${result.intent_class}`;

    console.log(statusTag);
  }

  // ── Per-Run Details ─────────────────────────────────────────────────────────
  console.log('\n' + separator());
  console.log('  Per-Run Details');
  console.log(separator());

  for (const r of results) {
    console.log(`\n[Run ${r.idx}] "${r.prompt}"`);

    if (r.scope_locked) {
      console.log('  Status:        SCOPE_LOCKED');
      console.log('  Reason:        full_product classification rejected during MVP validation');
      console.log('  Suggestion:    Try describing a simpler version — a landing page or lightweight app');

      if (r.decomposition_telemetry) {
        const dt = r.decomposition_telemetry;
        const candStr = dt.decomposition_candidates
          .map(c => `${c.class}(${c.confidence})`)
          .join(', ');
        const missingStr = dt.implied_missing_capabilities.join(', ') || 'none';
        console.log(`  Decomposition: candidates=[${candStr}]`);
        console.log(`  Missing caps:  [${missingStr}]`);
        console.log(`  Would have:    ${dt.what_system_would_have_done}`);
      }
    } else if (r.rejected_ambiguous) {
      console.log('  Status:        REJECTED (classification too ambiguous)');
      console.log(`  Entropy:       ${r.phase4_entropy?.toFixed(4) ?? 'n/a'}`);
    } else if (r.error) {
      console.log(`  Status:        ERROR — ${r.error}`);
    } else {
      console.log(`  Intent class:  ${r.intent_class}`);
      console.log(`  Budget:        ${r.complexity_budget}`);
      console.log(`  Schema:        ${r.schema_name ?? 'n/a'}`);

      if (r.constraint_contract) {
        const c = r.constraint_contract;
        console.log(`  Constraints:   frontend=${c.frontend} server=${c.server} db=${c.db} auth=${c.auth} api=${c.api}`);
      }

      if (r.phase4_entropy !== null) {
        const softLabel = r.soft_expansion_would_trigger ? 'YES (would activate)' : 'no';
        console.log(`  Phase 4:       entropy=${r.phase4_entropy.toFixed(4)} top=${r.phase4_top_class}(${(r.phase4_top_prob * 100).toFixed(1)}%) committed=${r.phase4_committed} soft_expansion=${softLabel}`);
      }

      // Phase 4.2: ISE surface extraction
      if (r.ise_surfaces !== null) {
        if (r.ise_passthrough) {
          console.log('  ISE (4.2):     passthrough (no interaction verbs detected)');
        } else {
          console.log(`  ISE (4.2):     surfaces=[${r.ise_surfaces.join(', ')}]`);
          if (r.ise_transitions && r.ise_transitions.length > 0) {
            console.log(`  ISE flow:      ${r.ise_transitions.join(' → ')}`);
          }
          if (r.ise_verbs && r.ise_verbs.length > 0) {
            console.log(`  ISE verbs:     ${r.ise_verbs.join(', ')}`);
          }
        }
      }

      // Phase 4.1: Decomposition telemetry (only on soft_expansion outcomes)
      if (r.decomposition_telemetry && r.intent_class === 'soft_expansion') {
        const dt = r.decomposition_telemetry;
        const candStr = dt.decomposition_candidates
          .map(c => `${c.class}(${c.confidence})`)
          .join(', ');
        const missingStr = dt.implied_missing_capabilities.join(', ') || 'none';
        console.log(`  Decomposition: candidates=[${candStr}]`);
        console.log(`  Missing caps:  [${missingStr}]`);
        console.log(`  Would have:    ${dt.what_system_would_have_done}`);
      }

      if (FULL_PIPELINE) {
        if (r.pipeline_run_id) {
          const violationStr = r.pipeline_violations === null ? 'n/a' : `${r.pipeline_violations} violation(s)`;
          console.log(`  Pipeline:      ${r.pipeline_status} | files=${r.pipeline_files_count ?? 'n/a'} | violations=${violationStr} | verify=${r.pipeline_verify_passed ? 'PASS' : 'FAIL'}`);
          console.log(`  Preview:       ${r.pipeline_output_url}`);
        } else {
          console.log(`  Pipeline:      not run${r.error ? ` — ${r.error}` : ''}`);
        }
      }
    }
  }

  // ── Summary Report ──────────────────────────────────────────────────────────
  console.log('\n' + separator('═'));
  console.log('  SUMMARY REPORT');
  console.log(separator('═') + '\n');

  const totalRuns = results.length;
  const scopeLocked     = results.filter(r => r.scope_locked);
  const ambiguous       = results.filter(r => r.rejected_ambiguous);
  const staticSurface   = results.filter(r => r.intent_class === 'static_surface' && !r.scope_locked);
  const lightApp        = results.filter(r => r.intent_class === 'light_app'       && !r.scope_locked);
  const softExpansion   = results.filter(r => r.intent_class === 'soft_expansion'  && !r.scope_locked);
  const errored         = results.filter(r => r.error && !r.scope_locked && !r.rejected_ambiguous);

  console.log(`Total runs: ${totalRuns}`);
  console.log('');

  // Classification distribution
  if (staticSurface.length > 0) {
    const clean = FULL_PIPELINE
      ? staticSurface.filter(r => r.pipeline_verify_passed).length
      : staticSurface.length; // assume clean without full pipeline
    const violations = FULL_PIPELINE
      ? staticSurface.filter(r => r.pipeline_violations > 0).length
      : '?';
    const cleanLabel = FULL_PIPELINE ? `${clean} clean, ${violations} violation(s)` : `${clean} classified`;
    console.log(`static_surface:         ${staticSurface.length} (${cleanLabel})`);
  }

  if (lightApp.length > 0) {
    const clean = FULL_PIPELINE
      ? lightApp.filter(r => r.pipeline_verify_passed).length
      : lightApp.length;
    const violations = FULL_PIPELINE
      ? lightApp.filter(r => r.pipeline_violations > 0).length
      : '?';
    const cleanLabel = FULL_PIPELINE ? `${clean} clean, ${violations} violation(s)` : `${clean} classified`;
    console.log(`light_app:              ${lightApp.length} (${cleanLabel})`);
  }

  if (softExpansion.length > 0) {
    console.log(`soft_expansion:         ${softExpansion.length} (Phase 4 ambiguous contracts)`);
  }

  if (scopeLocked.length > 0) {
    console.log(`rejected (full_product  scope locked): ${scopeLocked.length}`);
  }

  if (ambiguous.length > 0) {
    console.log(`rejected (ambiguous):   ${ambiguous.length}`);
  }

  if (errored.length > 0) {
    console.log(`errored:                ${errored.length}`);
  }

  console.log('');

  // Over-scoping rate
  const proceeded = totalRuns - scopeLocked.length - ambiguous.length;
  const overScopingRate = proceeded > 0
    ? `${(scopeLocked.length / totalRuns * 100).toFixed(0)}%`
    : '0%';
  console.log(`Over-scoping rate (scope-locked):  ${overScopingRate} (${scopeLocked.length}/${totalRuns})`);

  // Full pipeline stats
  if (FULL_PIPELINE) {
    const ran            = results.filter(r => r.pipeline_run_id);
    const passed         = results.filter(r => r.pipeline_verify_passed);
    const totalFiles     = results.reduce((s, r) => s + (r.pipeline_files_count || 0), 0);
    const avgFiles       = ran.length > 0 ? (totalFiles / ran.length).toFixed(1) : 'n/a';
    const totalViolations = results.reduce((s, r) => s + (r.pipeline_violations || 0), 0);

    console.log('');
    console.log(`Full pipeline runs:    ${ran.length}/${proceeded}`);
    console.log(`VERIFY passed:         ${passed.length}/${ran.length}`);
    console.log(`Average files:         ${avgFiles}`);
    console.log(`Total violations:      ${totalViolations}`);
  } else {
    console.log('');
    console.log('(Full pipeline stats: set BUILDORBIT_URL to enable)');
  }

  // Phase 4 soft expansion observation
  if (computeCandidates) {
    const wouldTrigger = results.filter(r => r.soft_expansion_would_trigger).length;
    console.log('');
    console.log(`Phase 4 — soft_expansion_would_trigger: ${wouldTrigger}/${totalRuns} runs`);
    if (wouldTrigger > 0) {
      const names = results
        .filter(r => r.soft_expansion_would_trigger)
        .map(r => `  [${r.idx}] "${r.prompt}" (entropy=${r.phase4_entropy?.toFixed(4)})`)
        .join('\n');
      console.log(names);
    }
  }

  // Phase 4.1 Decomposition Telemetry summary
  const withDecomp = results.filter(r => r.decomposition_telemetry);
  if (withDecomp.length > 0) {
    console.log('');
    console.log(`Phase 4.1 — DECOMPOSITION_TELEMETRY fired: ${withDecomp.length}/${totalRuns} runs`);
    console.log(`  Breakdown: scope_locked=${withDecomp.filter(r => r.scope_locked).length}, soft_expansion=${withDecomp.filter(r => r.intent_class === 'soft_expansion').length}`);
    // Show implied_missing_capabilities distribution
    const capFreq = {};
    for (const r of withDecomp) {
      for (const cap of (r.decomposition_telemetry.implied_missing_capabilities || [])) {
        capFreq[cap] = (capFreq[cap] || 0) + 1;
      }
    }
    if (Object.keys(capFreq).length > 0) {
      const capStr = Object.entries(capFreq)
        .sort((a, b) => b[1] - a[1])
        .map(([cap, count]) => `${cap}(${count})`)
        .join(', ');
      console.log(`  Implied missing capabilities: ${capStr}`);
    }
  }

  // Phase 4.2 ISE summary
  const iseRuns = results.filter(r => r.ise_surfaces !== null);
  if (iseRuns.length > 0) {
    const iseActive     = iseRuns.filter(r => !r.ise_passthrough);
    const isePassthrough = iseRuns.filter(r => r.ise_passthrough);

    console.log('');
    console.log(`Phase 4.2 — ISE surface extraction: ${iseRuns.length}/${totalRuns} runs`);
    console.log(`  With surfaces:  ${iseActive.length} runs`);
    console.log(`  Passthrough:    ${isePassthrough.length} runs (no interaction verbs)`);

    // Surface frequency across all runs
    const surfaceFreq = {};
    for (const r of iseActive) {
      for (const s of (r.ise_surfaces || [])) {
        surfaceFreq[s] = (surfaceFreq[s] || 0) + 1;
      }
    }
    if (Object.keys(surfaceFreq).length > 0) {
      const surfStr = Object.entries(surfaceFreq)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s}(${n})`)
        .join(', ');
      console.log(`  Surface distribution: ${surfStr}`);
    }

    // Passthrough verification — prompts with NO interaction verbs should produce empty ISE output.
    // Note: a prompt can be classified static_surface but still have interaction verbs
    // (e.g. "landing page with email signup" → static_surface + email_capture ISE surface).
    // That is CORRECT ISE behavior. We only flag prompts where ISE verbs = [] but surfaces ≠ [].
    const badPassthrough = iseRuns.filter(r =>
      Array.isArray(r.ise_verbs) && r.ise_verbs.length === 0 &&
      Array.isArray(r.ise_surfaces) && r.ise_surfaces.length > 0
    );
    if (badPassthrough.length > 0) {
      console.log(`  ⚠️  Bad passthrough (verbs=[] but surfaces non-empty): ${badPassthrough.length} run(s)`);
      for (const r of badPassthrough) {
        console.log(`    [${r.idx}] "${r.prompt}" → surfaces=[${(r.ise_surfaces || []).join(', ')}]`);
      }
    } else {
      console.log('  Passthrough invariant: ✅ (no prompts with verbs=[] but surfaces≠[])');
    }
  } else if (extractInteractionSurfaces) {
    console.log('');
    console.log('Phase 4.2 — ISE: module loaded but classify() did not attach _ise to contracts');
    console.log('  (Re-run after intent-gate.js ISE integration is applied)');
  }

  // Classification accuracy estimate (manual annotation)
  console.log('');
  console.log('Classification accuracy: see per-run details above');
  console.log('  (Automated accuracy requires ground-truth labels — evaluate manually)');

  console.log('\n' + separator('═'));
  console.log('  Stress test complete.');
  console.log(separator('═') + '\n');

  // Exit with error code if any errors occurred
  if (errored.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[StressTest] Fatal error:', err);
  process.exit(1);
});
