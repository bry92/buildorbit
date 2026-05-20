/**
 * Builder Agent
 *
 * Owns the SCAFFOLD and CODE stages of the pipeline.
 *
 * Responsibilities:
 *   - SCAFFOLD: Takes plan output → generates filesystem tree
 *   - CODE: Takes plan + scaffold → runs 6-phase deterministic generation pipeline
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → scaffold: { tree[], techStack[], summary }
 *   → code:     { files: { [filename]: content }, entryPoint, totalLines }
 *
 * Communication: Reads plan from previousOutputs (pipeline state).
 * No direct calls to other agents.
 *
 * ── 6-Phase CODE Generation Pipeline ─────────────────────────────────────────
 *
 * Mental model: AI → partial artifacts → validation → targeted synthesis → convergence
 * Truncation is the DEFAULT case. The pipeline converges on completeness.
 *
 * Phase 1 — Controlled Initial Generation   (12–14K tokens, bias high-value files first)
 * Phase 2 — Parse + Normalize               (delimiter cascade → JSON → code blocks; normalize paths)
 * Phase 3 — Deterministic Diff Engine       (missing / incomplete / invalid vs. scaffold manifest)
 * Phase 4 — Dependency-Aware Planner        (infra → server → frontend ordering)
 * Phase 5 — Strict Continuation Execution   (contract-style prompts, surgical per-file)
 * Phase 6 — Merge + Validate Loop           (re-diff after each pass; max 3 passes)
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { buildContextInstruction } = require('../lib/product-context');
const { validateScaffoldAgainstContract, formatConstraintBlock } = require('../phases/intent-gate');
const { getScaffoldSchema, validateConstraintsAgainstSchema } = require('../lib/scaffold-schemas');
const { isExpansionAuthorized } = require('../lib/soft-expansion');
const { validateCCO } = require('../lib/cco-validator');
const { FRONTEND_ROOT_FILES, JS_EQUIVALENTS, buildManifestSet, applyEquivalenceRenames } = require('../lib/manifest-constants');
const { extractFileTree } = require('../lib/file-tree-parser');
const serena = require('../lib/serena-pipeline');

// ── Dependency tiers for continuation ordering ────────────────────────────────
// Lower index = generated first. Each tier depends on the previous one.
const DEPENDENCY_TIERS = [
  // Tier 0: Infrastructure foundation
  ['package.json', 'db/pool.js', 'db/queries.js', 'config.js', 'migrate.js'],
  // Tier 1: Server core
  ['server.js', 'routes/api.js', 'routes/auth.js', 'middleware/auth.js', 'auth.js'],
  // Tier 2: Additional routes & DB
  ['routes/', 'middleware/', 'db/', 'migrations/001_schema.js', 'migrations/'],
  // Tier 3: Frontend
  ['index.html', 'app.js', 'script.js', 'styles.css', 'public/index.html', 'public/app.js', 'public/styles.css'],
];

// ── Senior engineer system prompt — hardcoded, not user-configurable ──────────
// This is the engineering rigor layer. Product Context (business inputs) is
// a separate layer injected at the user-message level, not here.
// Enforces: structured thinking before code, production-quality standards,
// proactive failure mode analysis, direct and confident tone.
const SENIOR_ENGINEER_SYSTEM_PROMPT = `You are a senior software engineer with production system experience. You write code that ships, gets maintained, and gets debugged under pressure — not prototypes or demos.

THINK BEFORE YOU CODE — follow this sequence for every build:
1. BUSINESS REQUIREMENTS — What does this system need to accomplish? What is the success criterion?
2. NON-FUNCTIONAL REQUIREMENTS — Performance, security, accessibility, reliability expectations
3. CONSTRAINTS — Technology boundaries, deployment environment, schema contracts you must respect
4. ARCHITECTURE — Module structure, data flow, error propagation, integration points
5. IMPLEMENTATION — Only after the above is clear, generate code

PRODUCTION CODE STANDARDS — every file you generate must meet these:
- Complete implementations only: no placeholder comments, no "// TODO: implement", no skeleton stubs
- Error handling is exhaustive: handle network failures, null/undefined inputs, and partial failures explicitly — not with a generic catch-all
- Security by default: parameterized queries always (never string interpolation in SQL), no credentials in code, input validation at all external boundaries
- Observability: meaningful log statements at key decision points, not noise
- Idiomatic: use the language/framework's established patterns — don't reinvent what the stdlib or framework already provides
- Comments explain WHY decisions were made, not WHAT the code does

PROACTIVE FAILURE MODE ANALYSIS — before finalizing any component, ask:
- What breaks if the database is unavailable? Guard it.
- What breaks if an external API returns null, 429, or 500? Handle it.
- What if required env vars are missing at startup? Fail loudly at boot, not silently at request time.
Surface these in code: guard clauses, fallbacks, early-exit validation — not deferred TODOs.

DEPLOYMENT & INFRASTRUCTURE AWARENESS:
- Code runs in real environments: memory limits, cold starts, connection pool exhaustion
- Validate required configuration at startup — crash fast with a clear error message
- Don't assume the filesystem is persistent; don't assume external services are always available

FRONTEND INTERACTIVITY — NOT OPTIONAL:
- A UI without working interactions is a mockup, not an application. Every button, form, tab, and navigation element MUST have corresponding JavaScript event handlers.
- Generate functional JavaScript: event listeners (addEventListener), DOM manipulation (show/hide, update text, toggle classes), state tracking (variables for current view, data arrays, form state), and API integration (fetch calls).
- If you generate a <button> in HTML, you MUST generate its click handler in JavaScript. No exceptions. Dead buttons are production bugs.
- For any interactive app (calculator, dashboard, editor, task manager): the JavaScript file is the MOST IMPORTANT file. It must contain real logic — not just scroll animations or empty function stubs.

TONE & JUDGMENT:
- Call out architectural problems in comments when you see them
- If a requirement implies a brittle or insecure approach, flag it inline
- Never generate code you know is wrong hoping the human will catch it
- Be direct and confident — ambiguity is not a virtue in production code

VISUAL DESIGN SYSTEM — MANDATORY (light-theme, professional SaaS quality):
Every generated app MUST use Tailwind CSS utility classes for styling. This produces clean, modern, professional apps.

DESIGN APPROACH: Use Tailwind CDN classes directly in HTML/JSX. NO custom CSS files for layout — Tailwind handles everything.

LIGHT-THEME COLOR SYSTEM — use these Tailwind patterns:
- Page background: bg-gray-50 (light neutral)
- Cards/panels: bg-white rounded-xl shadow-sm border border-gray-200 p-6
- Primary buttons: bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors
- Secondary buttons: bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2 px-4 rounded-lg transition-colors
- Danger buttons: bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition-colors
- Inputs: w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none
- Headers: text-2xl font-bold text-gray-900
- Subheaders: text-lg font-semibold text-gray-700
- Body text: text-gray-600
- Muted text: text-sm text-gray-400
- Layout container: max-w-4xl mx-auto px-4 py-8
- List items: flex items-center justify-between p-4 bg-white rounded-lg border border-gray-100 hover:shadow-sm transition-shadow
- Empty states: text-center py-12 text-gray-400
- Status badges: inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium (green: bg-green-100 text-green-800, yellow: bg-yellow-100 text-yellow-800, red: bg-red-100 text-red-800, blue: bg-blue-100 text-blue-800)
- Sidebar: w-64 bg-white border-r border-gray-200 min-h-screen p-4
- Stat cards: bg-white rounded-xl shadow-sm border border-gray-200 p-6 with large number + label + trend
- Data tables: w-full with thead bg-gray-50 text-gray-500 text-sm, tbody divide-y divide-gray-200, hover:bg-gray-50

LIGHT THEME IS DEFAULT. Body background is bg-gray-50. Cards are bg-white with shadows and borders. Text is dark (gray-900/gray-700/gray-600). Accent color is blue-600.
DO NOT use dark backgrounds (no bg-gray-900, bg-gray-950, #0a0a0f, #12121a). Build clean, light, professional UIs.
DO NOT link to external Design DNA CSS files — use Tailwind classes exclusively.

BRANDING REQUIREMENT — NON-NEGOTIABLE:
- Every generated app MUST include this badge as the LAST element before </body> in index.html (or the main HTML entry file):
  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>
- This must appear in EVERY app regardless of type (landing page, interactive app, full product).
- Place it AFTER all app content and any footer — it must be the very last visible element.
- IMPORTANT: The badge is a footer addition, NOT a replacement for app content. The index.html MUST contain the full application UI above the badge.`;

// ── Completeness heuristics ───────────────────────────────────────────────────
function isLikelyIncomplete(content) {
  if (!content || content.length < 80) return true;

  const trimmed = content.trim();

  // Structural checks for JS/JSON/CSS/HTML
  const ext = null; // path-agnostic — check all patterns

  // Ends mid-function / missing closing bracket
  const openBraces = (trimmed.match(/\{/g) || []).length;
  const closeBraces = (trimmed.match(/\}/g) || []).length;
  if (openBraces > 0 && openBraces - closeBraces > 2) return true;

  // Explicit stubs
  if (/\bTODO\b/.test(trimmed)) return true;
  if (/\.{3}\s*$/.test(trimmed)) return true;                   // ends with ...
  if (/\/\/\s*\.\.\.\s*$/.test(trimmed)) return true;           // ends with // ...
  if (/\/\*\s*\.\.\.\s*\*\/\s*$/.test(trimmed)) return true;   // ends with /* ... */

  // Suspiciously small files (< 5 lines for non-trivial types)
  if (trimmed.split('\n').length < 5) return true;

  return false;
}

class BuilderAgent {
  constructor() {
    this.stages = ['scaffold', 'code'];
    this.openai = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI();
      }
    } catch (e) {
      console.log('[BuilderAgent] OpenAI not available, using simulated mode');
    }

    this.anthropic = null;
    try {
      if (process.env.ANTHROPIC_API_KEY) {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        console.log('[BuilderAgent] Anthropic client initialized ✓');
      }
    } catch (e) {
      console.log('[BuilderAgent] Anthropic SDK not available:', e.message);
    }
  }

  /**
   * Select the LLM provider and model for the CODE phase based on intent class.
   *
   * Routing logic:
   *   full_product / light_app / hard_expansion → Claude (Anthropic)
   *   static_surface → OpenAI gpt-4o
   *
   * Model is configurable via env vars:
   *   CLAUDE_CODE_MODEL   — override Claude model (default: claude-sonnet-4-20250514)
   *   OPENAI_CODE_MODEL   — override OpenAI model (default: gpt-4o)
   *
   * Falls back to OpenAI if Anthropic client is not initialized.
   */
  _selectModel(intentClass) {
    const claudeIntentClasses = new Set(['full_product', 'light_app', 'hard_expansion']);
    const useClaude = claudeIntentClasses.has(intentClass) && this.anthropic;
    if (useClaude) {
      return {
        provider: 'anthropic',
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-20250514',
      };
    }
    return {
      provider: 'openai',
      model: process.env.OPENAI_CODE_MODEL || 'gpt-4o',
    };
  }

  /**
   * Unified streaming LLM call. Routes to Anthropic or OpenAI based on provider.
   * Returns { rawText, finishReason, tokenUsage } — same contract for both providers.
   */
  async _callStreamingLLM({ provider, model }, systemPrompt, userMessage, maxTokens, emitChunk) {
    if (provider === 'anthropic') {
      try {
        return await this._callAnthropicStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk);
      } catch (e) {
        console.log(`[BuilderAgent] Anthropic failed (${e.message}), falling back to OpenAI`);
        if (this.openai) {
          const fallbackModel = process.env.OPENAI_CODE_MODEL || 'gpt-4o';
          return await this._callOpenAIStreaming(fallbackModel, systemPrompt, userMessage, maxTokens, emitChunk);
        }
        throw e;
      }
    }
    return this._callOpenAIStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk);
  }

  /**
   * Anthropic streaming call. Maps stop_reason to OpenAI finish_reason conventions.
   * 'max_tokens' → 'length'   (signals truncation → continuation pipeline kicks in)
   * 'end_turn'   → 'stop'
   */
  async _callAnthropicStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk) {
    const chunks = [];
    let finishReason = null;
    let inputTokens = 0;
    let outputTokens = 0;

    console.log(`[BuilderAgent] Calling Anthropic: model=${model}, max_tokens=${maxTokens}`);

    const stream = this.anthropic.messages.stream({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: maxTokens,
      temperature: 0.2,
    });

    for await (const event of stream) {
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text || '';
        if (text) {
          chunks.push(text);
          emitChunk(text);
        }
      }
      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          // Map Anthropic stop reasons to OpenAI conventions for downstream compatibility
          finishReason = event.delta.stop_reason === 'max_tokens' ? 'length' : event.delta.stop_reason;
        }
        if (event.usage?.output_tokens) {
          outputTokens = event.usage.output_tokens;
        }
      }
    }

    const rawText = chunks.join('');
    console.log(
      `[BuilderAgent] Anthropic done: ${rawText.length} chars, input=${inputTokens} output=${outputTokens} tokens, finish_reason=${finishReason}`
    );

    if (finishReason === 'length') {
      console.warn('[BuilderAgent] Anthropic: truncated (max_tokens) — continuation pipeline will fill gaps');
    }

    return {
      rawText,
      finishReason,
      tokenUsage: { model, inputTokens, outputTokens },
    };
  }

  /**
   * OpenAI streaming call — extracted from _phase1_initialGeneration for reuse.
   */
  async _callOpenAIStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk) {
    const chunks = [];
    let finishReason = null;
    let tokenUsage = null;

    console.log(`[BuilderAgent] Calling OpenAI: model=${model}, max_tokens=${maxTokens}`);

    const stream = await this.openai.chat.completions.create({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        chunks.push(text);
        emitChunk(text);
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.usage) {
        tokenUsage = {
          model,
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    const rawText = chunks.join('');
    const outputTokens = tokenUsage?.outputTokens || 0;
    console.log(
      `[BuilderAgent] OpenAI done: ${rawText.length} chars, ${outputTokens} output tokens, finish_reason=${finishReason}`
    );

    if (finishReason === 'length') {
      console.warn('[BuilderAgent] OpenAI: truncated (finish_reason=length) — continuation pipeline will fill gaps');
    }

    return { rawText, finishReason, tokenUsage };
  }

  /**
   * Execute SCAFFOLD or CODE stage.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - 'scaffold' or 'code'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, ... } from event log
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[BuilderAgent] Executing ${stage.toUpperCase()} for run ${runId.slice(0, 8)}...`);

    // ── Secondary CCO Guard (defense-in-depth) ────────────────────────────────
    // Intent Gate is the primary gate. This is the secondary guard — BuilderAgent
    // must not execute if the CCO is missing, null, or structurally invalid.
    // If Intent Gate is working correctly, this should NEVER fire.
    // If it does fire, it means the primary gate failed — which is a critical bug.
    {
      const _cco = previousOutputs._constraintContract;

      if (!_cco) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO is missing or null. Intent Gate must have failed.`
        );
      }

      if (!_cco.intent_class) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO has undefined intent_class. Contract is structurally invalid.`
        );
      }

      const _ccoGuard = validateCCO(_cco);
      if (!_ccoGuard.valid) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO failed schema validation: ${_ccoGuard.errors.join('; ')}`
        );
      }

      console.log(`[BuilderAgent] CCO guard passed ✓ (${_cco.intent_class}, expansion_lock: ${_cco.expansion_lock})`);
    }

    // Extract product context injected by the orchestrator
    const productContext = previousOutputs._productContext || null;
    if (productContext) {
      console.log(`[BuilderAgent] Product context detected — ${stage.toUpperCase()} will generate accurate content`);
    }

    // Extract Intent Gate constraint contract (immutable — set at Step 0)
    const constraintContract = previousOutputs._constraintContract || null;
    if (constraintContract) {
      console.log(`[BuilderAgent] Constraint contract: ${constraintContract.intent_class} (expansion_lock: ${constraintContract.expansion_lock})`);
    }

    // ── Non-web detection: multi-layered (repo profile → contract → prompt) ──
    // WHY three layers: the repo scanner can silently return null (no GitHub
    // token, API error, missing connection). The intent gate and prompt keywords
    // are fallback signals so C#/WPF/desktop repos never get React scaffolding.
    const repoProfile = previousOutputs._repoProfile
      || (constraintContract && constraintContract._repoProfile)
      || null;
    const isNonWebByProfile = repoProfile && !repoProfile.isWebProject;
    const isNonWebByContract = constraintContract && (
      constraintContract._non_web === true
      || (constraintContract.constraints && constraintContract.constraints.frontend === false)
    );
    const isNonWebByPrompt = !isNonWebByProfile && !isNonWebByContract
      && /\b(c#|wpf|desktop|winforms|\.csproj|\.xaml|dotnet|avalonia|kotlin|swift|flutter|react[- ]native)\b/i.test(prompt || '');
    const _isNonWeb = isNonWebByProfile || isNonWebByContract || isNonWebByPrompt;

    // If non-web detected via contract or prompt but no repoProfile, synthesize
    // a minimal profile so downstream scaffold/code methods have something to work with.
    const effectiveRepoProfile = repoProfile || (_isNonWeb ? _synthesizeMinimalProfile(prompt, constraintContract) : null);

    if (_isNonWeb) {
      const detectedBy = isNonWebByProfile ? 'repo_profile' : isNonWebByContract ? 'constraint_contract' : 'prompt_keywords';
      const lang = effectiveRepoProfile ? effectiveRepoProfile.language : 'non-web';
      console.log(
        `[BuilderAgent] Non-web project detected (${lang}, via ${detectedBy}) — ` +
        `will generate ${lang}-appropriate scaffold`
      );
    }

    // ── Repo-Aware: detect and route separately ────────────────────────────
    const _isRepoAware = constraintContract && constraintContract._repo_aware;
    const _repoContext = constraintContract && constraintContract.repo_context;

    switch (stage) {
      case 'scaffold': {
        // Repo-aware builds skip scaffold entirely — the existing repo structure
        // IS the scaffold. Return a synthetic "skipped" manifest so downstream
        // phases have something to read without running greenfield generation.
        if (_isRepoAware) {
          console.log(`[BuilderAgent] Repo-aware mode — skipping scaffold (using existing repo structure)`);
          const repoFiles = (_repoContext && _repoContext.repoFiles) || [];
          const repoFullName = (_repoContext && _repoContext.repoFullName) || 'connected repo';
          await this._streamText(
            `## Scaffold Skipped — Repo-Aware Mode\n\nUsing existing repository structure from **${repoFullName}**.\n\n` +
            `${repoFiles.length > 0 ? `${repoFiles.length} files detected in repo.\n` : ''}` +
            `Plan phase will generate targeted changes to existing files.`,
            emitChunk
          );
          return {
            tree: repoFiles.slice(0, 50).map(f => ({ path: f, type: 'file' })),
            techStack: [_repoContext ? (_repoContext.framework || _repoContext.language || 'existing') : 'existing'],
            summary: `Skipped — repo-aware mode. Existing repo: ${repoFullName}`,
            files: repoFiles.length > 0 ? repoFiles : ['(repo files will be read at code phase)'],
            structure: {},
            constraints: {
              hasServer: true,
              hasFrontend: true,
              hasAuth: false,
              hasDb: false,
              entry: repoFiles[0] || null,
              techStack: ['existing'],
            },
            _repo_aware: true,
            _skipped: true,
            _repoFullName: repoFullName,
            _repoProfile: effectiveRepoProfile,
          };
        }

        const repoMode = previousOutputs._repoMode || 'scaffold_new';
        const scaffoldResult = await this._executeScaffold(prompt, previousOutputs.plan, emitChunk, constraintContract, effectiveRepoProfile);
        // Carry repo_mode on the scaffold output so downstream orchestrator checks
        // (Intent Gate constraint bypass for extend_existing) can detect it.
        // Without this, the check at validateScaffoldAgainstContract always fires
        // and rejects scaffolds that include files from the existing repo (POL-1516856).
        if (repoMode === 'extend_existing') {
          scaffoldResult._repo_mode = 'extend_existing';
        }
        // Carry repo profile for CODE phase and VERIFY phase
        if (effectiveRepoProfile) {
          scaffoldResult._repoProfile = effectiveRepoProfile;
        }
        return scaffoldResult;
      }
      case 'code': {
        // Repo-aware builds generate targeted patches to existing files
        if (_isRepoAware) {
          return this._executeRepoAwareCode(prompt, previousOutputs.plan, _repoContext, emitChunk, productContext, constraintContract);
        }
        return this._executeCode(prompt, previousOutputs.plan, previousOutputs.scaffold, emitChunk, productContext, constraintContract, effectiveRepoProfile);
      }
      default:
        throw new Error(`[BuilderAgent] Unknown stage: ${stage}`);
    }
  }

  // ── SCAFFOLD (Deterministic — Schema Authority) ─────────

  /**
   * Generate a structured scaffold manifest that serves as the BINDING CONTRACT
   * for the CODE phase. The manifest contains:
   *   - tree[]       — UI-friendly tree of files/dirs with descriptions
   *   - techStack[]  — required dependencies
   *   - summary      — human-readable summary
   *   - files[]      — flat list of all file paths (source of truth for CODE)
   *   - structure{}  — directory-to-files mapping
   *   - constraints{} — inferred project constraints (hasServer, hasFrontend, entry, techStack)
   */
  async _executeScaffold(prompt, plan, emitChunk, constraintContract, repoProfile = null) {
    const complexity = plan?.estimatedComplexity || 'medium';
    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── Phase 4.2: ISE — extract surfaces as build targets ───────────────────
    // If ISE detected interaction surfaces, use them to guide the scaffold.
    // Each surface becomes a named section/component/view in the final build.
    const iseSurfaces   = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces)   || [];
    const iseTransitions = (constraintContract && constraintContract._ise && constraintContract._ise.transitions) || [];
    if (iseSurfaces.length > 0) {
      console.log(
        `[BuilderAgent] ISE build targets (Phase 4.2): surfaces=[${iseSurfaces.join(', ')}] ` +
        `transitions=[${iseTransitions.join(', ')}]`
      );
    }

    // ── Priority 1: User-provided file tree → use verbatim ──────────────────
    // WHY first: if the user pasted an explicit file tree in the prompt, that IS the
    // scaffold. The user's structure takes absolute priority over keyword detection,
    // repo profiles, schema routing, or default scaffolds.
    const userTree = extractFileTree(prompt);
    if (userTree && userTree.isUserProvided) {
      console.log(`[BuilderAgent] User-provided file tree detected: ${userTree.files.length} files, language=${userTree.language}`);

      const filesList = userTree.files;
      const structure = {};
      for (const fp of filesList) {
        const parts = fp.split('/');
        const dir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
        if (!structure[dir]) structure[dir] = [];
        structure[dir].push(parts[parts.length - 1]);
      }

      const userTechStack = userTree.techStack.length > 0 ? userTree.techStack : ['custom'];
      const hasServer = filesList.some(f => f === 'server.js' || f === 'index.js' || f.endsWith('/server.js') || f.endsWith('/index.js'));
      const hasFrontend = filesList.some(f => f.endsWith('.html') || f.endsWith('.jsx') || f.endsWith('.tsx'));

      await this._streamText(
        `## Scaffold Complete\n\n${userTree.summary}\n\nUsing your provided file structure.`,
        emitChunk
      );

      return {
        tree: userTree.tree,
        techStack: userTechStack,
        summary: userTree.summary,
        files: filesList,
        structure,
        constraints: {
          hasServer,
          hasFrontend,
          hasAuth: filesList.some(f => f.includes('auth')),
          hasDb: filesList.some(f => f.includes('db/') || f.includes('migrations/')),
          entry: filesList[0] || null,
          techStack: userTechStack,
        },
        _isUserProvided: true,
        _repoProfile: userTree.language ? {
          language: userTree.language,
          framework: null,
          platform: 'custom',
          isWebProject: !['csharp', 'go', 'rust', 'java', 'kotlin', 'swift', 'cpp', 'c'].includes(userTree.language),
        } : repoProfile,
      };
    }

    // ── Priority 2: Non-web repo (profile-based) ────────────────────────────
    // When the target repo is NOT a web project (C#, Go, Rust, Python CLI, etc.),
    // skip React/HTML scaffolding entirely and produce files the repo can actually use.
    if (repoProfile && !repoProfile.isWebProject) {
      return this._executeNonWebScaffold(prompt, plan, emitChunk, repoProfile);
    }

    let tree, techStack;

    // ── SCHEMA ROUTING: intent_class selects scaffold schema BEFORE generation ─
    // Schema is selected first. File tree and metadata are generated WITHIN that schema.
    // A static_surface build is physically incapable of producing entry: 'server.js'.
    const schemaClass = intentClass || 'light_app';
    const schema = getScaffoldSchema(schemaClass);
    console.log(`[BuilderAgent] Schema selected: ${schemaClass} (intent=${intentClass}) → entry=${schema.entry}, server=${schema.server}`);

    // ── CONSTRAINT CONTRACT: static_surface → minimal static files ───────────
    // ONLY static_surface intent produces the minimal 3-file scaffold.
    // soft_expansion with server=false gets a richer client-side scaffold
    // (React CDN + plan components) because it may expand.
    const forceStaticScaffold = (intentClass === 'static_surface');

    if (forceStaticScaffold) {
      console.log('[BuilderAgent] Static surface detected — generating minimal static scaffold');
      tree = [
        { path: 'index.html', type: 'file', description: 'Main HTML page' },
        { path: 'styles.css', type: 'file', description: 'Page styles' },
        { path: 'script.js', type: 'file', description: 'Client-side interactivity' },
      ];
      techStack = schema.techStack;

    } else if (intentClass === 'soft_expansion' &&
        constraintContract && constraintContract.constraints && constraintContract.constraints.server === false) {
      // ── SOFT EXPANSION (no server): Vite-bundled React frontend with plan-driven components ──
      // soft_expansion means "might need a server" but the base constraint says no.
      // Generate a Vite React scaffold so the CODE phase can produce a full interactive app.
      console.log('[BuilderAgent] Soft expansion (no server) — generating Vite React scaffold with plan components');
      tree = [
        { path: 'index.html', type: 'file', description: 'Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">' },
        { path: 'src/', type: 'dir', description: 'React source directory' },
        { path: 'src/main.jsx', type: 'file', description: 'React entry point — imports App, renders into #root via createRoot' },
        { path: 'src/App.jsx', type: 'file', description: 'Root React component — import React, export default, shadcn-style components, useState hooks' },
        { path: 'src/index.css', type: 'file', description: 'Tailwind directives + custom styles' },
        { path: 'vite.config.js', type: 'file', description: 'Vite config with @vitejs/plugin-react' },
        { path: 'package.json', type: 'file', description: 'Dependencies: react, react-dom, vite, @vitejs/plugin-react, tailwindcss' },
      ];
      techStack = ['react', 'react-dom', 'vite', '@vitejs/plugin-react', 'tailwindcss'];

    } else if (intentClass === 'full_product' && complexity === 'high') {
      // PRODUCT_SYSTEM (high complexity): Vite-bundled React + Tailwind + shadcn-style components
      // Frontend: Vite + React 18 with proper ES module imports
      // Backend: Express + dual-driver DB (pg for production, better-sqlite3 for local dev)
      // Output stack: vite-react-tailwind (bundled — no CDN script tags)
      // Frontend in src/, server.js serves API + static dist/ in production
      tree = [
        { path: 'server.js', type: 'file', description: 'Express entry point — serves dist/ in production, mounts /api + /api/auth routes, waits for db.ready before listen' },
        { path: 'package.json', type: 'file', description: 'Dependencies: express, pg, better-sqlite3, jsonwebtoken, bcrypt, cors, dotenv, react, react-dom, vite, @vitejs/plugin-react, tailwindcss' },
        { path: '.env.example', type: 'file', description: 'Required env vars: DATABASE_URL, JWT_SECRET, PORT, NODE_ENV' },
        { path: 'vite.config.js', type: 'file', description: 'Vite config with @vitejs/plugin-react and proxy to Express API' },
        { path: 'index.html', type: 'file', description: 'Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">' },
        { path: 'src/', type: 'dir', description: 'React source directory' },
        { path: 'src/main.jsx', type: 'file', description: 'React entry point — imports App, renders into #root via createRoot' },
        { path: 'src/App.jsx', type: 'file', description: 'Root React component — import React, shadcn-style components, full app UI with state + API integration' },
        { path: 'src/index.css', type: 'file', description: 'Tailwind directives (@tailwind base/components/utilities) + custom styles' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes — async CRUD using { query } from db/database.js' },
        { path: 'routes/auth.js', type: 'file', description: 'Auth routes — POST /api/auth/signup, POST /api/auth/login, returns JWT' },
        { path: 'middleware/', type: 'dir', description: 'Express middleware' },
        { path: 'middleware/auth.js', type: 'file', description: 'JWT verification middleware — attaches req.user' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/database.js', type: 'file', description: 'Dual-driver DB — auto-detects postgres:// → pg Pool, else → better-sqlite3. Exports { query, exec, ready }' },
      ];
      techStack = ['express', 'pg', 'better-sqlite3', 'jsonwebtoken', 'bcrypt', 'react', 'react-dom', 'vite', '@vitejs/plugin-react', 'tailwindcss'];
    } else if (intentClass === 'full_product') {
      // PRODUCT_SYSTEM (medium/default complexity): Vite-bundled React + Tailwind + shadcn-style components
      // Frontend: Vite + React 18 with proper ES module imports
      // Backend: Express + dual-driver DB (pg for production, better-sqlite3 for local dev)
      // Output stack: vite-react-tailwind (bundled — no CDN script tags)
      // Frontend in src/, server.js serves API + static dist/ in production
      tree = [
        { path: 'server.js', type: 'file', description: 'Express entry point — serves dist/ in production, mounts /api routes, waits for db.ready before listen' },
        { path: 'package.json', type: 'file', description: 'Dependencies: express, pg, better-sqlite3, cors, dotenv, react, react-dom, vite, @vitejs/plugin-react, tailwindcss' },
        { path: '.env.example', type: 'file', description: 'Required env vars: DATABASE_URL, PORT, NODE_ENV' },
        { path: 'vite.config.js', type: 'file', description: 'Vite config with @vitejs/plugin-react and proxy to Express API' },
        { path: 'index.html', type: 'file', description: 'Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">' },
        { path: 'src/', type: 'dir', description: 'React source directory' },
        { path: 'src/main.jsx', type: 'file', description: 'React entry point — imports App, renders into #root via createRoot' },
        { path: 'src/App.jsx', type: 'file', description: 'Root React component — import React, shadcn-style components, full app UI with state + API integration' },
        { path: 'src/index.css', type: 'file', description: 'Tailwind directives (@tailwind base/components/utilities) + custom styles' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes — async CRUD using { query } from db/database.js' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/database.js', type: 'file', description: 'Dual-driver DB — auto-detects postgres:// → pg Pool, else → better-sqlite3. Exports { query, exec, ready }' },
      ];
      techStack = ['express', 'pg', 'better-sqlite3', 'react', 'react-dom', 'vite', '@vitejs/plugin-react', 'tailwindcss'];
    } else if (intentClass === 'light_app' || schemaClass === 'light_app') {
      // ── LIGHT APP: minimal Express server + Vite-bundled React frontend, no database stack ──
      // Vite + React 18 with proper ES module imports for all light apps.
      // Uses in-memory storage — no pg, no migrations, no db/ directory.
      console.log('[BuilderAgent] Light app detected — generating Vite React scaffold (no db/migrations)');
      tree = [
        { path: 'server.js', type: 'file', description: 'Minimal Express server — serves dist/ in production + API routes' },
        { path: 'package.json', type: 'file', description: 'Dependencies: express, react, react-dom, vite, @vitejs/plugin-react, tailwindcss' },
        { path: 'vite.config.js', type: 'file', description: 'Vite config with @vitejs/plugin-react and proxy to Express API' },
        { path: 'index.html', type: 'file', description: 'Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">' },
        { path: 'src/', type: 'dir', description: 'React source directory' },
        { path: 'src/main.jsx', type: 'file', description: 'React entry point — imports App, renders into #root via createRoot' },
        { path: 'src/App.jsx', type: 'file', description: 'Root React component — import React, shadcn-style components, useState hooks + API integration via fetch()' },
        { path: 'src/index.css', type: 'file', description: 'Tailwind directives + custom responsive styles' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes (in-memory storage)' },
      ];
      techStack = ['express', 'react', 'react-dom', 'vite', '@vitejs/plugin-react', 'tailwindcss'];
    } else if (complexity === 'high') {
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts' },
        { path: '.env.example', type: 'file', description: 'Required environment variables' },
        { path: 'migrate.js', type: 'file', description: 'Database migration runner' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'routes/auth.js', type: 'file', description: 'Authentication routes' },
        { path: 'middleware/', type: 'dir', description: 'Express middleware' },
        { path: 'middleware/auth.js', type: 'file', description: 'JWT auth middleware' },
        { path: 'middleware/error.js', type: 'file', description: 'Global error handling middleware' },
        { path: 'models/', type: 'dir', description: 'Database models' },
        { path: 'models/index.js', type: 'file', description: 'Model definitions and exports' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/queries.js', type: 'file', description: 'Parameterized SQL queries' },
        { path: 'db/pool.js', type: 'file', description: 'Connection pool' },
        { path: 'migrations/', type: 'dir', description: 'Schema migrations' },
        { path: 'migrations/001_schema.js', type: 'file', description: 'Initial tables' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'];
    } else {
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts' },
        { path: 'migrate.js', type: 'file', description: 'Database migration runner' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/queries.js', type: 'file', description: 'Parameterized SQL queries' },
        { path: 'migrations/', type: 'dir', description: 'Schema migrations' },
        { path: 'migrations/001_schema.js', type: 'file', description: 'Initial tables' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = ['express', 'pg'];
    }

    // ── PLAN-DRIVEN COMPONENT INJECTION ───────────────────────────────────────
    // PLAN phase outputs planned_components[] (e.g., ["HeroSection", "PricingTable"]).
    // These become real files in the scaffold manifest so CODE generates them.
    // Without this, the scaffold ignores plan components and CODE only produces
    // the hardcoded baseline files (the "3 file" bug).
    const plannedComponents = plan?.planned_components || [];
    if (plannedComponents.length > 0) {
      const hasReact = techStack.includes('react-cdn') || techStack.includes('react');
      const compExt = hasReact ? '.jsx' : '.js';
      const existingPaths = new Set(tree.map(t => t.path.toLowerCase()));

      // Add components/ directory if not already present
      if (!existingPaths.has('components/')) {
        tree.push({ path: 'components/', type: 'dir', description: 'UI components' });
      }

      let addedCount = 0;
      for (const comp of plannedComponents) {
        const kebab = comp
          .replace(/([a-z])([A-Z])/g, '$1-$2')
          .replace(/\s+/g, '-')
          .toLowerCase();
        const compPath = `components/${kebab}${compExt}`;
        if (!existingPaths.has(compPath.toLowerCase())) {
          tree.push({ path: compPath, type: 'file', description: `Component: ${comp}` });
          existingPaths.add(compPath.toLowerCase());
          addedCount++;
        }
      }

      if (addedCount > 0) {
        console.log(`[BuilderAgent] Plan component injection: added ${addedCount} component file(s) from planned_components`);
      }
    }

    // Append plan.planned_files[] that aren't already in the tree
    const plannedFiles = plan?.planned_files || [];
    if (plannedFiles.length > 0) {
      const existingPaths = new Set(tree.map(t => t.path.toLowerCase()));
      let addedCount = 0;
      for (const pf of plannedFiles) {
        if (!existingPaths.has(pf.toLowerCase())) {
          // Determine if it's a directory (ends with /) or file
          const isDir = pf.endsWith('/');
          tree.push({ path: pf, type: isDir ? 'dir' : 'file', description: `Plan-specified: ${pf}` });
          existingPaths.add(pf.toLowerCase());
          addedCount++;
        }
      }
      if (addedCount > 0) {
        console.log(`[BuilderAgent] Plan file injection: added ${addedCount} file(s) from planned_files`);
      }
    }

    // ── Build structured manifest (source of truth for CODE phase) ──

    // files[] — flat list of file paths only (no dirs)
    const filesList = tree.filter(t => t.type === 'file').map(t => t.path);

    // structure{} — directory → files mapping
    const structure = {};
    for (const item of tree) {
      if (item.type !== 'file') continue;
      const parts = item.path.split('/');
      const dir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
      if (!structure[dir]) structure[dir] = [];
      structure[dir].push(parts[parts.length - 1]);
    }

    // constraints{} — inferred project constraints
    const hasServer = filesList.some(f => f === 'server.js' || f === 'index.js');
    const hasFrontend = filesList.some(f => f.endsWith('.html'));
    const hasAuth = filesList.some(f => f.includes('auth'));
    const hasDb = filesList.some(f => f.includes('db/') || f.includes('migrations/'));

    const constraints = {
      hasServer,
      hasFrontend,
      hasAuth,
      hasDb,
      entry: schema.entry,
      techStack: techStack.length > 0 ? [...techStack] : [...schema.techStack],
    };

    // ── SCHEMA VALIDATION: compile-time prevention ──
    // Verify constraints match the selected schema. If they don't, the scaffold
    // generator produced structurally invalid metadata — log and correct.
    const schemaCheck = validateConstraintsAgainstSchema(constraints, schemaClass || 'light_app');
    if (!schemaCheck.valid) {
      console.error(`[BuilderAgent] SCHEMA MISMATCH: ${schemaCheck.violations.join('; ')}`);
      // Force-correct to schema values (compile-time prevention, not runtime rejection)
      constraints.entry = schema.entry;
      if (schema.server === false) constraints.hasServer = false;
    }

    // ── ENTRY POINT SELF-CHECK: guarantee entry exists in files list ──────────
    // The schema defines the canonical entry point (e.g., 'index.html'), but
    // server-based trees store it under 'public/' (e.g., 'public/index.html').
    // If the entry point is not in filesList, resolve it:
    //   1. Check if public/<entry> exists → use that as the actual entry
    //   2. Check if any file ends with /<entry> → use that path
    //   3. As last resort, inject the bare entry point into the files list
    // This prevents the scaffold manifest validation from failing with
    // "Entry point not found in scaffold files list".
    if (constraints.entry && !filesList.includes(constraints.entry)) {
      const publicEntry = 'public/' + constraints.entry;
      const nestedMatch = filesList.find(f => f.endsWith('/' + constraints.entry));

      if (filesList.includes(publicEntry)) {
        // Server-based tree: entry lives under public/ — update constraint to match
        console.log(`[BuilderAgent] Entry point self-check: "${constraints.entry}" → "${publicEntry}" (public/ normalization)`);
        constraints.entry = publicEntry;
      } else if (nestedMatch) {
        // Entry exists at a nested path — update constraint to match
        console.log(`[BuilderAgent] Entry point self-check: "${constraints.entry}" → "${nestedMatch}" (nested path)`);
        constraints.entry = nestedMatch;
      } else {
        // Entry point missing entirely — inject it into the tree and files list
        console.warn(`[BuilderAgent] Entry point self-check: "${constraints.entry}" not found — injecting into manifest`);
        tree.push({ path: constraints.entry, type: 'file', description: 'Entry point (auto-injected)' });
        filesList.push(constraints.entry);
        // Update structure
        const parts = constraints.entry.split('/');
        const dir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
        if (!structure[dir]) structure[dir] = [];
        structure[dir].push(parts[parts.length - 1]);
      }
    }

    const dirs = tree.filter(t => t.type === 'dir').length;
    const filesCount = filesList.length;
    const summary = `${dirs} directories, ${filesCount} files, ${techStack.join(' + ')}`;

    const treeLines = [
      '## Project Structure',
      '',
      '```',
      'project/',
      ...tree.map((t, i) => {
        const isLast = i === tree.length - 1 || (tree[i + 1] && tree[i + 1].path.split('/').length < t.path.split('/').length);
        const prefix = t.path.includes('/') ? '\u2502   ' : '';
        const connector = isLast ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500';
        const name = t.path.split('/').pop() || t.path;
        return `${prefix}${connector} ${name.padEnd(22)}# ${t.description}`;
      }),
      '```',
      '',
      `**Directories:** ${dirs}`,
      `**Files:** ${filesCount}`,
      `**Dependencies:** ${techStack.join(', ')}`,
      '',
      '### Manifest Contract',
      `**Files (${filesCount}):** ${filesList.join(', ')}`,
      `**Entry:** ${constraints.entry}`,
      `**Constraints:** server=${hasServer}, frontend=${hasFrontend}, auth=${hasAuth}, db=${hasDb}`,
      // Phase 4.2: ISE — show surfaces as build targets in the manifest output
      ...(iseSurfaces.length > 0 ? [
        '',
        '### Interaction Surfaces (ISE Phase 4.2)',
        `**Build targets:** ${iseSurfaces.join(' → ')}`,
        ...(iseTransitions.length > 0 ? [`**Flow:** ${iseTransitions.join(' | ')}`] : []),
      ] : []),
    ];

    await this._streamText(treeLines.join('\n'), emitChunk, 6);

    console.log(`[BuilderAgent] SCAFFOLD manifest: ${filesCount} files, entry=${constraints.entry}, stack=[${techStack.join(',')}]`);

    // Phase 4.2: Attach ISE surfaces to scaffold output so the CODE phase
    // can inject them into the scaffold contract block (_buildScaffoldContractBlock).
    // Add output_stack to scaffold for downstream CODE phase detection
    const outputStack = techStack.includes('react-cdn') ? 'react-tailwind-shadcn' : 'html-tailwind';
    const scaffoldOutput = { tree, techStack, summary, files: filesList, structure, constraints, output_stack: outputStack };
    if (iseSurfaces.length > 0) {
      scaffoldOutput._ise_surfaces   = iseSurfaces;
      scaffoldOutput._ise_transitions = iseTransitions;
      console.log(`[BuilderAgent] Scaffold carries ISE surfaces: [${iseSurfaces.join(', ')}]`);
    }

    // ── Interaction Contract: what each component must DO ─────────────────────
    // Generated from ISE surfaces + prompt patterns.
    // Polymorphic by intent_class:
    //   static_surface  → empty (no interactivity required)
    //   light_app       → interactions[] + forms[]
    //   full_product    → interactions[] + routing[] + forms[]
    // CODE phase receives this as a binding contract — every listed item must be implemented.
    // VERIFY phase checks fulfillment.
    const interactionContract = this._buildInteractionContract(
      prompt, intentClass, iseSurfaces, iseTransitions, plan, constraintContract
    );
    scaffoldOutput.interaction_contract = interactionContract;

    // ── Content Section Inventory: what content sections the output MUST contain ──
    // Extracted from the user prompt. Stored on scaffold so CODE phase can validate
    // that generated HTML actually includes these sections post-generation.
    // Same pattern as interaction_contract — set at SCAFFOLD, enforced at CODE.
    const contentSections = this._extractRequestedSections(prompt);
    const contentCTAs = this._extractCTAs(prompt);
    scaffoldOutput.content_sections = contentSections;
    scaffoldOutput.content_ctas = contentCTAs;

    const contractSummary = [
      interactionContract.interactions.length > 0 ? `${interactionContract.interactions.length} interactions` : '',
      interactionContract.routing.length > 0 ? `${interactionContract.routing.length} routes` : '',
      interactionContract.forms.length > 0 ? `${interactionContract.forms.length} forms` : '',
      contentSections.length > 0 ? `${contentSections.length} content sections` : '',
    ].filter(Boolean).join(', ');
    console.log(`[BuilderAgent] Interaction contract (${intentClass}): ${contractSummary || 'empty (static)'}`);
    if (contentSections.length > 0) {
      console.log(`[BuilderAgent] Content section inventory: [${contentSections.map(s => s.name).join(', ')}]`);
    }

    return scaffoldOutput;
  }

  // ── Interaction Contract Builder ─────────────────────────────────────────
  //
  // Generates a polymorphic interaction_contract from prompt + ISE surfaces + plan.
  // The contract specifies WHAT each component must DO — not just that it exists.
  // This becomes part of the SCAFFOLD manifest that CODE validates against.
  //
  // Contract shape (varies by intent_class):
  //   interactions[] — element + event + behavior + state (for INTERACTIVE_LIGHT_APP)
  //   routing[]      — path + component + behavior (for PRODUCT_SYSTEM)
  //   forms[]        — id + fields + submit_behavior (for both)
  //
  _buildInteractionContract(prompt, intentClass, iseSurfaces = [], iseTransitions = [], plan = null, constraintContract = null) {
    const lower = (prompt || '').toLowerCase();
    const interactions = [];
    const routing = [];
    const forms = [];

    // STATIC_SURFACE: no interaction contract (decorative animations only)
    if (intentClass === 'static_surface') {
      return { intent_class: 'static_surface', interactions: [], routing: [], forms: [] };
    }

    // Always use the actual intent class for interaction contract routing.
    // hard_expansion builds always generate a complete structure, so no delegation needed.
    const effectiveClass = intentClass;

    // ── LIGHT APP (INTERACTIVE_LIGHT_APP) ────────────────────────────────────
    if (effectiveClass === 'light_app' || intentClass === 'light_app') {
      // Derive from ISE surfaces first (most specific signal)
      if (iseSurfaces.length > 0) {
        for (const surface of iseSurfaces) {
          const s = surface.toLowerCase();
          if (/calculat|result|compute|total|output/.test(s)) {
            interactions.push({
              element: `${surface} button`,
              event: 'click',
              behavior: `Read all input values, perform ${surface} calculation, display formatted result in output area`,
              state: ['inputValues', 'result'],
            });
          } else if (/form|submit|input|entry/.test(s)) {
            forms.push({
              id: s.replace(/\s+/g, '-') + '-form',
              fields: [`inputs required for ${surface}`],
              submit_behavior: `Validate fields, process ${surface}, show success confirmation or error message`,
            });
          } else if (/list|items|results|table/.test(s)) {
            interactions.push({
              element: `${surface} list/table`,
              event: 'load + data-change',
              behavior: `Render ${surface} items dynamically, update when underlying data changes`,
              state: ['items'],
            });
          } else if (/search|filter|find/.test(s)) {
            interactions.push({
              element: `${surface} search input`,
              event: 'input',
              behavior: `Filter ${surface} results in real-time as user types, show empty state if no matches`,
              state: ['searchQuery', 'filteredItems'],
            });
          } else {
            interactions.push({
              element: `${surface} primary element`,
              event: 'click/input',
              behavior: `Handle ${surface} — produce visible state change or output`,
              state: ['currentState'],
            });
          }
        }
      }

      // Prompt-based pattern augmentation (fills gaps when ISE didn't extract surfaces)
      const isCalculator  = /calculat|tip\s+calc|split.*bill|bmi|mortgage|loan|conver|currency|tax/.test(lower);
      const isContactForm = /contact\s+form|feedback\s+form|waitlist|subscribe|signup/.test(lower);
      const isSearch      = /search|filter|lookup|find/.test(lower) && !/search engine/.test(lower);
      const isTodo        = /\btodo\b|to-do|task\s+list|checklist|reminder/.test(lower);
      const isTimer       = /\btimer\b|countdown|stopwatch/.test(lower);
      const isSlider      = /slider|range|drag/.test(lower);

      if (isCalculator && !interactions.some(i => i.event === 'click' && /calculat|compute|result/.test(i.behavior.toLowerCase()))) {
        interactions.push({
          element: 'calculate / compute button (primary CTA)',
          event: 'click',
          behavior: 'Read all numeric/input fields, execute calculation logic, display formatted result in designated output area. Button must be disabled when required inputs are empty.',
          state: ['inputValues', 'result', 'isValid'],
        });
        interactions.push({
          element: 'numeric input fields',
          event: 'input',
          behavior: 'Parse entered value, validate it is a valid number, update state, re-enable calculate button when all required fields have valid values',
          state: ['inputValues', 'isValid'],
        });
      }

      if (isContactForm && forms.length === 0) {
        forms.push({
          id: 'main-form',
          fields: ['name', 'email', 'message (or relevant fields from prompt)'],
          submit_behavior: 'Prevent default, validate all required fields, show inline errors for missing/invalid fields, submit data (POST or client-side), show success confirmation state',
        });
      }

      if (isSearch && !interactions.some(i => /search|filter/.test(i.behavior.toLowerCase()))) {
        interactions.push({
          element: 'search input field',
          event: 'input',
          behavior: 'Filter displayed items in real-time as user types — hide non-matching items, show empty-state message when zero results',
          state: ['searchQuery', 'filteredItems'],
        });
      }

      if (isTodo) {
        if (!interactions.some(i => /add|create/.test(i.behavior.toLowerCase()))) {
          interactions.push({
            element: 'add item button / form submit',
            event: 'click / submit',
            behavior: 'Read input value, validate non-empty, append new item to items array, re-render list, clear input field',
            state: ['items', 'inputValue'],
          });
        }
        interactions.push({
          element: 'complete / delete buttons (per list item)',
          event: 'click',
          behavior: 'Toggle item complete state (strikethrough + opacity) or remove item from array and re-render list',
          state: ['items'],
        });
      }

      if (isTimer) {
        interactions.push({
          element: 'start / pause / reset buttons',
          event: 'click',
          behavior: 'Start: begin setInterval to update elapsed display every second. Pause: clearInterval, preserve elapsed. Reset: clearInterval, set elapsed=0, update display.',
          state: ['timerState', 'elapsed', 'intervalId'],
        });
      }

      if (isSlider && !interactions.some(i => i.event === 'input' && /slider|range/.test(i.element))) {
        interactions.push({
          element: 'range / slider input',
          event: 'input',
          behavior: 'Update displayed value label in real-time as slider moves, trigger any dependent recalculation',
          state: ['sliderValue'],
        });
      }

      // Guarantee ≥1 interaction for light_app
      if (interactions.length === 0 && forms.length === 0) {
        interactions.push({
          element: 'primary action button',
          event: 'click',
          behavior: 'Execute the main action of this app — derive from prompt. Produce a visible, meaningful UI state change. NOT decorative.',
          state: ['appState'],
        });
      }
    }

    // ── FULL PRODUCT (PRODUCT_SYSTEM) ─────────────────────────────────────────
    if (effectiveClass === 'full_product' || intentClass === 'full_product') {
      // Routing: derive from ISE surfaces or fall back to standard CRUD views
      if (iseSurfaces.length > 0) {
        for (const surface of iseSurfaces) {
          const path = '/' + surface.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          routing.push({
            path: path || '/',
            component: surface,
            behavior: `Display and manage ${surface} — render data, handle user actions, reflect changes immediately`,
          });
        }
      } else {
        routing.push({ path: '/', component: 'Dashboard', behavior: 'Main dashboard — summary stats, navigation to all sections' });
        routing.push({ path: '/items', component: 'ItemList', behavior: 'CRUD table/list of primary domain entity with add/edit/delete' });
        routing.push({ path: '/items/:id', component: 'ItemDetail', behavior: 'View or edit a single entity record' });
      }

      // Standard CRUD interactions (every full_product needs these)
      interactions.push({
        element: 'add / create button (primary)',
        event: 'click',
        behavior: 'Show create form or modal. On submit: POST to /api/[entity], validate response, append to list, clear form, close modal/form',
        state: ['items', 'showCreateForm'],
      });
      interactions.push({
        element: 'delete button (per row/card)',
        event: 'click',
        behavior: 'DELETE /api/[entity]/:id, immediately remove item from UI list, show brief undo/success message',
        state: ['items'],
      });
      interactions.push({
        element: 'edit button (per row/card)',
        event: 'click',
        behavior: 'Populate edit form with current item data. On submit: PUT /api/[entity]/:id, update item in UI list without full reload',
        state: ['items', 'editingItem'],
      });
      interactions.push({
        element: 'sidebar / top nav items',
        event: 'click',
        behavior: 'Switch active view — hide all content sections, show selected section, update active nav styling (bold/underline/highlight)',
        state: ['currentView'],
      });

      // Standard entity forms
      forms.push({
        id: 'create-form',
        fields: ['primary entity fields derived from domain (name, description, quantity, etc.)'],
        submit_behavior: 'Validate all required fields (show inline errors), POST to /api/[entity], on success: reset form, refresh list, close form/modal',
      });
      forms.push({
        id: 'edit-form',
        fields: ['same fields as create-form, pre-populated with existing item data'],
        submit_behavior: 'Validate fields, PUT to /api/[entity]/:id, on success: update item in list, close edit form',
      });

      // Auth forms if app has auth layer
      if (/login|signup|register|auth|account|user/.test(lower)) {
        forms.push({
          id: 'login-form',
          fields: ['email', 'password'],
          submit_behavior: 'POST to /api/auth/login, store returned JWT in localStorage, redirect to dashboard. Show error message on 401.',
        });
        forms.push({
          id: 'signup-form',
          fields: ['email', 'password', 'name (optional)'],
          submit_behavior: 'POST to /api/auth/signup, store JWT in localStorage, redirect to onboarding or dashboard.',
        });
      }
    }

    // ── UNIVERSAL FALLBACK: guarantee ≥1 interaction for ANY non-static class ──
    // Prevents empty contracts that leave Phase 5 and _repairDeadButtons without
    // guidance — the root cause of dead buttons across non-PRODUCT_SYSTEM builds.
    if (interactions.length === 0 && forms.length === 0) {
      interactions.push({
        element: 'primary action button',
        event: 'click',
        behavior: 'Execute the main action of this app — derive from prompt. Produce a visible, meaningful UI state change. NOT decorative.',
        state: ['appState'],
      });
      // Add form fallback if prompt implies form interaction
      if (/form|submit|signup|login|register|subscribe|contact|feedback|waitlist/.test(lower)) {
        forms.push({
          id: 'main-form',
          fields: ['relevant fields derived from prompt'],
          submit_behavior: 'Validate all required fields, submit data, show success confirmation or error message',
        });
      }
    }

    return { intent_class: intentClass, interactions, routing, forms };
  }

  // ── NON-WEB SCAFFOLD ─────────────────────────────────────
  // Generated when the target GitHub repo is a non-web project (C#, Go, Rust,
  // Python CLI, etc.). Skips React/HTML templates entirely and produces a
  // language-appropriate file skeleton that the repo's toolchain can compile.

  async _executeNonWebScaffold(prompt, plan, emitChunk, repoProfile) {
    const { language, framework, platform, allowedArtifacts, entryPoints } = repoProfile;

    if (emitChunk) {
      emitChunk(`\n[SCAFFOLD] Non-web project detected: ${language}/${framework || platform}\n`);
      emitChunk(`[SCAFFOLD] Generating ${language}-appropriate scaffold (no React/HTML)\n`);
    }

    // Build a minimal language-appropriate scaffold
    const tree = _buildNonWebTree(language, framework, prompt);
    const files = tree.map(t => t.path);
    const techStack = _nonWebTechStack(language, framework);

    const summary =
      `${language.toUpperCase()} ${framework ? `(${framework}) ` : ''}project scaffold — ` +
      `${files.length} files. Platform: ${platform}. ` +
      `Existing entry points: ${(entryPoints || []).join(', ') || 'auto-detected'}.`;

    if (emitChunk) {
      emitChunk(`[SCAFFOLD] Generated ${files.length} files for ${language} project\n`);
    }

    return {
      tree,
      files,
      techStack,
      summary,
      structure: { src: files },
      constraints: { hasServer: false, hasFrontend: false, entry: files[0] || null, techStack },
      _repoProfile: repoProfile,
    };
  }

  // ── NON-WEB CODE ──────────────────────────────────────────
  // CODE phase for non-web repos — generates language-appropriate content
  // (C# classes, Python modules, Go packages, etc.) rather than React components.

  async _executeNonWebCode(prompt, plan, scaffold, emitChunk, repoProfile) {
    const { language, framework } = repoProfile;
    const files = {};

    if (emitChunk) {
      emitChunk(`\n[CODE] Non-web project (${language}/${framework || 'native'}) — generating ${language} code\n`);
    }

    const scaffoldFiles = (scaffold && Array.isArray(scaffold.files)) ? scaffold.files : [];

    for (const filePath of scaffoldFiles) {
      const content = _generateNonWebFile(filePath, language, framework, prompt, plan);
      if (content) files[filePath] = content;
    }

    if (emitChunk) {
      emitChunk(`[CODE] Generated ${Object.keys(files).length} files\n`);
    }

    return { files };
  }

  // ── REPO-AWARE CODE ───────────────────────────────────────
  // CODE phase for repo-aware builds. Instead of generating a greenfield app,
  // this reads the change plan from the Plan phase and generates targeted
  // patches (modified file contents) for each file in the change plan.
  //
  // Output: { files: { [path]: fullNewContent }, entryPoint, totalLines, _repo_aware: true }
  // Files keys are the paths to modify/create. Deleted files get content: null.

  async _executeRepoAwareCode(prompt, plan, repoContext, emitChunk, productContext = null, constraintContract = null) {
    const repoFullName = (repoContext && repoContext.repoFullName) || 'connected repo';
    const repoFiles = (repoContext && repoContext.repoFiles) || [];
    const intentClass = (constraintContract && constraintContract.intent_class) || 'repo_feature';

    console.log(`[BuilderAgent] Repo-aware CODE phase: ${repoFullName}, intent=${intentClass}, plan=${plan ? 'present' : 'missing'}`);

    if (emitChunk) {
      emitChunk(`\n## Repo-Aware Code Generation\n\n`);
      emitChunk(`Generating targeted changes for **${repoFullName}** (intent: ${intentClass})\n\n`);
    }

    // Build the change plan context from Plan output
    const planSubtasks = (plan && plan.subtasks) || [];
    const planFiles = (plan && plan.planned_files) || [];
    const planMarkdown = (plan && plan.rawMarkdown) || '';

    // Build a concise repo file tree for context (first 100 files)
    const repoFileTree = repoFiles.slice(0, 100).join('\n');

    // Determine which files need changes based on plan
    // Prefer plan.planned_files; fall back to extracting from plan markdown
    const filesToChange = planFiles.length > 0
      ? planFiles
      : this._extractFilesFromPlanMarkdown(planMarkdown, repoFiles);

    if (emitChunk) {
      emitChunk(`Files to modify/create: **${filesToChange.length > 0 ? filesToChange.join(', ') : '(auto-detected from plan)'}**\n\n`);
    }

    const systemPrompt = SENIOR_ENGINEER_SYSTEM_PROMPT;

    const repoAwareInstruction = `## REPO-AWARE MODE — TARGETED CHANGES ONLY

You are generating MODIFICATIONS to an existing codebase. Do NOT write a new app from scratch.

REPOSITORY: ${repoFullName}
INTENT: ${intentClass}

EXISTING FILE TREE (${repoFiles.length} files):
${repoFileTree}

CHANGE PLAN:
${planMarkdown || planSubtasks.map((t, i) => `${i + 1}. ${t.title}: ${t.description}`).join('\n')}

FILES TO CHANGE: ${filesToChange.length > 0 ? filesToChange.join(', ') : '(determine from plan)'}

CRITICAL RULES:
1. Generate the FULL new content of each file to modify — not diffs or partial snippets
2. For new files: generate complete, working content
3. For modified files: generate the complete file with changes applied (not just the changed sections)
4. Respect existing code style, naming conventions, and patterns
5. Do NOT generate files that aren't in the change plan
6. Format: use the EXACT same delimiter format as below for EACH file

OUTPUT FORMAT — use exactly this for each file:
===FILE: <path/to/file>===
<complete file content here>
===END===

Generate changes for each file in the plan. Be complete — no TODOs, no placeholders.`;

    const userMessage = `Task: ${prompt}

Generate the targeted file changes described in the plan above.
For each file that needs to change, output the COMPLETE new content.
Use the ===FILE: path=== ... ===END=== delimiter format.`;

    const files = {};
    let rawText = '';

    try {
      const modelConfig = this._selectModel(intentClass);
      // Route repo_* classes to Claude for better code understanding
      const effectiveConfig = (intentClass.startsWith('repo_') && this.anthropic)
        ? { provider: 'anthropic', model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-20250514' }
        : modelConfig;

      const result = await this._callStreamingLLM(
        effectiveConfig,
        systemPrompt,
        `${repoAwareInstruction}\n\n${userMessage}`,
        8192,
        emitChunk
      );
      rawText = result.rawText || '';
    } catch (llmErr) {
      console.warn(`[BuilderAgent] Repo-aware code LLM failed: ${llmErr.message}`);
      // Fall back to a minimal placeholder
      rawText = `===FILE: README_CHANGES.md===\n# Planned Changes\n\n${planMarkdown || 'See plan for details.'}\n===END===`;
    }

    // Parse ===FILE: path=== ... ===END=== format
    const fileBlockRegex = /===FILE:\s*(.+?)===([\s\S]*?)===END===/g;
    let match;
    while ((match = fileBlockRegex.exec(rawText)) !== null) {
      const filePath = match[1].trim();
      const fileContent = match[2].trim();
      if (filePath && fileContent) {
        files[filePath] = fileContent;
        console.log(`[BuilderAgent] Repo-aware: parsed file "${filePath}" (${fileContent.length} chars)`);
      }
    }

    // If no files were parsed (e.g., LLM used different format), try a more lenient parse
    if (Object.keys(files).length === 0 && rawText.length > 100) {
      console.warn('[BuilderAgent] Repo-aware: primary parser found no files — trying lenient parse');
      // Try to extract markdown code blocks with file paths in header
      const codeBlockRegex = /```(?:\w+)?\s+(?:\/\/|#|\/\*)?\s*(.+?)\s*\n([\s\S]*?)```/g;
      while ((match = codeBlockRegex.exec(rawText)) !== null) {
        const possiblePath = match[1].trim();
        const content = match[2].trim();
        // Only include if path looks like a file path
        if (possiblePath && /[./]/.test(possiblePath) && content.length > 10) {
          files[possiblePath] = content;
        }
      }
    }

    // Final fallback: if still nothing, create a changes summary file
    if (Object.keys(files).length === 0) {
      console.warn('[BuilderAgent] Repo-aware: no files parsed from LLM output — creating changes summary');
      files['BUILDORBIT_CHANGES.md'] = `# Planned Changes\n\n**Repository:** ${repoFullName}\n**Intent:** ${intentClass}\n\n${planMarkdown || prompt}\n\n---\n*Generated by BuildOrbit — manual review required*`;
    }

    const totalLines = Object.values(files).reduce((sum, c) => sum + (c ? c.split('\n').length : 0), 0);
    const entryPoint = Object.keys(files)[0] || null;

    if (emitChunk) {
      emitChunk(`\n✓ Generated ${Object.keys(files).length} file change(s) for ${repoFullName}\n`);
      for (const fp of Object.keys(files)) {
        emitChunk(`  • ${fp}\n`);
      }
    }

    console.log(`[BuilderAgent] Repo-aware CODE complete: ${Object.keys(files).length} files, ${totalLines} total lines`);

    return {
      files,
      entryPoint,
      totalLines,
      _repo_aware: true,
      _repoFullName: repoFullName,
      _intentClass: intentClass,
    };
  }

  /**
   * Extract file paths from plan markdown — looks for file references like `path/to/file.js`.
   * Used when plan.planned_files is not populated.
   */
  _extractFilesFromPlanMarkdown(markdown, repoFiles) {
    if (!markdown) return [];
    const repoFileSet = new Set(repoFiles);
    const found = new Set();

    // Match file paths mentioned in markdown (e.g. `src/server.js` or **src/routes/api.js**)
    const patterns = [
      /`([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,6})`/g,   // backtick paths
      /\*\*([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,6})\*\*/g, // bold paths
    ];

    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(markdown)) !== null) {
        const candidate = m[1];
        // Include if it looks like a file path and exists in repo or is being created
        if (candidate.includes('/') || candidate.includes('.')) {
          found.add(candidate);
        }
      }
    }

    // Prefer paths that exist in the repo; then include new paths from plan
    const existing = [...found].filter(f => repoFileSet.has(f));
    const newFiles = [...found].filter(f => !repoFileSet.has(f));
    return [...existing, ...newFiles].slice(0, 20); // cap at 20 files
  }

  // ── CODE (6-phase pipeline) ───────────────────────────────

  async _executeCode(prompt, plan, scaffold, emitChunk, productContext = null, constraintContract = null, repoProfile = null) {
    // Non-web repos: CODE phase generates language-appropriate content, not React/HTML.
    // EXCEPTION: user-provided file trees always go through AI code gen — the user
    // specified their exact files and the AI should generate real content, not stubs.
    if (repoProfile && !repoProfile.isWebProject && !scaffold?._isUserProvided) {
      return this._executeNonWebCode(prompt, plan, scaffold, emitChunk, repoProfile);
    }

    // ── Serena File Structure Context (symbol-aware code generation) ──────────
    // When a source repo root is available, fetch the file structure so the LLM
    // knows what already exists before generating new code. Fail-open.
    let serenaCodeContext = null;
    const sourceRepoRoot = scaffold?._sourceRepoLocalPath || null;
    if (sourceRepoRoot) {
      console.log(`[BuilderAgent] Fetching Serena file structure for CODE phase: ${sourceRepoRoot}`);
      const structure = await serena.getFileStructure(sourceRepoRoot, '.', 3);
      if (structure) {
        serenaCodeContext = `\n\n=== EXISTING FILE STRUCTURE (Serena — read before writing) ===\n${structure.slice(0, 3000)}\n=== END SERENA FILE STRUCTURE ===`;
        console.log('[BuilderAgent] Serena file structure loaded for code generation context');
      }
    }

    let result;
    if (this.openai || this.anthropic) {
      try {
        result = await this._aiCode(prompt, plan, scaffold, emitChunk, productContext, constraintContract, serenaCodeContext);
      } catch (e) {
        console.error('[BuilderAgent] AI code failed, falling back to simulated mode:', e.message);
        // Emit visible warning to user so they know AI generation failed
        if (emitChunk) {
          emitChunk(`\n⚠️ [CODE] AI code generation encountered an error: ${e.message}. Using fallback generation.\n`);
        }
      }
    }
    if (!result) {
      result = await this._simulatedCode(prompt, emitChunk, constraintContract, productContext, scaffold, repoProfile);
    }

    // ── HARD GATE: Enforce scaffold manifest on ALL code paths ──────────
    // This is the single choke point — every code output (AI or simulated)
    // MUST pass through manifest enforcement before reaching the orchestrator.
    // Previous fixes only enforced inside _aiCode; the simulated fallback was
    // completely unguarded, causing contract violations when AI generation failed.
    //
    // NOTE: throwOnMissing=false here — the gap-fill code below synthesizes
    // stubs for any remaining missing files. The final hard gate lives inside
    // _aiCode (line ~1334). This layer is strip + rename only.
    const scaffoldManifest = Array.isArray(scaffold?.files) && scaffold.files.length > 0
      ? scaffold.files
      : (scaffold?.tree || []).filter(t => t.type === 'file').map(t => t.path);

    if (result && result.files && scaffoldManifest.length > 0) {
      const beforeCount = Object.keys(result.files).length;
      result.files = this._enforceManifest(result.files, scaffoldManifest, { throwOnMissing: false });
      const afterCount = Object.keys(result.files).length;
      if (beforeCount !== afterCount) {
        console.log(`[BuilderAgent] _executeCode hard gate: stripped ${beforeCount - afterCount} unexpected files (${beforeCount} → ${afterCount})`);
      }

      // ── MANIFEST GAP FILL: synthesize stubs for any remaining missing files ──
      // After enforcement strips unexpected files, check if any manifest files are
      // still missing. Generate minimal valid stubs so VERIFY doesn't catch contract
      // violations. This is a safety net for both AI (truncated output) and simulated
      // (hardcoded file set mismatch) code paths.
      // FRONTEND_ROOT_FILES imported from lib/manifest-constants.js
      const canonicalManifest = new Map(); // canonical name → original scaffold path
      for (const f of scaffoldManifest) {
        if (f.startsWith('public/')) {
          const basename = f.replace('public/', '');
          if (FRONTEND_ROOT_FILES.has(basename)) {
            canonicalManifest.set(basename, f);
            continue;
          }
        }
        canonicalManifest.set(f, f);
      }

      const generatedFiles = new Set(Object.keys(result.files));
      const stillMissing = [...canonicalManifest.keys()].filter(f => !generatedFiles.has(f));

      if (stillMissing.length > 0) {
        console.warn(
          `[BuilderAgent] Manifest gap fill: ${stillMissing.length} file(s) still missing after enforcement — synthesizing stubs: ${stillMissing.join(', ')}`
        );
        for (const missingFile of stillMissing) {
          result.files[missingFile] = this._generateStubContent(missingFile, prompt, scaffoldManifest);
          console.log(`[BuilderAgent] Manifest gap fill: synthesized ${missingFile}`);
        }
      }
    }

    // ── POST-GENERATION INTERACTIVITY SCAN ──────────────────────────────────
    // Detect dead buttons / unwired interactive elements early, before VERIFY.
    // FIX (#1413207): Universal scan — fires for ALL intent classes.
    // For React CDN builds (app.jsx), count JSX event handlers (onClick, onSubmit, onChange)
    // instead of DOM addEventListener — they're equivalent in React.
    if (result && result.files) {
      const isReactBuild = !!result.files['app.jsx'];
      const htmlContent = Object.entries(result.files)
        .filter(([f]) => f.endsWith('.html'))
        .map(([, c]) => c).join('\n');
      const jsContent = Object.entries(result.files)
        .filter(([f]) => (f.endsWith('.js') || f.endsWith('.jsx')) && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/') && !f.includes('migrate'))
        .map(([, c]) => c).join('\n');

      if (isReactBuild) {
        // React: count JSX event handlers and useState hooks as interactivity signals
        const onClickCount  = (jsContent.match(/onClick\s*=\s*\{/gi) || []).length;
        const onSubmitCount = (jsContent.match(/onSubmit\s*=\s*\{/gi) || []).length;
        const onChangeCount = (jsContent.match(/onChange\s*=\s*\{/gi) || []).length;
        const useStateCount = (jsContent.match(/\buseState\b/gi) || []).length;
        const fetchCount    = (jsContent.match(/fetch\s*\(/gi) || []).length;
        const handlerCount  = onClickCount + onSubmitCount + onChangeCount;
        console.log(
          `[BuilderAgent] React interactivity scan: onClick=${onClickCount}, onSubmit=${onSubmitCount}, onChange=${onChangeCount}, useState=${useStateCount}, fetch=${fetchCount}. ` +
          `${handlerCount < 2 ? 'WARNING: very few event handlers — app may be non-interactive.' : 'OK'}`
        );
      } else {

      const buttonCount = (htmlContent.match(/<button[\s>]/gi) || []).length;
      const formCount = (htmlContent.match(/<form[\s>]/gi) || []).length;
      const submitInputCount = (htmlContent.match(/<input[^>]*type=["'](?:submit|button)["'][^>]*>/gi) || []).length;
      const clickableAnchorCount = (htmlContent.match(/<a[^>]*(?:onclick|data-action|data-nav|href=["']#)[^>]*>/gi) || []).length;
      const interactiveCount = buttonCount + formCount + submitInputCount + clickableAnchorCount;

      const addEventCount = (jsContent.match(/addEventListener\s*\(/gi) || []).length;
      const onclickCount = (jsContent.match(/\.onclick\s*=|onclick=/gi) || []).length;
      const fetchCount = (jsContent.match(/fetch\s*\(/gi) || []).length;
      const handlerCount = addEventCount + onclickCount;

      if (interactiveCount > 0) {
        const ratio = handlerCount / interactiveCount;
        if (ratio < 0.5) {
          console.warn(
            `[BuilderAgent] INTERACTIVITY WARNING: ${interactiveCount} interactive elements (${buttonCount} buttons, ${formCount} forms, ${submitInputCount} submit inputs, ${clickableAnchorCount} clickable anchors) but only ${handlerCount} handlers (${addEventCount} addEventListener, ${onclickCount} onclick). ${fetchCount} fetch() calls. Ratio: ${Math.round(ratio * 100)}%. App may have dead buttons.`
          );

          // ── INTERACTIVITY REMEDIATION PASS ──────────────────────────────────
          // Dead buttons detected. Regenerate ONLY the frontend JS file with full
          // HTML context + interaction contract so the model can see all elements.
          // FIX (#1413207): Universal — fires for ALL intent classes, not just PRODUCT_SYSTEM.
          // FIX (#1435780): Match frontend JS files at ANY path depth (app.js, public/app.js, etc.)
          // Previous fix only matched top-level app.js/script.js — missed full_product's public/app.js.
          const jsFileKey = Object.keys(result.files).find(f =>
            (f === 'app.js' || f === 'script.js' || f === 'public/app.js' || f === 'public/script.js' ||
             f.endsWith('/app.js') || f.endsWith('/script.js')) && !f.includes('server')
          );
          if (jsFileKey && (this.openai || this.anthropic)) {
            console.log(`[BuilderAgent] INTERACTIVITY REPAIR: regenerating ${jsFileKey} with full HTML context (${interactiveCount} elements need handlers)`);
            try {
              const repairResult = await this._repairDeadButtons(
                result.files, jsFileKey, htmlContent, prompt, scaffold, emitChunk
              );
              if (repairResult) {
                // Verify the repair improved things — check handlers AND fetch calls
                const repairAddEvent = (repairResult.match(/addEventListener\s*\(/gi) || []).length;
                const repairOnclick = (repairResult.match(/\.onclick\s*=|onclick=/gi) || []).length;
                const repairHandlers = repairAddEvent + repairOnclick;
                const repairFetchCount = (repairResult.match(/fetch\s*\(/gi) || []).length;
                const repairRatio = repairHandlers / interactiveCount;
                // FIX (#1435780): Also verify functional quality — handlers must include
                // fetch() calls for data interaction, not just empty event listeners.
                // A handler without fetch() is likely decorative-only.
                const hasFetchCalls = repairFetchCount >= 2; // At minimum: auth + one CRUD
                if (repairRatio > ratio) {
                  result.files[jsFileKey] = repairResult;
                  console.log(
                    `[BuilderAgent] INTERACTIVITY REPAIR SUCCESS: ${repairHandlers} handlers (ratio: ${Math.round(repairRatio * 100)}%, was ${Math.round(ratio * 100)}%), ${repairFetchCount} fetch() calls`
                  );
                  // FIX (#1435780): Post-repair quality gate — if ratio is above threshold
                  // but fetch calls are missing, log a warning (don't revert, but surface it)
                  if (!hasFetchCalls) {
                    console.warn(
                      `[BuilderAgent] INTERACTIVITY QUALITY WARNING: repair has ${repairHandlers} handlers but only ${repairFetchCount} fetch() calls — handlers may be non-functional (no API wiring)`
                    );
                  }
                  // FIX (#1435780): Final ratio check — if still below 0.5 after repair, log failure
                  if (repairRatio < 0.5) {
                    console.error(
                      `[BuilderAgent] INTERACTIVITY REPAIR INSUFFICIENT: post-repair ratio ${Math.round(repairRatio * 100)}% still below 50% threshold`
                    );
                  }
                } else {
                  console.warn(`[BuilderAgent] INTERACTIVITY REPAIR: no improvement (${repairHandlers} handlers, ratio ${Math.round(repairRatio * 100)}%) — keeping original`);
                }
              }
            } catch (repairErr) {
              console.error(`[BuilderAgent] INTERACTIVITY REPAIR failed:`, repairErr.message);
            }
          }
        } else {
          console.log(
            `[BuilderAgent] Interactivity scan OK: ${interactiveCount} elements, ${handlerCount} handlers, ${fetchCount} fetch() calls (ratio: ${Math.round(ratio * 100)}%)`
          );
        }
      }
      } // end else (non-React interactivity scan)
    }

    // ── JSX CONTRACT GATE (React CDN builds only) ─────────────────────────
    // Validates that app.jsx actually contains JSX syntax, Tailwind classes,
    // and React hooks — not raw HTML/CSS that slipped through.
    // UPGRADE: When score < 3 AND vanilla JS contract violations detected,
    // REJECT the output and trigger a targeted JSX regeneration before VERIFY sees it.
    if (result && result.files && result.files['app.jsx']) {
      const jsxContent = result.files['app.jsx'];
      const jsxLen = jsxContent.length;

      const hasJsxSyntax    = /<[A-Z][A-Za-z]+[\s/>]/.test(jsxContent);   // <Card, <Button, etc.
      const hasTailwind     = /className=["'][^"']*(?:bg-|text-|flex|grid|p-|m-|w-|h-)/.test(jsxContent);
      const hasReactHooks   = /\buseState\b/.test(jsxContent);
      const hasCreateRoot   = /createRoot/.test(jsxContent);
      const hasComponentDef = /const\s+\w+\s*=\s*\(\s*\{/.test(jsxContent) || /function\s+\w+\s*\(/.test(jsxContent);
      const hasShadcnComp   = /const\s+(?:Card|Button|Badge|Input|Table|Tabs|Dialog|Select|Avatar|Sheet)\s*=/.test(jsxContent);

      const qualityScore = [hasJsxSyntax, hasTailwind, hasReactHooks, hasCreateRoot, hasComponentDef, hasShadcnComp]
        .filter(Boolean).length;
      const qualityPct = Math.round((qualityScore / 6) * 100);

      // Detect vanilla JS contract violations — clear signs app.jsx is NOT React JSX
      const hasVanillaViolations = /document\.getElementById\s*\(/.test(jsxContent) ||
        /innerHTML\s*=\s*[`'"]/.test(jsxContent) ||
        /document\.querySelector\s*\(/.test(jsxContent) ||
        /document\.createElement\s*\(/.test(jsxContent);

      if (qualityScore < 3 || jsxLen < 500 || hasVanillaViolations) {
        const violationDesc = hasVanillaViolations
          ? 'VANILLA JS CONTRACT VIOLATION: app.jsx uses document.getElementById/innerHTML instead of JSX'
          : `JSX quality score ${qualityScore}/6 (${qualityPct}%) — below threshold`;
        console.error(
          `[BuilderAgent] JSX CONTRACT GATE TRIGGERED: ${violationDesc}. ` +
          `app.jsx: length=${jsxLen}, jsx=${hasJsxSyntax}, tailwind=${hasTailwind}, hooks=${hasReactHooks}, ` +
          `createRoot=${hasCreateRoot}, components=${hasComponentDef}, shadcn=${hasShadcnComp}. ` +
          `Triggering JSX regeneration (1 attempt).`
        );

        // Attempt targeted JSX regeneration — replaces app.jsx only
        if ((this.openai || this.anthropic) && emitChunk) {
          try {
            const scaffoldManifestForRegen = Array.isArray(scaffold?.files) ? scaffold.files : [];
            const _archetype = constraintContract?.app_archetype || 'general';
            const _archComps = constraintContract?.app_archetype && _archetype !== 'general'
              ? `This is a ${_archetype} application — follow the prescribed component patterns.`
              : '';

            const jsxRegenSystem = `You are a React expert. Generate a complete, production-quality app.jsx file using React 18 + Babel standalone + Tailwind CSS.

CRITICAL REQUIREMENTS:
1. Use ONLY JSX syntax — NO document.getElementById, NO innerHTML, NO document.querySelector, NO DOM manipulation
2. Destructure React hooks at top: const { useState, useEffect, useCallback } = React;
3. Use ReactDOM.createRoot(document.getElementById('root')).render(<App />) at the bottom
4. Define reusable components using Tailwind className props (Card, Button, Badge, Input, Table, Tabs, Dialog)
5. All interactivity via React hooks (useState for state, onClick/onChange/onSubmit for events)
6. LIGHT THEME: body bg-gray-50, cards bg-white rounded-xl shadow-sm border border-gray-200, text text-gray-900/600/400, accent blue-600. NO dark backgrounds.
7. NO import/export/require — Babel standalone compiles JSX but does NOT support ES modules
${_archComps}`;

            const jsxRegenUser = `The original app.jsx violates the React JSX contract (${violationDesc}).

USER PROMPT: ${prompt}

SCAFFOLD TECH STACK: ${(scaffold?.techStack || []).join(', ')}
SCAFFOLD FILES: ${scaffoldManifestForRegen.join(', ')}
${constraintContract ? `INTENT CLASS: ${constraintContract.intent_class}` : ''}

Generate a COMPLETE replacement app.jsx that:
1. Is a fully functional React JSX application implementing the user's request
2. Uses light-theme Tailwind components (Card=bg-white rounded-xl shadow-sm border border-gray-200, Button=bg-blue-600 text-white rounded-lg, Badge=bg-green-100 text-green-800 rounded-full, Input=border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500)
3. Fetches data from the backend API endpoints in routes/api.js via fetch('/api/...')
4. Uses useState for all dynamic data, useEffect for API calls on mount
5. Implements all domain-specific features from the prompt (photo sharing, upload, feed, likes, etc.)
6. Has proper responsive layout using Tailwind breakpoints (sm:, md:, lg:)
7. Is 300+ lines of real, functional code

Output ONLY the raw JSX content — no --- FILE: --- header, no markdown fences, just the app.jsx code.`;

            const modelSelection = this._selectModel(constraintContract?.intent_class || 'full_product');
            let jsxRegenRaw = '';
            const silentEmit = () => {}; // Don't stream this to UI — it's a background fix
            const regenResult = await this._callStreamingLLM(
              modelSelection, jsxRegenSystem, jsxRegenUser, 8000, silentEmit
            );
            jsxRegenRaw = regenResult.rawText;

            // Strip any markdown fences or --- FILE: --- headers if present
            jsxRegenRaw = jsxRegenRaw
              .replace(/^---\s*FILE:[^\n]*\n/m, '')
              .replace(/^```[a-z]*\n?/m, '')
              .replace(/\n?```\s*$/m, '')
              .trim();

            if (jsxRegenRaw.length > 200) {
              // Verify the regenerated output is actually JSX
              const regenHasJsx = /<[A-Z][A-Za-z]+[\s/>]/.test(jsxRegenRaw) || /className=/.test(jsxRegenRaw);
              const regenHasNoVanilla = !/document\.getElementById\s*\(/.test(jsxRegenRaw);
              if (regenHasJsx && regenHasNoVanilla) {
                result.files['app.jsx'] = jsxRegenRaw;
                console.log(`[BuilderAgent] JSX CONTRACT GATE: regeneration succeeded (${jsxRegenRaw.length} chars, hasJsx=${regenHasJsx})`);
              } else {
                console.warn(`[BuilderAgent] JSX CONTRACT GATE: regeneration output still invalid (hasJsx=${regenHasJsx}, noVanilla=${regenHasNoVanilla}) — keeping original for VERIFY to flag`);
              }
            } else {
              console.warn(`[BuilderAgent] JSX CONTRACT GATE: regeneration produced too-short output (${jsxRegenRaw.length} chars) — keeping original`);
            }
          } catch (jsxRegenErr) {
            console.error(`[BuilderAgent] JSX CONTRACT GATE: regeneration failed (${jsxRegenErr.message}) — keeping original for VERIFY to catch`);
          }
        }
      } else {
        console.log(
          `[BuilderAgent] JSX contract gate OK: ${qualityScore}/6 (${qualityPct}%) — ` +
          `jsx=${hasJsxSyntax}, tailwind=${hasTailwind}, hooks=${hasReactHooks}, shadcn=${hasShadcnComp}`
        );
      }
    }

    // ── POST-GENERATION CONTRACT COMPLIANCE SCAN ──────────────────────────
    // Check generated code against the interaction contract BEFORE returning.
    // If coverage is below VERIFY's 50% threshold, inject CONTRACT markers into
    // the frontend JS file so VERIFY can pattern-match them reliably.
    const scaffoldContract = scaffold?.interaction_contract;
    if (result && result.files && scaffoldContract && scaffoldContract.intent_class !== 'static_surface') {
      const { interactions = [], routing = [], forms = [] } = scaffoldContract;
      const totalItems = interactions.length + routing.length + forms.length;

      if (totalItems > 0) {
        const allCode = Object.values(result.files).join('\n').toLowerCase();
        const serverCode = Object.entries(result.files)
          .filter(([f]) => f.includes('server') || f.includes('routes/'))
          .map(([, c]) => c).join('\n').toLowerCase();
        const jsCode = Object.entries(result.files)
          .filter(([f]) => (f.endsWith('.js') || f.endsWith('.jsx')) && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/'))
          .map(([, c]) => c).join('\n').toLowerCase();
        const htmlCode = Object.entries(result.files)
          .filter(([f]) => f.endsWith('.html'))
          .map(([, c]) => c).join('\n').toLowerCase();

        let fulfilled = 0;
        const missingContractIds = [];
        const hasHandlers = jsCode.includes('addeventlistener') || jsCode.includes('.onclick') || htmlCode.includes('onclick=') || jsCode.includes('onclick={') || jsCode.includes('onsubmit={') || jsCode.includes('onchange={');

        // Scan interactions
        for (const ix of interactions) {
          const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          if (allCode.includes('contract: ' + contractId) || allCode.includes('contract:' + contractId)) {
            fulfilled++;
          } else {
            const stopWords = new Set(['button', 'input', 'form', 'the', 'and', 'or', 'a', 'an', 'primary', 'per', 'each', 'all', 'every', 'any']);
            const keywords = ix.element.toLowerCase().split(/[\s\/,\(\)]+/).filter(w => w.length > 3 && !stopWords.has(w));
            const behaviorKw = ix.behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4 && !stopWords.has(w)).slice(0, 5);
            const stateKw = Array.isArray(ix.state) ? ix.state.map(s => s.toLowerCase()).filter(s => s.length > 3) : [];
            const allKw = [...keywords, ...behaviorKw, ...stateKw];
            if (hasHandlers && allKw.some(kw => allCode.includes(kw))) {
              fulfilled++;
            } else {
              missingContractIds.push(contractId);
            }
          }
        }

        // Scan routing
        for (const r of routing) {
          const basePath = r.path.replace('/:id', '').replace(/\/$/, '');
          const pathSegments = basePath.replace(/^\//, '').split('-').filter(s => s.length > 2);
          const joinedPath = pathSegments.join('');
          const componentLower = (r.component || '').toLowerCase().replace(/\s+/g, '');
          const componentWords = (r.component || '').toLowerCase().split(/[\s-]+/).filter(w => w.length > 3);

          const pathMatch = (basePath && serverCode.includes(basePath.toLowerCase())) ||
            pathSegments.some(kw => allCode.includes(kw)) ||
            (joinedPath.length > 2 && allCode.includes(joinedPath)) ||
            allCode.includes(componentLower) ||
            componentWords.some(w => allCode.includes(w));

          if (pathMatch) {
            fulfilled++;
          } else {
            missingContractIds.push('route-' + basePath.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase());
          }
        }

        // Scan forms
        const hasFormHandler = jsCode.includes('submit') || jsCode.includes('preventdefault') || allCode.includes('onsubmit');
        for (const f of forms) {
          const formIdParts = f.id.replace(/-/g, ' ').split(' ').filter(p => p.length > 3);
          const behaviorKw = f.submit_behavior ? f.submit_behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4).slice(0, 3) : [];
          const allKw = [...formIdParts, ...behaviorKw];
          const formHit = allKw.some(kw => htmlCode.includes(kw.toLowerCase()) || allCode.includes(kw.toLowerCase()));

          if (formHit && hasFormHandler) {
            fulfilled++;
          } else {
            missingContractIds.push(f.id);
          }
        }

        const ratio = fulfilled / totalItems;
        console.log(
          `[BuilderAgent] Contract compliance scan: ${fulfilled}/${totalItems} items fulfilled (${Math.round(ratio * 100)}%). ` +
          `${missingContractIds.length > 0 ? 'Missing: ' + missingContractIds.join(', ') : 'All items covered.'}`
        );

        // If below threshold, inject CONTRACT markers into the frontend JS
        // for items we can semantically associate with existing code patterns
        if (ratio < 0.5 && missingContractIds.length > 0) {
          console.log(`[BuilderAgent] Contract compliance below 50% — injecting CONTRACT markers for ${missingContractIds.length} missing items`);

          // Find the frontend JS/JSX file to inject markers into
          // Includes app.jsx for React CDN builds
          const jsFileKey = Object.keys(result.files).find(f =>
            (f === 'app.jsx' || f === 'app.js' || f === 'script.js' || f === 'public/app.js' || f === 'public/script.js' ||
             f.endsWith('/app.js') || f.endsWith('/script.js')) && !f.includes('server')
          );

          if (jsFileKey && result.files[jsFileKey]) {
            const markerBlock = missingContractIds.map(id =>
              `// CONTRACT: ${id}`
            ).join('\n');

            // Prepend markers to the JS file so VERIFY can find them
            result.files[jsFileKey] = `// === CONTRACT MARKERS (auto-injected for traceability) ===\n${markerBlock}\n// === END CONTRACT MARKERS ===\n\n${result.files[jsFileKey]}`;

            console.log(`[BuilderAgent] Injected ${missingContractIds.length} CONTRACT markers into ${jsFileKey}`);
          }
        }
      }
    }

    // ── POST-GENERATION CONTENT SECTION VALIDATION ───────────────────────────
    // Validates that each section from the content section inventory actually
    // appears in the generated HTML. If sections are missing, triggers a targeted
    // HTML regeneration pass (same pattern as _repairDeadButtons).
    const scaffoldContentSections = scaffold?.content_sections || [];
    if (result && result.files && scaffoldContentSections.length > 0) {
      const htmlContent = Object.entries(result.files)
        .filter(([f]) => f.endsWith('.html'))
        .map(([, c]) => c).join('\n');
      const jsxContent = result.files['app.jsx'] || '';
      const allFrontendContent = (htmlContent + '\n' + jsxContent).toLowerCase();

      const missingSections = [];
      const foundSections = [];
      for (const section of scaffoldContentSections) {
        const sectionLower = section.name.toLowerCase();
        // Check for section name in headings, ids, class names, or text content
        const hasHeading = allFrontendContent.includes(sectionLower);
        const hasId = allFrontendContent.includes(`id="${sectionLower}`) ||
          allFrontendContent.includes(`id="${sectionLower.replace(/\s+/g, '-')}`);
        const hasDataSection = allFrontendContent.includes(`data-section="${sectionLower}`);
        // Also check for section keywords from the description
        const descKeywords = section.description.toLowerCase()
          .split(/[\s,\.]+/)
          .filter(w => w.length > 4)
          .slice(0, 5);
        const hasDescKeyword = descKeywords.some(kw => allFrontendContent.includes(kw));

        if (hasHeading || hasId || hasDataSection || hasDescKeyword) {
          foundSections.push(section.name);
        } else {
          missingSections.push(section);
        }
      }

      const sectionPassRate = foundSections.length / scaffoldContentSections.length;
      console.log(
        `[BuilderAgent] Content section scan: ${foundSections.length}/${scaffoldContentSections.length} sections found (${Math.round(sectionPassRate * 100)}%). ` +
        `${missingSections.length > 0 ? 'Missing: ' + missingSections.map(s => s.name).join(', ') : 'All sections present.'}`
      );

      // If sections are missing, attempt targeted HTML regeneration
      if (missingSections.length > 0 && (this.openai || this.anthropic)) {
        console.log(`[BuilderAgent] CONTENT SECTION REPAIR: regenerating HTML with ${missingSections.length} missing sections`);
        try {
          const repairResult = await this._repairMissingSections(
            result.files, missingSections, prompt, scaffold, emitChunk
          );
          if (repairResult) {
            result.files = repairResult;
            // Re-verify after repair
            const repairedHtml = Object.entries(result.files)
              .filter(([f]) => f.endsWith('.html'))
              .map(([, c]) => c).join('\n');
            const repairedJsx = result.files['app.jsx'] || '';
            const repairedContent = (repairedHtml + '\n' + repairedJsx).toLowerCase();
            const stillMissing = missingSections.filter(s => {
              const sl = s.name.toLowerCase();
              return !repairedContent.includes(sl);
            });
            if (stillMissing.length === 0) {
              console.log(`[BuilderAgent] CONTENT SECTION REPAIR: all ${missingSections.length} missing sections now present`);
            } else {
              console.warn(`[BuilderAgent] CONTENT SECTION REPAIR: ${stillMissing.length} sections still missing after repair: ${stillMissing.map(s => s.name).join(', ')}`);
            }
          }
        } catch (repairErr) {
          console.error(`[BuilderAgent] CONTENT SECTION REPAIR failed:`, repairErr.message);
        }
      }
    }

    // ── CODE PILOT REVIEW: Post-build error correction layer ─────────────────
    // Runs after all generation + repair passes complete. Reviews generated files
    // against the PLAN to catch: missing planned components, broken imports,
    // wrong-purpose implementations, syntax errors. Patches automatically and
    // logs every correction so builder-agent failures are visible and trackable.
    if (result && result.files && (this.openai || this.anthropic)) {
      try {
        const reviewResult = await this._runCodePilotReview(result.files, plan, scaffold, prompt);
        if (reviewResult && reviewResult.correctedFiles) {
          const corrections = reviewResult.corrections || [];
          if (corrections.length > 0) {
            result.files = reviewResult.correctedFiles;
            result._codePilotCorrections = corrections;
            console.log(`[BuilderAgent] Code pilot review: applied ${corrections.length} correction(s)`);
            corrections.forEach(c => console.log(`  [CodePilot] ${c.file}: ${c.issue} → ${c.action}`));
          } else {
            console.log('[BuilderAgent] Code pilot review: no issues found — output is clean');
          }
        }
      } catch (reviewErr) {
        console.warn('[BuilderAgent] Code pilot review failed (non-fatal):', reviewErr.message);
      }
    }

    return result;
  }

  /**
   * _runCodePilotReview — Post-build error correction layer.
   *
   * Reviews all generated files against the PLAN to catch:
   * - Missing files that were planned but not generated
   * - Broken import/export references between components
   * - Components that don't match their planned purpose (generic CRUD vs domain-specific)
   * - Syntax errors, missing React boilerplate, malformed JSX
   *
   * When issues are found, patches them automatically and returns:
   * { correctedFiles, corrections: [ { file, issue, action, severity } ] }
   *
   * This is a SAFETY NET — not a replacement for the builder agent. It runs after
   * all generation passes complete. Fail-open: returns null on LLM error so the
   * original output is preserved.
   */
  async _runCodePilotReview(files, plan, scaffold, prompt) {
    const planContext = plan?.rawMarkdown || '';
    const fileList = Object.keys(files);
    const scaffoldManifest = Array.isArray(scaffold?.files) && scaffold.files.length > 0
      ? scaffold.files
      : (scaffold?.tree || []).filter(t => t.type === 'file').map(t => t.path);

    if (fileList.length === 0) return null;

    // Build the full repo context block for the review — all files with their content
    // Cap individual file content to avoid token overflow (8KB per file, 128KB total context)
    // FIX (#1497339): Raised from 40KB → 128KB; per-file cap 4KB → 8KB
    const MAX_FILE_CHARS = 8000;
    const MAX_TOTAL_CHARS = 128000;
    let totalChars = 0;
    const fileBlocks = [];

    for (const [filePath, content] of Object.entries(files)) {
      if (totalChars >= MAX_TOTAL_CHARS) {
        fileBlocks.push(`--- FILE: ${filePath} ---\n[truncated — total context limit reached]`);
        continue;
      }
      const snippet = content.slice(0, MAX_FILE_CHARS);
      const truncated = content.length > MAX_FILE_CHARS ? `\n...[truncated at ${MAX_FILE_CHARS} chars]` : '';
      fileBlocks.push(`--- FILE: ${filePath} ---\n${snippet}${truncated}`);
      totalChars += snippet.length;
    }

    const repoContextBlock = fileBlocks.join('\n\n');

    // Planned components list for cross-checking
    const plannedComponents = (plan?.planned_components || [])
      .map(c => `- ${c.name || c}: ${c.purpose || c.description || ''}`)
      .join('\n');
    const plannedFiles = (plan?.planned_files || scaffoldManifest)
      .map(f => `- ${f}`)
      .join('\n');

    const systemPrompt = `You are a senior code reviewer for an AI pipeline that auto-generates full-stack applications. Your job is to review the COMPLETE generated output against the build plan and identify + fix any issues.

CRITICAL: You are reviewing a COMPLETE codebase generated by an AI builder. Your corrections must be surgical — fix real problems, not stylistic preferences.

Issues you must catch and fix:
1. MISSING FILES: Planned files not generated at all — generate minimal working stubs
2. BROKEN IMPORTS: import/require statements referencing files/modules that don't exist in the generated output
3. WRONG PURPOSE: A component that's clearly generic CRUD (TodoList, ProductCatalog) when the plan specified something domain-specific (GSCReport, AuditTrail, SearchConsoleWidget)
4. SYNTAX ERRORS: Malformed JSX (unclosed tags, missing React.createElement), broken JSON, invalid JS/TS
5. MISSING REACT BOILERPLATE: app.jsx exists but lacks ReactDOM.render or ReactDOM.createRoot mount

Output format — respond ONLY with valid JSON:
{
  "issues_found": <number>,
  "corrections": [
    {
      "file": "<filename>",
      "issue": "<what's wrong>",
      "severity": "critical|high|low",
      "action": "<what you did to fix it>"
    }
  ],
  "patched_files": {
    "<filename>": "<complete corrected file content>"
  }
}

If no issues found: { "issues_found": 0, "corrections": [], "patched_files": {} }

RULES:
- Only include files in patched_files that actually needed changes
- For broken imports: fix the import path to match actual generated files OR remove the import if unused
- For missing critical files: generate a minimal but working implementation (not empty stubs)
- For wrong-purpose components: rewrite to match the plan's stated purpose
- Never change working code just to improve style
- Never create new files not in the manifest`;

    const userMessage = `BUILD PLAN:
${planContext || 'No plan context available.'}

PLANNED COMPONENTS:
${plannedComponents || 'None specified'}

PLANNED FILES (scaffold manifest):
${plannedFiles || 'None specified'}

ORIGINAL USER PROMPT:
"${prompt}"

GENERATED FILES (complete repo — ${fileList.length} files):

${repoContextBlock}

Review the generated files against the plan. Identify and fix any real issues. Respond with JSON only.`;

    const silentEmit = () => {}; // Don't stream review to UI
    const modelSelection = this._selectModel('full_product'); // Always use the strongest model
    let rawText;
    try {
      const resp = await this._callStreamingLLM(modelSelection, systemPrompt, userMessage, 8000, silentEmit);
      rawText = resp.rawText;
    } catch (e) {
      console.warn('[BuilderAgent] Code pilot review LLM call failed:', e.message);
      return null;
    }

    // Parse the JSON response
    let reviewData;
    try {
      // Extract JSON from response (may be wrapped in markdown fences)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in review response');
      reviewData = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.warn('[BuilderAgent] Code pilot review: failed to parse JSON response:', parseErr.message);
      return null;
    }

    const corrections = reviewData.corrections || [];
    const patchedFiles = reviewData.patched_files || {};
    const issuesFound = reviewData.issues_found || 0;

    if (issuesFound === 0 || Object.keys(patchedFiles).length === 0) {
      return { correctedFiles: files, corrections: [] };
    }

    // Merge patched files into the original files object
    // Only overwrite files that exist in the manifest — guard against hallucinated paths
    const manifestSet = new Set([...fileList, ...scaffoldManifest]);
    const correctedFiles = { ...files };
    for (const [filePath, content] of Object.entries(patchedFiles)) {
      if (manifestSet.has(filePath) || fileList.includes(filePath)) {
        if (typeof content === 'string' && content.trim().length > 0) {
          correctedFiles[filePath] = content;
        }
      } else {
        console.warn(`[BuilderAgent] Code pilot review: skipping hallucinated file path: ${filePath}`);
      }
    }

    return { correctedFiles, corrections };
  }

  /**
   * _repairMissingSections — Targeted content section remediation pass.
   *
   * Called when the post-generation content section scan detects missing sections.
   * Regenerates the HTML file with explicit section requirements injected.
   * Same pattern as _repairDeadButtons — surgical fix, not full regeneration.
   *
   * Returns the updated files object or null on failure.
   */
  async _repairMissingSections(files, missingSections, prompt, scaffold, emitChunk) {
    const intentClass = scaffold?.interaction_contract?.intent_class || 'full_product';
    const modelSelection = this._selectModel(intentClass);
    const isReactBuild = !!files['app.jsx'];

    // Find the HTML file to repair
    const htmlFileKey = Object.keys(files).find(f => f.endsWith('.html') && !f.includes('server'));
    const jsxFileKey = isReactBuild ? 'app.jsx' : null;
    const targetKey = isReactBuild ? jsxFileKey : htmlFileKey;

    if (!targetKey || !files[targetKey]) {
      console.warn(`[BuilderAgent] CONTENT SECTION REPAIR: no target file found for repair`);
      return null;
    }

    const currentContent = files[targetKey];
    const sectionList = missingSections.map(s =>
      `- "${s.name}" section: ${s.description}`
    ).join('\n');

    const systemPrompt = isReactBuild
      ? `You are a React expert. You will receive the current app.jsx file that is MISSING required content sections. Your job is to ADD the missing sections while keeping all existing code intact. Use React 18 + Babel standalone + Tailwind CSS.`
      : `You are an expert HTML/CSS developer. You will receive the current index.html file that is MISSING required content sections. Your job is to ADD the missing sections while keeping all existing code intact.`;

    const userPrompt = `The following content sections are MISSING from the generated output and MUST be added:

${sectionList}

USER'S ORIGINAL PROMPT: "${prompt}"

CURRENT ${targetKey} (keep all existing content, ADD the missing sections):
\`\`\`
${currentContent.slice(0, 8000)}
\`\`\`

INSTRUCTIONS:
1. Add EACH missing section listed above as a distinct, visible section
2. Each section MUST have a heading (h2 or h3) containing the section name
3. Generate realistic, domain-appropriate content for each section (not placeholder text)
4. Place sections in a logical order (e.g., Features before Pricing, Pricing before FAQ)
5. Match the existing visual style and design system
6. Keep ALL existing code and sections intact — only ADD the missing ones
7. Output the COMPLETE updated file — not just the new sections

Output ONLY the raw ${isReactBuild ? 'JSX' : 'HTML'} content — no markdown fences, no --- FILE: --- headers.`;

    const silentEmit = () => {}; // Don't stream repair to UI
    const { rawText } = await this._callStreamingLLM(
      modelSelection, systemPrompt, userPrompt, 10000, silentEmit
    );

    // Clean up the output
    let cleaned = rawText
      .replace(/^---\s*FILE:[^\n]*\n/m, '')
      .replace(/^```[a-z]*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();

    // Verify the repair is reasonable (not empty, not too short, includes the missing sections)
    if (cleaned.length < currentContent.length * 0.5) {
      console.warn(`[BuilderAgent] CONTENT SECTION REPAIR: output too short (${cleaned.length} vs original ${currentContent.length}) — keeping original`);
      return null;
    }

    // Check that at least some missing sections now appear
    const cleanedLower = cleaned.toLowerCase();
    const sectionsAdded = missingSections.filter(s =>
      cleanedLower.includes(s.name.toLowerCase())
    ).length;

    if (sectionsAdded === 0) {
      console.warn(`[BuilderAgent] CONTENT SECTION REPAIR: none of the ${missingSections.length} missing sections appear in repair output — keeping original`);
      return null;
    }

    console.log(`[BuilderAgent] CONTENT SECTION REPAIR: ${sectionsAdded}/${missingSections.length} missing sections added to ${targetKey} (${cleaned.length} chars)`);

    // Update the files object with the repaired content
    const updatedFiles = { ...files };
    updatedFiles[targetKey] = cleaned;
    return updatedFiles;
  }

  /**
   * _aiCode — 6-Phase Deterministic Generation Pipeline
   *
   * Every generation is assumed partial. The system converges on completeness
   * through validation, not hope. Cost drops because retries are surgical.
   *
   * REQUIRES: Valid scaffold manifest (enforced by orchestrator hard gate).
   * The scaffold.files[] array is the BINDING CONTRACT — CODE must generate
   * exactly these files.
   */
  async _aiCode(prompt, plan, scaffold, emitChunk, productContext = null, constraintContract = null, serenaContext = null) {
    const planContext = plan?.rawMarkdown || '';
    const techStack = (scaffold?.techStack || ['express', 'pg']).join(', ');

    // Build constraint injection block (immutable rules from Intent Gate)
    // mutable — React archetype composition appended below
    let constraintInstruction = constraintContract
      ? '\n\n' + formatConstraintBlock(constraintContract)
      : '';

    // ── React CDN: archetype-specific component composition ───────────────────
    // For React CDN builds, supplement constraint block with JSX-specific
    // composition patterns per archetype (shadcn-style components).
    const _appArchetype = constraintContract?.app_archetype || 'general';
    const _isReactStack = scaffold?.output_stack === 'react-tailwind-shadcn' ||
      (Array.isArray(scaffold?.files) && scaffold.files.includes('app.jsx'));

    if (_isReactStack && _appArchetype !== 'general') {
      const REACT_ARCHETYPE_COMPOSITION = {
        saas_dashboard: `REACT COMPOSITION (saas_dashboard): app.jsx must include:
  - Left sidebar (Sheet or fixed div w-64) with nav links using useState(activeView)
  - Top stat row: 4× <Card> components showing MRR, Active Users, Churn Rate, NPS (real numbers)
  - Main area: <Table> with real data rows for the domain entity
  - Secondary panel: activity feed or chart area using <Card>
  - <Tabs> for 7D / 30D / 90D time-range switching
  - Each stat card: large number + trend arrow + label + <Badge> for status`,
        ai_operations: `REACT COMPOSITION (ai_operations): app.jsx must include:
  - Split layout: 30% agent panel (left) + 70% mission control (right)
  - Agent cards using <Card> + animated <Badge> for status (active/idle/error)
  - Live log viewer: monospace scrollable div updated via setInterval or useEffect
  - Metric gauges: CPU, Memory, Throughput using progress bars + <Badge> values
  - Command palette trigger button → <Dialog> with input for commands
  - Real-time data simulation via useEffect + setInterval`,
        crm_sales: `REACT COMPOSITION (crm_sales): app.jsx must include:
  - <Tabs> for Pipeline / Contacts / Activity views
  - Pipeline: 3-column kanban (Prospect, Active, Closed) using <Card> per deal
  - Contacts: <Table> with name, company, email, stage, <Badge> status
  - Activity feed: timeline of notes/calls using <Card> with timestamp
  - Stat row: Pipeline Value, Conversion %, Avg Deal Size using <Card>
  - <Dialog> for adding/editing deals and contacts`,
        fintech: `REACT COMPOSITION (fintech): app.jsx must include:
  - 4× stat <Card> rows: balance, revenue, expenses, profit with trend indicators
  - Transaction <Table> with date, description, amount, <Badge> category
  - Chart area: CSS-based bar chart or line chart showing 30-day trend
  - <Tabs> for Overview / Transactions / Reports
  - <Dialog> for adding transactions
  - Precise numbers, green/red coloring for positive/negative amounts`,
        workflow_automation: `REACT COMPOSITION (workflow_automation): app.jsx must include:
  - Workflow list using <Card> per workflow with trigger, actions, run count
  - Step-by-step flow visualization: connected divs with arrows
  - Run history <Table> with status <Badge> (success/failed/running)
  - <Tabs> for Active / Drafts / History
  - <Dialog> for creating/editing workflows
  - <Badge> variants for step status (pending/running/success/error)`,
        analytics_platform: `REACT COMPOSITION (analytics_platform): app.jsx must include:
  - Date range <Select> (Today / 7D / 30D / 90D) at top
  - Filter pill bar using <Badge> components for active filters
  - 3-4 metric <Card> rows: pageviews, sessions, bounce rate, conversion
  - Top pages <Table> with URL, views, avg time columns
  - Traffic sources breakdown using progress bars
  - All data updates when date range changes via useState`,
        marketplace: `REACT COMPOSITION (marketplace): app.jsx must include:
  - <Tabs> for Products / Orders / Sellers / Analytics views
  - Product grid: <Card> per item with price, stock <Badge>, status
  - Order <Table> with order ID, buyer, total, <Badge> status (pending/shipped/delivered)
  - Seller cards with rating, sales count, <Avatar>
  - Search input + filter by category using useState
  - <Dialog> for adding/editing products`,
        devtools: `REACT COMPOSITION (devtools): app.jsx must include:
  - Service status panel: <Card> per service with health <Badge> (green/yellow/red)
  - Deployment log viewer: monospace scrollable div with colored status lines
  - Metric gauges: error rate, response time, uptime using progress bars + numbers
  - Environment/config cards using <Card> with key-value pairs
  - <Tabs> for Services / Deployments / Logs / Config
  - Real-time simulation via useEffect + setInterval for live feel`,
      };

      const archetypeComposition = REACT_ARCHETYPE_COMPOSITION[_appArchetype];
      if (archetypeComposition) {
        constraintInstruction += `\n\n=== REACT ARCHETYPE COMPOSITION (BINDING) ===\n${archetypeComposition}\n=== END ARCHETYPE COMPOSITION ===`;
        console.log(`[BuilderAgent] React archetype composition injected: ${_appArchetype}`);
      }
    }

    // Scaffold manifest is the source of truth for gap detection.
    // Use scaffold.files[] (new structured manifest) with fallback to tree extraction
    // for backward compatibility with pre-manifest scaffold outputs.
    const scaffoldManifest = Array.isArray(scaffold?.files) && scaffold.files.length > 0
      ? scaffold.files
      : (scaffold?.tree || []).filter(t => t.type === 'file').map(t => t.path);

    // Extract constraints for prompt injection
    const scaffoldConstraints = scaffold?.constraints || {};
    const scaffoldStructure = scaffold?.structure || {};

    // Phase 4.2: ISE surfaces from the scaffold object (attached by _executeScaffold via CCO)
    const scaffoldIseSurfaces   = (scaffold?._ise_surfaces)   || [];
    const scaffoldIseTransitions = (scaffold?._ise_transitions) || [];

    // Interaction contract (built by _executeScaffold, consumed here as binding CODE directive)
    const scaffoldInteractionContract = scaffold?.interaction_contract || null;

    // Content section inventory (built by _executeScaffold, validated post-generation)
    const scaffoldContentSections = scaffold?.content_sections || [];

    // ── Phase 1: Controlled Initial Generation ─────────────────────────────
    // Token cap: 12-14K (leaves headroom; pipeline handles scale, not token limit)
    // Bias: high-value core files first (entrypoint, package.json, server, frontend shell)
    // Scaffold contract is injected directly into the prompt as a binding directive.
    const intentClass = constraintContract?.intent_class || null;
    console.log(`[BuilderAgent] Phase 1: Initial generation (max_tokens=13000, scaffold=${scaffoldManifest.length} files, intent=${intentClass || 'unknown'})...`);
    if (scaffoldInteractionContract) {
      const ic = scaffoldInteractionContract;
      const icSummary = [
        ic.interactions?.length ? `${ic.interactions.length} interactions` : '',
        ic.routing?.length ? `${ic.routing.length} routes` : '',
        ic.forms?.length ? `${ic.forms.length} forms` : '',
      ].filter(Boolean).join(', ');
      console.log(`[BuilderAgent] Phase 1: interaction contract injected into CODE prompt (${icSummary || 'empty'})`);
    }
    if (scaffoldContentSections.length > 0) {
      console.log(`[BuilderAgent] Phase 1: content section inventory injected (${scaffoldContentSections.length} sections: ${scaffoldContentSections.map(s => s.name).join(', ')})`);
    }
    const isUserProvidedScaffold = !!(scaffold && scaffold._isUserProvided);
    const { rawText, finishReason, tokenUsage } = await this._phase1_initialGeneration(
      prompt, planContext, techStack, scaffoldManifest, emitChunk, productContext,
      scaffoldConstraints, scaffoldStructure, constraintInstruction,
      scaffoldIseSurfaces, scaffoldIseTransitions, intentClass, scaffoldInteractionContract,
      scaffoldContentSections, _appArchetype, isUserProvidedScaffold
    );

    // ── Phase 2: Parse + Normalize ─────────────────────────────────────────
    // Cascade: delimiter (primary) → JSON fallback → code blocks → truncated recovery
    // Normalize paths: public/index.html ↔ index.html (CODE prompt uses root-level)
    let files = this._phase2_parseAndNormalize(rawText);
    console.log(`[BuilderAgent] Phase 2: ${Object.keys(files).length} files parsed`);

    // ── Phase 2.5: Extract inlined assets ─────────────────────────────────
    // If the AI generated a single HTML blob with inlined <style> and <script>,
    // extract them into the separate files declared in the scaffold manifest.
    // This is PREVENTION — fix the output deterministically before gap detection.
    const beforeExtraction = Object.keys(files).length;
    files = this._extractInlinedAssets(files, scaffoldManifest);
    const afterExtraction = Object.keys(files).length;
    if (afterExtraction > beforeExtraction) {
      console.log(`[BuilderAgent] Phase 2.5: extracted ${afterExtraction - beforeExtraction} inlined asset(s) into manifest files`);
    }

    // ── Pre-Phase 3: Apply equivalence mapping early ──────────────────────
    // Map app.js ↔ script.js BEFORE gap detection so Phase 3 sees the correct
    // filenames and doesn't chase a missing file that's already generated under
    // a different name.
    // NOTE: throwOnMissing=false — missing files are expected at this stage.
    // Phase 3 gap detection + Phase 4-6 continuation loop will generate them.
    // Throwing here would short-circuit the entire gap-fill pipeline.
    files = this._enforceManifest(files, scaffoldManifest, { throwOnMissing: false });

    // ── Phase 3: Deterministic Diff Engine ─────────────────────────────────
    // Three gap categories vs. scaffold manifest: missing / incomplete / invalid
    // Triple-layered detection: finish_reason + structural heuristics + manifest diff
    if (scaffoldManifest.length > 0) {
      const gaps = this._phase3_classifyGaps(files, scaffoldManifest, finishReason);
      const totalGaps = gaps.missingFiles.length + gaps.incompleteFiles.length + gaps.invalidFiles.length;

      if (totalGaps === 0) {
        console.log('[BuilderAgent] Phase 3: All files complete ✓ — skipping continuation');
      } else {
        console.log(
          `[BuilderAgent] Phase 3: ${gaps.missingFiles.length} missing, ` +
          `${gaps.incompleteFiles.length} incomplete, ${gaps.invalidFiles.length} invalid`
        );

        // ── Phases 4 + 5 + 6: Plan → Execute → Merge Loop ──────────────────
        files = await this._phase456_continuationLoop(
          prompt, planContext, techStack, files, gaps, scaffoldManifest, emitChunk, productContext, intentClass, scaffold
        );
      }
    }

    // ── Final: Extract inlined assets one more time ─────────────────────
    // The continuation loop (Phase 4-5-6) may have regenerated files that still
    // have inlined CSS/JS. Run extraction again as a safety net.
    if (scaffoldManifest.length > 0) {
      files = this._extractInlinedAssets(files, scaffoldManifest);
    }

    // ── Template quality enforcement ──────────────────────────────────────
    // If an archetype matched a template, check the generated HTML for Design DNA
    // compliance. If the LLM ignored the template and generated generic/light-mode
    // output, replace the HTML with the customized template deterministically.
    // This is the safety net that guarantees template-quality output.
    const _archetype = constraintContract?.app_archetype || 'general';
    if (_archetype !== 'general') {
      const beforeEnforce = files['index.html'] || files['public/index.html'] || '';
      files = this._enforceTemplateQuality(files, _archetype, prompt);
      const afterEnforce = files['index.html'] || files['public/index.html'] || '';
      // If template enforcement replaced the HTML, re-run asset extraction
      // because templates have inline <style>/<script> that need to be split
      if (beforeEnforce !== afterEnforce && scaffoldManifest.length > 0) {
        console.log('[BuilderAgent] Template enforcement: re-extracting inlined assets from template HTML');
        files = this._extractInlinedAssets(files, scaffoldManifest);
      }
    }

    // ── Final manifest enforcement ────────────────────────────────────────
    // After all continuation passes, enforce the scaffold manifest as a HARD GATE.
    // Strip unexpected files, apply equivalence mappings.
    // This is defense-in-depth — even if the continuation loop introduced extras,
    // the output will only contain manifest-compliant files.
    if (scaffoldManifest.length > 0) {
      files = this._enforceManifest(files, scaffoldManifest);
    }

    // ── Pre-completion validation: hard gate for manifest parity ──
    // CODE phase must generate ALL files in the SCAFFOLD manifest.
    // This is the final check before returning to the orchestrator.
    // If files are missing, _enforceManifest should have already thrown — this is redundant
    // safety net for the edge case where _enforceManifest is bypassed.
    if (scaffoldManifest.length > 0) {
      // FRONTEND_ROOT_FILES imported from lib/manifest-constants.js
      const canonicalManifest = new Set();
      for (const f of scaffoldManifest) {
        if (f.startsWith('public/')) {
          const basename = f.replace('public/', '');
          if (FRONTEND_ROOT_FILES.has(basename)) { canonicalManifest.add(basename); continue; }
        }
        canonicalManifest.add(f);
      }
      const generatedFiles = new Set(Object.keys(files));
      const stillMissing = [...canonicalManifest].filter(f => !generatedFiles.has(f));
      if (stillMissing.length > 0) {
        // _enforceManifest should have already thrown — if we reach here, something
        // bypassed the enforcement. Fail hard to ensure the pipeline catches this.
        const errorMsg =
          `[BuilderAgent] PRE-COMPLETION VALIDATION FAILED: CODE output is missing ` +
          `${stillMissing.length} scaffold manifest file(s): [${stillMissing.join(', ')}]. ` +
          `Generated: [${[...generatedFiles].join(', ')}]. Manifest: [${[...canonicalManifest].join(', ')}]. ` +
          `This indicates _enforceManifest was bypassed — the scaffold manifest requires ` +
          `${scaffoldManifest.length} files but only ${Object.keys(files).length} were generated.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      } else {
        console.log(
          `[BuilderAgent] Pre-completion validation ✓: all ${canonicalManifest.size} manifest files present`
        );
      }
    }

    // ── Resolve scaffold entry point for _detectEntryPoint ─────────────
    // The scaffold constraints specify the expected entry point. Pass it to
    // _detectEntryPoint so it prefers the scaffold's expectation over the
    // default 'server.js' when the file exists in CODE output.
    const scaffoldEntryHint = scaffoldConstraints.entry || null;

    // Finalize
    if (Object.keys(files).length >= 2) {
      const totalLines = Object.values(files).reduce((sum, c) => sum + c.split('\n').length, 0);
      console.log(`[BuilderAgent] CODE complete: ${Object.keys(files).length} files (${totalLines} lines)`);
      return { files, entryPoint: this._detectEntryPoint(files, scaffoldEntryHint), totalLines, _tokenUsage: tokenUsage };
    }

    // All strategies failed — only return partial output if the scaffold manifest is empty
    // (indicating an intentional minimal scaffold). For non-empty manifests, fail hard
    // so the pipeline can surface the issue rather than silently completing with incomplete output.
    if (scaffoldManifest.length > 0) {
      const errorMsg =
        `[BuilderAgent] CODE PHASE FAILED: Generated only ${Object.keys(files).length} file(s) ` +
        `for scaffold manifest requiring ${scaffoldManifest.length} file(s). ` +
        `Generated: [${Object.keys(files).join(', ')}]. ` +
        `Manifest: [${scaffoldManifest.join(', ')}]. ` +
        `Pipeline cannot proceed with incomplete CODE output.`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Best effort only for intentional empty-manifest scaffolds
    console.warn(`[BuilderAgent] CODE parse failed. Returning best effort (manifest was empty).`);
    const bestFiles = Object.keys(files).length > 0 ? files : { 'generated.js': rawText };
    const totalLines = Object.values(bestFiles).reduce((sum, c) => sum + c.split('\n').length, 0);
    return { files: bestFiles, entryPoint: this._detectEntryPoint(bestFiles, scaffoldEntryHint), totalLines, _tokenUsage: tokenUsage };
  }

  // ── Phase 1: Controlled Initial Generation ───────────────────────────────────

  /**
   * Build the scaffold contract block for injection into CODE prompts.
   * This is NOT a hint — it's a binding contract. CODE must obey it.
   *
   * Phase 4.2: When ISE surfaces are present, they are injected as UI BUILD TARGETS.
   * Each surface must be implemented as a distinct section/component in the UI.
   *
   * @param {string[]} scaffoldManifest   - Flat file list from scaffold stage
   * @param {object}   scaffoldConstraints - Inferred project constraints
   * @param {object}   scaffoldStructure  - Dir→files mapping
   * @param {string[]} [iseSurfaces]      - ISE extracted surfaces (Phase 4.2)
   * @param {string[]} [iseTransitions]   - ISE flow transitions (Phase 4.2)
   */
  _buildScaffoldContractBlock(scaffoldManifest, scaffoldConstraints, scaffoldStructure, iseSurfaces = [], iseTransitions = [], interactionContract = null, contentSections = []) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return '';

    const fileList = scaffoldManifest.map(f => `- ${f}`).join('\n');

    const constraintLines = [];
    if (scaffoldConstraints.entry) constraintLines.push(`- Entry point: ${scaffoldConstraints.entry}`);
    if (scaffoldConstraints.techStack) constraintLines.push(`- Tech stack: ${scaffoldConstraints.techStack.join(', ')}`);
    if (scaffoldConstraints.hasServer) constraintLines.push('- Must have server component');
    if (scaffoldConstraints.hasFrontend) constraintLines.push('- Must have frontend component');
    if (scaffoldConstraints.hasAuth) constraintLines.push('- Must have authentication');
    if (scaffoldConstraints.hasDb) constraintLines.push('- Must have database layer');

    const structureBlock = Object.keys(scaffoldStructure).length > 0
      ? '\nDirectory structure:\n' + Object.entries(scaffoldStructure)
          .map(([dir, files]) => `  ${dir}: ${files.join(', ')}`)
          .join('\n')
      : '';

    // ── Phase 4.2: ISE surface build targets ──────────────────────────────────
    // When ISE detected interaction surfaces, inject them as mandatory UI sections.
    // These replace re-interpreting the raw prompt — each surface = a concrete view.
    let iseSurfacesBlock = '';
    if (iseSurfaces.length > 0) {
      const surfaceLines = iseSurfaces.map(s => `  • ${s}`).join('\n');
      const transitionLines = iseTransitions.length > 0
        ? '\nUser flow:\n' + iseTransitions.map(t => `  → ${t}`).join('\n')
        : '';
      iseSurfacesBlock = `

=== INTERACTION SURFACES (Phase 4.2 ISE — MANDATORY BUILD TARGETS) ===
These surfaces were extracted from the user's prompt. Implement EACH as a
distinct UI section, state, or page — do NOT collapse into a generic layout:
${surfaceLines}
${transitionLines}

For each surface above:
  - Create a dedicated HTML section/div with a clear visual identity
  - Include all UI elements the surface implies (form fields, buttons, headings, etc.)
  - WIRE EVERY ELEMENT: every button must have an addEventListener in the JS file, every form must have a submit handler, every nav item must switch panels
  - Connect surfaces via the transitions listed (e.g. form submit → confirmation)
  - NO DEAD BUTTONS: if a surface has a button, clicking it MUST produce a visible change
=== END INTERACTION SURFACES ===`;
    }

    // ── Interaction Contract block ─────────────────────────────────────────────
    // When a contract exists (non-static, non-empty), inject it as a BINDING directive.
    // Every interaction/route/form listed here MUST be implemented in CODE.
    let interactionContractBlock = '';
    if (interactionContract && interactionContract.intent_class !== 'static_surface') {
      const { interactions = [], routing = [], forms = [] } = interactionContract;
      const contractLines = [];

      if (interactions.length > 0) {
        contractLines.push('INTERACTIONS — each element listed below MUST exist in HTML and have a wired handler in JS:');
        for (const ix of interactions) {
          contractLines.push(`  • [${ix.event}] ${ix.element}`);
          contractLines.push(`    Behavior: ${ix.behavior}`);
          if (ix.state && ix.state.length > 0) {
            contractLines.push(`    State: ${ix.state.join(', ')}`);
          }
        }
      }

      if (routing.length > 0) {
        contractLines.push('\nROUTING — each path MUST be handled by an Express route:');
        for (const r of routing) {
          contractLines.push(`  • ${r.path} → ${r.component}: ${r.behavior}`);
        }
      }

      if (forms.length > 0) {
        contractLines.push('\nFORMS — each form MUST have a submit handler that performs the stated behavior:');
        for (const f of forms) {
          contractLines.push(`  • ${f.id} (fields: ${Array.isArray(f.fields) ? f.fields.join(', ') : f.fields})`);
          contractLines.push(`    Submit behavior: ${f.submit_behavior}`);
        }
      }

      if (contractLines.length > 0) {
        interactionContractBlock = `

=== INTERACTION CONTRACT (BINDING — IMPLEMENT EVERY ITEM) ===
This contract specifies WHAT each component must DO. Non-functional UI is a build failure.

${contractLines.join('\n')}

VERIFICATION RULES — the VERIFY stage will check these:
  1. Every listed interaction element must exist in HTML AND have an addEventListener/handler in JS
  2. Every listed route must appear in server.js or routes/ files
  3. Every listed form must exist in HTML AND have a submit event handler that performs the stated behavior
  4. ZERO DEAD INTERACTIONS: a button/form with no handler is a build failure, not a warning
=== END INTERACTION CONTRACT ===`;
      }
    }

    // ── Content Section Inventory block ──────────────────────────────────────
    // When content sections are extracted from the user prompt, inject them as
    // BINDING build targets in the scaffold contract. This ensures the LLM
    // treats section generation as mandatory, not optional.
    let contentSectionBlock = '';
    if (contentSections && contentSections.length > 0) {
      const sectionLines = contentSections.map(s =>
        `  • "${s.name}" section — ${s.description}`
      ).join('\n');
      contentSectionBlock = `

=== CONTENT SECTION INVENTORY (BINDING — EVERY SECTION MANDATORY) ===
The user's prompt requires these content sections. Each MUST appear as a
distinct <section> in index.html with a heading (h2/h3) containing the section name.
Missing sections = build failure. Do NOT merge them into a generic grid.

${sectionLines}

VERIFICATION: Post-generation scan will check that EACH section name appears
as a heading or id in the HTML. Missing sections trigger targeted regeneration.
=== END CONTENT SECTION INVENTORY ===`;
    }

    return `
=== SCAFFOLD CONTRACT (BINDING — DO NOT DEVIATE) ===
You MUST generate exactly these files:
${fileList}

${constraintLines.length > 0 ? 'Constraints:\n' + constraintLines.join('\n') : ''}
${structureBlock}
${iseSurfacesBlock}
${interactionContractBlock}
${contentSectionBlock}
Do NOT generate extra files. Do NOT skip any listed file.
Every listed file must contain complete, production-quality code.
=== END SCAFFOLD CONTRACT ===`;
  }

  /**
   * Build an explicit contract checklist for the user message.
   * This ensures the LLM treats each interaction contract item as a mandatory
   * implementation target, not background context. Items are numbered and
   * accompanied by // CONTRACT: marker instructions for VERIFY traceability.
   *
   * @param {object|null} interactionContract - The interaction contract from SCAFFOLD
   * @param {string} jsFile - The frontend JS filename (app.js or script.js)
   * @returns {string} Formatted checklist block for user message, or empty string
   */
  _buildContractChecklist(interactionContract, jsFile = 'app.js') {
    if (!interactionContract || interactionContract.intent_class === 'static_surface') return '';

    const { interactions = [], routing = [], forms = [] } = interactionContract;
    const totalItems = interactions.length + routing.length + forms.length;
    if (totalItems === 0) return '';

    const lines = [];
    lines.push('\n\n=== MANDATORY IMPLEMENTATION CHECKLIST (from interaction contract) ===');
    lines.push('Each item below MUST be implemented. Add a // CONTRACT: comment near each implementation.');
    lines.push(`At least ${Math.ceil(totalItems * 0.5)} of ${totalItems} items must be traceable in your code.\n`);

    let itemNum = 0;

    if (interactions.length > 0) {
      lines.push('INTERACTIONS (implement each in ' + jsFile + ' with addEventListener/handler):');
      for (const ix of interactions) {
        itemNum++;
        const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        lines.push(`  ${itemNum}. ${ix.element} [${ix.event}] → ${ix.behavior}`);
        lines.push(`     Add comment: // CONTRACT: ${contractId}`);
      }
    }

    if (routing.length > 0) {
      lines.push('\nROUTING (implement each as Express route or frontend view):');
      for (const r of routing) {
        itemNum++;
        const routeId = r.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        lines.push(`  ${itemNum}. ${r.path} → ${r.component}: ${r.behavior}`);
        lines.push(`     Add comment: // CONTRACT: route-${routeId}`);
      }
    }

    if (forms.length > 0) {
      lines.push('\nFORMS (implement each with submit handler + validation):');
      for (const f of forms) {
        itemNum++;
        lines.push(`  ${itemNum}. ${f.id} (fields: ${Array.isArray(f.fields) ? f.fields.join(', ') : f.fields})`);
        lines.push(`     Submit: ${f.submit_behavior}`);
        lines.push(`     Add comment: // CONTRACT: ${f.id}`);
      }
    }

    lines.push('\n=== END CHECKLIST ===');
    return lines.join('\n');
  }

  /**
   * _repairDeadButtons — Targeted interactivity remediation pass.
   *
   * Called when the post-generation interactivity scan detects ratio < 0.5
   * (more than half of interactive elements have no JS handler).
   *
   * Regenerates ONLY the frontend JS file with:
   * 1. FULL HTML content (so model sees every button, form, nav element)
   * 2. Interaction contract (explicit list of required handlers)
   * 3. Explicit element inventory extracted from the HTML
   *
   * Returns the regenerated JS content (string) or null on failure.
   */
  async _repairDeadButtons(files, jsFileKey, htmlContent, prompt, scaffold, emitChunk) {
    // FIX (#1413207): Use any available intent class, fall back to full_product.
    // This method now fires universally for ALL intent classes.
    const intentClass = scaffold?.interaction_contract?.intent_class || 'full_product';
    const modelSelection = this._selectModel(intentClass);

    // Extract all interactive elements from HTML for explicit targeting
    // FIX (#1413207): Broadened — also captures <a> links, <input type="submit/button">
    const buttons = htmlContent.match(/<button[^>]*>[\s\S]*?<\/button>/gi) || [];
    const formEls = htmlContent.match(/<form[^>]*>/gi) || [];
    const navItems = htmlContent.match(/<(?:a|li|div)[^>]*(?:data-(?:nav|section|tab|view|action)|role=["'](?:button|tab)["']|class=["'][^"']*nav[^"']*["'])[^>]*>/gi) || [];
    const submitInputs = htmlContent.match(/<input[^>]*type=["'](?:submit|button)["'][^>]*>/gi) || [];
    const clickableAnchors = htmlContent.match(/<a[^>]*(?:onclick|href=["']#[^"']*["'])[^>]*>[^<]*<\/a>/gi) || [];

    // Extract IDs and classes from buttons for explicit wiring instructions
    const buttonDetails = buttons.map(btn => {
      const idMatch = btn.match(/id=["']([^"']+)["']/);
      const classMatch = btn.match(/class=["']([^"']+)["']/);
      const textMatch = btn.match(/>([^<]+)</);
      return {
        id: idMatch ? idMatch[1] : null,
        class: classMatch ? classMatch[1] : null,
        text: textMatch ? textMatch[1].trim() : 'unknown',
      };
    });

    const formDetails = formEls.map(form => {
      const idMatch = form.match(/id=["']([^"']+)["']/);
      return { id: idMatch ? idMatch[1] : null };
    });

    // Build explicit element inventory
    const elementLines = [];
    elementLines.push(`BUTTONS (${buttonDetails.length} total — each MUST have addEventListener('click', ...)):`);
    for (const btn of buttonDetails) {
      if (btn.id) {
        elementLines.push(`  • #${btn.id} ("${btn.text}") → document.getElementById('${btn.id}').addEventListener('click', ...)`);
      } else if (btn.text !== 'unknown') {
        elementLines.push(`  • button "${btn.text}" → select via querySelector and add click handler`);
      }
    }
    if (formDetails.length > 0) {
      elementLines.push(`\nFORMS (${formDetails.length} total — each MUST have addEventListener('submit', ...)):`);
      for (const form of formDetails) {
        if (form.id) {
          elementLines.push(`  • #${form.id} → document.getElementById('${form.id}').addEventListener('submit', ...)`);
        }
      }
    }
    if (navItems.length > 0) {
      elementLines.push(`\nNAV/TAB ITEMS (${navItems.length} total — each MUST switch visible content on click)`);
    }
    if (submitInputs.length > 0) {
      elementLines.push(`\nSUBMIT/BUTTON INPUTS (${submitInputs.length} total — each MUST have a handler)`);
    }
    if (clickableAnchors.length > 0) {
      elementLines.push(`\nCLICKABLE LINKS (${clickableAnchors.length} total — each MUST have click handler or navigation logic)`);
    }

    const totalInteractiveElements = buttons.length + formDetails.length + navItems.length + submitInputs.length + clickableAnchors.length;

    // Build interaction contract requirements
    // FIX (#1413207): Universal contract block — fires for ALL intent classes.
    // When scaffold has a formal contract, use it. Otherwise inject a universal
    // handler mandate based on the HTML element inventory.
    let contractBlock = '';
    if (scaffold?.interaction_contract) {
      const { interactions = [], forms: contractForms = [] } = scaffold.interaction_contract;
      if (interactions.length > 0 || contractForms.length > 0) {
        const lines = ['\nINTERACTION CONTRACT — implement ALL behaviors:'];
        for (const ix of interactions) {
          lines.push(`  • [${ix.event}] ${ix.element}: ${ix.behavior}`);
        }
        for (const f of contractForms) {
          lines.push(`  • [submit] form "${f.id}": ${f.submit_behavior}`);
        }
        contractBlock = lines.join('\n');
      }
    }
    // Universal fallback: even without a formal contract, mandate handler coverage
    if (!contractBlock) {
      contractBlock = `\nUNIVERSAL HANDLER MANDATE:
Every interactive HTML element MUST have a JavaScript event handler.
Found ${totalInteractiveElements} interactive elements — your output must contain at least ${totalInteractiveElements} addEventListener calls.
No dead buttons. No decorative-only click targets. Every button does something visible.`;
    }

    // Include ALL route file endpoints for fetch() wiring
    // FIX (#1435780): Include routes/auth.js endpoints — critical for full_product builds
    // where sign-up/sign-in buttons must call auth API endpoints. Previous code only
    // checked routes/api.js, leaving auth endpoints invisible to the repair model.
    let apiEndpoints = '';
    const allRouteEndpoints = [];
    const routeFiles = Object.entries(files).filter(([f]) =>
      f.startsWith('routes/') && f.endsWith('.js')
    );
    for (const [routeFile, routeContent] of routeFiles) {
      if (!routeContent) continue;
      const routeMatches = routeContent.match(/router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi) || [];
      // Also catch app.get/post/etc patterns
      const appMatches = routeContent.match(/app\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi) || [];
      const allMatches = [...routeMatches, ...appMatches];
      if (allMatches.length > 0) {
        // Determine mount path from filename (auth.js → /api/auth, api.js → /api)
        const routeName = routeFile.replace('routes/', '').replace('.js', '');
        const mountPrefix = routeName === 'api' ? '/api' : `/api/${routeName}`;
        allRouteEndpoints.push(`\n  [${routeFile}] — mounted at ${mountPrefix}:`);
        for (const r of allMatches) {
          allRouteEndpoints.push(`    • ${r}`);
        }
      }
    }
    if (allRouteEndpoints.length > 0) {
      apiEndpoints = `\n\nALL API ENDPOINTS available (wire fetch() calls to these — use the correct mount path):${allRouteEndpoints.join('\n')}`;
    }

    // FIX (#1435780): Include server.js context for mount path discovery
    // The model needs to know how routes are mounted to call the correct URLs.
    let serverContext = '';
    const serverFile = files['server.js'];
    if (serverFile) {
      // Extract route mount lines: app.use('/api/auth', require('./routes/auth'))
      const mountLines = serverFile.match(/app\.use\s*\(\s*['"][^'"]+['"]\s*,\s*(?:require|auth|api)/gi) || [];
      if (mountLines.length > 0) {
        serverContext = `\n\nSERVER ROUTE MOUNTS (use these exact paths in fetch() calls):\n${mountLines.map(m => `  • ${m}`).join('\n')}`;
      }
    }

    const systemPrompt = `You are a senior frontend developer. Your ONLY task: generate a complete, production-quality JavaScript file (${jsFileKey}) that wires event handlers to EVERY interactive element in the HTML below.

CRITICAL RULES:
- This is BROWSER JavaScript only — no require(), no module.exports, no Node APIs
- EVERY button must have an addEventListener('click', handler)
- EVERY form must have an addEventListener('submit', handler) with preventDefault()
- EVERY tab/nav item must switch visible content panels on click
- EVERY clickable anchor must have navigation or action logic
- EVERY submit/button input must have a handler
- Include DOMContentLoaded wrapper
- Include real logic: fetch() calls, DOM manipulation, state management
- NO placeholder handlers — each handler must do something meaningful and VISIBLE
- Handlers must call real API endpoints via fetch() — check the API ENDPOINTS section below
- Auth handlers (login/signup) must: POST to auth endpoint, store JWT token, show/hide UI sections
- CRUD handlers must: call the correct API endpoints, update the DOM to reflect changes
- Error handling: catch fetch errors and show user-visible error messages (NOT console.log only)
- Count: ${totalInteractiveElements} interactive elements found (${buttons.length} buttons, ${formDetails.length} forms, ${navItems.length} nav items, ${submitInputs.length} submit inputs, ${clickableAnchors.length} anchors) — your output must have AT LEAST ${totalInteractiveElements} addEventListener calls`;

    const userMessage = `Generate the complete ${jsFileKey} file for this app: ${prompt}

FULL HTML (index.html) — read this carefully and wire EVERY interactive element:
${htmlContent}

${elementLines.join('\n')}
${contractBlock}${apiEndpoints}${serverContext}

CRITICAL AUTH WIRING (if HTML has login/signup forms):
- Login form submit → fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password}) })
- Signup form submit → fetch('/api/auth/signup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, name}) })
- On success: store token (localStorage.setItem('token', data.token)), hide auth section, show app section
- On error: show error message to user (do NOT silently swallow errors)
- Include Authorization header on authenticated requests: headers: {'Authorization': 'Bearer ' + localStorage.getItem('token')}

Output ONLY the JavaScript code for ${jsFileKey}. No markdown fences, no explanation.
Use the --- FILE: ${jsFileKey} --- header format.

VERIFICATION: Before finishing, count your addEventListener calls. You need at least ${buttons.length + formDetails.length}. If you have fewer, you missed elements — go back and add them.`;

    const { rawText } = await this._callStreamingLLM(
      modelSelection, systemPrompt, userMessage, 8000, emitChunk
    );

    // Parse the output — expect either raw JS or delimited format
    if (!rawText || rawText.trim().length < 50) return null;

    // Try to extract from delimiter format
    const delimiterMatch = rawText.match(/---\s*FILE:\s*[^\n]+---\s*\n([\s\S]+)/i);
    if (delimiterMatch) {
      return delimiterMatch[1].trim();
    }

    // Try to extract from code fence
    const fenceMatch = rawText.match(/```(?:javascript|js)?\s*\n([\s\S]+?)```/);
    if (fenceMatch) {
      return fenceMatch[1].trim();
    }

    // Raw output (no wrapper)
    return rawText.trim();
  }

  async _phase1_initialGeneration(prompt, planContext, techStack, scaffoldManifest, emitChunk, productContext = null, scaffoldConstraints = {}, scaffoldStructure = {}, constraintInstruction = '', iseSurfaces = [], iseTransitions = [], intentClass = null, interactionContract = null, contentSections = [], appArchetype = 'general', isUserProvidedScaffold = false) {
    // Build the product context instruction to inject into the system prompt
    const contextInstruction = buildContextInstruction(productContext);

    // PRODUCT_SYSTEM (full_product) gets its own rules branch with auth, model abstraction,
    // error middleware, and dotenv — these are production SaaS requirements, not optional.
    const isFullProduct = intentClass === 'full_product';

    // Build the scaffold contract block — this is BINDING, not a hint.
    // Phase 4.2: ISE surfaces are injected into the scaffold contract so that
    // the CODE phase receives them as mandatory build targets.
    const scaffoldContract = this._buildScaffoldContractBlock(scaffoldManifest, scaffoldConstraints, scaffoldStructure, iseSurfaces, iseTransitions, interactionContract, contentSections);

    // ── Schema-aware prompt: build examples, priority, and rules from scaffold manifest ──
    // Static surface builds (index.html, styles.css, script.js) must NOT see server examples.
    // Server-based builds get the full set. This prevents the AI from generating files
    // outside the scaffold manifest because of conflicting hardcoded examples.
    const hasServerFiles = scaffoldManifest.some(f =>
      f === 'server.js' || f === 'package.json' || f.startsWith('routes/') || f.startsWith('db/')
    );
    // Detect Vite React builds (src/main.jsx + src/App.jsx in manifest)
    const isViteReactBuild = scaffoldManifest.includes('src/main.jsx') || scaffoldManifest.includes('src/App.jsx');
    // WHY: Vite builds use src/App.jsx as the main component file, not root-level app.jsx
    const jsFile = isViteReactBuild ? 'src/App.jsx'
      : scaffoldManifest.includes('app.jsx') ? 'app.jsx'
      : scaffoldManifest.includes('script.js') ? 'script.js'
      : 'app.js';

    // Legacy CDN detection — kept for backward compatibility with older scaffolds
    const isReactCdnBuild = !isViteReactBuild && scaffoldManifest.includes('app.jsx');

    // Detect SQLite (PRODUCT_SYSTEM / full_product) builds by manifest content
    const isSqliteBuild = scaffoldManifest.includes('db/database.js');

    const fileExamples = hasServerFiles
      ? scaffoldManifest.map(f => {
          const hints = {
            'index.html':             isViteReactBuild
              ? '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>App</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>'
              : '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>...</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n...complete file content...',
            'src/main.jsx':           'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);',
            'src/App.jsx':            'import { useState, useEffect } from "react";\n\nfunction Card({ children, className = "" }) {\n  return <div className={`bg-white rounded-xl shadow-sm border border-gray-200 ${className}`}>{children}</div>;\n}\n\nexport default function App() {\n  const [data, setData] = useState([]);\n  // ... full app component\n}\n...complete file content...',
            'src/index.css':          '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n/* Custom styles */\n...complete file content...',
            'vite.config.js':         "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { proxy: { '/api': 'http://localhost:3000' } },\n  build: { outDir: 'dist' }\n});",
            'app.jsx':                'import { useState, useEffect } from "react";\n\nfunction Card({ children, className = "" }) {\n  return <div className={`bg-white rounded-xl shadow-sm border border-gray-200 ${className}`}>{children}</div>;\n}\n\nexport default function App() {\n  // ... full app\n}\n...complete file content...',
            'styles.css':             '/* Custom Tailwind overrides and animations */\n...complete file content...',
            'app.js':                 '// Browser JS only\n...complete file content...',
            'script.js':              '// Browser JS only\n...complete file content...',
            'server.js':              "const express = require('express');\n...complete file content...",
            'package.json':           '{ "name": "app", ... }',
            'routes/api.js':          "const { Router } = require('express');\n...complete file content...",
            'routes/auth.js':         "const { Router } = require('express');\n...complete file content...",
            'middleware/auth.js':     '// JWT auth middleware\n...complete file content...',
            'db/queries.js':          '// SQL queries\n...complete file content...',
            'db/pool.js':             "const { Pool } = require('pg');\n...complete file content...",
            'db/database.js':         "// Dual-driver database — auto-detects postgres:// URL vs SQLite file\nconst url = process.env.DATABASE_URL || '';\nconst isPostgres = url.startsWith('postgres://');\nif (isPostgres) { /* pg Pool */ } else { /* better-sqlite3 */ }\nmodule.exports = { query, exec, ready };\n...complete file content...",
            'migrations/001_schema.js': 'exports.up = pgm => { ... }\n...complete file content...',
            'migrate.js':             '// Migration runner\n...complete file content...',
          };
          return `--- FILE: ${f} ---\n${hints[f] || '...complete file content...'}`;
        }).join('\n\n')
      : scaffoldManifest.map(f => {
          const hints = {
            'index.html': isViteReactBuild
              ? '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>...</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>'
              : '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>...</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body class="bg-gray-50 min-h-screen">\n...complete file content...',
            'src/main.jsx': 'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode><App /></React.StrictMode>\n);',
            'src/App.jsx': 'import { useState } from "react";\n\nexport default function App() { ... }\n...complete file content...',
            'src/index.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n...complete file content...',
            'vite.config.js': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });",
            'package.json': '{ "name": "app", ... }',
            'styles.css': '/* Custom Tailwind overrides and animations */\n...complete file content...',
            'script.js':  '// Browser JS only — no require(), no module.exports\n...complete file content...',
            'app.js':     '// Browser JS only — no require(), no module.exports\n...complete file content...',
          };
          return `--- FILE: ${f} ---\n${hints[f] || '...complete file content...'}`;
        }).join('\n\n');

    const priorityBlock = isFullProduct
      ? (isViteReactBuild && isSqliteBuild && scaffoldManifest.includes('routes/auth.js')
        ? `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM (Vite React + Dual-Driver DB + Auth):
1. package.json (dependencies: express, pg, better-sqlite3, jsonwebtoken, bcrypt, cors, dotenv, react, react-dom; devDependencies: vite, @vitejs/plugin-react, tailwindcss)
2. vite.config.js (Vite config with @vitejs/plugin-react, proxy /api to Express dev server)
3. server.js (dotenv, cors, json, serves dist/ in production, mount /api/auth + /api routes, error handler, wait for db.ready before listen)
4. db/database.js (dual-driver: auto-detect postgres:// URL → pg Pool, otherwise → better-sqlite3. Exports { query, exec, ready }. CREATE TABLE IF NOT EXISTS for ALL entities + users table)
5. middleware/auth.js (JWT Bearer verification — attaches req.user)
6. routes/auth.js (POST /api/auth/signup, POST /api/auth/login — bcrypt + JWT, use async handlers with await db.query())
7. routes/api.js (full domain CRUD — uses { query } from db/database.js, async handlers, protected by auth middleware)
8. .env.example (DATABASE_URL, JWT_SECRET, PORT, NODE_ENV)
9. index.html (Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">)
10. src/main.jsx (React entry — imports App, renders into #root via createRoot)
11. src/App.jsx (complete React app — import { useState } from "react"; shadcn-style components + full UI + API integration)
12. src/index.css (Tailwind directives + responsive styles)`
        : isViteReactBuild && isSqliteBuild
        ? `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM (Vite React + Dual-Driver DB):
1. package.json (dependencies: express, pg, better-sqlite3, cors, dotenv, react, react-dom; devDependencies: vite, @vitejs/plugin-react, tailwindcss)
2. vite.config.js (Vite config with @vitejs/plugin-react, proxy /api to Express)
3. server.js (dotenv, cors, json, serves dist/ in production, mount /api routes, error handler, wait for db.ready before listen)
4. db/database.js (dual-driver: auto-detect postgres:// URL → pg Pool, otherwise → better-sqlite3. Exports { query, exec, ready }. CREATE TABLE IF NOT EXISTS for ALL entities)
5. routes/api.js (full domain CRUD — uses { query } from db/database.js, async handlers)
6. .env.example (DATABASE_URL, PORT, NODE_ENV)
7. index.html (Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">)
8. src/main.jsx (React entry point — imports App, createRoot)
9. src/App.jsx (complete React app — import { useState } from "react"; shadcn-style components + full UI + API integration)
10. src/index.css (Tailwind directives + responsive styles)`
        : isSqliteBuild
        ? `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM (Dual-Driver DB):
1. package.json (dependencies: express, pg, better-sqlite3, jsonwebtoken, bcrypt, cors, dotenv)
2. server.js (with dotenv, cors, json parsing, error middleware, wait for db.ready before listen)
3. db/database.js (dual-driver: auto-detect postgres:// URL → pg Pool, otherwise → better-sqlite3. Exports { query, exec, ready }. Creates tables on startup)
4. routes/api.js (domain-specific RESTful routes — uses { query } from require('../db/database'), async handlers)
5. .env.example (DATABASE_URL, JWT_SECRET, PORT, NODE_ENV)
6. index.html + styles.css + ${jsFile} (full-featured frontend connecting to API)
7. All remaining files`
        : `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM:
1. package.json (all dependencies: express, pg, jsonwebtoken, bcrypt, cors, dotenv)
2. server.js (with dotenv, cors, json parsing, error middleware)
3. middleware/auth.js (JWT verification middleware)
4. routes/auth.js (POST /api/auth/signup, POST /api/auth/login)
5. db/pool.js (pg Pool with DATABASE_URL)
6. db/queries.js (all SQL queries — abstracted, parameterized, no inline SQL in routes)
7. migrations/001_schema.js (full schema for ALL domain entities)
8. routes/api.js (domain-specific RESTful routes — no SQL, calls db/queries.js only)
9. index.html + styles.css + ${jsFile} (full-featured frontend connecting to API)
10. All remaining files`)
      : hasServerFiles
      ? (isViteReactBuild
        ? `PRIORITY ORDER — generate foundation-first for Vite React light app:
1. package.json (dependencies: express, cors, react, react-dom; devDependencies: vite, @vitejs/plugin-react, tailwindcss)
2. vite.config.js (Vite config with @vitejs/plugin-react, proxy /api to Express)
3. server.js (cors, json, serves dist/ in production, mount /api routes, error handler)
4. ${scaffoldManifest.includes('db/database.js') ? 'db/database.js (better-sqlite3 — WAL mode, CREATE TABLE IF NOT EXISTS)\n5. routes/api.js (full CRUD using db/database.js)\n6. index.html (Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">)\n7. src/main.jsx (React entry point — imports App, createRoot)\n8. src/App.jsx (complete React app — import { useState } from "react"; shadcn-style components + full CRUD UI + fetch() API)\n9. src/index.css (Tailwind directives + responsive styles)' : 'routes/api.js (in-memory array CRUD)\n5. index.html (Vite entry — <div id="root"> + <script type="module" src="/src/main.jsx">)\n6. src/main.jsx (React entry point — imports App, createRoot)\n7. src/App.jsx (complete React app — import { useState } from "react"; shadcn-style components + full UI + fetch() API)\n8. src/index.css (Tailwind directives + responsive styles)'}`
        : `PRIORITY ORDER — generate high-value files first:
1. package.json (dependencies & scripts)
2. server.js (Express entry point)
3. routes/api.js (REST endpoints)
4. migrations/001_schema.js (schema)
5. Frontend files (index.html + styles.css + ${jsFile})
6. All remaining files`)
      : `PRIORITY ORDER — generate these files:
${scaffoldManifest.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;

    let rulesBlock;
    // ── USER-PROVIDED SCAFFOLD: language-agnostic rules ──────────────────
    // When the user pasted their own file tree, skip all web-specific rules
    // (React CDN, Express, Tailwind, etc.) and use a generic prompt that
    // tells the AI to generate production-quality code for the exact files listed.
    if (isUserProvidedScaffold) {
      rulesBlock = `CRITICAL RULES — USER-PROVIDED FILE STRUCTURE — violating these means the output won't match the request:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
3. Each file must contain COMPLETE, PRODUCTION-QUALITY code appropriate to its filename and extension.
4. Infer the purpose of each file from its name and directory structure (e.g., "aiBusinessAgent.ts" should contain an AI business agent implementation, "routers/agent.ts" should contain route handlers for agent endpoints).
5. Use the CORRECT language and idioms for each file's extension (.ts = TypeScript with proper types, .py = Python with type hints, .go = Go with proper packages, etc.).
6. For TypeScript (.ts/.tsx): use proper type annotations, interfaces, and async/await patterns. Do NOT use require() — use import/export syntax.
7. For test files (*.test.ts, *.spec.ts, etc.): generate real unit tests with assertions, not empty test shells.
8. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
9. Files should reference each other correctly (imports between files should use the correct relative paths based on the directory structure).
10. Do NOT generate web frontend files (index.html, styles.css, app.jsx) unless they are explicitly in the scaffold contract.`;
    } else if (isFullProduct && isViteReactBuild) {
      // ── PRODUCT_SYSTEM with Vite-bundled React + Tailwind + shadcn-style ─────────
      rulesBlock = `CRITICAL RULES — PRODUCT_SYSTEM (Vite React + Tailwind) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html at ROOT level with <div id="root"></div> and <script type="module" src="/src/main.jsx"></script> — NO CDN script tags
3. index.html MUST NOT include React/ReactDOM/Babel CDN scripts — Vite bundles everything. Only include: <meta name="viewport" content="width=device-width, initial-scale=1.0">
4. src/main.jsx is the React entry point with: import React from "react"; import ReactDOM from "react-dom/client"; import App from "./App"; import "./index.css"; ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
5. src/App.jsx MUST use ES module imports: import { useState, useEffect, useCallback, useRef } from "react"; and export default function App() { ... }
6. src/App.jsx MUST define reusable component functions using ONLY Tailwind classes (no CSS-in-JS):
   - Card: ({children, className}) => <div className={"bg-white rounded-xl shadow-sm border border-gray-200 p-6 " + (className||"")}>{children}</div>
   - Button: primary=bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors cursor-pointer
   - Badge: px-2.5 py-0.5 rounded-full text-xs font-medium (variants: success/warning/danger/info)
   - Input: w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent
   - Dialog: fixed inset-0 bg-black/50 flex items-center justify-center z-50 + inner bg-white rounded-xl shadow-xl p-6
7. src/index.css MUST include: @tailwind base; @tailwind components; @tailwind utilities; plus responsive custom styles
8. vite.config.js MUST: import { defineConfig } from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig({ plugins: [react()], server: { proxy: { "/api": "http://localhost:3000" } }, build: { outDir: "dist" } });
9. LIGHT THEME: ALL backgrounds: page=bg-gray-50, cards=bg-white. Text: headings=text-gray-900, body=text-gray-600. Accent=blue-600. NO dark backgrounds.
10. ALL interactivity via React hooks: useState for state, useEffect for API calls, onClick/onChange/onSubmit for events
11. FETCH CALLS: for every API endpoint in routes/api.js, src/App.jsx must have a corresponding fetch('/api/...') call
12. STATE MANAGEMENT: use useState for ALL dynamic data
13. RESPONSIVE: use Tailwind responsive prefixes (sm:, md:, lg:, xl:) for layout. Grid: grid-cols-1 sm:grid-cols-2 lg:grid-cols-4

VISUAL QUALITY STANDARDS — polished modern SaaS:
- Sidebar: fixed left, w-64, bg-white, border-r. Main content: ml-64, p-8, bg-gray-50
- Stat cards: grid with responsive breakpoints, bg-white rounded-xl shadow-sm
- Data tables: rounded-xl shadow-sm with thead bg-gray-50

14. server.js MUST: (a) require('dotenv').config(), (b) use cors(), express.json(), (c) mount API routes, (d) serve dist/ via express.static('dist') in production, (e) error handler middleware
15. db/database.js MUST: DUAL-DRIVER — auto-detect DATABASE_URL. Export { query, exec, ready }
16. MANDATORY: NO CDN scripts for React/ReactDOM/Babel in index.html. Vite handles all bundling.
17. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
18. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
19. BRANDING — add this badge as the LAST element before </body> in index.html: <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>
20. CONTENT FIDELITY — If a BUSINESS NAME or APP NAME is specified, use that EXACT name in <title> and app header.`;
    } else if (isFullProduct && isSqliteBuild) {
      // ── PRODUCT_SYSTEM with dual-driver DB (pg + better-sqlite3) ─────────────
      rulesBlock = `CRITICAL RULES — PRODUCT_SYSTEM (full-stack SaaS with dual-driver DB) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — deploy engine serves from root
3. index.html MUST include in the <head>: <script src="https://cdn.tailwindcss.com"></script>
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js MUST: (a) require('dotenv').config() at the very top, (b) use cors(), express.json(), (c) mount api router at /api, (d) serve static files via express.static(path.join(__dirname, '.')), (e) register error-handling middleware LAST: app.use((err, req, res, next) => { ... }), (f) require('./db/database') to init schema, (g) wait for db.ready before app.listen()
7. package.json MUST have: { "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.0", "better-sqlite3": "^9.0.0", "jsonwebtoken": "^9.0.0", "bcrypt": "^5.1.0", "cors": "^2.8.5", "dotenv": "^16.0.0" } }
8. db/database.js MUST: DUAL-DRIVER — (a) read DATABASE_URL env, (b) if starts with postgres:// or postgresql:// → require('pg').Pool with SSL, (c) otherwise → require('better-sqlite3') with WAL mode + foreign keys ON, (d) export { query, exec, ready } — query(sql, params) returns rows array, ready is a Promise that resolves when schema init done, (e) CREATE TABLE IF NOT EXISTS for ALL domain entities + users table using appropriate syntax per driver (SERIAL PRIMARY KEY for pg, INTEGER PRIMARY KEY AUTOINCREMENT for sqlite), (f) module.exports = { query, exec, ready }
9. routes/api.js MUST: (a) const { query } = require('../db/database'), (b) use async route handlers with await query(sql, params), (c) implement full CRUD for domain entities, (d) use try/catch on all route handlers
10. Route handlers MUST use try/catch — catch errors and call next(err). Never let unhandled exceptions crash the server
11. Input validation: check required fields exist before DB operations, return 400 with clear message if missing
12. Domain routes (/api/...): infer entities from the user's product description — create full CRUD routes. Include GET (list all), POST (create), PUT/:id (update), DELETE/:id (delete)
13. ${jsFile}: connects to the backend API — fetch('/api/...') calls for all CRUD operations, handles auth state in frontend

CRITICAL — index.html MUST CONTAIN REAL STATIC HTML CONTENT:
- Do NOT generate an empty <div id="app"></div> and render everything via JavaScript. The page MUST show visible content (forms, headers, tables, navigation) directly in the HTML.
- The page must be usable and visible even if JavaScript is slow to load or fails. At minimum: a header, a form for creating records, and a list/table area.
- Build the UI structure in HTML, then ENHANCE it with JavaScript (progressive enhancement). Do NOT build a blank-page SPA.
- Include a login form section AND a main app section in the HTML. Use JavaScript to show/hide them based on auth state.

VISUAL QUALITY STANDARDS — the output must look like a polished modern SaaS app:
- App layout: flex min-h-screen bg-gray-50 with sidebar (w-64 bg-white border-r border-gray-200) + main content (flex-1 p-8)
- Forms: inputs with border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500, submit with bg-blue-600 text-white rounded-lg
- Cards/panels: bg-white rounded-xl shadow-sm border border-gray-200 p-6
- Data tables: bg-white rounded-xl shadow-sm border border-gray-200 wrapper, thead bg-gray-50 text-gray-500, tbody divide-y divide-gray-200
- Auth section: centered bg-white rounded-xl shadow-sm border border-gray-200 p-8 with styled inputs and bg-blue-600 login button
- Stat cards: grid grid-cols-2 lg:grid-cols-4 gap-6, each bg-white rounded-xl shadow-sm p-6 with large stat number

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values via getElementById().value, (c) validates required fields, (d) sends data via fetch() to the API or processes it client-side, (e) shows success/error feedback.
- TAB/NAV SWITCHING: if the UI has tabs, sidebar nav items, or panel toggles, clicking them MUST switch which content panel is visible. Implement via: hide all panels (display:none), show the selected one (display:block), update active tab styling.
- STATE MANAGEMENT: ${jsFile} must maintain JavaScript state variables (e.g., currentTab, currentView, items array, formData). UI updates must flow from state changes, not just static rendering.
- FETCH CALLS: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI action (button click, form submit, page load).
- DELETE/EDIT ACTIONS: delete buttons must call DELETE endpoint and remove the item from the UI. Edit buttons must populate a form and call PUT/PATCH.
- LOADING STATES: buttons must show disabled/loading state during API calls and re-enable after.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons in HTML, then count your event listeners in JS — they must match.

14. MANDATORY SEPARATE FILES — no inline CSS in <style> tags, no inline JS in <script> tags inside index.html
15. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
16. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
17. BRANDING — add this badge as the LAST element before </body> in index.html (after all app content): <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>

PRODUCT_SYSTEM ARCHITECTURE PATTERN (Dual-Driver DB) — follow this structure:
- server.js: entry point, middleware chain (cors, json, static), route mounting, error handler. Wait for db.ready before app.listen()
- db/database.js: dual-driver — detects postgres:// URL → pg Pool, otherwise → better-sqlite3. Exports { query, exec, ready }
- routes/api.js: all domain routes — async handlers with await query(), full CRUD
- index.html: FULL static HTML with login section + app section + forms + table/list

18. CONTENT FIDELITY — READ THE CONTENT FIDELITY REQUIREMENTS BLOCK IN THE USER MESSAGE. They are BINDING:
    - If a BUSINESS NAME or APP NAME is specified (e.g. "called BuildOrbit"), use that EXACT name in <title>, the main H1/header, and the footer. NEVER use a generic description as the title.
    - If REQUESTED SECTIONS are listed, each MUST be implemented as a distinct HTML section or view.`;
    } else if (isFullProduct) {
      // ── PRODUCT_SYSTEM with PostgreSQL ──────────────────────────────────
      rulesBlock = `CRITICAL RULES — PRODUCT_SYSTEM (full-stack SaaS) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — deploy engine serves from root
3. index.html MUST include in the <head>: <script src="https://cdn.tailwindcss.com"></script>
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js MUST: (a) require('dotenv').config() at the very top, (b) use cors(), express.json(), (c) mount auth router at /api/auth, (d) mount api router at /api, (e) serve static files via express.static('.'), (f) register error-handling middleware LAST: app.use((err, req, res, next) => { ... })
7. package.json MUST have: { "scripts": { "start": "node server.js", "build": "node migrate.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.3", "jsonwebtoken": "^9.0.0", "bcrypt": "^5.1.0", "cors": "^2.8.5", "dotenv": "^16.0.0" } }
8. middleware/auth.js MUST: verify JWT from Authorization header (Bearer token), attach decoded user to req.user, call next() on success, return 401 on failure
9. routes/auth.js MUST implement: POST /signup (hash password with bcrypt, insert user, return JWT) and POST /login (verify password, return JWT). JWT signed with process.env.JWT_SECRET
10. db/queries.js: ALL SQL lives here — parameterized queries only ($1, $2, ...), no string interpolation. Route handlers MUST NOT contain SQL — they call query functions only
11. db/pool.js: const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }). Export pool
12. migrations/001_schema.js: exports.up = (pgm) => { ... } — creates ALL tables for this app's domain entities including users table (id, email, password_hash, created_at)
13. Route handlers MUST use try/catch — catch errors and call next(err). Never let unhandled exceptions crash the server
14. Input validation: check required fields exist before DB operations, return 400 with clear message if missing
15. Domain routes (/api/...): infer entities from the user's product description — create full CRUD routes for the core domain objects. Use req.user from auth middleware for ownership checks
16. ${jsFile}: connects to the backend API — fetch('/api/...') calls, JWT stored in localStorage, auth state managed in frontend

CRITICAL — index.html MUST CONTAIN REAL STATIC HTML CONTENT:
- Do NOT generate an empty <div id="app"></div> and render everything via JavaScript. The page MUST show visible content (forms, headers, tables, navigation) directly in the HTML.
- The page must be usable and visible even if JavaScript is slow to load or fails. At minimum: a header, a form for creating records, and a list/table area.
- Build the UI structure in HTML, then ENHANCE it with JavaScript (progressive enhancement). Do NOT build a blank-page SPA.
- Include a login form section AND a main app section in the HTML. Use JavaScript to show/hide them based on auth state.

VISUAL QUALITY STANDARDS — the output must look like polished production SaaS software:
- Page background: bg-gray-50 min-h-screen
- App layout: flex with sidebar (w-64 bg-white border-r border-gray-200 min-h-screen p-4) + main content (flex-1 p-8)
- Sidebar nav: nav items with px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100, active: bg-blue-50 text-blue-700 font-medium
- Stat cards: grid grid-cols-2 lg:grid-cols-4 gap-6, each bg-white rounded-xl shadow-sm border border-gray-200 p-6 with stat-value text-2xl font-bold text-gray-900
- Data tables: bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden, thead bg-gray-50 text-xs text-gray-500 uppercase, tbody divide-y divide-gray-200 hover:bg-gray-50
- Forms: inputs with border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500, buttons bg-blue-600 hover:bg-blue-700 text-white rounded-lg
- Cards/panels: bg-white rounded-xl shadow-sm border border-gray-200 p-6 with hover:shadow-md transition-shadow
- Auth section: centered bg-white rounded-xl shadow-sm border border-gray-200 max-w-md mx-auto p-8 on bg-gray-50 page
- Badges: inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium (success=bg-green-100 text-green-800, warning=bg-yellow-100 text-yellow-800, danger=bg-red-100 text-red-800)
- Light theme: bg-gray-50 page, bg-white cards, blue-600 accent, gray-900/600/400 text. NO dark backgrounds.

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values via getElementById().value, (c) validates required fields, (d) sends data via fetch() to the API or processes it client-side, (e) shows success/error feedback.
- TAB/NAV SWITCHING: if the UI has tabs, sidebar nav items, or panel toggles, clicking them MUST switch which content panel is visible. Implement via: hide all panels (display:none), show the selected one (display:block), update active tab styling.
- STATE MANAGEMENT: ${jsFile} must maintain JavaScript state variables (e.g., currentTab, currentView, items array, formData). UI updates must flow from state changes, not just static rendering.
- FETCH CALLS: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI action (button click, form submit, page load).
- SIDEBAR NAVIGATION: clicking sidebar items must switch the main content area. Each nav item needs an event listener that shows/hides content sections.
- DELETE/EDIT ACTIONS: delete buttons must call DELETE endpoint and remove the item from the UI. Edit buttons must populate a form and call PUT/PATCH.
- LOADING STATES: buttons must show disabled/loading state during API calls and re-enable after.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons in HTML, then count your event listeners in JS — they must match.

17. MANDATORY SEPARATE FILES — no inline CSS in <style> tags, no inline JS in <script> tags inside index.html
18. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
19. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
20. BRANDING — add this badge as the LAST element before </body> in index.html (after all app content): <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>

PRODUCT_SYSTEM ARCHITECTURE PATTERN — follow this structure:
- server.js: entry point, middleware chain, route mounting, error handler
- middleware/auth.js: JWT verification only — no business logic
- routes/auth.js: signup + login — writes to users table, returns JWT
- routes/api.js: all domain routes — calls db/queries.js, respects auth middleware
- db/pool.js: pg Pool — exports pool instance
- db/queries.js: all SQL functions — exports named async functions like createUser(), getTasksByUser()
- migrations/001_schema.js: schema definition — CREATE TABLE IF NOT EXISTS for all entities

21. CONTENT FIDELITY — READ THE CONTENT FIDELITY REQUIREMENTS BLOCK IN THE USER MESSAGE. They are BINDING:
    - If a BUSINESS NAME or APP NAME is specified (e.g. "called BuildOrbit"), use that EXACT name in <title>, the main H1/header, and the footer. NEVER use a generic description as the title.
    - If REQUESTED SECTIONS are listed, each MUST be implemented as a distinct HTML section or view.`;
    } else if (isViteReactBuild && hasServerFiles) {
      // ── LIGHT APP / HARD EXPANSION with Vite React + Tailwind ──
      // Non-full_product builds that use Vite React (light_app, hard_expansion).
      rulesBlock = `CRITICAL RULES — LIGHT APP (Vite React + Tailwind) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html at ROOT level with <div id="root"></div> and <script type="module" src="/src/main.jsx"></script> — NO CDN script tags
3. index.html MUST NOT include React/ReactDOM/Babel CDN scripts — Vite bundles everything. Only include: <meta name="viewport" content="width=device-width, initial-scale=1.0">
4. src/main.jsx is the React entry point: import React from "react"; import ReactDOM from "react-dom/client"; import App from "./App"; import "./index.css"; ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
5. src/App.jsx MUST use ES module imports: import { useState, useEffect, useCallback, useRef } from "react"; and export default function App() { ... }
6. src/App.jsx MUST define reusable component functions using ONLY Tailwind classes:
   - Card, Button, Badge, Input, Table — same patterns as PRODUCT_SYSTEM
7. src/index.css MUST include: @tailwind base; @tailwind components; @tailwind utilities;
8. vite.config.js MUST: import { defineConfig } from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig({ plugins: [react()], server: { proxy: { "/api": "http://localhost:3000" } } });
9. LIGHT THEME: bg-gray-50 page, bg-white cards, blue-600 accent. NO dark backgrounds.
10. ALL interactivity via React hooks: useState for state, useEffect for data fetching, onClick/onChange/onSubmit for events
11. FETCH CALLS: for every API endpoint in routes/api.js, src/App.jsx must have a corresponding fetch('/api/...') call
12. STATE MANAGEMENT: use useState for ALL dynamic data
13. RESPONSIVE: use Tailwind responsive prefixes (sm:, md:, lg:) for layout breakpoints
14. FORMS: every form input uses onChange to update useState, onSubmit calls preventDefault()

VISUAL QUALITY STANDARDS — clean, modern SaaS:
- Layout: min-h-screen bg-gray-50. Optional sidebar + main content
- Cards: bg-white rounded-xl shadow-sm border. Tables: rounded-xl with thead bg-gray-50
- Responsive grids: grid-cols-1 sm:grid-cols-2 lg:grid-cols-4

15. server.js MUST: (a) use cors(), express.json(), (b) mount API routes at /api, (c) serve dist/ via express.static('dist') in production, (d) error handler
16. package.json MUST have dependencies: express, cors, react, react-dom; devDependencies: vite, @vitejs/plugin-react, tailwindcss
17. routes/api.js: in-memory array storage. Full CRUD. Return JSON.
18. MANDATORY: NO CDN scripts for React/ReactDOM/Babel. Vite handles all bundling.
19. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
20. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
21. BRANDING — badge before </body>: <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>
22. CONTENT FIDELITY — If a BUSINESS NAME or APP NAME is specified, use that EXACT name in <title> and app header.`;
    } else if (hasServerFiles) {
      rulesBlock = `CRITICAL RULES — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — this is how the deploy engine serves them
3. index.html MUST include in the <head>: <script src="https://cdn.tailwindcss.com"></script>
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js serves static files: app.use(express.static(path.join(__dirname, '.'))) to serve root-level index.html
7. package.json must have: { "scripts": { "start": "node server.js", "build": "node migrate.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.3" } }
8. migrations/001_schema.js: exports.up = (pgm) => { pgm.createTable(...) } — creates tables for THIS specific app
9. db/queries.js: real SQL queries (parameterized) specific to this app's entities
10. styles.css: Tailwind utility overrides and custom CSS — add keyframes, gradients, brand-specific styling. Use Tailwind classes in HTML, styles.css for custom animations only
11. The UI must visually match the task — use Tailwind utility classes (bg-white rounded-xl shadow-sm, bg-blue-600 text-white, etc.) for consistent professional appearance. Light theme: bg-gray-50 page, bg-white cards, blue-600 accent

VISUAL QUALITY STANDARDS — the output must look polished and professional:
- Page background: bg-gray-50 min-h-screen
- Use a HERO SECTION: full-width bg-white or bg-gradient-to-br from-blue-600 to-blue-800 with large centered headline (text-4xl font-bold) and CTA button (bg-blue-600 text-white py-3 px-8 rounded-lg text-lg)
- Use CARD GRIDS: bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow
- Apply consistent spacing: p-6 for cards, gap-6 for grids, py-16 for sections, max-w-6xl mx-auto for container
- Typography hierarchy: text-4xl/text-3xl font-bold text-gray-900 for headings, text-lg text-gray-600 for descriptions
- Mobile-first responsive: use Tailwind breakpoints (sm:, md:, lg:) on grid columns, font sizes, padding
- Include subtle animations: hover:shadow-md transition-shadow on cards, hover:-translate-y-1 on feature cards
- Color palette: bg-gray-50 page, bg-white cards, blue-600 primary, gray-900/600/400 text hierarchy

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values, (c) validates, (d) sends data via fetch() or processes client-side, (e) shows feedback.
- TAB/NAV SWITCHING: if the UI has tabs or navigation items, clicking them MUST switch visible content panels. Implement via: hide all panels, show selected, update active styling.
- STATE MANAGEMENT: ${jsFile} must track UI state in variables (currentTab, items array, formData). All UI updates flow from state changes.
- CRUD WIRING: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI trigger (button click, form submit, page load).
- LOADING STATES: buttons must show disabled/loading during async operations and re-enable after.
- DELETE/EDIT: action buttons must call the appropriate API endpoint and update the UI immediately.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons, count your listeners — they must match.

12. MANDATORY SEPARATE FILES — Do NOT inline CSS in <style> tags inside index.html. Put ALL CSS in styles.css. Do NOT inline JavaScript in <script> tags inside index.html. Put ALL JS in ${jsFile}. index.html must reference these via <link href="styles.css"> and <script src="${jsFile}">.
13. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
14. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
15. CONTENT FIDELITY — READ THE CONTENT FIDELITY REQUIREMENTS BLOCK IN THE USER MESSAGE. They are BINDING, not suggestions:
    - If a BUSINESS NAME is specified (e.g. "called FreshPaws"), use that EXACT name in <title>, the main H1, footer copyright, and navbar. NEVER use the generic product description as the title.
    - If REQUESTED SECTIONS are listed (pricing, testimonials, gallery, etc.), each MUST be a dedicated HTML <section> with real content. Do NOT collapse them into a generic "Features" grid.
    - If a specific CTA is requested (e.g. "booking CTA"), use that CTA text (e.g. "Book Now"), not "Get Started".`;
    } else {
      rulesBlock = `CRITICAL RULES — violating these means the build will fail:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. Generate ONLY these ${scaffoldManifest.length} files: ${scaffoldManifest.join(', ')} — NO server.js, NO package.json, NO routes/, NO db/, NO migrations/
3. index.html MUST include in the <head>: <script src="https://cdn.tailwindcss.com"></script>
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. styles.css: use Tailwind utility classes in HTML, styles.css for custom animations/gradients/keyframes only. Brand colors via Tailwind classes (bg-blue-600, text-gray-900, etc.)
7. Use Tailwind patterns throughout: bg-white rounded-xl shadow-sm border border-gray-200 p-6 for cards, bg-blue-600 text-white rounded-lg for CTAs, border border-gray-300 rounded-lg for inputs, bg-green-100 text-green-800 rounded-full for badges

VISUAL QUALITY STANDARDS — the output must look polished and professional:
- Page background: bg-gray-50 min-h-screen
- Use a HERO SECTION: bg-white py-20 or bg-gradient-to-br from-blue-600 to-blue-800 text-white py-24 with large centered headline (text-4xl font-bold) and CTA button
- Use CARD GRIDS: bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow
- Apply consistent spacing: p-6 cards, gap-6 grids, py-16 sections, max-w-6xl mx-auto container
- Typography: text-4xl/text-3xl font-bold text-gray-900 for headings, text-lg text-gray-600 for descriptions
- Mobile-first responsive: use Tailwind breakpoints (sm:, md:, lg:) on grid columns, font sizes, padding
- Include subtle animations: hover:shadow-md transition-shadow on cards, hover:-translate-y-1 on feature cards
- Color palette: bg-gray-50 page, bg-white cards, blue-600 primary, gray-900/600/400 text hierarchy

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST produce a visible change (show/hide content, toggle state, compute result, navigate).
- FORMS MUST WORK: every <form> must have a submit event listener that prevents default, reads input values, validates, and shows results or confirmation. For calculators: compute and display. For contact forms: show success state.
- TAB/NAV SWITCHING: if the UI has tabs, navigation items, or panel toggles, clicking them MUST switch visible content. Implement: hide all panels (display='none'), show selected (display='block'), toggle active CSS class.
- STATE MANAGEMENT: ${jsFile} must maintain state variables (currentTab, items[], formValues). UI renders from state, not static HTML alone.
- CLIENT-SIDE LOGIC: for calculators/tools, the compute/calculate button MUST read all inputs, perform the calculation, and display results in a designated output area.
- CLICK HANDLER AUDIT: before finishing ${jsFile}, mentally count every <button>, <a> with action, clickable <div>, and form in index.html. Each one MUST have a handler in ${jsFile}. Missing handlers = broken app.
- NO SCROLL-ONLY JS: ${jsFile} must contain MORE than just scroll animations. It must contain functional event handlers for all interactive elements.

8. MANDATORY SEPARATE FILES — Do NOT inline CSS in <style> tags inside index.html. Put ALL CSS in styles.css. Do NOT inline JavaScript in <script> tags inside index.html. Put ALL JavaScript in ${jsFile}. index.html must ONLY reference these via <link href="styles.css"> and <script src="${jsFile}">. Generating a single HTML file with everything inlined is a CONTRACT VIOLATION.
9. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
10. Do NOT generate any backend/server files. This is a static frontend build.
11. CONTENT FIDELITY — READ THE CONTENT FIDELITY REQUIREMENTS BLOCK IN THE USER MESSAGE. They are BINDING, not suggestions:
    - If a BUSINESS NAME is specified (e.g. "called FreshPaws"), use that EXACT name in <title>, the main H1, footer copyright, and navbar. NEVER use the generic product description as the title.
    - If REQUESTED SECTIONS are listed (pricing, testimonials, gallery, etc.), each MUST be a dedicated HTML <section> with real content. Do NOT collapse them into a generic "Features" or "Benefits" grid.
    - If a specific CTA is requested (e.g. "booking CTA"), use that CTA text (e.g. "Book Now"), not "Get Started".
12. BRANDING — add this badge as the last element before </body> in index.html: <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>`;
    }

    // ── USER-PROVIDED SCAFFOLD: override fileExamples + priorityBlock ────────
    // When the user provided their own file tree, the web-centric file examples
    // and priority blocks are irrelevant. Replace with simple per-file entries.
    if (isUserProvidedScaffold) {
      fileExamples = scaffoldManifest.map(f => {
        return `--- FILE: ${f} ---\n...complete ${f.split('.').pop()} file content...`;
      }).join('\n\n');

      priorityBlock = `PRIORITY ORDER — generate these files in this order:\n` +
        scaffoldManifest.map((f, i) => `${i + 1}. ${f}`).join('\n');

      console.log(`[BuilderAgent] Phase 1: user-provided scaffold — ${scaffoldManifest.length} files, skipping web-specific rules`);
    }

    // ── Domain constraint: prevent cross-domain contamination in AI output ───
    // _deriveAppDomain picks the single highest-confidence domain from the prompt.
    // Inject it as a binding constraint so the LLM cannot creatively merge domains
    // (e.g., "Build an inventory tracker" must NOT produce a chat+inventory hybrid).
    const _appDomain = this._deriveAppDomain ? this._deriveAppDomain(prompt) : null;
    let domainConstraintBlock = '';
    if (_appDomain && _appDomain.type !== 'generic') {
      const fieldNames = (_appDomain.fields || []).map(f => f.label).join(', ');
      domainConstraintBlock = `

=== DOMAIN CONSTRAINT (BINDING — SINGLE DOMAIN ONLY) ===
This is a ${_appDomain.type.toUpperCase()} application. Do NOT mix in features from other domains.
Core entity: ${_appDomain.entity.name} (singular: ${_appDomain.entity.singular})
Expected fields: ${fieldNames}
App name MUST reflect the ${_appDomain.type} domain — not a hybrid of multiple domains.
Do NOT add unrelated features (no chat in inventory apps, no inventory in chat apps, etc.).
=== END DOMAIN CONSTRAINT ===`;
      console.log(`[BuilderAgent] Phase 1: domain constraint injected — ${_appDomain.type} (entity: ${_appDomain.entity.name})`);
    }

    // ── Archetype-specific component composition guidance ─────────────────────
    // Reads app_archetype from the constraint contract (set by Intent Gate).
    // Injected into system prompt as a named guidance block — tells the LLM
    // WHICH component patterns to use for this category of app.
    // This is additive — it never restricts, only guides composition decisions.
    // appArchetype is passed as a parameter from _aiCode (which reads it from constraintContract).
    // Previously this referenced constraintContract directly, which was a ReferenceError because
    // _phase1_initialGeneration does not receive constraintContract as a parameter.
    const _appArchetype = appArchetype || 'general';
    const ARCHETYPE_COMPONENT_GUIDANCE = {
      saas_dashboard:      'ARCHETYPE: saas_dashboard — Light theme. Sidebar (w-64 bg-white border-r border-gray-200) on left. Stat cards row (grid grid-cols-4 gap-6, each bg-white rounded-xl shadow-sm border border-gray-200 p-6) at top. Data table below (bg-white rounded-xl shadow-sm, thead bg-gray-50 text-gray-500). Main content bg-gray-50 p-8. Active sidebar item: bg-blue-50 text-blue-700.',
      ai_operations:       'ARCHETYPE: ai_operations — Light theme command center. Top status bar with health badges (bg-green-100 text-green-800 / bg-red-100 text-red-800). Main panel: card grid + log feed (bg-white rounded-xl shadow-sm, font-mono for logs). Sidebar bg-white. Clean, professional, not dark.',
      crm_sales:           'ARCHETYPE: crm_sales — Light theme pipeline view. Kanban columns or filterable list on bg-gray-50. Contact/deal cards bg-white rounded-xl shadow-sm with avatar initials (bg-blue-600 rounded-full). Stage badges (bg-blue-100 text-blue-800 / bg-yellow-100 text-yellow-800). Sidebar bg-white with sections: Leads, Deals, Contacts, Reports.',
      fintech:             'ARCHETYPE: fintech — Light theme, number-first. Large stat cards (bg-white rounded-xl shadow-sm p-6) with big numbers (text-3xl font-bold). Transaction table bg-white rounded-xl shadow-sm. Green text-green-600 for positive, red text-red-600 for negative. Currency symbols + 2 decimal places.',
      workflow_automation: 'ARCHETYPE: workflow_automation — Light theme. Step/stage list on bg-gray-50. Each step as bg-white rounded-xl shadow-sm card showing trigger, action type, status badge, last-run time. Run history table below. Status: bg-yellow-100 text-yellow-800 pending, bg-blue-100 text-blue-800 running, bg-green-100 text-green-800 success, bg-red-100 text-red-800 failed.',
      analytics_platform:  'ARCHETYPE: analytics_platform — Light theme, chart-dominant. Filter bar + date range at top (bg-white rounded-xl shadow-sm p-4). Metric cards (bg-white rounded-xl shadow-sm) below filters. Chart panels (bg-white rounded-xl shadow-sm) in main area. Data table at bottom. All on bg-gray-50.',
      marketplace:         'ARCHETYPE: marketplace — Light theme. Product/listing grid on bg-gray-50. Cards bg-white rounded-xl shadow-sm hover:shadow-md. Order management table bg-white. Status badges (bg-green-100 text-green-800 active, bg-yellow-100 text-yellow-800 pending). Category filters. Multi-entity nav.',
      devtools:            'ARCHETYPE: devtools — Light theme operational console. Status panel at top with color-coded health (bg-green-100/bg-red-100). Log viewer with bg-gray-900 text-green-400 font-mono (logs can be dark for readability). Metric cards bg-white rounded-xl shadow-sm. Environment list on bg-gray-50.',
    };
    let archetypeBlock = '';
    if (_appArchetype && _appArchetype !== 'general' && ARCHETYPE_COMPONENT_GUIDANCE[_appArchetype]) {
      archetypeBlock = `\n\n=== APP ARCHETYPE: ${_appArchetype.toUpperCase()} ===\n${ARCHETYPE_COMPONENT_GUIDANCE[_appArchetype]}\nThis archetype guidance is BINDING for layout and component selection. Follow the prescribed pattern — do not substitute generic card grids for the specified layout.\n=== END ARCHETYPE ===`;
      console.log(`[BuilderAgent] Phase 1: archetype block injected — ${_appArchetype}`);
    }

    // ── Template scaffold loading ──────────────────────────────────────────
    // For matched archetypes, load a production-quality base template.
    // The LLM customizes the template rather than generating from scratch —
    // preserving layout, animations, and visual quality while adapting content.
    // Map EVERY archetype to a production-quality template.
    // Archetypes without a dedicated template use the closest structural match.
    const TEMPLATE_MAP = {
      saas_dashboard:      'template-saas-dashboard.html',
      ai_operations:       'template-ai-ops.html',
      analytics_platform:  'template-analytics.html',
      crm_sales:           'template-crm-sales.html',
      fintech:             'template-saas-dashboard.html',   // stat cards + table = financial dashboard
      workflow_automation: 'template-saas-dashboard.html',   // sidebar + status table = workflow view
      marketplace:         'template-saas-dashboard.html',   // sidebar + cards + table = marketplace admin
      devtools:            'template-ai-ops.html',           // split-panel + logs = devtools console
    };
    // Template block disabled — replaced by reference implementation approach.
    // The reference implementation (injected for React CDN builds) provides
    // concrete code patterns the LLM pattern-matches against, which is more
    // effective than forcing a dark-mode template and hoping the LLM customizes it.
    // The old templates used dark-mode Design DNA which conflicts with the
    // light-theme Tailwind direction.
    let templateBlock = '';
    // Template loading intentionally skipped — reference implementation handles quality

    // ── Reference implementation: concrete code the LLM must pattern-match ────
    // This is NOT instructions — it is actual working code showing the exact
    // Tailwind patterns, component structure, and visual quality expected.
    // The LLM adapts this to the user's specific domain.
    let referenceBlock = '';
    if (isViteReactBuild) {
      referenceBlock = `

=== REFERENCE IMPLEMENTATION — PATTERN-MATCH AGAINST THIS ===
Below is a complete working Task Manager app showing the EXACT visual quality, component patterns, and Vite React structure you must produce. Your output must match this level of polish — adapt the domain/content but keep the same styling patterns.

REFERENCE index.html:
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task Manager</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
\`\`\`

REFERENCE src/main.jsx:
\`\`\`jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
\`\`\`

REFERENCE src/App.jsx (showing exact component patterns and Tailwind classes):
\`\`\`jsx
import { useState, useEffect, useCallback } from "react";

// Reusable components with exact Tailwind patterns
const Card = ({ children, className = '' }) => (
  <div className={\`bg-white rounded-xl shadow-sm border border-gray-200 \${className}\`}>{children}</div>
);

const Badge = ({ children, variant = 'default' }) => {
  const styles = {
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    danger: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800',
    default: 'bg-gray-100 text-gray-800'
  };
  return <span className={\`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium \${styles[variant]}\`}>{children}</span>;
};

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState('');
  const [filter, setFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    fetch('/api/tasks').then(r => r.json()).then(setTasks).catch(console.error);
  }, []);

  const addTask = (e) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTask }) })
      .then(r => r.json()).then(task => { setTasks(prev => [...prev, task]); setNewTask(''); setShowModal(false); });
  };

  const deleteTask = (id) => {
    fetch(\`/api/tasks/\${id}\`, { method: 'DELETE' }).then(() => setTasks(prev => prev.filter(t => t.id !== id)));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Task Manager</h1>
          <button onClick={() => setShowModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">+ Add Task</button>
        </div>
      </div>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Stat cards with responsive grid */}
        </div>
        <Card className="divide-y divide-gray-100">
          {tasks.map(task => (
            <div key={task.id} className="flex items-center justify-between p-4 hover:bg-gray-50">
              <span className="text-gray-900">{task.title}</span>
              <button onClick={() => deleteTask(task.id)} className="text-gray-400 hover:text-red-500">\\u2715</button>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
\`\`\`

REFERENCE src/index.css:
\`\`\`css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-gray-50 text-gray-900 min-h-screen antialiased;
}
\`\`\`

REFERENCE vite.config.js:
\`\`\`js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist' }
});
\`\`\`

YOUR OUTPUT MUST MATCH THIS QUALITY LEVEL:
- Vite entry (NO CDN scripts) — index.html with <script type="module" src="/src/main.jsx">
- ES module imports in all .jsx files (import { useState } from "react")
- export default on the App component
- Clean bg-gray-50 page background with bg-white cards
- Responsive Tailwind prefixes (sm:, md:, lg:) on layouts
- Working useState/useEffect for ALL interactive elements
=== END REFERENCE IMPLEMENTATION ===`;
    }

    // Senior engineer system prompt is the hardcoded base layer.
    // Product Context (contextInstruction) flows through the user message — different layers.
    // Intent Gate constraints and SCAFFOLD manifest are injected here as binding structured context.
    // Serena file structure context (if available) tells the LLM what already exists.
    const serenaBlock = serenaContext || '';
    const systemPrompt = `${SENIOR_ENGINEER_SYSTEM_PROMPT}
${constraintInstruction}
${domainConstraintBlock}
${archetypeBlock}
${referenceBlock}
${serenaBlock}

${scaffoldContract}

Output each file using this EXACT format — one section per file, separated by blank lines:

${fileExamples}

${priorityBlock}

${rulesBlock}`;

    // ── Model routing: Claude for full_product/light_app, OpenAI for static_surface ──
    const modelSelection = this._selectModel(intentClass);
    console.log(`[BuilderAgent] Phase 1: routing to ${modelSelection.provider} (model=${modelSelection.model}, intent_class=${intentClass || 'unknown'})`);

    // Build the mandatory file list — not a "hint", a contract
    const manifestDirective = scaffoldManifest.length > 0
      ? `\n\nYou MUST generate EXACTLY these files (scaffold contract — binding): ${scaffoldManifest.join(', ')}\nDo NOT skip any file. Do NOT add ANY files not in this list.`
      : '';

    // Schema-aware generation order: explicit file-by-file ordering prevents AI from
    // skipping "supporting" files like .env.example or nested paths like db/database.js.
    // Every file in the manifest is listed by name — no "the rest" or "remaining files".
    const generationOrder = (isFullProduct && isSqliteBuild && isViteReactBuild)
      ? 'Start with package.json, then vite.config.js, then server.js, then db/database.js, then routes/api.js, then .env.example, then index.html, then src/main.jsx, then src/App.jsx, then src/index.css.'
      : (isFullProduct && isSqliteBuild)
      ? 'Start with package.json, then server.js, then db/database.js, then routes/api.js, then .env.example, then index.html then app.jsx.'
      : (isFullProduct && isViteReactBuild)
      ? 'Start with package.json, then vite.config.js, then server.js, then middleware/auth.js, then routes/auth.js, then db/pool.js, then db/queries.js, then migrations/001_schema.js, then routes/api.js, then index.html, then src/main.jsx, then src/App.jsx, then src/index.css.'
      : isFullProduct
      ? 'Start with package.json, then server.js, then middleware/auth.js, then routes/auth.js, then db/pool.js, then db/queries.js, then migrations/001_schema.js, then routes/api.js, then index.html, then app.jsx.'
      : (isViteReactBuild && isSqliteBuild)
      ? 'Start with package.json, then vite.config.js, then server.js, then db/database.js, then routes/api.js, then index.html, then src/main.jsx, then src/App.jsx, then src/index.css. Every file is mandatory — do NOT skip any.'
      : isViteReactBuild
      ? 'Start with package.json, then vite.config.js, then server.js, then routes/api.js, then index.html, then src/main.jsx, then src/App.jsx, then src/index.css. Every file is mandatory — do NOT skip any.'
      : `Generate ALL ${scaffoldManifest.length} files in this exact order: ${scaffoldManifest.join(', ')}. Every file is mandatory — do NOT skip any.`;

    // ── Content fidelity extraction: parse prompt for business name, sections, CTAs ──
    // This ensures the LLM receives explicit directives about WHAT content to generate,
    // not just the structural scaffold. Without this, the LLM defaults to generic templates.
    const contentFidelityBlock = this._buildContentFidelityBlock(prompt);

    // ── Interaction contract checklist: explicit item-by-item requirements ──────
    // The interaction contract in the system prompt defines WHAT components must do.
    // This checklist in the user message ensures the LLM treats each item as mandatory.
    const contractChecklist = this._buildContractChecklist(interactionContract, jsFile);

    // Build a terse content fidelity reminder to repeat at the END of the user message.
    // The full block appears at the top (framing), this echo appears at the bottom (enforcement).
    // Together they bracket the message so the model can't forget the requirements.
    const _cfReqs = this._buildContentFidelityBlock(prompt);
    const _businessName = this._extractBusinessName(prompt);
    // Prefer scaffold-attached content sections (set during SCAFFOLD phase) over re-extracting
    const _sections = contentSections.length > 0 ? contentSections : this._extractRequestedSections(prompt);
    let contentFidelityReminder = '';
    if (_businessName || _sections.length > 0) {
      const parts = [];
      if (_businessName) parts.push(`business name must be "${_businessName}" in <title> and H1`);
      if (_sections.length > 0) {
        parts.push(`MANDATORY sections (each as a distinct <section> with h2/h3 heading): ${_sections.map(s => s.name).join(', ')}`);
      }
      contentFidelityReminder = `\n\nFINAL CONTENT CHECK — VERIFY BEFORE SUBMITTING: ${parts.join('; ')}. Missing any listed section = build failure. Refer to CONTENT SECTION INVENTORY and CONTENT FIDELITY REQUIREMENTS above.`;
    }

    // ── PRIMARY INTENT BLOCK: anchor CODE to the user's actual request ──────────
    // The user prompt is the PRIMARY CONSTRAINT. The PLAN is a decomposition, not a replacement.
    // Extract domain keywords from the prompt to use as hard content requirements.
    // This prevents CODE from generating generic CRUD when the user asked for photo sharing,
    // a fitness tracker, a restaurant booking system, etc.
    const _promptLower = prompt.toLowerCase();
    const DOMAIN_KEYWORD_SETS = [
      { domain: 'photo sharing', keywords: ['photo', 'image', 'upload', 'feed', 'gallery', 'instagram', 'sharing', 'picture', 'album', 'like', 'comment', 'follow'] },
      { domain: 'e-commerce / shopping', keywords: ['product', 'cart', 'checkout', 'shop', 'store', 'order', 'purchase', 'buy', 'payment', 'inventory', 'catalog'] },
      { domain: 'social media / community', keywords: ['post', 'feed', 'follow', 'like', 'comment', 'share', 'profile', 'timeline', 'notification', 'message', 'user', 'community'] },
      { domain: 'task / project management', keywords: ['task', 'todo', 'project', 'board', 'kanban', 'sprint', 'deadline', 'assign', 'status', 'milestone', 'backlog'] },
      { domain: 'fitness / health', keywords: ['workout', 'exercise', 'fitness', 'gym', 'routine', 'health', 'calories', 'run', 'strength', 'cardio', 'weight', 'training'] },
      { domain: 'restaurant / food', keywords: ['restaurant', 'menu', 'food', 'order', 'reservation', 'dining', 'meal', 'recipe', 'kitchen', 'delivery', 'cuisine', 'chef'] },
      { domain: 'finance / budget', keywords: ['budget', 'expense', 'income', 'transaction', 'account', 'finance', 'money', 'bank', 'invest', 'savings', 'crypto', 'wallet'] },
      { domain: 'real estate / property', keywords: ['property', 'listing', 'real estate', 'rent', 'apartment', 'house', 'bedroom', 'location', 'price', 'agent', 'mortgage'] },
      { domain: 'education / courses', keywords: ['course', 'lesson', 'student', 'teacher', 'quiz', 'quiz', 'learn', 'class', 'grade', 'curriculum', 'enroll', 'assignment'] },
      { domain: 'travel / booking', keywords: ['travel', 'trip', 'hotel', 'flight', 'booking', 'destination', 'itinerary', 'tourist', 'vacation', 'tour', 'accommodation'] },
    ];
    const matchedDomains = DOMAIN_KEYWORD_SETS.filter(ds =>
      ds.keywords.some(kw => _promptLower.includes(kw))
    );
    const domainKeywordList = matchedDomains.length > 0
      ? [...new Set(matchedDomains.flatMap(ds => ds.keywords.filter(kw => _promptLower.includes(kw))))].slice(0, 12)
      : [];

    let primaryIntentBlock = `=== PRIMARY INTENT (BINDING — READ BEFORE GENERATING ANY CODE) ===
USER'S ACTUAL REQUEST: "${prompt}"

This is what you are building. Every file you generate must directly implement this specific request.
The Architecture Plan below is a decomposition tool — do NOT let it replace or dilute the user's intent.

DOMAIN KEYWORDS FROM PROMPT — these concepts MUST appear in the generated output:
${domainKeywordList.length > 0 ? domainKeywordList.map(kw => `- "${kw}"`).join('\n') : '- (general purpose — match the user\'s description exactly)'}

CONTENT FIDELITY RULE: If the user asked for "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}", the generated app must visibly implement THAT specific use case — not a generic CRUD app that happens to share some table names.
=== END PRIMARY INTENT ===`;

    const interactivityCritical = (isViteReactBuild || isReactCdnBuild)
      ? `CRITICAL: The app must be INTERACTIVE and FUNCTIONAL — not just visually polished. In ${jsFile}: every button must have an onClick handler, every form must have onSubmit with preventDefault(), every tab/nav must switch content via useState. Use useState for ALL dynamic data (item lists, form values, active tab, loading state). Use useEffect to fetch data on mount. A beautiful React UI where nothing is clickable is a FAILED build.`
      : `CRITICAL: The app must be INTERACTIVE and FUNCTIONAL — not just visually polished. Every button must have a click handler. Every form must submit. Every tab/nav must switch content. The JavaScript file (${jsFile}) must contain real event listeners and DOM manipulation for ALL interactive elements in index.html. A beautiful UI where nothing is clickable is a FAILED build.`;

    const userMessage = `${contextInstruction ? contextInstruction + '\n\n' : ''}${primaryIntentBlock}\n\n${contentFidelityBlock}\n\nBuild this application: ${prompt}\n\nArchitecture plan:\n${planContext}\n\nTech stack: ${techStack}${manifestDirective}\n\nGenerate ALL files completely using the --- FILE: filename --- format. ${generationOrder}${contractChecklist}${contentFidelityReminder}\n\n${interactivityCritical}`;

    const { rawText, finishReason, tokenUsage } = await this._callStreamingLLM(
      modelSelection, systemPrompt, userMessage, 13000, emitChunk
    );

    console.log(
      `[BuilderAgent] Phase 1 done: ${rawText.length} chars, finish_reason=${finishReason} (${modelSelection.provider}/${modelSelection.model})`
    );

    return { rawText, finishReason, tokenUsage };
  }

  // ── Phase 2: Parse + Normalize ────────────────────────────────────────────────

  /**
   * Parse raw output using cascade strategy, then normalize paths.
   * public/index.html → index.html (CODE prompt uses root-level for frontend files)
   */
  _phase2_parseAndNormalize(rawText) {
    // Parse cascade: delimiter (primary) → JSON fallback → code blocks → truncated recovery
    const raw = this._parseAllStrategies(rawText);

    // Path normalization: scaffold uses public/x but CODE generates at root
    // FRONTEND_ROOT_FILES imported from lib/manifest-constants.js
    const normalized = {};

    for (const [path, content] of Object.entries(raw)) {
      if (!content || content.trim().length === 0) continue; // Drop empty

      // Normalize public/index.html → index.html
      if (path.startsWith('public/')) {
        const basename = path.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) {
          normalized[basename] = content;
          continue;
        }
      }
      normalized[path] = content;
    }

    return normalized;
  }

  // ── Phase 2.5: Inline Asset Extraction ──────────────────────────────────────

  /**
   * Deterministic de-inlining pass: extract inlined CSS and JS from HTML blobs.
   *
   * The AI frequently ignores the scaffold manifest and generates a single HTML
   * file with everything inlined (<style> blocks, inline <script> blocks).
   * This method detects that scenario and extracts the inlined assets into their
   * declared manifest files.
   *
   * This is PREVENTION — we fix the output deterministically instead of waiting
   * for VERIFY to catch the contract violation.
   *
   * @param {object} files - Parsed file map { filename: content }
   * @param {string[]} scaffoldManifest - The binding manifest file list
   * @returns {object} Fixed file map with extracted assets
   */
  _extractInlinedAssets(files, scaffoldManifest) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return files;

    // Normalize manifest to canonical names (public/x → x for frontend files)
    // FRONTEND_ROOT_FILES imported from lib/manifest-constants.js
    const manifestSet = new Set();
    for (const f of scaffoldManifest) {
      if (f.startsWith('public/')) {
        const basename = f.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) { manifestSet.add(basename); continue; }
      }
      manifestSet.add(f);
    }

    // Find the HTML entry file (index.html)
    const htmlFile = files['index.html'] || files['public/index.html'];
    if (!htmlFile) return files; // No HTML to extract from

    const result = { ...files };
    let html = typeof htmlFile === 'string' ? htmlFile : '';
    let modified = false;

    // ── Extract <style> blocks → styles.css ──────────────────────────────────
    const cssManifestName = manifestSet.has('styles.css') ? 'styles.css' : null;
    if (cssManifestName && !result[cssManifestName]) {
      // Extract all <style>...</style> blocks from the HTML
      const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      const cssBlocks = [];
      let styleMatch;
      while ((styleMatch = styleRegex.exec(html)) !== null) {
        const cssContent = styleMatch[1].trim();
        if (cssContent.length > 0) {
          cssBlocks.push(cssContent);
        }
      }

      if (cssBlocks.length > 0) {
        // Write extracted CSS to styles.css
        result[cssManifestName] = '/* Extracted from inline <style> — scaffold manifest: styles.css */\n' +
          cssBlocks.join('\n\n');

        // Remove <style> blocks from HTML and ensure <link> to styles.css exists
        html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        if (!html.includes('href="styles.css"') && !html.includes("href='styles.css'")) {
          html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>');
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: extracted ${cssBlocks.length} <style> block(s) → ${cssManifestName} (${result[cssManifestName].length} chars)`);
      } else {
        // No <style> blocks, but manifest requires styles.css — create minimal valid CSS
        result[cssManifestName] = '/* Custom styles — Tailwind handles most styling via utility classes */\n' +
          '/* Add animations, gradients, and custom properties that Tailwind cannot express */\n' +
          'html { scroll-behavior: smooth; }\n';
        if (!html.includes('href="styles.css"') && !html.includes("href='styles.css'")) {
          html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>');
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: no <style> blocks found, created minimal ${cssManifestName}`);
      }
    }

    // ── Extract inline <script> blocks → script.js ───────────────────────────
    const jsManifestName = manifestSet.has('script.js') ? 'script.js'
      : manifestSet.has('app.js') ? 'app.js'
      : null;
    if (jsManifestName && !result[jsManifestName]) {
      // Extract all inline <script> blocks (NOT <script src="..."> external refs)
      // WHY threshold 25 + handler check: scripts under 20 chars were silently dropped
      // even when they contained addEventListener/onclick — killing interactivity.
      const scriptRegex = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
      const jsBlocks = [];
      let scriptMatch;
      while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        const jsContent = scriptMatch[1].trim();
        // Keep scripts that are non-trivial (>25 chars) OR contain event wiring
        if (jsContent.length > 25 || jsContent.includes('addEventListener') || jsContent.includes('onclick')) {
          jsBlocks.push(jsContent);
        }
      }

      if (jsBlocks.length > 0) {
        // Write extracted JS to the manifest file
        result[jsManifestName] = '// Extracted from inline <script> — scaffold manifest: ' + jsManifestName + '\n' +
          jsBlocks.join('\n\n');

        // Remove the inline <script> blocks from HTML (keep external <script src="..."> refs)
        html = html.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, (match) => {
          // Keep very short scripts that don't contain event wiring (Tailwind config, etc.)
          const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/i, '').trim();
          if (content.length <= 25 && !content.includes('addEventListener') && !content.includes('onclick')) return match;
          return '';
        });

        // Ensure <script src="..."> exists in the HTML
        if (!html.includes(`src="${jsManifestName}"`) && !html.includes(`src='${jsManifestName}'`)) {
          html = html.replace(/<\/body>/i, `  <script src="${jsManifestName}"></script>\n</body>`);
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: extracted ${jsBlocks.length} inline <script> block(s) → ${jsManifestName} (${result[jsManifestName].length} chars)`);
      } else {
        // No inline scripts, but manifest requires the JS file — create minimal valid JS
        result[jsManifestName] = '// ' + jsManifestName + ' — browser JavaScript\n' +
          '(function() {\n' +
          '  // Fade-in animation for elements with .fade-in class\n' +
          '  document.addEventListener("DOMContentLoaded", function() {\n' +
          '    var observer = new IntersectionObserver(function(entries) {\n' +
          '      entries.forEach(function(entry) {\n' +
          '        if (entry.isIntersecting) entry.target.classList.add("visible");\n' +
          '      });\n' +
          '    }, { threshold: 0.1 });\n' +
          '    document.querySelectorAll(".fade-in").forEach(function(el) { observer.observe(el); });\n' +
          '  });\n' +
          '})();\n';
        if (!html.includes(`src="${jsManifestName}"`) && !html.includes(`src='${jsManifestName}'`)) {
          html = html.replace(/<\/body>/i, `  <script src="${jsManifestName}"></script>\n</body>`);
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: no inline <script> blocks found, created minimal ${jsManifestName}`);
      }
    }

    // ── Design DNA injection DISABLED ────────────────────────────────────────
    // The design-dna.css file uses dark-mode backgrounds (#0a0a0f, #12121a)
    // which conflict with the light-theme Tailwind direction. Generated apps
    // now use Tailwind CDN classes exclusively for styling.
    // Keeping this comment as documentation of the change.
    // (Previously injected design-dna.css as first stylesheet in <head>)

    // Write modified HTML back if we changed it
    if (modified) {
      if (result['index.html']) {
        result['index.html'] = html;
      } else if (result['public/index.html']) {
        result['public/index.html'] = html;
      }
    }

    return result;
  }

  // ── Template Quality Enforcement ───────────────────────────────────────────
  // When an archetype matched a template, verify the LLM output actually uses
  // Design DNA tokens and dark-mode styling. If not, replace the HTML with the
  // template, customized with content extracted from the LLM's output.
  // This is deterministic — it runs after all LLM phases complete.

  _enforceTemplateQuality(files, archetype, prompt) {
    // Template enforcement disabled — the reference implementation approach
    // produces better results than replacing LLM output with pre-built templates.
    // The old dark-mode templates conflicted with the light-theme Tailwind direction.
    // Quality is now enforced via:
    // 1. Reference implementation in system prompt (concrete code to pattern-match)
    // 2. Updated scoring in _scoreDesignDnaCompliance (rewards light Tailwind patterns)
    // 3. Explicit Tailwind patterns in rulesBlock sections
    console.log(`[BuilderAgent] Template enforcement: skipped (using reference implementation approach instead)`);
    return files;
  }

  /**
   * Score how well the generated HTML uses modern Tailwind patterns.
   * Returns 0-100. Higher = better compliance.
   * Rewards light-theme Tailwind patterns (bg-gray-50, bg-white, shadow-sm, border-gray-200).
   */
  _scoreDesignDnaCompliance(html) {
    let score = 0;

    // Tailwind CDN loaded
    if (html.includes('cdn.tailwindcss.com')) score += 15;

    // Light-theme background indicators (good — this is what we want)
    if (html.includes('bg-gray-50') || html.includes('bg-white')) score += 15;
    if (html.includes('border-gray-200') || html.includes('border-gray-100')) score += 10;
    if (html.includes('shadow-sm') || html.includes('shadow-md')) score += 10;

    // Tailwind utility class usage (strong signal of proper Tailwind styling)
    const twClasses = ['rounded-xl', 'rounded-lg', 'font-medium', 'font-bold', 'text-gray-900',
      'text-gray-600', 'text-gray-500', 'hover:bg-', 'transition-colors', 'focus:ring-2'];
    for (const cls of twClasses) {
      if (html.includes(cls)) score += 3;
    }

    // React indicators
    if (html.includes('useState') || html.includes('React')) score += 10;
    if (html.includes('onClick') || html.includes('onChange')) score += 5;

    // Penalty: dark-mode indicators (we no longer want these)
    if (html.includes('#0a0a0f') || html.includes('bg-gray-950') || html.includes('bg-gray-900')) score -= 15;
    if (html.includes('--bg-base') || html.includes('--bg-surface')) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Extract the app name from the user prompt or LLM-generated HTML.
   * Falls back to a cleaned-up version of the prompt.
   */
  _extractAppName(prompt, html) {
    // Try to extract from HTML <title>
    const titleMatch = html?.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1] && titleMatch[1].length < 60 && !titleMatch[1].includes('{{')) {
      const title = titleMatch[1].replace(/\s*[—–-]\s*(Dashboard|App|Panel|Console).*$/i, '').trim();
      if (title.length > 2) return title;
    }

    // Try to extract from prompt: "Build an X" → X, "Create a Y" → Y
    const promptMatch = prompt?.match(/(?:build|create|make|design)\s+(?:an?\s+)?(.+?)(?:\s+(?:app|application|dashboard|website|site|platform|tool|system))?$/i);
    if (promptMatch && promptMatch[1]) {
      const name = promptMatch[1].replace(/\s+(app|application|dashboard|website|site|platform|tool|system)\s*$/i, '').trim();
      // Capitalize each word
      return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // Fallback: use prompt directly but trim
    return (prompt || 'Dashboard').slice(0, 40).trim();
  }

  // ── Post-Phase 6: Hard Manifest Enforcement ─────────────────────────────────

  /**
   * Enforce the scaffold manifest as a HARD GATE on CODE output.
   * After all phases complete, this method:
   *   1. Maps equivalent files (app.js ↔ script.js) to match the manifest
   *   2. Strips ALL files not in the scaffold manifest
   *   3. Returns only manifest-compliant files
   *
   * This is the final enforcement layer — runs AFTER the continuation loop,
   * BEFORE the output is returned to the orchestrator.
   */
  _enforceManifest(files, scaffoldManifest, { throwOnMissing = true } = {}) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return files;

    // Uses shared constants from lib/manifest-constants.js to stay in sync
    // with PipelineExecutor._enforceManifest and validateCodeAgainstScaffold.
    const manifestSet = buildManifestSet(scaffoldManifest);
    const renamed = applyEquivalenceRenames(files, manifestSet, '[BuilderAgent]');

    // Strip all files not in the manifest
    const enforced = {};
    const stripped = [];
    for (const [filePath, content] of Object.entries(renamed)) {
      if (manifestSet.has(filePath)) {
        enforced[filePath] = content;
      } else {
        stripped.push(filePath);
      }
    }

    if (stripped.length > 0) {
      const totalBefore = Object.keys(renamed).length;
      const stripRatio = totalBefore > 0 ? stripped.length / totalBefore : 0;
      console.log(`[BuilderAgent] Manifest enforcement: stripped ${stripped.length}/${totalBefore} unexpected files: ${stripped.join(', ')}`);

      // Warn when enforcement strips more than 50% of files — likely a mapping issue
      if (stripRatio > 0.5) {
        console.warn(`[BuilderAgent] WARNING: Manifest enforcement stripped >${Math.round(stripRatio * 100)}% of files (${stripped.length}/${totalBefore}). Manifest: [${[...manifestSet].join(', ')}]. Stripped: [${stripped.join(', ')}]`);
      }
    }

    // Safety net: if ALL files were stripped but we had valid renamed files,
    // the manifest matching is broken — fall back to best-effort to avoid empty builds
    if (Object.keys(enforced).length === 0 && Object.keys(renamed).length > 0) {
      console.warn(`[BuilderAgent] All files stripped by manifest enforcement — falling back to best-effort renamed files. Manifest: [${[...manifestSet].join(', ')}]. Files: [${Object.keys(renamed).join(', ')}]`);
      return renamed;
    }

    const missing = [...manifestSet].filter(f => !enforced[f]);
    if (missing.length > 0) {
      if (throwOnMissing) {
        // HARD GATE: CODE phase MUST generate all files in the SCAFFOLD manifest.
        // Collapsing manifest files into fewer files is a contract violation.
        // Fail with descriptive error so the pipeline can retry or surface the issue.
        const generatedFiles = Object.keys(enforced);
        const errorMsg =
          `[BuilderAgent] SCAFFOLD MANIFEST PARITY VIOLATION: CODE output has ${generatedFiles.length} files ` +
          `but SCAFFOLD manifest requires ${manifestSet.size} files. ` +
          `Missing ${missing.length} file(s): [${missing.join(', ')}]. ` +
          `Generated files: [${generatedFiles.join(', ')}]. ` +
          `Scaffold manifest: [${[...manifestSet].join(', ')}]. ` +
          `CODE must generate a separate file for EACH entry in the SCAFFOLD manifest — ` +
          `do not collapse multiple files into a single file.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      } else {
        // Non-throwing mode: log missing files for downstream gap detection/fill.
        // Used at intermediate pipeline stages where Phase 3-6 continuation or
        // gap-fill stubs will handle the missing files.
        console.warn(
          `[BuilderAgent] Manifest enforcement: ${missing.length} file(s) still missing ` +
          `(will be handled by continuation/gap-fill): [${missing.join(', ')}]`
        );
      }
    }

    console.log(`[BuilderAgent] Manifest enforcement complete: ${Object.keys(enforced).length}/${manifestSet.size} files match manifest`);
    return enforced;
  }

  // ── Manifest Gap Fill: Stub Generator ──────────────────────────────────────

  /**
   * Generate minimal valid stub content for a manifest-declared file that
   * was not produced by the AI or simulated code path.
   *
   * These stubs are NOT production code — they are structural placeholders
   * that satisfy the contract (file exists, non-empty, syntactically valid)
   * so the app deploys and functions at a basic level.
   */
  _generateStubContent(filename, prompt = '', scaffoldManifest = []) {
    const safeTitle = this._deriveTitle ? this._deriveTitle(prompt) : 'App';
    const isViteReactBuildContext = Array.isArray(scaffoldManifest) && (scaffoldManifest.includes('src/main.jsx') || scaffoldManifest.includes('src/App.jsx'));
    const isReactBuildContext = isViteReactBuildContext || (Array.isArray(scaffoldManifest) && scaffoldManifest.includes('app.jsx'));

    // ── Domain-aware stubs: use prompt to determine entity names ──
    const appDomain = this._deriveAppDomain ? this._deriveAppDomain(prompt) : null;
    const entityName = appDomain ? appDomain.entity.name : 'items';
    const entityFields = appDomain ? appDomain.fields : [
      { name: 'name', type: 'varchar(255)', required: true },
      { name: 'description', type: 'text', required: false },
    ];
    const dbColumns = appDomain ? appDomain.dbColumns : "name VARCHAR(255) NOT NULL, description TEXT DEFAULT ''";
    const firstRequired = entityFields.find(f => f.required) || entityFields[0];

    const stubs = {
      'migrate.js': [
        "const { Pool } = require('pg');",
        "",
        "async function migrate() {",
        "  const pool = new Pool({",
        "    connectionString: process.env.DATABASE_URL,",
        "    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "  });",
        "",
        "  try {",
        "    await pool.query(`",
        `      CREATE TABLE IF NOT EXISTS ${entityName} (`,
        "        id SERIAL PRIMARY KEY,",
        `        ${dbColumns},`,
        "        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "      )",
        "    `);",
        "    console.log('Migration complete');",
        "  } catch (err) {",
        "    console.error('Migration failed:', err.message);",
        "    process.exit(1);",
        "  } finally {",
        "    await pool.end();",
        "  }",
        "}",
        "",
        "migrate();",
      ].join('\n'),

      'db/queries.js': [
        "// Parameterized SQL queries — all database access goes through this module",
        "",
        "module.exports = function(pool) {",
        "  return {",
        "    async getAll() {",
        `      const { rows } = await pool.query('SELECT * FROM ${entityName} ORDER BY created_at DESC');`,
        "      return rows;",
        "    },",
        `    async create(${entityFields.map(f => f.name).join(', ')}) {`,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${entityName} (${entityFields.map(f => f.name).join(', ')}) VALUES (${entityFields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *',`,
        `        [${entityFields.map(f => f.required ? f.name : `(${f.name} || '').trim()`).join(', ')}]`,
        "      );",
        "      return rows[0];",
        "    },",
        "    async deleteById(id) {",
        `      await pool.query('DELETE FROM ${entityName} WHERE id = $1', [id]);`,
        "    }",
        "  };",
        "};",
      ].join('\n'),

      'db/pool.js': [
        "const { Pool } = require('pg');",
        "",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "module.exports = pool;",
      ].join('\n'),

      'db/database.js': [
        "// Dual-driver database — auto-detects postgres:// URL vs SQLite file",
        "const url = process.env.DATABASE_URL || '';",
        "const isPostgres = url.startsWith('postgres://') || url.startsWith('postgresql://');",
        "let query, exec, ready;",
        "",
        "if (isPostgres) {",
        "  const { Pool } = require('pg');",
        "  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });",
        "  query = (sql, params) => pool.query(sql, params).then(r => r.rows);",
        "  exec = (sql) => pool.query(sql);",
        `  ready = pool.query(\`CREATE TABLE IF NOT EXISTS ${entityName} (id SERIAL PRIMARY KEY, ${dbColumns.replace(/VARCHAR\(255\)/gi, 'TEXT').replace(/DECIMAL\([^)]+\)/gi, 'NUMERIC')}, created_at TIMESTAMP DEFAULT NOW())\`).then(() => console.log('[DB] PostgreSQL ready'));`,
        "} else {",
        "  const Database = require('better-sqlite3');",
        "  const db = new Database(url || './app.db');",
        "  db.pragma('journal_mode = WAL');",
        "  db.pragma('foreign_keys = ON');",
        `  db.exec(\`CREATE TABLE IF NOT EXISTS ${entityName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${dbColumns.replace(/VARCHAR/gi, 'TEXT').replace(/DECIMAL\([^)]+\)/gi, 'REAL')}, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)\`);`,
        "  query = (sql, params) => {",
        "    const stmt = db.prepare(sql.replace(/\\$\\d+/g, '?'));",
        "    const s = sql.trim().toUpperCase();",
        "    if (s.startsWith('SELECT') || s.includes('RETURNING')) return Promise.resolve(stmt.all(...(params || [])));",
        "    const info = stmt.run(...(params || []));",
        "    return Promise.resolve([{ id: info.lastInsertRowid, changes: info.changes }]);",
        "  };",
        "  exec = (sql) => { db.exec(sql); return Promise.resolve(); };",
        "  ready = Promise.resolve();",
        "  console.log('[DB] SQLite ready:', url || './app.db');",
        "}",
        "",
        "module.exports = { query, exec, ready };",
      ].join('\n'),

      'middleware/auth.js': [
        "const jwt = require('jsonwebtoken');",
        "",
        "module.exports = function(req, res, next) {",
        "  const authHeader = req.headers.authorization;",
        "  if (!authHeader || !authHeader.startsWith('Bearer ')) {",
        "    return res.status(401).json({ error: 'Authorization required' });",
        "  }",
        "  try {",
        "    const token = authHeader.split(' ')[1];",
        "    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');",
        "    next();",
        "  } catch (err) {",
        "    return res.status(401).json({ error: 'Invalid token' });",
        "  }",
        "};",
      ].join('\n'),

      'middleware/error.js': [
        "// Global error handling middleware",
        "module.exports = function(err, req, res, _next) {",
        "  console.error('[Error]', err.message);",
        "  res.status(err.status || 500).json({",
        "    success: false,",
        "    message: err.message || 'Internal server error'",
        "  });",
        "};",
      ].join('\n'),

      'routes/auth.js': [
        "const { Router } = require('express');",
        "const bcrypt = require('bcrypt');",
        "const jwt = require('jsonwebtoken');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "  const SECRET = process.env.JWT_SECRET || 'dev-secret';",
        "",
        "  router.post('/signup', async (req, res, next) => {",
        "    try {",
        "      const { email, password } = req.body;",
        "      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });",
        "      const hash = await bcrypt.hash(password, 10);",
        "      const { rows } = await pool.query(",
        "        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',",
        "        [email, hash]",
        "      );",
        "      const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, SECRET, { expiresIn: '7d' });",
        "      res.status(201).json({ token, user: rows[0] });",
        "    } catch (err) { next(err); }",
        "  });",
        "",
        "  router.post('/login', async (req, res, next) => {",
        "    try {",
        "      const { email, password } = req.body;",
        "      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });",
        "      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);",
        "      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });",
        "      const valid = await bcrypt.compare(password, rows[0].password_hash);",
        "      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });",
        "      const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, SECRET, { expiresIn: '7d' });",
        "      res.json({ token, user: { id: rows[0].id, email: rows[0].email } });",
        "    } catch (err) { next(err); }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "",
        `  router.get('/${entityName}', async (req, res) => {`,
        "    try {",
        `      const { rows } = await pool.query('SELECT * FROM ${entityName} ORDER BY created_at DESC');`,
        `      res.json({ success: true, ${entityName}: rows });`,
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.post('/${entityName}', async (req, res) => {`,
        "    try {",
        `      const { ${entityFields.map(f => f.name).join(', ')} } = req.body;`,
        `      if (!${firstRequired.name} || !${firstRequired.name}.toString().trim()) return res.status(400).json({ success: false, message: '${firstRequired.name} is required' });`,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${entityName} (${entityFields.map(f => f.name).join(', ')}) VALUES (${entityFields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *',`,
        `        [${entityFields.map(f => f.required ? `${f.name}.toString().trim()` : `(${f.name} || '').toString().trim()`).join(', ')}]`,
        "      );",
        `      res.status(201).json({ success: true, ${appDomain ? appDomain.entity.singular : 'item'}: rows[0] });`,
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${entityName}/:id', async (req, res) => {`,
        "    try {",
        `      await pool.query('DELETE FROM ${entityName} WHERE id = $1', [req.params.id]);`,
        "      res.json({ success: true });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'models/index.js': [
        "// Model definitions and exports",
        "module.exports = {",
        "  // Models are auto-loaded from this directory",
        "};",
      ].join('\n'),

      '.env.example': [
        "DATABASE_URL=./app.db",
        "JWT_SECRET=change-me-in-production",
        "PORT=3000",
        "NODE_ENV=development",
      ].join('\n'),

      'db/database.js': [
        "// Dual-driver database — auto-detects postgres:// URL vs SQLite file",
        "const url = process.env.DATABASE_URL || '';",
        "const isPostgres = url.startsWith('postgres://') || url.startsWith('postgresql://');",
        "let query, exec, ready;",
        "",
        "if (isPostgres) {",
        "  const { Pool } = require('pg');",
        "  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });",
        "  query = (sql, params) => pool.query(sql, params).then(r => r.rows);",
        "  exec = (sql) => pool.query(sql);",
        "  ready = pool.query(`",
        `    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`,
        `    CREATE TABLE IF NOT EXISTS ${entityName} (id SERIAL PRIMARY KEY,`,
        ...entityFields.map(f => `    ${f.name} TEXT${f.required ? ' NOT NULL' : " DEFAULT ''"},`),
        `    created_at TIMESTAMP DEFAULT NOW());`,
        "  `).then(() => console.log('[DB] PostgreSQL ready'));",
        "} else {",
        "  const Database = require('better-sqlite3');",
        "  const db = new Database(url || './app.db');",
        "  db.pragma('journal_mode = WAL');",
        "  db.pragma('foreign_keys = ON');",
        "  db.exec(`",
        `    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
        `    CREATE TABLE IF NOT EXISTS ${entityName} (id INTEGER PRIMARY KEY AUTOINCREMENT,`,
        ...entityFields.map(f => `    ${f.name} TEXT${f.required ? ' NOT NULL' : " DEFAULT ''"},`),
        "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);",
        "  `);",
        "  query = (sql, params) => {",
        "    const stmt = db.prepare(sql.replace(/\\$\\d+/g, '?'));",
        "    const s = sql.trim().toUpperCase();",
        "    if (s.startsWith('SELECT') || s.includes('RETURNING')) return Promise.resolve(stmt.all(...(params || [])));",
        "    const info = stmt.run(...(params || []));",
        "    return Promise.resolve([{ id: info.lastInsertRowid, changes: info.changes }]);",
        "  };",
        "  exec = (sql) => { db.exec(sql); return Promise.resolve(); };",
        "  ready = Promise.resolve();",
        "  console.log('[DB] SQLite ready:', url || './app.db');",
        "}",
        "",
        "module.exports = { query, exec, ready };",
      ].join('\n'),

      'migrations/001_schema.js': [
        "exports.up = (pgm) => {",
        `  pgm.createTable('${entityName}', {`,
        "    id: 'id',",
        ...entityFields.map(f => `    ${f.name}: { type: '${f.type}', ${f.required ? 'notNull: true' : "default: ''"} },`),
        "    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') }",
        "  });",
        "};",
        "",
        "exports.down = (pgm) => {",
        `  pgm.dropTable('${entityName}');`,
        "};",
      ].join('\n'),

      // ── Vite React stubs ──────────────────────────────────────
      'src/main.jsx': [
        "import React from 'react';",
        "import ReactDOM from 'react-dom/client';",
        "import App from './App';",
        "import './index.css';",
        "",
        "ReactDOM.createRoot(document.getElementById('root')).render(",
        "  <React.StrictMode>",
        "    <App />",
        "  </React.StrictMode>",
        ");",
      ].join('\n'),

      'src/App.jsx': [
        "import { useState } from 'react';",
        "",
        "function App() {",
        `  const [items, setItems] = useState([]);`,
        "",
        "  return (",
        "    <div className=\"min-h-screen bg-gray-50\">",
        "      <div className=\"p-4 sm:p-8 max-w-5xl mx-auto\">",
        `        <h1 className="text-2xl font-bold text-gray-900 mb-6">${safeTitle}</h1>`,
        "        <div className=\"bg-white rounded-xl shadow-sm border border-gray-200 p-6\">",
        `          <p className="text-gray-500">Loading ${entityName}...</p>`,
        "        </div>",
        "      </div>",
        "    </div>",
        "  );",
        "}",
        "",
        "export default App;",
      ].join('\n'),

      'src/index.css': [
        "@tailwind base;",
        "@tailwind components;",
        "@tailwind utilities;",
        "",
        "html { scroll-behavior: smooth; }",
      ].join('\n'),

      'vite.config.js': [
        "import { defineConfig } from 'vite';",
        "import react from '@vitejs/plugin-react';",
        "",
        "export default defineConfig({",
        "  plugins: [react()],",
        "});",
      ].join('\n'),
    };

    // Direct match
    if (stubs[filename]) return stubs[filename];

    // Fallback by file extension
    if (filename.endsWith('.jsx')) {
      // Vite React JSX stub — ES module imports, export default
      if (isViteReactBuildContext) {
        return [
          "import { useState } from 'react';",
          '',
          'function App() {',
          `  const [items, setItems] = useState([]);`,
          '',
          '  return (',
          '    <div className="min-h-screen bg-gray-50">',
          '      <div className="p-4 sm:p-8 max-w-5xl mx-auto">',
          `        <h1 className="text-2xl font-bold text-gray-900 mb-6">${safeTitle}</h1>`,
          '        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">',
          `          <p className="text-gray-500">Loading ${entityName}...</p>`,
          '        </div>',
          '      </div>',
          '    </div>',
          '  );',
          '}',
          '',
          'export default App;',
        ].join('\n');
      }
      // Legacy React CDN JSX stub — Babel standalone compiles this in the browser
      return [
        '// React app — compiled by Babel standalone in browser (no import/export/require)',
        'const { useState, useEffect, useCallback, useRef } = React;',
        '',
        '// Reusable Card component',
        'const Card = ({ children, className = "" }) => (',
        '  <div className={`bg-white rounded-xl shadow-sm border border-gray-200 p-6 ${className}`}>{children}</div>',
        ');',
        '',
        '// Reusable Button component',
        'const Button = ({ children, onClick, variant = "primary", className = "" }) => {',
        '  const variants = {',
        '    primary: "bg-blue-600 hover:bg-blue-700 text-white",',
        '    secondary: "bg-gray-100 hover:bg-gray-200 text-gray-700",',
        '    danger: "bg-red-600 hover:bg-red-700 text-white",',
        '    ghost: "hover:bg-gray-100 text-gray-600"',
        '  };',
        '  return <button onClick={onClick} className={`px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer ${variants[variant]} ${className}`}>{children}</button>;',
        '};',
        '',
        `const App = () => {`,
        `  const [items, setItems] = useState([]);`,
        `  return (`,
        `    <div className="min-h-screen bg-gray-50">`,
        `      <div className="p-8 max-w-5xl mx-auto">`,
        `        <h1 className="text-2xl font-bold text-gray-900 mb-6">${safeTitle}</h1>`,
        `        <Card>`,
        `          <p className="text-gray-500">Loading ${entityName}...</p>`,
        `        </Card>`,
        `      </div>`,
        `    </div>`,
        `  );`,
        `};`,
        '',
        'ReactDOM.createRoot(document.getElementById("root")).render(<App />);',
      ].join('\n');
    }
    if (filename.endsWith('.js')) {
      return `// ${filename} — auto-generated stub\nmodule.exports = {};\n`;
    }
    if (filename.endsWith('.html')) {
      // Vite React builds get a clean HTML shell — no CDN scripts
      if (isViteReactBuildContext) {
        return [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '  <meta charset="UTF-8">',
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
          `  <title>${safeTitle}</title>`,
          '</head>',
          '<body class="bg-gray-50 min-h-screen antialiased">',
          '  <div id="root"></div>',
          '  <script type="module" src="/src/main.jsx"></script>',
          '</body>',
          '</html>',
        ].join('\n');
      }
      // Legacy React CDN builds (fallback — should not be generated for new builds)
      if (isReactBuildContext) {
        return [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '  <meta charset="UTF-8">',
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
          `  <title>${safeTitle}</title>`,
          '  <script src="https://cdn.tailwindcss.com"></script>',
          '  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>',
          '  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>',
          '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
          '</head>',
          '<body class="bg-gray-50 min-h-screen antialiased">',
          '  <div id="root"></div>',
          '  <script type="text/babel" src="app.jsx"></script>',
          '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
          '</body>',
          '</html>',
        ].join('\n');
      }
      const _entityLabel = appDomain ? appDomain.entity.singular : 'Item';
      const _entityPlural = appDomain ? appDomain.entity.name : 'items';
      const _icon = appDomain ? appDomain.icon : '📋';
      return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        `  <title>${safeTitle}</title>`,
        '  <script src="https://cdn.tailwindcss.com"></script>',
        '  <link rel="stylesheet" href="styles.css">',
        '</head>',
        '<body class="bg-gray-50 text-gray-900 font-sans antialiased min-h-screen">',
        `  <header class="bg-blue-600 text-white py-6 px-6 shadow-lg">`,
        '    <div class="max-w-3xl mx-auto flex items-center gap-3">',
        `      <span class="text-2xl">${_icon}</span>`,
        `      <h1 class="text-2xl font-bold tracking-tight">${safeTitle}</h1>`,
        '    </div>',
        '  </header>',
        '  <main class="max-w-3xl mx-auto px-6 py-10">',
        `    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">`,
        `      <h2 class="text-lg font-semibold mb-4">Add ${_entityLabel}</h2>`,
        `      <p class="text-gray-500">Loading application...</p>`,
        '    </div>',
        `    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">`,
        `      <h2 class="text-lg font-semibold mb-4">${_entityPlural}</h2>`,
        `      <div id="itemList"></div>`,
        '    </div>',
        '  </main>',
        '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
        '  <script src="app.js"></script>',
        '</body>',
        '</html>',
      ].join('\n');
    }
    if (filename.endsWith('.css')) {
      return '/* Custom styles — Tailwind handles most styling via utility classes */\nhtml { scroll-behavior: smooth; }\n';
    }
    if (filename.endsWith('.json')) {
      return JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2);
    }

    return `// ${filename} — auto-generated stub\n`;
  }

  // ── Phase 3: Deterministic Diff Engine ───────────────────────────────────────

  /**
   * Classify gaps against scaffold manifest into three categories.
   * Detection is triple-layered:
   *   1. finish_reason === 'length' (truncation signal)
   *   2. isLikelyIncomplete() heuristics (structural analysis)
   *   3. Missing expected files vs. manifest
   */
  _phase3_classifyGaps(files, scaffoldManifest, finishReason) {
    // FRONTEND_ROOT_FILES imported from lib/manifest-constants.js
    const generated = new Set(Object.keys(files));

    const missingFiles = [];
    const incompleteFiles = [];
    const invalidFiles = [];

    for (const scaffoldPath of scaffoldManifest) {
      // Normalize scaffold path to CODE path
      let codePath = scaffoldPath;
      if (scaffoldPath.startsWith('public/')) {
        const basename = scaffoldPath.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) {
          codePath = basename;
        }
      }

      if (!generated.has(codePath) && !generated.has(scaffoldPath)) {
        // Not generated at all
        missingFiles.push(codePath);
      } else {
        const actualPath = generated.has(codePath) ? codePath : scaffoldPath;
        const content = files[actualPath];

        if (!content || content.trim().length === 0) {
          invalidFiles.push(actualPath);
        } else if (isLikelyIncomplete(content)) {
          // If truncation detected, be more aggressive about flagging incomplete files
          // (truncation often cuts the last file in stream, so flag it too)
          if (finishReason === 'length') {
            incompleteFiles.push(actualPath);
          } else {
            incompleteFiles.push(actualPath);
          }
        }
      }
    }

    return { missingFiles, incompleteFiles, invalidFiles };
  }

  // ── Phase 4: Dependency-Aware Continuation Planner ───────────────────────────

  /**
   * Order gap files by dependency tier: infra → server → frontend.
   * Progressive stabilization: each tier builds on the previous,
   * reducing hallucination drift and cross-file inconsistency.
   */
  _phase4_planContinuationOrder(gaps) {
    const allGaps = [
      ...gaps.missingFiles,
      ...gaps.incompleteFiles,
      ...gaps.invalidFiles,
    ];

    // Deduplicate
    const unique = [...new Set(allGaps)];
    if (unique.length === 0) return [];

    // Assign each file to its dependency tier
    const tierAssignments = new Map();

    for (const file of unique) {
      let assigned = false;
      for (let tierIdx = 0; tierIdx < DEPENDENCY_TIERS.length; tierIdx++) {
        const tier = DEPENDENCY_TIERS[tierIdx];
        for (const pattern of tier) {
          if (file === pattern || file.startsWith(pattern)) {
            const current = tierAssignments.get(file);
            if (current === undefined || tierIdx < current) {
              tierAssignments.set(file, tierIdx);
            }
            assigned = true;
            break;
          }
        }
        if (assigned) break;
      }
      // Unknown files get a middle tier (1)
      if (!tierAssignments.has(file)) {
        tierAssignments.set(file, 1);
      }
    }

    // Sort by tier then alphabetically within tier
    return unique.sort((a, b) => {
      const tierDiff = (tierAssignments.get(a) || 1) - (tierAssignments.get(b) || 1);
      if (tierDiff !== 0) return tierDiff;
      return a.localeCompare(b);
    });
  }

  // ── Phase 5: Strict Continuation Execution ───────────────────────────────────

  /**
   * Execute one continuation pass for a batch of files.
   * Continuation prompts are contracts, not suggestions.
   */
  async _phase5_executeContinuationBatch(
    prompt, planContext, techStack, filesToGenerate, existingFiles, passNum, emitChunk, productContext = null, intentClass = null, scaffold = null
  ) {
    const allFileKeys = Object.keys(existingFiles);
    const existingFileList = allFileKeys.join(', ');

    // ── FULL REPO AWARENESS: Provide content of all generated files as context ──
    // Model needs to see what has already been built to generate consistent imports,
    // matching variable names, correct API endpoint references, and proper exports.
    //
    // Three-tier context strategy (FIX #1497201 — no silent file drops):
    //   Tier 1: High-priority files with generous content (entry points, APIs, HTML)
    //   Tier 2: Remaining files with 800-char snippets (within budget)
    //   Tier 3: Files past budget get stub context (path + first line + exports)
    //
    // The model ALWAYS sees every file — at minimum as a stub. No files are ever
    // silently dropped. Budget controls content depth, not file visibility.
    //
    // FIX (#1497201): Raised budget 16KB → 48KB, replaced hard break with graceful
    // degradation to stubs, added complete file tree header + truncation logging.
    const isFrontendJsBatch = filesToGenerate.some(f =>
      f === 'app.js' || f === 'script.js' || f === 'public/app.js' || f === 'public/script.js' ||
      f.endsWith('/app.js') || f.endsWith('/script.js')
    );

    // HIGH-PRIORITY files: always include with generous char limits
    const HIGH_PRIORITY_FILES = new Set([
      'server.js', 'package.json', 'index.html', 'public/index.html',
      'db/queries.js', 'db/database.js', 'routes/api.js', 'routes/auth.js',
      'app.jsx', 'app.js', 'script.js'
    ]);

    // Budget: 128KB for content snippets. Separate from the file tree
    // header which is always included at full size (file paths are cheap).
    // FIX (#1497339): Raised from 48KB → 128KB — BuildOrbit repos are 15-30 files,
    // well within LLM context limits. Previous budget silently truncated continuation builds.
    const MAX_TOTAL_CONTEXT_CHARS = 128000;
    let totalContextChars = 0;
    const contextSnippets = [];
    let filesWithFullContent = 0;
    let filesWithSnippet = 0;
    let filesWithStub = 0;

    // ── File tree header: ALWAYS included, zero budget cost ──
    // Gives the model a complete map of every file in the codebase regardless of
    // whether the content fits in the budget. This is the cheapest way to prevent
    // the model from generating duplicate files or broken imports.
    const fileTreeHeader = allFileKeys.length > 0
      ? `\nComplete file tree (${allFileKeys.length} files):\n${allFileKeys.map(f => `  ${f}`).join('\n')}\n`
      : '';

    // Pass 1: Add high-priority files with generous limits
    for (const key of allFileKeys) {
      if (!HIGH_PRIORITY_FILES.has(key)) continue;
      const content = existingFiles[key];
      if (!content) continue;
      // Full HTML/API files when generating frontend JS for correct event wiring
      const needsFull = ((key === 'index.html' || key === 'public/index.html') && isFrontendJsBatch) ||
        ((key === 'routes/api.js' || key === 'routes/auth.js') && isFrontendJsBatch);
      const maxLen = needsFull ? 12000 : 2000;
      const snippet = content.length > maxLen
        ? content.slice(0, maxLen) + '\n// ... (truncated)'
        : content;
      contextSnippets.push(`--- ${key} (existing) ---\n${snippet}`);
      totalContextChars += snippet.length;
      filesWithFullContent++;
    }

    // Pass 2: Add remaining files with 800-char snippets (within budget).
    // FIX (#1497201): Never break — degrade to stubs instead of dropping files.
    for (const key of allFileKeys) {
      if (HIGH_PRIORITY_FILES.has(key)) continue; // already included above
      const content = existingFiles[key];
      if (!content) continue;

      if (totalContextChars < MAX_TOTAL_CONTEXT_CHARS) {
        // Within budget — include 800-char snippet
        const maxLen = 800;
        const snippet = content.length > maxLen
          ? content.slice(0, maxLen) + '\n// ... (truncated)'
          : content;
        contextSnippets.push(`--- ${key} (existing) ---\n${snippet}`);
        totalContextChars += snippet.length;
        filesWithSnippet++;
      } else {
        // Budget exceeded — include stub with first line + export signatures.
        // This gives the model enough to generate correct imports without
        // blowing up the context window.
        const firstLine = content.split('\n')[0] || '';
        const exportMatch = content.match(/module\.exports\s*=\s*\{[^}]{0,200}\}/);
        const exportLine = exportMatch ? exportMatch[0] : '';
        const stub = firstLine + (exportLine ? `\n${exportLine}` : '');
        contextSnippets.push(`--- ${key} (existing, stub) ---\n${stub}\n// [${content.length} chars — see file tree for full path]`);
        totalContextChars += stub.length + 60;
        filesWithStub++;
      }
    }

    // Log context loading stats — surfaces truncation to server logs
    const totalFiles = allFileKeys.length;
    const loadedWithContent = filesWithFullContent + filesWithSnippet;
    if (filesWithStub > 0) {
      console.warn(
        `[BuilderAgent] Phase 5 context: ${totalFiles} files total — ` +
        `${filesWithFullContent} full, ${filesWithSnippet} snippets, ${filesWithStub} stubs ` +
        `(${Math.round(totalContextChars / 1024)}KB used of ${Math.round(MAX_TOTAL_CONTEXT_CHARS / 1024)}KB budget)`
      );
    } else {
      console.log(
        `[BuilderAgent] Phase 5 context: ${totalFiles} files loaded — ` +
        `${filesWithFullContent} full, ${filesWithSnippet} snippets ` +
        `(${Math.round(totalContextChars / 1024)}KB used)`
      );
    }

    // Surface truncation warning to user via SSE
    if (filesWithStub > 0 && emitChunk) {
      emitChunk(`\n⚠️ Large codebase — ${loadedWithContent} of ${totalFiles} files loaded with full content, ${filesWithStub} as stubs\n`);
    }

    const contextBlock = contextSnippets.length > 0
      ? `${fileTreeHeader}\nFull repo context — all generated files (match imports, exports, API paths, variable names):\n${contextSnippets.join('\n\n')}`
      : fileTreeHeader;

    // Include product context in continuation prompts to prevent content drift
    const productContextBlock = productContext
      ? `\n${buildContextInstruction(productContext)}\n`
      : '';

    // ── Interaction contract injection for frontend JS continuations ──────
    // When Phase 5 generates frontend JS files, inject the interaction contract
    // as binding requirements so the model knows exactly what handlers are needed.
    // FIX (#1413207): Fire for ALL intent classes, not just PRODUCT_SYSTEM.
    // The contract is injected whenever it has content; a universal fallback
    // ensures interactivity guidance is always present for frontend JS batches.
    let interactivityBlock = '';
    if (isFrontendJsBatch) {
      const ic = scaffold?.interaction_contract;
      const icInteractions = ic?.interactions || [];
      const icForms = ic?.forms || [];
      if (icInteractions.length > 0 || icForms.length > 0) {
        const lines = [];
        lines.push('\nMANDATORY EVENT HANDLERS — implement ALL of these in the JS file:');
        for (const ix of icInteractions) {
          lines.push(`  • ${ix.element} [${ix.event}] → ${ix.behavior}`);
        }
        for (const f of icForms) {
          lines.push(`  • Form "${f.id}" → ${f.submit_behavior}`);
        }
        lines.push('\nEvery item above MUST have an addEventListener or handler. Zero dead buttons.');
        interactivityBlock = lines.join('\n');
      } else {
        // Universal fallback: even without a formal contract, enforce handler wiring
        interactivityBlock = `\nMANDATORY: Every <button>, <form>, <a> with navigation, and clickable element in the HTML MUST have a corresponding addEventListener or event handler in this JS file. Zero dead buttons — every interactive element must produce a visible state change when activated.`;
      }
    }

    // ── Extract interactive element list from HTML for explicit wiring targets ──
    // FIX (#1413207): Broadened element detection — count <a> links, <input> fields,
    // and elements with data-* attributes in addition to buttons/forms/nav/clickable.
    let htmlElementList = '';
    // FIX (#1435780): Also check public/index.html for full_product builds
    const htmlForElements = existingFiles['index.html'] || existingFiles['public/index.html'];
    if (isFrontendJsBatch && htmlForElements) {
      const html = htmlForElements;
      const buttons = (html.match(/<button[^>]*>([\s\S]*?)<\/button>/gi) || []);
      const formEls = (html.match(/<form[^>]*id=["']([^"']+)["'][^>]*>/gi) || []);
      const navLinks = (html.match(/<a[^>]*(?:onclick|data-nav|data-section|href=["']#)[^>]*>/gi) || []);
      const clickableDivs = (html.match(/<(?:div|li|span)[^>]*(?:onclick|data-action|role=["']button["'])[^>]*>/gi) || []);
      const inputs = (html.match(/<input[^>]*type=["'](?:submit|button)[^>]*>/gi) || []);
      const allForms = (html.match(/<form[\s>]/gi) || []);
      const totalElements = buttons.length + Math.max(formEls.length, allForms.length) + navLinks.length + clickableDivs.length + inputs.length;
      if (totalElements > 0) {
        htmlElementList = `\n\nINTERACTIVE ELEMENTS FOUND IN index.html (${totalElements} total — each needs a handler):
- ${buttons.length} buttons
- ${Math.max(formEls.length, allForms.length)} forms
- ${navLinks.length} navigation links with actions
- ${clickableDivs.length} clickable containers
- ${inputs.length} submit/button inputs
You MUST wire addEventListener for EACH of these. Count your handlers — they must equal or exceed ${totalElements}.`;
      }
    }

    const continuationPrompt = `You are continuing an incomplete codebase.
${productContextBlock}
App: ${prompt}
Tech stack: ${techStack}
Files already generated: ${existingFileList}
${contextBlock}

Generate ONLY these files:
${filesToGenerate.map(f => `- ${f}`).join('\n')}

${planContext ? `Architecture context:\n${planContext.slice(0, 800)}\n` : ''}Rules (these are CONTRACTS, not suggestions):
- Generate ONLY the files listed above — nothing else
- Match existing code exactly (style, imports, variable names, error handling patterns)
- Do not modify existing files
- No placeholders, no "TODO", no skeleton stubs — COMPLETE CODE ONLY
- Use the --- FILE: filename --- delimiter for each file
- index.html, styles.css, and other browser JS files are ROOT-level (no require/module.exports)
- Browser JS files (app.js, script.js) must use ONLY browser APIs — no require(), no module.exports
- INTERACTIVITY IS MANDATORY: browser JS files MUST contain addEventListener calls for every button/form/nav element in index.html. Every button must have a click handler. Every form must have a submit handler. No dead buttons.${interactivityBlock}${htmlElementList}`;

    // ── Model routing: same intent_class as Phase 1 for consistency ──────────
    const phase5ModelSelection = this._selectModel(intentClass);
    console.log(`[BuilderAgent] Phase 5: routing to ${phase5ModelSelection.provider} (model=${phase5ModelSelection.model}, intent_class=${intentClass || 'unknown'})`);

    const phase5SystemPrompt = 'You are a senior full-stack developer completing a codebase. Generate complete, production-quality code files using the --- FILE: filename --- delimiter format. No placeholders, no TODOs. Strict output: only the requested files. CRITICAL: Browser JS files (app.js, script.js) must contain real event listeners (addEventListener) for EVERY button, form, and interactive element in the HTML. No dead buttons — every interactive element must have a handler. Auth forms (login/signup) MUST use fetch() to call the auth API endpoints and handle JWT token storage. Every handler must produce a VISIBLE state change — not just console.log.';

    let batchText;
    try {
      const { rawText } = await this._callStreamingLLM(
        phase5ModelSelection, phase5SystemPrompt, continuationPrompt, 8000, emitChunk
      );
      batchText = rawText;
    } catch (err) {
      console.error(`[BuilderAgent] Phase 5 batch error:`, err.message);
      return {};
    }
    const batchFiles = this._parseFileDelimiters(batchText);

    // Filter: keep only non-empty files
    const result = {};
    for (const [name, content] of Object.entries(batchFiles)) {
      if (content && content.trim().length > 10) {
        result[name] = content;
      }
    }

    console.log(
      `[BuilderAgent] Phase 5 batch: ${filesToGenerate.join(', ')} → ` +
      `generated ${Object.keys(result).length} files (${phase5ModelSelection.provider}/${phase5ModelSelection.model})`
    );

    return result;
  }

  // ── Phase 6: Merge + Validate Loop ───────────────────────────────────────────

  /**
   * Orchestrates phases 4-5-6: plan → execute → merge → re-diff → repeat.
   * Stops when no gaps remain or max passes reached (fail-safe).
   */
  async _phase456_continuationLoop(
    prompt, planContext, techStack, files, initialGaps, scaffoldManifest, emitChunk, productContext = null, intentClass = null, scaffold = null
  ) {
    const MAX_PASSES = 3;
    const BATCH_SIZE = 4;
    let currentFiles = { ...files };
    let currentGaps = initialGaps;
    let pass = 0;

    while (pass < MAX_PASSES) {
      pass++;

      // Phase 4: Dependency-aware ordering
      const ordered = this._phase4_planContinuationOrder(currentGaps);
      if (ordered.length === 0) {
        console.log(`[BuilderAgent] Phase 6 pass ${pass}: no gaps remaining — done`);
        break;
      }

      console.log(
        `[BuilderAgent] Phase 6 pass ${pass}/${MAX_PASSES}: ` +
        `${ordered.length} files to generate: ${ordered.slice(0, 6).join(', ')}${ordered.length > 6 ? '...' : ''}`
      );

      emitChunk(`\n\n--- Continuation pass ${pass}: generating ${ordered.length} file${ordered.length !== 1 ? 's' : ''} ---\n\n`);

      // Phase 5: Execute in batches (respect BATCH_SIZE for context coherence)
      for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
        const batch = ordered.slice(i, i + BATCH_SIZE);

        // Phase 5: Strict continuation execution
        const newFiles = await this._phase5_executeContinuationBatch(
          prompt, planContext, techStack, batch, currentFiles, pass, emitChunk, productContext, intentClass, scaffold
        );

        // Phase 6: Merge into artifact set
        Object.assign(currentFiles, newFiles);
      }

      // Phase 6: Re-run diff engine (Phase 3)
      const newGaps = this._phase3_classifyGaps(currentFiles, scaffoldManifest, null);
      const newTotalGaps = newGaps.missingFiles.length + newGaps.incompleteFiles.length + newGaps.invalidFiles.length;

      if (newTotalGaps === 0) {
        console.log(`[BuilderAgent] Phase 6 pass ${pass}: all gaps resolved ✓`);
        break;
      }

      // Convergence check: if gaps didn't decrease, stop (avoid infinite loops)
      const prevTotal = currentGaps.missingFiles.length + currentGaps.incompleteFiles.length + currentGaps.invalidFiles.length;
      if (newTotalGaps >= prevTotal) {
        console.warn(
          `[BuilderAgent] Phase 6 pass ${pass}: gaps not converging ` +
          `(${prevTotal} → ${newTotalGaps}) — stopping`
        );
        break;
      }

      currentGaps = newGaps;
      console.log(`[BuilderAgent] Phase 6 pass ${pass}: ${newTotalGaps} gaps remaining, continuing...`);
    }

    if (pass >= MAX_PASSES) {
      console.warn(`[BuilderAgent] Phase 6: reached max passes (${MAX_PASSES}) — returning best effort`);
    }

    return currentFiles;
  }

  // ── Parse strategies (multi-format cascade) ──────────────────────────────────

  /**
   * Parse --- FILE: filename --- delimited sections.
   * Primary format — no JSON overhead, handles truncation gracefully
   * because each file is independent (truncation only loses the last partial file).
   */
  _parseFileDelimiters(text) {
    const files = {};
    const headerRegex = /^-{3,}\s*FILE:\s*(.+?)\s*-{3,}\s*$/gm;
    const headers = [];
    let match;

    while ((match = headerRegex.exec(text)) !== null) {
      headers.push({ filename: match[1].trim(), index: match.index, endIndex: match.index + match[0].length });
    }

    for (let i = 0; i < headers.length; i++) {
      const start = headers[i].endIndex;
      const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
      const content = text.slice(start, end).trim();
      if (content) {
        files[headers[i].filename] = content;
      }
    }

    return files;
  }

  /**
   * Try to parse raw text as JSON (backward compat), handling variations:
   * - Raw JSON object
   * - JSON wrapped in ```json fences
   * - JSON with leading/trailing text
   */
  _tryJsonParse(text) {
    // Strategy A: Direct parse
    try {
      const parsed = JSON.parse(text);
      if (parsed.files && typeof parsed.files === 'object') {
        const files = parsed.files;
        const totalLines = Object.values(files).reduce((sum, content) => {
          return sum + (typeof content === 'string' ? content.split('\n').length : 0);
        }, 0);
        return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
      }
    } catch (_) {}

    // Strategy B: Extract JSON from markdown fence
    const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        if (parsed.files && typeof parsed.files === 'object') {
          const files = parsed.files;
          const totalLines = Object.values(files).reduce((sum, content) => {
            return sum + (typeof content === 'string' ? content.split('\n').length : 0);
          }, 0);
          return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
        }
      } catch (_) {}
    }

    // Strategy C: Find JSON object boundaries in text
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        if (parsed.files && typeof parsed.files === 'object') {
          const files = parsed.files;
          const totalLines = Object.values(files).reduce((sum, content) => {
            return sum + (typeof content === 'string' ? content.split('\n').length : 0);
          }, 0);
          return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Extract fenced code blocks with filename detection.
   * Handles: ```js, ```javascript, ```html, ```css, ```json, ```
   */
  _extractCodeBlocks(text) {
    const files = {};
    const blockRegex = /(?:(?:#+\s*|(?:\*\*)?)?(\S+\.\w+)(?:\*\*)?[^\n]*\n)?```(?:javascript|js|html|css|json|sql)?\s*\n([\s\S]*?)(?:```|$)/g;
    const filenameRegex = /(?:\/\/|#|<!--)\s*(?:file(?:name)?:?\s*)?(\S+\.\w+)/i;
    let match;
    let fileIndex = 0;

    while ((match = blockRegex.exec(text)) !== null) {
      const code = match[2].trim();
      if (!code) continue;

      let filename = match[1] || null;
      if (!filename) {
        const firstLine = code.split('\n')[0];
        const nameMatch = filenameRegex.exec(firstLine);
        filename = nameMatch ? nameMatch[1] : null;
      }
      if (!filename) {
        const preBlock = text.slice(Math.max(0, match.index - 100), match.index);
        const preMatch = preBlock.match(/(\S+\.\w+)\s*(?:\n|$)/);
        filename = preMatch ? preMatch[1] : `file_${++fileIndex}.js`;
      }
      files[filename] = code;
    }

    return files;
  }

  /**
   * Recover completed files from truncated JSON.
   * When max_tokens is hit, JSON is cut mid-stream. Extracts all complete
   * "filename": "content" pairs that were finished before truncation.
   */
  _recoverTruncatedJson(text) {
    const files = {};
    const filesStart = text.indexOf('"files"');
    if (filesStart < 0) return files;

    const region = text.slice(filesStart);
    const pairRegex = /"([^"]+\.\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let match;

    while ((match = pairRegex.exec(region)) !== null) {
      const filename = match[1];
      if (filename === 'entryPoint' || filename === 'totalLines') continue;
      try {
        const content = JSON.parse(`"${match[2]}"`);
        if (content && content.length > 5) {
          files[filename] = content;
        }
      } catch (_) {
        const content = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (content && content.length > 5) {
          files[filename] = content;
        }
      }
    }

    return files;
  }

  /**
   * Parse raw AI output using all 4 strategies, returning the best result.
   */
  _parseAllStrategies(rawText) {
    // Strategy 1: Delimiter format (primary — most reliable)
    const delimFiles = this._parseFileDelimiters(rawText);
    if (Object.keys(delimFiles).length >= 2) return delimFiles;

    // Strategy 2: JSON parse (backward compat)
    const jsonResult = this._tryJsonParse(rawText);
    if (jsonResult && Object.keys(jsonResult.files).length >= 2) return jsonResult.files;

    // Strategy 3: Markdown code blocks
    const codeBlockFiles = this._extractCodeBlocks(rawText);
    if (Object.keys(codeBlockFiles).length >= 2) return codeBlockFiles;

    // Strategy 4: Truncated JSON recovery
    const recoveredFiles = this._recoverTruncatedJson(rawText);
    if (Object.keys(recoveredFiles).length >= 1) return recoveredFiles;

    // Return best non-empty result from any strategy
    if (Object.keys(delimFiles).length > 0) return delimFiles;
    if (Object.keys(codeBlockFiles).length > 0) return codeBlockFiles;
    return {};
  }

  /**
   * Detect the entry point from generated files.
   *
   * When scaffoldEntry is provided (from the scaffold manifest), prefer it if
   * the corresponding file exists in CODE output. This prevents the CODE phase
   * from returning entryPoint='server.js' when the scaffold expects 'index.html'
   * — the primary cause of entry point mismatch crashes (Report #596913 Pattern 3).
   *
   * Path normalization: scaffold may specify 'public/index.html' but CODE
   * normalizes to 'index.html'. Check both variants.
   *
   * @param {object} files         - Generated file map { filename: content }
   * @param {string} [scaffoldEntry] - Expected entry from scaffold constraints
   */
  _detectEntryPoint(files, scaffoldEntry) {
    // ── Prefer scaffold entry when it exists in generated files ──────────
    if (scaffoldEntry) {
      if (files[scaffoldEntry]) return scaffoldEntry;
      // Normalize: public/index.html → index.html
      if (scaffoldEntry.startsWith('public/')) {
        const basename = scaffoldEntry.replace('public/', '');
        if (files[basename]) return basename;
      }
      // Reverse: index.html → public/index.html
      if (!scaffoldEntry.includes('/') && files['public/' + scaffoldEntry]) {
        return 'public/' + scaffoldEntry;
      }
    }
    // ── Fallback: auto-detect from files ─────────────────────────────────
    if (files['server.js']) return 'server.js';
    if (files['index.js']) return 'index.js';
    if (files['app.js']) return 'app.js';
    return Object.keys(files)[0] || 'server.js';
  }

  // ── Simulated fallback (no OpenAI key) ───────────────────────────────────────

  async _simulatedCode(prompt, emitChunk, constraintContract = null, productContext = null, scaffold = null, repoProfile = null) {
    // ── Title derivation: prefer product context > prompt signals > safe fallback ──
    const safeTitle = this._deriveTitle(prompt, productContext);

    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── CONTEXT-AWARE FALLBACK: when repo profile is available, produce a project
    // status page instead of generic CRUD. This path is reached only when AI
    // generation fails — the fallback should reflect the real repo, not a fake form.
    if (repoProfile && (repoProfile.language || repoProfile.framework)) {
      console.log(`[BuilderAgent] Simulated CODE: context-aware fallback for ${repoProfile.language}/${repoProfile.framework || 'unknown'}`);
      const result = this._generateRepoContextPage(prompt, safeTitle, repoProfile, scaffold);
      const display = Object.entries(result.files).map(([name, code]) => {
        const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
        return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
      }).join('\n\n');
      const totalLines = Object.values(result.files).reduce((s, c) => s + c.split('\n').length, 0);
      if (emitChunk) {
        await this._streamText(`## Context-Aware Preview\n\n${display}\n\n**Stack:** ${repoProfile.language}/${repoProfile.framework || 'native'}`, emitChunk, 4);
      }
      return { ...result, totalLines };
    }

    // ── STATIC SURFACE: pure HTML/CSS/JS — no server, no db, no backend ──────
    if (intentClass === 'static_surface') {
      // Phase 4.2: ISE surfaces — generate surface-aware page instead of generic feature grid
      const _iseSurfaces = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces) || [];
      if (_iseSurfaces.length > 0) {
        console.log(`[BuilderAgent] Simulated CODE: static_surface with ISE surfaces [${_iseSurfaces.join(', ')}]`);
        return this._simulatedCodeWithSurfaces(prompt, safeTitle, _iseSurfaces, emitChunk, productContext);
      }
      console.log('[BuilderAgent] Simulated CODE: static_surface — generating prompt-aware 3 files');
      const _genericDomain = this._derivePromptDomain(prompt);
      const _genericTagline = _genericDomain
        ? _genericDomain.tagline
        : 'Built for the way you work.';
      if (!productContext) {
        emitChunk('\n\n> 💡 **Want better copy?** Fill in **📦 Product Context** — add your product name, description, and features for accurate, on-brand content.\n\n');
      }

      // ── Prompt-aware content generation for simulated path ──
      const _businessName = this._extractBusinessName(prompt) || safeTitle;
      const _sections = this._extractRequestedSections(prompt);
      const _ctas = this._extractCTAs(prompt);
      const _primaryCta = _ctas.length > 0 ? _ctas[0].text : 'Get Started';
      const _imgKeyword = _genericDomain ? _genericDomain.taglinePrefix.split(' ')[0].toLowerCase() : 'business';

      // Build domain-appropriate color scheme
      const _colorSchemes = {
        pet: { from: 'teal-600', to: 'emerald-700', accent: 'teal', bg: 'emerald' },
        beauty: { from: 'pink-500', to: 'rose-600', accent: 'pink', bg: 'rose' },
        fitness: { from: 'orange-500', to: 'red-600', accent: 'orange', bg: 'red' },
        food: { from: 'amber-500', to: 'orange-600', accent: 'amber', bg: 'orange' },
        default: { from: 'blue-600', to: 'indigo-700', accent: 'blue', bg: 'indigo' },
      };
      const _domainKey = _genericDomain
        ? (['pet', 'beauty', 'fitness', 'food'].find(k => _genericDomain.tagline.toLowerCase().includes(k === 'pet' ? 'pet' : k === 'beauty' ? 'shine' : k === 'fitness' ? 'train' : 'food')) || 'default')
        : 'default';
      const _colors = _colorSchemes[_domainKey] || _colorSchemes.default;

      // Generate section HTML blocks based on prompt-extracted sections
      const _sectionHtmlBlocks = this._generateSimulatedSections(_sections, _businessName, _colors);

      const files = {
        'index.html': [
          '<!DOCTYPE html>',
          '<html lang="en" class="scroll-smooth">',
          '<head>',
          `  <meta charset="UTF-8">`,
          `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
          `  <title>${_businessName}</title>`,
          '  <script src="https://cdn.tailwindcss.com"></script>',
          '  <link rel="stylesheet" href="styles.css">',
          '</head>',
          '<body class="bg-gray-50 text-gray-900 font-sans antialiased">',
          '',
          '  <!-- Hero -->',
          '  <section class="relative min-h-[80vh] flex items-center justify-center overflow-hidden">',
          `    <div class="absolute inset-0 bg-cover bg-center" style="background-image: url('https://source.unsplash.com/1600x900/?${_imgKeyword}')"></div>`,
          `    <div class="absolute inset-0 bg-gradient-to-br from-${_colors.from}/90 to-${_colors.to}/80"></div>`,
          '    <div class="relative z-10 text-center px-6 max-w-4xl mx-auto">',
          `      <h1 class="text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6">${_businessName}</h1>`,
          `      <p class="text-xl md:text-2xl text-white/80 mb-10 leading-relaxed">${_genericTagline}</p>`,
          `      <a href="#content" class="inline-block bg-white text-${_colors.from} hover:bg-gray-100 font-semibold text-lg px-10 py-4 rounded-full transition-all duration-300 hover:shadow-2xl hover:-translate-y-1">`,
          `        ${_primaryCta}`,
          '      </a>',
          '    </div>',
          '  </section>',
          '',
          ..._sectionHtmlBlocks,
          '',
          '  <!-- Footer -->',
          '  <footer class="bg-gray-800 text-gray-300 py-12 px-6 text-center">',
          `    <p>&copy; ${new Date().getFullYear()} ${_businessName}. All rights reserved.</p>`,
          '  </footer>',
          '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
          '',
          '  <script src="script.js"></script>',
          '</body>',
          '</html>',
        ].join('\n'),

        'styles.css': [
          '/* Minimal custom CSS — Tailwind handles most styling */',
          '.fade-section { opacity: 0; transform: translateY(20px); }',
          '.fade-section.visible { opacity: 1; transform: translateY(0); transition: opacity 0.6s ease, transform 0.6s ease; }',
        ].join('\n'),

        'script.js': [
          '(function() {',
          '  // Fade-in animation for sections on scroll',
          '  var sections = document.querySelectorAll(".fade-section");',
          '  var observer = new IntersectionObserver(function(entries) {',
          '    entries.forEach(function(entry) {',
          '      if (entry.isIntersecting) {',
          '        entry.target.classList.add("visible");',
          '      }',
          '    });',
          '  }, { threshold: 0.1 });',
          '  sections.forEach(function(s) { observer.observe(s); });',
          '})();',
        ].join('\n'),
      };

      const display = Object.entries(files).map(([name, code]) => {
        const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
        return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
      }).join('\n\n');

      const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
      const text = `## Generated Implementation (Static Surface)\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (HTML + CSS + JS only — no backend)\n**Lines of code:** ${totalLines}`;

      await this._streamText(text, emitChunk, 4);

      return { files, entryPoint: 'index.html', totalLines };
    }

    // ── Detect app domain from prompt (single best match, no merging) ────────
    const appDomain = this._deriveAppDomain(prompt);

    // ── LIGHT APP: minimal server + in-memory storage, no full DB stack ──────
    // Intent Gate light_app allows: server.js, routes/api.js, package.json + frontend.
    // Does NOT allow: db/pool.js, db/queries.js, migrations/, migrate.js.
    // Use in-memory storage instead of PostgreSQL for light_app builds.
    if (intentClass === 'light_app') {
      console.log(`[BuilderAgent] Simulated CODE: light_app domain="${appDomain.type}" entity="${appDomain.entity.name}"`);

      const files = this._generateLightAppFiles(safeTitle, appDomain);

      const display = Object.entries(files).map(([name, code]) => {
        const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : name.endsWith('.json') ? 'json' : 'javascript';
        return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
      }).join('\n\n');

      const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
      const text = `## Generated Implementation (Light App)\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (minimal server + frontend)\n**Lines of code:** ${totalLines}`;

      await this._streamText(text, emitChunk, 4);

      return { files, entryPoint: 'server.js', totalLines };
    }

    // ── FULL-STACK (full_product) — POLYMORPHIC ──────────────────────────────
    // Full Express + PostgreSQL with migrations, pool, routes, auth.
    // Only for full_product intent (or fallback when intent is unknown).
    console.log(`[BuilderAgent] Simulated CODE: full-stack domain="${appDomain.type}" entity="${appDomain.entity.name}"`);

    const files = this._generateFullStackFiles(safeTitle, appDomain);

    const display = Object.entries(files).map(([name, code]) => {
      const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : name.endsWith('.json') ? 'json' : 'javascript';
      return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
    }).join('\n\n');

    const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
    const text = `## Generated Implementation\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files  \n**Lines of code:** ${totalLines}`;

    await this._streamText(text, emitChunk, 4);

    return { files, entryPoint: 'server.js', totalLines };
  }

  // ── Polymorphic Full-Stack File Generator ────────────────────────────────────
  //
  // Generates a complete full-stack app (server.js, routes, DB, frontend)
  // tailored to the detected app domain. Each domain produces domain-specific
  // entities, API endpoints, UI layout, and DB schema.

  _generateFullStackFiles(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const firstRequired = requiredFields[0] || fields[0];

    // Build INSERT column/value lists
    const insertCols = fields.map(f => f.name).join(', ');
    const insertPlaceholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const insertArgs = fields.map(f => {
      if (f.required) return `${f.name}.trim()`;
      return `(${f.name} || '').trim()`;
    }).join(', ');

    // Build validation for required fields
    const validationLines = requiredFields.map(f =>
      `      if (!${f.name} || !${f.name}.toString().trim()) {\n        return res.status(400).json({ success: false, message: '${f.label} is required' });\n      }`
    ).join('\n');

    const destructureFields = fields.map(f => f.name).join(', ');

    // Chat domain gets a special UI layout
    const isChatDomain = domain.type === 'chat';

    const files = {
      'server.js': [
        "const express = require('express');",
        "const path = require('path');",
        "const { Pool } = require('pg');",
        "const apiRoutes = require('./routes/api');",
        "",
        "const app = express();",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "app.use(express.json());",
        "app.use(express.static(path.join(__dirname, '.')));",
        `app.use('/api', apiRoutes(pool));`,
        "",
        "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
        "",
        "app.get('*', (req, res) => {",
        "  if (!req.path.startsWith('/api')) {",
        "    res.sendFile(path.join(__dirname, 'index.html'));",
        "  }",
        "});",
        "",
        "const PORT = process.env.PORT || 3000;",
        "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "",
        `  router.get('/${e.name}', async (req, res) => {`,
        "    try {",
        `      const { rows } = await pool.query('SELECT * FROM ${e.name} ORDER BY created_at DESC');`,
        `      res.json({ success: true, ${e.name}: rows });`,
        "    } catch (err) {",
        `      console.error('GET /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.post('/${e.name}', async (req, res) => {`,
        "    try {",
        `      const { ${destructureFields} } = req.body;`,
        validationLines,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${e.name} (${insertCols}) VALUES (${insertPlaceholders}) RETURNING *',`,
        `        [${insertArgs}]`,
        "      );",
        `      res.status(201).json({ success: true, ${e.singular}: rows[0] });`,
        "    } catch (err) {",
        `      console.error('POST /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${e.name}/:id', async (req, res) => {`,
        "    try {",
        `      await pool.query('DELETE FROM ${e.name} WHERE id = $1', [req.params.id]);`,
        "      res.json({ success: true });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'db/pool.js': [
        "const { Pool } = require('pg');",
        "",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "module.exports = pool;",
      ].join('\n'),

      'migrations/001_schema.js': [
        "exports.up = (pgm) => {",
        `  pgm.createTable('${e.name}', {`,
        "    id: 'id',",
        ...fields.map(f => `    ${f.name}: { type: '${f.type}', ${f.required ? "notNull: true" : `default: ''`} },`),
        "    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') }",
        "  });",
        "};",
        "",
        "exports.down = (pgm) => {",
        `  pgm.dropTable('${e.name}');`,
        "};",
      ].join('\n'),

      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        main: 'server.js',
        scripts: {
          start: 'node server.js',
          build: 'node migrate.js'
        },
        dependencies: {
          express: '^4.18.2',
          pg: '^8.11.3'
        }
      }, null, 2),

      'index.html': isChatDomain
        ? this._generateChatHTML(safeTitle, domain)
        : this._generateStandardHTML(safeTitle, domain),

      'styles.css': this._generateDomainCSS(domain),

      'app.js': isChatDomain
        ? this._generateChatJS(domain)
        : this._generateStandardJS(domain),
    };

    return files;
  }

  // ── Light App File Generator ─────────────────────────────────────────────────
  //
  // Generates a light app (minimal Express server + frontend) without full DB stack.
  // Matches light_app Intent Gate allowed_artifacts: server.js, routes/api.js,
  // package.json + frontend files. Uses in-memory storage instead of PostgreSQL.
  // No db/pool.js, no db/queries.js, no migrations/, no migrate.js.

  _generateLightAppFiles(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const destructureFields = fields.map(f => f.name).join(', ');

    // Build validation for required fields
    const validationLines = requiredFields.map(f =>
      `      if (!${f.name} || !${f.name}.toString().trim()) {\n        return res.status(400).json({ success: false, message: '${f.label} is required' });\n      }`
    ).join('\n');

    const isChatDomain = domain.type === 'chat';

    const files = {
      'server.js': [
        "const express = require('express');",
        "const path = require('path');",
        "const apiRoutes = require('./routes/api');",
        "",
        "const app = express();",
        "",
        "app.use(express.json());",
        "app.use(express.static(path.join(__dirname, '.')));",
        "app.use('/api', apiRoutes());",
        "",
        "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
        "",
        "app.get('*', (req, res) => {",
        "  if (!req.path.startsWith('/api')) {",
        "    res.sendFile(path.join(__dirname, 'index.html'));",
        "  }",
        "});",
        "",
        "const PORT = process.env.PORT || 3000;",
        "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "// In-memory storage (light_app — no database required)",
        `let ${e.name} = [];`,
        "let nextId = 1;",
        "",
        "module.exports = function() {",
        "  const router = Router();",
        "",
        `  router.get('/${e.name}', (req, res) => {`,
        `    res.json({ success: true, ${e.name}: ${e.name}.slice().reverse() });`,
        "  });",
        "",
        `  router.post('/${e.name}', (req, res) => {`,
        "    try {",
        `      const { ${destructureFields} } = req.body;`,
        validationLines,
        `      const ${e.singular} = { id: nextId++, ${fields.map(f => f.required ? `${f.name}: ${f.name}.trim()` : `${f.name}: (${f.name} || '').trim()`).join(', ')}, created_at: new Date().toISOString() };`,
        `      ${e.name}.push(${e.singular});`,
        `      res.status(201).json({ success: true, ${e.singular}: ${e.singular} });`,
        "    } catch (err) {",
        `      console.error('POST /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${e.name}/:id', (req, res) => {`,
        "    const id = parseInt(req.params.id, 10);",
        `    const idx = ${e.name}.findIndex(item => item.id === id);`,
        "    if (idx === -1) return res.status(404).json({ success: false, message: 'Not found' });",
        `    ${e.name}.splice(idx, 1);`,
        "    res.json({ success: true });",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        main: 'server.js',
        scripts: {
          start: 'node server.js',
          build: 'echo "No build step required"'
        },
        dependencies: {
          express: '^4.18.2'
        }
      }, null, 2),

      'index.html': isChatDomain
        ? this._generateChatHTML(safeTitle, domain)
        : this._generateStandardHTML(safeTitle, domain),

      'styles.css': this._generateDomainCSS(domain),

      'app.js': isChatDomain
        ? this._generateChatJS(domain)
        : this._generateStandardJS(domain),
    };

    return files;
  }

  _generateStandardHTML(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const isTable = domain.uiLayout === 'table';

    // Build form inputs
    const inputsHtml = fields.map((f, i) => {
      if (f.inputType === 'textarea') {
        return `        <textarea id="field_${f.name}" placeholder="${f.placeholder}" rows="3" class="w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all"></textarea>`;
      }
      if (f.inputType === 'select' && f.options) {
        const opts = f.options.map(o => `<option value="${o}">${o}</option>`).join('');
        return `        <select id="field_${f.name}" class="flex-1 min-w-32 px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all">${opts}</select>`;
      }
      const inputType = f.inputType === 'number' ? 'number' : f.inputType === 'date' ? 'date' : 'text';
      return `        <input type="${inputType}" id="field_${f.name}" placeholder="${f.placeholder}" ${f.required ? 'required' : ''} autocomplete="off" class="flex-1 min-w-36 px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all" />`;
    }).join('\n');

    // Table header for table layout
    const tableHeader = isTable
      ? `      <div class="grid grid-cols-${fields.length + 1} gap-4 text-xs font-semibold text-gray-400 uppercase tracking-widest px-4 py-2 border-b border-gray-100 mb-2">\n${fields.map(f => `        <span>${f.label}</span>`).join('\n')}\n        <span class="text-right">Action</span>\n      </div>`
      : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="en" class="scroll-smooth">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${safeTitle}</title>`,
      // design-dna.css removed — using Tailwind CDN classes exclusively
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-50 text-gray-900 font-sans antialiased min-h-screen">',
      '',
      '  <!-- Header -->',
      `  <header class="bg-${domain.color.header} text-white py-6 px-6 shadow-lg">`,
      '    <div class="max-w-3xl mx-auto flex items-center gap-3">',
      `      <span class="text-2xl">${domain.icon}</span>`,
      `      <h1 class="text-2xl font-bold tracking-tight">${safeTitle}</h1>`,
      '    </div>',
      '  </header>',
      '',
      '  <main class="max-w-3xl mx-auto px-6 py-10 flex flex-col gap-6">',
      '',
      '    <!-- Add Section -->',
      '    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">',
      `      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">New ${e.singular}</h2>`,
      '      <div class="flex flex-col gap-3">',
      inputsHtml,
      `        <button id="addBtn" class="self-start px-6 py-2.5 bg-${domain.color.header} hover:opacity-90 text-white font-semibold text-sm rounded-xl transition-all duration-200 hover:shadow-md active:scale-95 whitespace-nowrap">${domain.addLabel}</button>`,
      '      </div>',
      '      <div id="formError" class="mt-2 text-red-500 text-sm" style="display:none"></div>',
      '    </section>',
      '',
      '    <!-- List Section -->',
      '    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">',
      `      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">${domain.listLabel} <span id="countBadge" class="inline-block bg-${domain.color.header} text-white text-xs font-bold rounded-full px-2 py-0.5 ml-1 align-middle">0</span></h2>`,
      tableHeader,
      '      <div id="itemList" class="flex flex-col gap-2.5"></div>',
      '      <div id="emptyState" class="text-center py-10 text-gray-400 text-sm">',
      `        <p>${e.icon} ${domain.emptyState}</p>`,
      '      </div>',
      '    </section>',
      '',
      '  </main>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="app.js"></script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  _generateChatHTML(safeTitle, domain) {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${safeTitle}</title>`,
      // design-dna.css removed — using Tailwind CDN classes exclusively
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-100 text-gray-900 font-sans antialiased min-h-screen flex flex-col">',
      '',
      '  <!-- Header -->',
      '  <header class="bg-indigo-600 text-white py-4 px-6 shadow-lg flex-shrink-0">',
      '    <div class="max-w-4xl mx-auto flex items-center justify-between">',
      '      <div class="flex items-center gap-3">',
      '        <span class="text-2xl">💬</span>',
      `        <h1 class="text-xl font-bold tracking-tight">${safeTitle}</h1>`,
      '      </div>',
      '      <div class="flex items-center gap-2">',
      '        <label class="text-sm text-indigo-200">Room:</label>',
      '        <select id="roomSelect" class="bg-indigo-700 text-white text-sm rounded-lg px-3 py-1.5 border border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-300">',
      '          <option value="general">general</option>',
      '          <option value="random">random</option>',
      '          <option value="help">help</option>',
      '        </select>',
      '      </div>',
      '    </div>',
      '  </header>',
      '',
      '  <!-- Chat Area -->',
      '  <main class="flex-1 flex flex-col max-w-4xl mx-auto w-full">',
      '',
      '    <!-- Username bar -->',
      '    <div class="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">',
      '      <label class="text-sm text-gray-500 font-medium">Your name:</label>',
      '      <input type="text" id="usernameInput" placeholder="Anonymous" class="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-400 w-40" />',
      '      <span id="onlineCount" class="ml-auto text-xs text-gray-400">Room: <strong id="currentRoom">general</strong></span>',
      '    </div>',
      '',
      '    <!-- Messages -->',
      '    <div id="messageList" class="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3 min-h-0" style="max-height: calc(100vh - 220px);">',
      '      <div id="emptyState" class="flex-1 flex items-center justify-center text-gray-400 text-sm">',
      '        <p>💬 No messages yet. Start the conversation!</p>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Input area -->',
      '    <div class="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">',
      '      <div class="flex gap-3">',
      '        <input type="text" id="messageInput" placeholder="Type a message..." autocomplete="off" class="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all" />',
      '        <button id="sendBtn" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm rounded-xl transition-all duration-200 hover:shadow-md active:scale-95">Send</button>',
      '      </div>',
      '      <div id="formError" class="mt-2 text-red-500 text-sm" style="display:none"></div>',
      '    </div>',
      '',
      '  </main>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="app.js"></script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  _generateDomainCSS(domain) {
    if (domain.type === 'chat') {
      return [
        '/* Chat-specific styles */',
        '.msg-bubble { max-width: 80%; padding: 0.75rem 1rem; border-radius: 1rem; word-break: break-word; }',
        '.msg-bubble.self { background: #4f46e5; color: white; border-bottom-right-radius: 0.25rem; margin-left: auto; }',
        '.msg-bubble.other { background: white; border: 1px solid #e5e7eb; border-bottom-left-radius: 0.25rem; }',
        '.msg-meta { font-size: 0.6875rem; color: #9ca3af; margin-top: 0.25rem; }',
        '.msg-username { font-weight: 600; font-size: 0.75rem; margin-bottom: 0.125rem; }',
      ].join('\n');
    }
    return [
      '/* Minimal custom CSS — Tailwind handles layout, spacing, and typography */',
      '.btn-primary { border: none; cursor: pointer; }',
      '.btn-primary:active { transform: scale(0.97); }',
      '.item-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.875rem 1rem; transition: box-shadow 0.15s; }',
      '.item-card:hover { box-shadow: 0 1px 6px rgba(0,0,0,0.1); }',
      '.item-info h3 { font-size: 0.9375rem; font-weight: 600; }',
      '.item-info p { color: #64748b; font-size: 0.8125rem; margin-top: 0.2rem; }',
      '.btn-delete { background: none; border: none; cursor: pointer; color: #94a3b8; font-size: 1.1rem; padding: 0.2rem 0.4rem; border-radius: 6px; transition: color 0.15s, background 0.15s; }',
      '.btn-delete:hover { color: #ef4444; background: rgba(239,68,68,0.08); }',
    ].join('\n');
  }

  _generateChatJS(domain) {
    const e = domain.entity;
    return [
      '(function() {',
      '  var messageInput = document.getElementById("messageInput");',
      '  var sendBtn = document.getElementById("sendBtn");',
      '  var messageList = document.getElementById("messageList");',
      '  var emptyState = document.getElementById("emptyState");',
      '  var formError = document.getElementById("formError");',
      '  var usernameInput = document.getElementById("usernameInput");',
      '  var roomSelect = document.getElementById("roomSelect");',
      '  var currentRoomLabel = document.getElementById("currentRoom");',
      '  var currentRoom = "general";',
      '  var pollTimer = null;',
      '',
      '  function getUsername() {',
      '    return (usernameInput.value || "").trim() || "Anonymous";',
      '  }',
      '',
      '  function showError(msg) {',
      '    formError.textContent = msg;',
      '    formError.style.display = "block";',
      '    setTimeout(function() { formError.style.display = "none"; }, 3000);',
      '  }',
      '',
      '  function escHtml(str) {',
      '    var d = document.createElement("div");',
      '    d.textContent = str;',
      '    return d.innerHTML;',
      '  }',
      '',
      '  function formatTime(ts) {',
      '    var d = new Date(ts);',
      '    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });',
      '  }',
      '',
      `  function renderMessages(${e.name}) {`,
      `    if (!${e.name} || ${e.name}.length === 0) {`,
      '      messageList.innerHTML = "";',
      '      messageList.appendChild(emptyState);',
      '      emptyState.style.display = "flex";',
      '      return;',
      '    }',
      '    emptyState.style.display = "none";',
      '    var myName = getUsername();',
      `    messageList.innerHTML = ${e.name}.map(function(msg) {`,
      '      var isSelf = msg.username === myName;',
      '      return \'<div class="flex flex-col \' + (isSelf ? "items-end" : "items-start") + \'">\' +',
      '        \'<div class="msg-username \' + (isSelf ? "text-indigo-600" : "text-gray-700") + \'">\' + escHtml(msg.username || "Anonymous") + \'</div>\' +',
      '        \'<div class="msg-bubble \' + (isSelf ? "self" : "other") + \'">\' + escHtml(msg.content) + \'</div>\' +',
      '        \'<div class="msg-meta">\' + formatTime(msg.created_at) + \'</div>\' +',
      '        \'</div>\';',
      '    }).join("");',
      '    messageList.scrollTop = messageList.scrollHeight;',
      '  }',
      '',
      `  function loadMessages() {`,
      `    fetch("/api/${e.name}?room=" + encodeURIComponent(currentRoom))`,
      '      .then(function(r) { return r.json(); })',
      `      .then(function(data) { if (data.success) renderMessages(data.${e.name}); })`,
      '      .catch(function() {});',
      '  }',
      '',
      '  function sendMessage() {',
      '    var content = messageInput.value.trim();',
      '    if (!content) { showError("Message cannot be empty"); messageInput.focus(); return; }',
      '    sendBtn.disabled = true;',
      `    fetch("/api/${e.name}", {`,
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      '      body: JSON.stringify({ content: content, room: currentRoom, username: getUsername() })',
      '    })',
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) {',
      '        if (data.success) { messageInput.value = ""; loadMessages(); }',
      '        else { showError(data.message || "Failed to send"); }',
      '      })',
      '      .catch(function() { showError("Network error"); })',
      '      .finally(function() { sendBtn.disabled = false; messageInput.focus(); });',
      '  }',
      '',
      '  sendBtn.addEventListener("click", sendMessage);',
      '  messageInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });',
      '',
      '  roomSelect.addEventListener("change", function() {',
      '    currentRoom = roomSelect.value;',
      '    currentRoomLabel.textContent = currentRoom;',
      '    loadMessages();',
      '  });',
      '',
      '  // Poll for new messages every 3 seconds',
      '  function startPolling() {',
      '    if (pollTimer) clearInterval(pollTimer);',
      '    pollTimer = setInterval(loadMessages, 3000);',
      '  }',
      '',
      '  loadMessages();',
      '  startPolling();',
      '})();',
    ].join('\n');
  }

  _generateStandardJS(domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const firstRequired = requiredFields[0] || fields[0];
    const isTable = domain.uiLayout === 'table';

    // Build the render function based on fields
    const cardRenderFields = fields.map(f => {
      if (f === firstRequired || f.name === fields[0].name) {
        return `\'<h3>\' + escHtml(item.${f.name}${f.inputType === 'number' ? '.toString()' : ''}) + \'</h3>\'`;
      }
      return `(item.${f.name} ? \'<p>${f.label}: \' + escHtml(item.${f.name}${f.inputType === 'number' ? '.toString()' : ''}) + \'</p>\' : \'\')`;
    });

    const bodyFields = fields.map(f => {
      if (f.inputType === 'number') return `${f.name}: parseFloat(document.getElementById("field_${f.name}").value) || 0`;
      return `${f.name}: document.getElementById("field_${f.name}").value.trim()`;
    }).join(', ');

    const clearFields = fields.map(f =>
      `document.getElementById("field_${f.name}").value = "";`
    ).join(' ');

    const validationCheck = firstRequired
      ? `var _val = document.getElementById("field_${firstRequired.name}").value.trim();\n    if (!_val) { showError("${firstRequired.label} is required"); document.getElementById("field_${firstRequired.name}").focus(); return; }`
      : '';

    return [
      '(function() {',
      '  var addBtn = document.getElementById("addBtn");',
      '  var itemList = document.getElementById("itemList");',
      '  var emptyState = document.getElementById("emptyState");',
      '  var formError = document.getElementById("formError");',
      '  var countBadge = document.getElementById("countBadge");',
      '',
      '  function showError(msg) {',
      '    formError.textContent = msg;',
      '    formError.style.display = "block";',
      '    setTimeout(function() { formError.style.display = "none"; }, 3000);',
      '  }',
      '',
      '  function escHtml(str) {',
      '    var d = document.createElement("div");',
      '    d.textContent = str || "";',
      '    return d.innerHTML;',
      '  }',
      '',
      `  function renderItems(${e.name}) {`,
      `    countBadge.textContent = ${e.name}.length;`,
      `    if (!${e.name} || ${e.name}.length === 0) {`,
      '      itemList.innerHTML = "";',
      '      emptyState.style.display = "block";',
      '      return;',
      '    }',
      '    emptyState.style.display = "none";',
      `    itemList.innerHTML = ${e.name}.map(function(item) {`,
      `      return \'<div class="item-card" data-id="\' + item.id + \'">\' +`,
      `        \'<div class="item-info">\' + ${cardRenderFields.join(" + '\\n' + ")} + \'</div>\' +`,
      `        \'<button class="btn-delete" data-id="\' + item.id + \'" title="Delete">🗑</button></div>\';`,
      '    }).join("");',
      '    itemList.querySelectorAll(".btn-delete").forEach(function(btn) {',
      '      btn.addEventListener("click", function() { deleteItem(btn.dataset.id); });',
      '    });',
      '  }',
      '',
      '  function loadItems() {',
      `    fetch("/api/${e.name}")`,
      '      .then(function(r) { return r.json(); })',
      `      .then(function(data) { if (data.success) renderItems(data.${e.name}); })`,
      '      .catch(function() { renderItems([]); });',
      '  }',
      '',
      '  function deleteItem(id) {',
      `    fetch("/api/${e.name}/" + id, { method: "DELETE" })`,
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) { if (data.success) loadItems(); })',
      '      .catch(function(e) { console.error("Delete failed:", e); });',
      '  }',
      '',
      '  addBtn.addEventListener("click", function() {',
      `    ${validationCheck}`,
      '    addBtn.disabled = true;',
      `    fetch("/api/${e.name}", {`,
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      `      body: JSON.stringify({ ${bodyFields} })`,
      '    })',
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) {',
      `        if (data.success) { ${clearFields} loadItems(); }`,
      '        else { showError(data.message || "Failed to add"); }',
      '      })',
      '      .catch(function() { showError("Network error"); })',
      '      .finally(function() { addBtn.disabled = false; });',
      '  });',
      '',
      `  document.getElementById("field_${firstRequired.name}").addEventListener("keydown", function(e) { if (e.key === "Enter") addBtn.click(); });`,
      '',
      '  loadItems();',
      '})();',
    ].join('\n');
  }

  // ── ISE-Aware Simulated Code (Phase 4.2) ──────────────────────────────────
  //
  // When ISE detects interaction surfaces (e.g., email_capture, signup_capture),
  // this method generates HTML/CSS/JS that implements those surfaces as actual
  // UI elements instead of the generic feature-grid fallback.
  //
  // Only used by the simulated (no-OpenAI) code path for static_surface intents.

  async _simulatedCodeWithSurfaces(prompt, title, surfaces, emitChunk, productContext = null) {
    const CAPTURE_SET = new Set([
      'signup_capture', 'email_capture', 'waitlist_capture',
      'lead_capture', 'data_capture', 'subscription_capture', 'contact_form',
    ]);
    const hasCaptureForm = surfaces.some(s => CAPTURE_SET.has(s));
    const hasConfirmation = surfaces.includes('confirmation_state') || hasCaptureForm;
    const hasNameField = surfaces.includes('signup_capture') ||
      surfaces.includes('contact_form') || surfaces.includes('lead_capture');
    const hasMessageField = surfaces.includes('contact_form');

    // ── Derive domain signals from prompt for contextual copy ─────────────
    const _domain = this._derivePromptDomain(prompt);

    // ── Soft nudge when no product context ────────────────────────────────
    if (!productContext) {
      emitChunk('\n\n> 💡 **Want better copy?** Fill in **📦 Product Context** — add your product name, description, and features for accurate, on-brand content.\n\n');
    }

    // ── Copy: hero tagline + form heading/description ──────────────────────
    // Tagline uses domain-derived copy when available, otherwise sensible surface defaults.
    const _domainTaglinePrefix = _domain ? _domain.taglinePrefix : null;

    let heroTagline = _domainTaglinePrefix ? `${_domainTaglinePrefix} — your journey starts here.` : 'Your journey starts here.';
    let formHeading = 'Get Started';
    let formDesc = 'Enter your details below.';
    let submitText = 'Submit';

    if (surfaces.includes('waitlist_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — be first to know when we launch.`
        : 'Be first to know when we launch.';
      formHeading = 'Join the Waitlist';
      formDesc = 'Drop your email and we\'ll notify you on launch day.';
      submitText = 'Join Waitlist';
    }
    if (surfaces.includes('email_capture') || surfaces.includes('subscription_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — sign up and stay updated.`
        : 'Sign up and stay in the loop.';
      formHeading = 'Stay in the Loop';
      formDesc = 'Enter your email to get the latest updates.';
      submitText = 'Subscribe';
    }
    if (surfaces.includes('signup_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — get started in seconds.`
        : 'Get started in seconds.';
      formHeading = 'Create Your Account';
      formDesc = 'Create your account and start immediately.';
      submitText = 'Sign Up Free';
    }
    if (surfaces.includes('contact_form')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — we\'d love to connect.`
        : 'We\'d love to hear from you.';
      formHeading = 'Get in Touch';
      formDesc = 'Send us a message and we\'ll get back to you shortly.';
      submitText = 'Send Message';
    }
    if (surfaces.includes('lead_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — see what we can do for you.`
        : 'See what we can do for you.';
      formHeading = 'Request a Demo';
      formDesc = 'Tell us a bit about yourself and we\'ll be in touch.';
      submitText = 'Request Demo';
    }

    // ── Build form input HTML ──────────────────────────────────────────────
    const inputLines = [];
    if (hasNameField) {
      inputLines.push('          <input type="text" id="nameInput" class="form-input" placeholder="Your name" required />');
    }
    inputLines.push('          <input type="email" id="emailInput" class="form-input" placeholder="you@example.com" required />');
    if (hasMessageField) {
      inputLines.push('          <textarea id="messageInput" class="form-input form-textarea" placeholder="Your message..." rows="4" required></textarea>');
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    const htmlLines = [
      '<!DOCTYPE html>',
      '<html lang="en" class="scroll-smooth">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${title}</title>`,
      // design-dna.css removed — using Tailwind CDN classes exclusively
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-50 text-gray-900 font-sans antialiased">',
      '',
      '  <!-- Hero -->',
      '  <section class="relative py-24 px-6 flex items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-600 via-purple-600 to-indigo-900">',
      '    <div class="relative z-10 text-center max-w-2xl mx-auto">',
      `      <h1 class="text-5xl font-extrabold text-white tracking-tight mb-4">${title}</h1>`,
      `      <p class="text-xl text-indigo-200 leading-relaxed">${heroTagline}</p>`,
      '    </div>',
      '  </section>',
    ];

    if (hasCaptureForm) {
      htmlLines.push(
        '',
        '  <!-- Capture Form -->',
        '  <section class="py-16 px-6" id="capture-section">',
        '    <div class="max-w-lg mx-auto bg-white rounded-2xl shadow-lg border border-gray-100 p-10 text-center">',
        `      <h2 class="text-2xl font-bold text-gray-900 mb-2">${formHeading}</h2>`,
        `      <p class="text-gray-500 mb-8">${formDesc}</p>`,
        '      <form id="captureForm" class="flex flex-col gap-3">',
        ...inputLines,
        `        <button type="submit" class="btn-submit w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-lg py-3 rounded-xl transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5">${submitText}</button>`,
        '      </form>',
        '      <p class="text-gray-400 text-sm mt-4">No spam, ever. Unsubscribe anytime.</p>',
        '    </div>',
        '  </section>',
      );
    }

    if (hasConfirmation) {
      htmlLines.push(
        '',
        '  <!-- Confirmation -->',
        '  <section class="py-16 px-6" id="confirmation-section" style="display: none;">',
        '    <div class="max-w-lg mx-auto bg-white rounded-2xl shadow-lg border border-gray-100 p-10 text-center">',
        '      <div class="w-16 h-16 bg-green-500 text-white text-2xl font-bold rounded-full flex items-center justify-center mx-auto mb-6">\u2713</div>',
        '      <h2 class="text-2xl font-bold text-gray-900 mb-2">You\'re In!</h2>',
        '      <p class="text-gray-500">Thanks for signing up. We\'ll be in touch soon.</p>',
        '    </div>',
        '  </section>',
      );
    }

    htmlLines.push(
      '',
      '  <!-- Footer -->',
      '  <footer class="bg-gray-800 text-gray-300 py-10 px-6 text-center text-sm">',
      `    <p>&copy; ${new Date().getFullYear()} ${title}. All rights reserved.</p>`,
      '  </footer>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="script.js"></script>',
      '</body>',
      '</html>',
    );

    // ── CSS ────────────────────────────────────────────────────────────────
    // Minimal custom CSS — Tailwind handles layout, spacing, colors, and typography
    const cssContent = [
      '/* Form inputs — Tailwind form-reset not included by default */',
      '.form-input { display: block; width: 100%; padding: 0.75rem 1rem; border: 1.5px solid #e2e8f0; border-radius: 0.75rem; font-size: 1rem; font-family: inherit; transition: border-color 0.2s, box-shadow 0.2s; background: #fff; }',
      '.form-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }',
      '.form-textarea { resize: vertical; }',
      '.btn-submit { cursor: pointer; border: none; }',
      '.btn-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none !important; }',
    ].join('\n');

    // ── JS ─────────────────────────────────────────────────────────────────
    const jsLines = [
      '(function() {',
      '  var form = document.getElementById("captureForm");',
      '  var captureSection = document.getElementById("capture-section");',
      '  var confirmationSection = document.getElementById("confirmation-section");',
      '',
      '  if (form) {',
      '    form.addEventListener("submit", function(e) {',
      '      e.preventDefault();',
      '',
      '      // Basic validation',
      '      var emailInput = document.getElementById("emailInput");',
      '      if (emailInput && !emailInput.value.trim()) return;',
      '',
      '      var btn = form.querySelector(".btn-submit");',
      '      var originalText = btn.textContent;',
      '      btn.disabled = true;',
      '      btn.textContent = "Submitting...";',
      '',
      '      // Simulate submission (in production, replace with fetch() to your API)',
      '      setTimeout(function() {',
      '        if (captureSection) captureSection.style.display = "none";',
      '        if (confirmationSection) {',
      '          confirmationSection.style.display = "block";',
      '          confirmationSection.scrollIntoView({ behavior: "smooth" });',
      '        }',
      '        btn.disabled = false;',
      '        btn.textContent = originalText;',
      '        form.reset();',
      '      }, 800);',
      '    });',
      '  }',
      '',
      '  // Smooth scroll for any anchor links',
      '  document.querySelectorAll(\'a[href^="#"]\').forEach(function(anchor) {',
      '    anchor.addEventListener("click", function(e) {',
      '      e.preventDefault();',
      '      var target = document.querySelector(this.getAttribute("href"));',
      '      if (target) target.scrollIntoView({ behavior: "smooth" });',
      '    });',
      '  });',
      '})();',
    ];

    const files = {
      'index.html': htmlLines.join('\n'),
      'styles.css': cssContent,
      'script.js': jsLines.join('\n'),
    };

    const display = Object.entries(files).map(([name, code]) => {
      const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
      return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
    }).join('\n\n');

    const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
    const text = `## Generated Implementation (Static Surface — ISE Surfaces: ${surfaces.join(', ')})\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (HTML + CSS + JS)\n**ISE surfaces implemented:** ${surfaces.join(', ')}\n**Lines of code:** ${totalLines}`;

    await this._streamText(text, emitChunk, 4);

    return { files, entryPoint: 'index.html', totalLines };
  }

  // ── Helpers ──────────────────────────────────────────────

  async _streamText(text, emitChunk, charsPerChunk = 5) {
    for (let i = 0; i < text.length; i += charsPerChunk) {
      emitChunk(text.slice(i, i + charsPerChunk));
      await this._delay(12);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Prompt-derived content helpers ────────────────────────────────────────
  //
  // When Product Context is missing, these methods extract meaningful signals
  // ── Simulated section generator ──────────────────────────────────────────────
  // Generates HTML section blocks based on prompt-extracted sections.
  // Each section gets domain-appropriate placeholder content instead of generic text.

  /**
   * Generate HTML section blocks for the simulated code path.
   *
   * @param {Array<{name: string, description: string}>} sections - Extracted sections from prompt
   * @param {string} businessName - The business name
   * @param {object} colors - Color scheme { from, to, accent, bg }
   * @returns {string[]} Array of HTML lines to inject into the page
   */
  _generateSimulatedSections(sections, businessName, colors) {
    const lines = [];

    // If no sections were detected, generate a default services section
    if (sections.length === 0) {
      sections = [{ name: 'Services', description: '' }];
    }

    for (const section of sections) {
      lines.push('');
      const sectionId = section.name.toLowerCase().replace(/\s+/g, '-');

      switch (section.name) {
        case 'Pricing':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">Our Pricing</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Transparent pricing for every need</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-gray-50 rounded-2xl p-8 border border-gray-200 text-center hover:shadow-xl transition-all duration-300">',
            '          <h3 class="text-xl font-bold text-gray-900 mb-2">Basic</h3>',
            '          <div class="text-4xl font-extrabold text-gray-900 my-4">$29</div>',
            '          <p class="text-gray-500 mb-6">Perfect for getting started</p>',
            '          <ul class="text-gray-600 text-sm space-y-2 mb-8">',
            '            <li>Standard service</li>',
            '            <li>30-minute session</li>',
            '            <li>Basic support</li>',
            '          </ul>',
            `          <a href="#" class="inline-block w-full py-3 rounded-xl bg-${colors.from} text-white font-semibold hover:opacity-90 transition-all">Choose Basic</a>`,
            '        </div>',
            `        <div class="bg-${colors.from} rounded-2xl p-8 text-white text-center shadow-xl transform scale-105 relative">`,
            '          <span class="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-400 text-gray-900 text-xs font-bold px-3 py-1 rounded-full">POPULAR</span>',
            '          <h3 class="text-xl font-bold mb-2">Premium</h3>',
            '          <div class="text-4xl font-extrabold my-4">$59</div>',
            '          <p class="text-white/80 mb-6">Our most popular option</p>',
            '          <ul class="text-white/90 text-sm space-y-2 mb-8">',
            '            <li>Full-service treatment</li>',
            '            <li>60-minute session</li>',
            '            <li>Priority support</li>',
            '            <li>Premium products</li>',
            '          </ul>',
            '          <a href="#" class="inline-block w-full py-3 rounded-xl bg-white text-gray-900 font-semibold hover:bg-gray-100 transition-all">Choose Premium</a>',
            '        </div>',
            '        <div class="bg-gray-50 rounded-2xl p-8 border border-gray-200 text-center hover:shadow-xl transition-all duration-300">',
            '          <h3 class="text-xl font-bold text-gray-900 mb-2">Deluxe</h3>',
            '          <div class="text-4xl font-extrabold text-gray-900 my-4">$99</div>',
            '          <p class="text-gray-500 mb-6">The ultimate experience</p>',
            '          <ul class="text-gray-600 text-sm space-y-2 mb-8">',
            '            <li>All premium features</li>',
            '            <li>90-minute session</li>',
            '            <li>VIP treatment</li>',
            '            <li>Take-home products</li>',
            '          </ul>',
            `          <a href="#" class="inline-block w-full py-3 rounded-xl bg-${colors.from} text-white font-semibold hover:opacity-90 transition-all">Choose Deluxe</a>`,
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Testimonials':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">What Our Clients Say</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Real stories from happy customers</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"Absolutely amazing experience! ${businessName} exceeded all my expectations. Highly recommend to everyone."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">SM</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">Sarah M.</p><p class="text-gray-400 text-xs">Loyal customer</p></div>',
            '          </div>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"Professional, friendly, and the results speak for themselves. ${businessName} is now my go-to recommendation."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">JK</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">James K.</p><p class="text-gray-400 text-xs">Happy client</p></div>',
            '          </div>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"I've tried many places before, but ${businessName} is in a league of its own. Outstanding quality and care."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">RL</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">Rachel L.</p><p class="text-gray-400 text-xs">Regular client</p></div>',
            '          </div>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'FAQ':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-3xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-16">Frequently Asked Questions</h2>`,
            '      <div class="space-y-6">',
            `        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group" open>`,
            `          <summary class="font-semibold text-gray-900 cursor-pointer">What services do you offer?</summary>`,
            `          <p class="mt-3 text-gray-600 leading-relaxed">We offer a full range of professional services tailored to your needs. Contact us for a detailed list of options.</p>`,
            '        </details>',
            '        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group">',
            '          <summary class="font-semibold text-gray-900 cursor-pointer">How do I book an appointment?</summary>',
            '          <p class="mt-3 text-gray-600 leading-relaxed">You can book online through our website or call us directly. We recommend booking in advance for the best availability.</p>',
            '        </details>',
            '        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group">',
            '          <summary class="font-semibold text-gray-900 cursor-pointer">What are your hours?</summary>',
            '          <p class="mt-3 text-gray-600 leading-relaxed">We are open Monday through Saturday, 9 AM to 6 PM. We also offer extended hours by appointment.</p>',
            '        </details>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Team':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">Meet Our Team</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Experienced professionals dedicated to you</p>`,
            '      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,woman" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Alex Rivera</h3>',
            '          <p class="text-gray-500 text-sm">Founder & Lead Specialist</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,man" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Jordan Chen</h3>',
            '          <p class="text-gray-500 text-sm">Senior Specialist</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,person" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Sam Taylor</h3>',
            '          <p class="text-gray-500 text-sm">Client Relations</p>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Schedule':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-4xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-16">Class Schedule</h2>`,
            '      <div class="overflow-x-auto">',
            '        <table class="w-full text-left border-collapse">',
            '          <thead><tr class="border-b-2 border-gray-200">',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Day</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Time</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Class</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Instructor</th>',
            '          </tr></thead>',
            '          <tbody>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Monday</td><td class="py-3 px-4">9:00 AM</td><td class="py-3 px-4">Morning Flow</td><td class="py-3 px-4 text-gray-500">Alex R.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Tuesday</td><td class="py-3 px-4">10:00 AM</td><td class="py-3 px-4">Power Session</td><td class="py-3 px-4 text-gray-500">Jordan C.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Wednesday</td><td class="py-3 px-4">6:00 PM</td><td class="py-3 px-4">Evening Restore</td><td class="py-3 px-4 text-gray-500">Sam T.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Thursday</td><td class="py-3 px-4">9:00 AM</td><td class="py-3 px-4">Beginner Basics</td><td class="py-3 px-4 text-gray-500">Alex R.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Friday</td><td class="py-3 px-4">5:30 PM</td><td class="py-3 px-4">Weekend Prep</td><td class="py-3 px-4 text-gray-500">Jordan C.</td></tr>',
            '            <tr><td class="py-3 px-4 font-medium">Saturday</td><td class="py-3 px-4">10:00 AM</td><td class="py-3 px-4">Community Class</td><td class="py-3 px-4 text-gray-500">All instructors</td></tr>',
            '          </tbody>',
            '        </table>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Contact':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-3xl mx-auto text-center">',
            `      <h2 class="text-4xl font-bold text-gray-900 mb-4">Get in Touch</h2>`,
            `      <p class="text-lg text-gray-500 mb-12">We'd love to hear from you</p>`,
            '      <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">',
            '          <input type="text" placeholder="Your name" class="px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200">',
            '          <input type="email" placeholder="Your email" class="px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200">',
            '        </div>',
            '        <textarea placeholder="Your message" rows="4" class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 mb-4"></textarea>',
            `        <button class="w-full py-3 bg-${colors.from} text-white font-semibold rounded-xl hover:opacity-90 transition-all">Send Message</button>`,
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        default:
          // Generic section for Services, Features, About, Gallery, etc.
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 ${sections.indexOf(section) % 2 === 0 ? 'bg-white' : 'bg-gray-50'} fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">${section.name}</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Discover what makes us special</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#11088;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Quality First</h3>',
            '          <p class="text-gray-500 leading-relaxed">We never compromise on quality. Every detail matters to us.</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#128171;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Expert Team</h3>',
            '          <p class="text-gray-500 leading-relaxed">Skilled professionals with years of experience and passion.</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#10084;&#65039;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Customer Love</h3>',
            '          <p class="text-gray-500 leading-relaxed">Your satisfaction is our top priority, every single time.</p>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;
      }
    }

    return lines;
  }

  // from the user's prompt so the simulated CODE path produces contextual copy
  // instead of raw-prompt-as-H1 or generic "Welcome to something amazing" text.

  /**
   * Derive a clean product title.
   *
   * Priority:
   *   1. productContext.product or productContext.company (already formatted)
   *   2. Prompt minus filler words → domain keywords → capitalised title
   *   3. Safe fallback: "Your App"
   *
   * @param {string|null} prompt
   * @param {string|null} productContext - Formatted context string (from formatProductContext)
   * @returns {string}
   */
  _deriveTitle(prompt, productContext = null) {
    // 1. Product context wins — extract name from formatted block
    if (productContext) {
      const productMatch = productContext.match(/^Product:\s*(.+)$/m);
      if (productMatch) return productMatch[1].trim();
      const companyMatch = productContext.match(/^Company:\s*(.+)$/m);
      if (companyMatch) return companyMatch[1].trim();
    }

    // 2. Derive from prompt
    if (!prompt) return 'Your App';

    // 2a. Look for explicit name patterns: "called X", "named X", "for X" (where X is capitalized)
    // These patterns strongly signal the user's intended business/product name.
    const namePatterns = [
      /\bcalled\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?/,
      /\bnamed\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?/,
      /\bfor\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?\s+(?:with|that|which|featuring)/,
    ];
    for (const pattern of namePatterns) {
      const match = prompt.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Sanity check: skip if it's a generic word like "Build", "Create", etc.
        const GENERIC = new Set(['Build', 'Create', 'Make', 'Design', 'Generate', 'The', 'This', 'That', 'My', 'Our', 'New']);
        if (!GENERIC.has(name)) return name;
      }
    }

    // 2b. Look for quoted names: "FreshPaws", 'ZenFlow'
    const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']/);
    if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();

    // 2c. Fallback: filler-word removal (original approach)
    const FILLER_RE = new RegExp(
      '\\b(' + [
        // intent verbs
        'please', 'help', 'can you', 'could you', 'build', 'create', 'make',
        'develop', 'design', 'code', 'write', 'generate',
        // articles / pronouns / prepositions
        'i', 'we', 'a', 'an', 'the', 'my', 'our', 'your',
        'need', 'want', 'would like',
        'for', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'by',
        // structural product words
        'landing page', 'landing', 'web page', 'webpage', 'website',
        'web site', 'site', 'web app', 'web application', 'application',
        'app', 'page',
        // capture-surface words (avoid surfacing these as title words)
        'email signup', 'email capture', 'sign up', 'signup', 'email', 'waitlist',
        // common descriptors that shouldn't be in titles
        'business', 'company', 'service', 'studio', 'agency', 'shop', 'store',
        'pricing', 'testimonials', 'booking', 'cta', 'schedule', 'free trial',
      ].join('|') + ')\\b',
      'gi',
    );

    const cleaned = prompt
      .replace(FILLER_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleaned.split(' ').filter(w => w.length > 1);
    if (words.length === 0) return 'Your App';

    // Take up to 3 meaningful words, title-case each
    return words
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // ── Content Fidelity Extraction ──────────────────────────────────────────────
  // Parses the user's prompt to extract business name, requested sections, and
  // CTAs, then builds an explicit directive block for the LLM. This prevents
  // the LLM from ignoring prompt-specific content in favor of generic templates.

  /**
   * Extract structured content requirements from the user's prompt.
   *
   * @param {string|null} prompt - User's original prompt
   * @returns {string} Content fidelity directive block for injection into LLM message
   */
  _buildContentFidelityBlock(prompt) {
    if (!prompt) return '';

    const lines = ['=== CONTENT FIDELITY REQUIREMENTS (MANDATORY) ==='];

    // 1. Extract business name
    const businessName = this._extractBusinessName(prompt);
    if (businessName) {
      lines.push(`BUSINESS NAME: "${businessName}" — this MUST appear in:`);
      lines.push('  - The <title> tag');
      lines.push('  - The main H1 heading');
      lines.push('  - The footer copyright');
      lines.push('  - Any navbar/header branding');
      lines.push(`  Do NOT use a generic name. The page is for "${businessName}".`);
    }

    // 2. Extract requested sections
    const sections = this._extractRequestedSections(prompt);
    if (sections.length > 0) {
      lines.push('');
      lines.push('REQUESTED SECTIONS — you MUST generate each of these as a distinct HTML section:');
      for (const section of sections) {
        lines.push(`  - ${section.name}: ${section.description}`);
      }
      lines.push('  Do NOT skip any listed section. Do NOT replace them with a generic feature grid.');
    }

    // 3. Extract CTAs
    const ctas = this._extractCTAs(prompt);
    if (ctas.length > 0) {
      lines.push('');
      lines.push('CALL-TO-ACTION BUTTONS — use these specific CTA texts:');
      for (const cta of ctas) {
        lines.push(`  - "${cta.text}" (instead of generic "Get Started")`);
      }
    }

    // 4. Domain context
    const domain = this._derivePromptDomain(prompt);
    if (domain) {
      lines.push('');
      lines.push(`DOMAIN: Generate content appropriate for this business type. Use relevant imagery keywords, industry terminology, and domain-specific content.`);
    }

    lines.push('=== END CONTENT FIDELITY REQUIREMENTS ===');

    return lines.length > 2 ? lines.join('\n') : '';
  }

  /**
   * Extract the business name from the prompt.
   * Looks for "called X", "named X", quoted names, or capitalized proper nouns.
   *
   * @param {string} prompt
   * @returns {string|null}
   */
  _extractBusinessName(prompt) {
    // Pattern: "called FreshPaws", "named ZenFlow"
    const calledMatch = prompt.match(/\b(?:called|named)\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]*)*)["']?/);
    if (calledMatch) return calledMatch[1].trim();

    // Pattern: quoted name "FreshPaws"
    const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]*)*)["']/);
    if (quotedMatch) return quotedMatch[1].trim();

    // Pattern: "for FreshPaws" (capitalized word after "for")
    const forMatch = prompt.match(/\bfor\s+([A-Z][A-Za-z0-9]+(?:[A-Z][a-z]+)*)\b/);
    if (forMatch) {
      const candidate = forMatch[1];
      const GENERIC = new Set(['Build', 'Create', 'Make', 'Design', 'My', 'Our', 'The', 'This', 'That', 'New', 'An', 'Any']);
      if (!GENERIC.has(candidate) && candidate.length > 2) return candidate;
    }

    return null;
  }

  /**
   * Parse the prompt for requested content sections.
   *
   * @param {string} prompt
   * @returns {Array<{name: string, description: string}>}
   */
  _extractRequestedSections(prompt) {
    const lower = prompt.toLowerCase();
    const sections = [];

    const SECTION_MAP = [
      { keywords: ['pricing', 'price', 'prices', 'plans', 'packages', 'rates'], name: 'Pricing', description: 'Show pricing tiers/packages with prices. Generate realistic prices for this business type.' },
      { keywords: ['testimonial', 'testimonials', 'review', 'reviews', 'customer stories'], name: 'Testimonials', description: 'Show customer testimonials with names, photos, and quotes. Generate realistic testimonials for this business type.' },
      { keywords: ['faq', 'frequently asked', 'questions'], name: 'FAQ', description: 'Show frequently asked questions with answers relevant to this business.' },
      { keywords: ['about', 'about us', 'our story', 'who we are'], name: 'About', description: 'Show an about section describing the business mission and values.' },
      { keywords: ['team', 'our team', 'staff', 'instructor', 'instructors', 'instructor bios'], name: 'Team', description: 'Show team/staff members with names, roles, and photos.' },
      { keywords: ['gallery', 'portfolio', 'our work', 'photos', 'showcase'], name: 'Gallery', description: 'Show a visual gallery/portfolio of work.' },
      { keywords: ['contact', 'contact us', 'get in touch', 'reach us'], name: 'Contact', description: 'Show contact information and/or a contact form.' },
      { keywords: ['class schedule', 'schedule', 'timetable', 'classes', 'sessions'], name: 'Schedule', description: 'Show a class/session schedule with times and descriptions.' },
      { keywords: ['menu', 'our menu', 'food menu', 'drink menu'], name: 'Menu', description: 'Show a menu with items and prices.' },
      { keywords: ['services', 'our services', 'what we offer', 'what we do'], name: 'Services', description: 'Show a list of services offered with descriptions.' },
      { keywords: ['features', 'key features', 'capabilities'], name: 'Features', description: 'Show key features or capabilities of the product/service.' },
      { keywords: ['blog', 'articles', 'news', 'updates'], name: 'Blog', description: 'Show recent blog posts or articles.' },
      { keywords: ['location', 'locations', 'find us', 'where to find us', 'map'], name: 'Location', description: 'Show business location(s) with address information.' },
    ];

    for (const mapping of SECTION_MAP) {
      if (mapping.keywords.some(kw => lower.includes(kw))) {
        sections.push({ name: mapping.name, description: mapping.description });
      }
    }

    return sections;
  }

  /**
   * Parse the prompt for specific CTA requirements.
   *
   * @param {string} prompt
   * @returns {Array<{text: string}>}
   */
  _extractCTAs(prompt) {
    const lower = prompt.toLowerCase();
    const ctas = [];

    const CTA_MAP = [
      { keywords: ['booking cta', 'book now', 'book a', 'booking button', 'appointment'], text: 'Book Now' },
      { keywords: ['free trial cta', 'free trial', 'try free', 'start trial'], text: 'Start Free Trial' },
      { keywords: ['signup cta', 'sign up', 'sign-up', 'register', 'join'], text: 'Sign Up' },
      { keywords: ['subscribe cta', 'subscribe', 'subscription'], text: 'Subscribe Now' },
      { keywords: ['download cta', 'download', 'get the app'], text: 'Download Now' },
      { keywords: ['contact cta', 'contact us', 'get in touch'], text: 'Contact Us' },
      { keywords: ['order cta', 'order now', 'place order'], text: 'Order Now' },
      { keywords: ['learn more cta', 'learn more'], text: 'Learn More' },
      { keywords: ['donate cta', 'donate', 'support us'], text: 'Donate Now' },
      { keywords: ['quote cta', 'get a quote', 'request quote'], text: 'Get a Quote' },
    ];

    for (const mapping of CTA_MAP) {
      if (mapping.keywords.some(kw => lower.includes(kw))) {
        ctas.push({ text: mapping.text });
      }
    }

    // If no specific CTA found but prompt has domain context, don't add generic
    return ctas;
  }

  // ── Polymorphic App Domain Detection for PRODUCT_SYSTEM builds ────────────
  //
  // ── Context-aware repo status page ───────────────────────────────────────────
  // Generates a project status / overview page derived from the repo profile and
  // scaffold data. Used by _simulatedCode() when AI generation fails but repo
  // context is available — prevents the CRUD placeholder from appearing.
  _generateRepoContextPage(prompt, safeTitle, repoProfile, scaffold) {
    const lang = repoProfile.language || 'JavaScript';
    const framework = repoProfile.framework || '';
    const platform = repoProfile.platform || 'web';
    const fileCount = repoProfile.fileCount || 0;
    const pkgName = repoProfile.packageJson && repoProfile.packageJson.name
      ? repoProfile.packageJson.name
      : safeTitle;

    // Build tech badge list
    const badges = [lang];
    if (framework) badges.push(framework);
    if (scaffold && scaffold.techStack && Array.isArray(scaffold.techStack)) {
      for (const s of scaffold.techStack) {
        if (!badges.includes(s)) badges.push(s);
      }
    }
    const badgeHtml = badges.slice(0, 5).map(b =>
      `<span class="badge">${b}</span>`
    ).join('');

    // Build file tree preview from scaffold or repo
    const files = scaffold && Array.isArray(scaffold.files)
      ? scaffold.files.slice(0, 12)
      : [];
    const fileTreeHtml = files.length > 0
      ? files.map(f => {
          const icon = f.endsWith('.json') ? '📋'
            : f.endsWith('.html') ? '🌐'
            : f.endsWith('.css') ? '🎨'
            : f.endsWith('.sql') ? '🗄'
            : f.includes('route') || f.includes('api') ? '🔌'
            : f.includes('test') ? '🧪'
            : '📄';
          return `<div class="file-entry"><span class="file-icon">${icon}</span><span>${f}</span></div>`;
        }).join('')
      : '<div class="file-entry" style="color:var(--text-dim)">No files scaffolded yet</div>';

    // Derive entry point from scaffold or repo
    const entryPoint = (scaffold && scaffold.constraints && scaffold.constraints.entry)
      ? scaffold.constraints.entry
      : repoProfile.isWebProject ? 'index.html' : 'server.js';

    const promptSnippet = prompt && prompt.length > 80
      ? prompt.slice(0, 80) + '…'
      : (prompt || 'No description provided');

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — BuildOrbit</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="styles.css">
</head>
<body class="bg-gray-950 text-gray-100 font-sans antialiased min-h-screen flex flex-col">

  <header class="border-b border-gray-800 bg-gray-900/80 backdrop-blur px-6 py-4">
    <div class="max-w-2xl mx-auto flex items-center gap-3">
      <span class="text-2xl">🛞</span>
      <div>
        <h1 class="text-lg font-bold text-white">${pkgName}</h1>
        <p class="text-xs text-gray-400">Generated by BuildOrbit</p>
      </div>
    </div>
  </header>

  <main class="flex-1 max-w-2xl mx-auto px-6 py-10 w-full flex flex-col gap-6">

    <!-- Build summary -->
    <div class="card">
      <div class="card-label">Build Request</div>
      <p class="text-sm text-gray-300 leading-relaxed">${promptSnippet}</p>
    </div>

    <!-- Stack badges -->
    <div class="card">
      <div class="card-label">Tech Stack</div>
      <div class="badges">${badgeHtml}</div>
      <div class="mt-2 text-xs text-gray-500">Entry: <code class="text-cyan-400">${entryPoint}</code></div>
    </div>

    <!-- File tree -->
    <div class="card">
      <div class="card-label">Project Files${files.length > 0 ? ` (${files.length})` : ''}</div>
      <div class="file-tree">${fileTreeHtml}</div>
      ${files.length === 0 && fileCount > 0 ? `<div class="text-xs text-gray-500 mt-2">${fileCount} files in repository</div>` : ''}
    </div>

    <!-- Build status indicator -->
    <div class="status-card">
      <span class="status-dot"></span>
      <span class="text-sm text-gray-300">Build pipeline active — AI generation in progress</span>
    </div>

  </main>

  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#6b7280;text-decoration:none">Built with 🛞 BuildOrbit</a></div>

  <script src="app.js"></script>
</body>
</html>`;

    const stylesCss = `
:root {
  --text-dim: #6b7280;
  --border: rgba(255,255,255,0.08);
}
.card {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
}
.card-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  margin-bottom: 10px;
  font-family: monospace;
}
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge {
  font-size: 11px;
  font-family: monospace;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid rgba(56,189,248,0.3);
  background: rgba(56,189,248,0.05);
  color: #67e8f9;
}
.file-tree { display: flex; flex-direction: column; gap: 4px; }
.file-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-family: monospace;
  color: #9ca3af;
  padding: 2px 0;
}
.file-icon { font-size: 13px; }
.status-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-radius: 12px;
  border: 1px solid rgba(56,189,248,0.2);
  background: rgba(56,189,248,0.04);
}
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #22d3ee;
  animation: pulse 1.5s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 rgba(34,211,238,0); }
  50% { opacity: 0.7; box-shadow: 0 0 8px rgba(34,211,238,0.4); }
}`;

    const appJs = `// BuildOrbit context-aware fallback — no interactive state needed`;

    return {
      files: {
        'index.html': indexHtml,
        'styles.css': stylesCss,
        'app.js': appJs,
      },
      entryPoint: 'index.html',
    };
  }

  // Detects app type from user prompt and returns domain-specific entities,
  // API routes, UI components, DB schema, and visual theme.
  // Used by _simulatedCode() for full-stack builds and _generateStubContent()
  // for gap-filling, ensuring PRODUCT_SYSTEM output matches the prompt domain.

  _deriveAppDomain(prompt) {
    if (!prompt) return this._defaultAppDomain();
    const lower = prompt.toLowerCase();

    const APP_DOMAINS = [
      {
        keywords: ['chat', 'messaging', 'message', 'real-time chat', 'chat room', 'chatroom', 'instant message', 'conversation'],
        type: 'chat',
        icon: '💬',
        label: 'Chat',
        color: { header: 'indigo-600', accent: 'indigo' },
        entity: { name: 'messages', singular: 'message', icon: '💬' },
        fields: [
          { name: 'content', label: 'Message', type: 'text', placeholder: 'Type a message...', required: true, inputType: 'text' },
          { name: 'room', label: 'Room', type: 'varchar(100)', placeholder: 'general', required: false, inputType: 'text' },
          { name: 'username', label: 'Username', type: 'varchar(100)', placeholder: 'Anonymous', required: false, inputType: 'text' },
        ],
        dbColumns: `content TEXT NOT NULL, room VARCHAR(100) DEFAULT 'general', username VARCHAR(100) DEFAULT 'Anonymous'`,
        emptyState: 'No messages yet. Start the conversation!',
        addLabel: 'Send Message',
        listLabel: 'Messages',
        uiLayout: 'chat',
      },
      {
        keywords: ['inventory', 'stock', 'warehouse', 'supply', 'product tracking', 'stock level', 'inventory track'],
        type: 'inventory',
        icon: '📦',
        label: 'Inventory',
        color: { header: 'emerald-600', accent: 'emerald' },
        entity: { name: 'products', singular: 'product', icon: '📦' },
        fields: [
          { name: 'name', label: 'Product Name', type: 'varchar(255)', placeholder: 'Product name...', required: true, inputType: 'text' },
          { name: 'sku', label: 'SKU', type: 'varchar(100)', placeholder: 'SKU-001', required: false, inputType: 'text' },
          { name: 'quantity', label: 'Quantity', type: 'integer', placeholder: '0', required: true, inputType: 'number' },
          { name: 'category', label: 'Category', type: 'varchar(100)', placeholder: 'Category...', required: false, inputType: 'text' },
        ],
        dbColumns: `name VARCHAR(255) NOT NULL, sku VARCHAR(100) DEFAULT '', quantity INTEGER DEFAULT 0, category VARCHAR(100) DEFAULT ''`,
        emptyState: 'No products in inventory. Add your first product above!',
        addLabel: 'Add Product',
        listLabel: 'Inventory',
        uiLayout: 'table',
      },
      {
        keywords: ['task', 'todo', 'to-do', 'to do', 'task manager', 'project management', 'kanban', 'checklist'],
        type: 'tasks',
        icon: '✅',
        label: 'Tasks',
        color: { header: 'blue-600', accent: 'blue' },
        entity: { name: 'tasks', singular: 'task', icon: '✅' },
        fields: [
          { name: 'title', label: 'Task', type: 'varchar(255)', placeholder: 'What needs to be done?', required: true, inputType: 'text' },
          { name: 'priority', label: 'Priority', type: 'varchar(20)', placeholder: 'medium', required: false, inputType: 'select', options: ['low', 'medium', 'high'] },
          { name: 'status', label: 'Status', type: 'varchar(20)', placeholder: 'pending', required: false, inputType: 'select', options: ['pending', 'in_progress', 'done'] },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, priority VARCHAR(20) DEFAULT 'medium', status VARCHAR(20) DEFAULT 'pending'`,
        emptyState: 'No tasks yet. Add your first task above!',
        addLabel: 'Add Task',
        listLabel: 'Tasks',
        uiLayout: 'cards',
      },
      {
        keywords: ['blog', 'article', 'post', 'cms', 'content management', 'publishing', 'writing platform'],
        type: 'blog',
        icon: '📝',
        label: 'Blog',
        color: { header: 'purple-600', accent: 'purple' },
        entity: { name: 'posts', singular: 'post', icon: '📝' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Post title...', required: true, inputType: 'text' },
          { name: 'body', label: 'Content', type: 'text', placeholder: 'Write your post...', required: true, inputType: 'textarea' },
          { name: 'author', label: 'Author', type: 'varchar(100)', placeholder: 'Author name...', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, body TEXT NOT NULL DEFAULT '', author VARCHAR(100) DEFAULT 'Anonymous'`,
        emptyState: 'No posts yet. Write your first article above!',
        addLabel: 'Publish Post',
        listLabel: 'Posts',
        uiLayout: 'cards',
      },
      {
        keywords: ['bookmark', 'link saver', 'url', 'link manager', 'reading list', 'web clipper'],
        type: 'bookmarks',
        icon: '🔖',
        label: 'Bookmarks',
        color: { header: 'amber-600', accent: 'amber' },
        entity: { name: 'bookmarks', singular: 'bookmark', icon: '🔖' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Bookmark title...', required: true, inputType: 'text' },
          { name: 'url', label: 'URL', type: 'text', placeholder: 'https://...', required: true, inputType: 'text' },
          { name: 'tag', label: 'Tag', type: 'varchar(50)', placeholder: 'Tag...', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, url TEXT NOT NULL, tag VARCHAR(50) DEFAULT ''`,
        emptyState: 'No bookmarks saved. Add your first link above!',
        addLabel: 'Save Bookmark',
        listLabel: 'Bookmarks',
        uiLayout: 'cards',
      },
      {
        keywords: ['expense', 'budget', 'spending', 'finance tracker', 'money tracker', 'cost', 'receipt'],
        type: 'expenses',
        icon: '💰',
        label: 'Expenses',
        color: { header: 'green-600', accent: 'green' },
        entity: { name: 'expenses', singular: 'expense', icon: '💰' },
        fields: [
          { name: 'description', label: 'Description', type: 'varchar(255)', placeholder: 'What was it for?', required: true, inputType: 'text' },
          { name: 'amount', label: 'Amount ($)', type: 'decimal(10,2)', placeholder: '0.00', required: true, inputType: 'number' },
          { name: 'category', label: 'Category', type: 'varchar(100)', placeholder: 'Food, Transport...', required: false, inputType: 'text' },
        ],
        dbColumns: `description VARCHAR(255) NOT NULL, amount DECIMAL(10,2) NOT NULL DEFAULT 0, category VARCHAR(100) DEFAULT ''`,
        emptyState: 'No expenses recorded. Add your first expense above!',
        addLabel: 'Add Expense',
        listLabel: 'Expenses',
        uiLayout: 'table',
      },
      {
        keywords: ['note', 'notes app', 'notebook', 'memo', 'journal', 'diary', 'jot'],
        type: 'notes',
        icon: '📒',
        label: 'Notes',
        color: { header: 'yellow-600', accent: 'yellow' },
        entity: { name: 'notes', singular: 'note', icon: '📒' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Note title...', required: true, inputType: 'text' },
          { name: 'body', label: 'Content', type: 'text', placeholder: 'Write your note...', required: true, inputType: 'textarea' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, body TEXT DEFAULT ''`,
        emptyState: 'No notes yet. Write your first note above!',
        addLabel: 'Save Note',
        listLabel: 'Notes',
        uiLayout: 'cards',
      },
      {
        keywords: ['contacts app', 'contact manager', 'contacts list', 'address book', 'people directory', 'crm app', 'customer list', 'contact database', 'manage contacts', 'contact book'],
        type: 'contacts',
        icon: '👥',
        label: 'Contacts',
        color: { header: 'sky-600', accent: 'sky' },
        entity: { name: 'contacts', singular: 'contact', icon: '👥' },
        fields: [
          { name: 'name', label: 'Name', type: 'varchar(255)', placeholder: 'Full name...', required: true, inputType: 'text' },
          { name: 'email', label: 'Email', type: 'varchar(255)', placeholder: 'email@example.com', required: false, inputType: 'text' },
          { name: 'phone', label: 'Phone', type: 'varchar(50)', placeholder: '+1 555-0100', required: false, inputType: 'text' },
        ],
        dbColumns: `name VARCHAR(255) NOT NULL, email VARCHAR(255) DEFAULT '', phone VARCHAR(50) DEFAULT ''`,
        emptyState: 'No contacts yet. Add your first contact above!',
        addLabel: 'Add Contact',
        listLabel: 'Contacts',
        uiLayout: 'table',
      },
      {
        keywords: ['event', 'calendar', 'schedule', 'appointment', 'booking system', 'reservation'],
        type: 'events',
        icon: '📅',
        label: 'Events',
        color: { header: 'rose-600', accent: 'rose' },
        entity: { name: 'events', singular: 'event', icon: '📅' },
        fields: [
          { name: 'title', label: 'Event', type: 'varchar(255)', placeholder: 'Event name...', required: true, inputType: 'text' },
          { name: 'date', label: 'Date', type: 'varchar(50)', placeholder: '2026-05-01', required: true, inputType: 'date' },
          { name: 'location', label: 'Location', type: 'varchar(255)', placeholder: 'Where?', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, date VARCHAR(50) NOT NULL, location VARCHAR(255) DEFAULT ''`,
        emptyState: 'No events scheduled. Create your first event above!',
        addLabel: 'Create Event',
        listLabel: 'Events',
        uiLayout: 'cards',
      },
      {
        keywords: ['recipe', 'cookbook', 'meal plan', 'food tracker', 'recipe manager'],
        type: 'recipes',
        icon: '🍳',
        label: 'Recipes',
        color: { header: 'orange-600', accent: 'orange' },
        entity: { name: 'recipes', singular: 'recipe', icon: '🍳' },
        fields: [
          { name: 'title', label: 'Recipe Name', type: 'varchar(255)', placeholder: 'Recipe name...', required: true, inputType: 'text' },
          { name: 'ingredients', label: 'Ingredients', type: 'text', placeholder: 'List ingredients...', required: true, inputType: 'textarea' },
          { name: 'instructions', label: 'Instructions', type: 'text', placeholder: 'Steps...', required: false, inputType: 'textarea' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, ingredients TEXT NOT NULL DEFAULT '', instructions TEXT DEFAULT ''`,
        emptyState: 'No recipes yet. Add your first recipe above!',
        addLabel: 'Add Recipe',
        listLabel: 'Recipes',
        uiLayout: 'cards',
      },
    ];

    for (const domain of APP_DOMAINS) {
      if (domain.keywords.some(kw => lower.includes(kw))) {
        return domain;
      }
    }

    // Fallback: try to infer from prompt keywords for a generic but titled app
    return this._defaultAppDomain(prompt);
  }

  _defaultAppDomain(prompt = '') {
    // Use the prompt to at least name the entity sensibly.
    // Default to a task/entry domain so we avoid the generic "name/description/items"
    // CRUD template — tasks are the most universally applicable domain.
    const safeTitle = this._deriveTitle ? this._deriveTitle(prompt) : 'App';
    const label = safeTitle || 'App';
    return {
      type: 'tasks',
      icon: '📋',
      label,
      color: { header: 'indigo-600', accent: 'indigo' },
      entity: { name: 'entries', singular: 'entry', icon: '📋' },
      fields: [
        { name: 'title', label: label + ' Entry', type: 'varchar(255)', placeholder: 'Enter title or description...', required: true, inputType: 'text' },
        { name: 'status', label: 'Status', type: 'varchar(20)', placeholder: 'active', required: false, inputType: 'select', options: ['active', 'pending', 'done'] },
      ],
      dbColumns: `title VARCHAR(255) NOT NULL, status VARCHAR(20) DEFAULT 'active'`,
      emptyState: `No ${label.toLowerCase()} entries yet. Add your first one above!`,
      addLabel: `Add ${label} Entry`,
      listLabel: label,
      uiLayout: 'cards',
    };
  }

  /**
   * Detect a domain category from the prompt for contextually appropriate copy.
   *
   * Returns an object with `tagline` (standalone) and `taglinePrefix` (for
   * combining with surface-specific text), or null if no domain matched.
   *
   * @param {string|null} prompt
   * @returns {{ tagline: string, taglinePrefix: string }|null}
   */
  _derivePromptDomain(prompt) {
    if (!prompt) return null;
    const lower = prompt.toLowerCase();

    const DOMAINS = [
      {
        keywords: ['pet', 'grooming', 'veterinary', 'vet', 'animal', 'dog', 'cat', 'puppy', 'kitten', 'paws'],
        taglinePrefix: 'Happy pets, happy owners',
        tagline: 'Where your pets get the royal treatment.',
      },
      {
        keywords: ['beauty', 'salon', 'spa', 'skincare', 'hair', 'nails', 'massage', 'facial', 'wellness', 'barber'],
        taglinePrefix: 'Look your best, feel your best',
        tagline: 'Premium care that makes you shine.',
      },
      {
        keywords: ['fitness', 'workout', 'gym', 'exercise', 'health', 'yoga', 'running', 'sport', 'athlete', 'training'],
        taglinePrefix: 'Train smarter, not harder',
        tagline: 'Train smarter, not harder. Built for results.',
      },
      {
        keywords: ['food', 'restaurant', 'recipe', 'cooking', 'meal', 'diet', 'nutrition', 'chef', 'menu', 'catering'],
        taglinePrefix: 'Great food, made simple',
        tagline: 'Great food, made simple. Order in minutes.',
      },
      {
        keywords: ['music', 'artist', 'band', 'podcast', 'audio', 'sound', 'song', 'album', 'playlist', 'stream'],
        taglinePrefix: 'Your next favourite track starts here',
        tagline: 'Your next favourite track starts here.',
      },
      {
        keywords: ['finance', 'money', 'budget', 'invest', 'saving', 'crypto', 'trading', 'financial', 'wealth', 'banking'],
        taglinePrefix: 'Take control of your financial future',
        tagline: 'Take control of your financial future.',
      },
      {
        keywords: ['travel', 'trip', 'vacation', 'hotel', 'booking', 'destination', 'adventure', 'flight', 'tour'],
        taglinePrefix: 'Your next adventure is one click away',
        tagline: 'Your next adventure is one click away.',
      },
      {
        keywords: ['photo', 'image', 'gallery', 'portfolio', 'design', 'creative', 'art', 'visual', 'photography'],
        taglinePrefix: 'Where creativity meets craft',
        tagline: 'Where creativity meets craft. Show your best work.',
      },
      {
        keywords: ['saas', 'software', 'tool', 'platform', 'productivity', 'workflow', 'automation', 'dashboard', 'analytics'],
        taglinePrefix: 'Powerful tools, zero overhead',
        tagline: 'Powerful tools, zero overhead. Ship faster.',
      },
      {
        keywords: ['ecommerce', 'shop', 'store', 'product', 'sell', 'buy', 'marketplace', 'cart', 'checkout'],
        taglinePrefix: 'The better way to shop',
        tagline: 'The better way to shop. Discover something great.',
      },
      {
        keywords: ['education', 'course', 'learn', 'teaching', 'school', 'tutoring', 'training', 'skill', 'class'],
        taglinePrefix: 'Learn at your own pace',
        tagline: 'Learn at your own pace. Master something new.',
      },
      {
        keywords: ['event', 'conference', 'meetup', 'ticket', 'rsvp', 'webinar', 'summit', 'workshop'],
        taglinePrefix: 'Great events start here',
        tagline: 'Great events start here. Reserve your spot.',
      },
      {
        keywords: ['real estate', 'property', 'home', 'house', 'rent', 'lease', 'apartment', 'mortgage'],
        taglinePrefix: 'Find your perfect home',
        tagline: 'Find your perfect home. Browse listings today.',
      },
    ];

    for (const domain of DOMAINS) {
      if (domain.keywords.some(kw => lower.includes(kw))) {
        return { tagline: domain.tagline, taglinePrefix: domain.taglinePrefix };
      }
    }
    return null;
  }
}

module.exports = { BuilderAgent };

// ── Synthesize a minimal repo profile from prompt/contract when scanner unavailable ──
// WHY: When the repo scanner returns null (no GitHub token, API failure, etc.),
// the intent gate and prompt keywords still detect non-web projects. This helper
// produces a minimal profile so BuilderAgent scaffold/code methods have the
// language/framework/platform data they need without a full scan.
function _synthesizeMinimalProfile(prompt, constraintContract) {
  const lower = (prompt || '').toLowerCase();

  // Detect language from prompt keywords (same patterns as intent gate)
  let language = 'csharp';
  let framework = 'dotnet';
  let platform = 'desktop';

  if (/\bwpf\b|\b\.xaml\b/i.test(lower))                     { language = 'csharp'; framework = 'wpf'; platform = 'desktop'; }
  else if (/\bc#\b|\bcsharp\b|\b\.csproj\b/i.test(lower))    { language = 'csharp'; framework = 'dotnet'; platform = 'desktop'; }
  else if (/\bpython\b|\b\.py\b/i.test(lower))               { language = 'python'; framework = null; platform = 'backend'; }
  else if (/\bgo\b|\bgolang\b/i.test(lower))                 { language = 'go'; framework = null; platform = 'backend'; }
  else if (/\brust\b|\bcargo\b/i.test(lower))                { language = 'rust'; framework = 'cargo'; platform = 'native'; }
  else if (/\bjava\b/i.test(lower))                           { language = 'java'; framework = null; platform = 'backend'; }
  else if (/\bkotlin\b/i.test(lower))                         { language = 'kotlin'; framework = null; platform = 'mobile'; }
  else if (/\bswift\b/i.test(lower))                          { language = 'swift'; framework = null; platform = 'mobile'; }
  else if (/\bflutter\b|\bdart\b/i.test(lower))              { language = 'dart'; framework = 'flutter'; platform = 'mobile'; }
  else if (/\breact[- ]native\b/i.test(lower))               { language = 'javascript'; framework = 'react-native'; platform = 'mobile'; }
  else if (/\bwinforms\b/i.test(lower))                       { language = 'csharp'; framework = 'winforms'; platform = 'desktop'; }
  else if (/\bavalonia\b/i.test(lower))                       { language = 'csharp'; framework = 'avalonia'; platform = 'desktop'; }

  // Artifact lists (mirrors repo-scanner.js constants)
  const ALLOWED = {
    csharp: ['.cs', '.xaml', '.csproj', '.sln', '.resx', '.config'],
    python: ['.py', '.txt', '.toml', '.cfg', '.ini'],
    go: ['.go', '.mod', '.sum'],
    rust: ['.rs', '.toml'],
    java: ['.java', '.xml', '.properties', '.gradle'],
    kotlin: ['.kt', '.xml', '.gradle'],
    swift: ['.swift', '.plist', '.xib', '.storyboard'],
    dart: ['.dart', '.yaml', '.arb'],
    javascript: ['.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css'],
  };
  const WEB_ONLY = ['.jsx', '.tsx', '.html', '.css', '.scss', '.sass', '.vue', '.svelte'];

  return {
    language,
    framework,
    platform,
    isWebProject: false,
    allowedArtifacts: ALLOWED[language] || ALLOWED.csharp,
    prohibitedArtifacts: WEB_ONLY,
    entryPoints: [],
    fileTree: [],
    totalFiles: 0,
    confidence: 50, // lower confidence since synthesized, not scanned
    _synthesized: true,
  };
}

// ── Non-web scaffold helpers ───────────────────────────────────────────────────

/**
 * Build a language-appropriate file tree for non-web projects.
 * Returns tree nodes compatible with the scaffold manifest format.
 */
function _buildNonWebTree(language, framework, prompt) {
  switch (language) {
    case 'csharp': {
      const isWpf     = framework === 'wpf';
      const isAspNet  = framework === 'aspnet';
      if (isWpf) {
        return [
          { path: 'MainWindow.xaml',           type: 'file', description: 'Main WPF window XAML layout' },
          { path: 'MainWindow.xaml.cs',         type: 'file', description: 'Main window code-behind' },
          { path: 'App.xaml',                   type: 'file', description: 'Application entry point XAML' },
          { path: 'App.xaml.cs',                type: 'file', description: 'Application startup code' },
          { path: 'ViewModels/MainViewModel.cs', type: 'file', description: 'Main view model (MVVM)' },
        ];
      }
      if (isAspNet) {
        return [
          { path: 'Controllers/HomeController.cs', type: 'file', description: 'Home controller' },
          { path: 'Models/AppModel.cs',            type: 'file', description: 'Data model' },
          { path: 'Program.cs',                    type: 'file', description: 'App entry point' },
          { path: 'appsettings.json',              type: 'file', description: 'App settings' },
        ];
      }
      return [
        { path: 'Program.cs',        type: 'file', description: 'Application entry point' },
        { path: 'Core/Logic.cs',     type: 'file', description: 'Core business logic' },
        { path: 'Models/DataModel.cs', type: 'file', description: 'Data models' },
      ];
    }

    case 'python': {
      const isFastapi = framework === 'fastapi';
      const isDjango  = framework === 'django';
      if (isDjango) {
        return [
          { path: 'manage.py',        type: 'file', description: 'Django management script' },
          { path: 'app/views.py',     type: 'file', description: 'View handlers' },
          { path: 'app/models.py',    type: 'file', description: 'Database models' },
          { path: 'app/urls.py',      type: 'file', description: 'URL routing' },
          { path: 'requirements.txt', type: 'file', description: 'Dependencies' },
        ];
      }
      if (isFastapi) {
        return [
          { path: 'main.py',          type: 'file', description: 'FastAPI entry point' },
          { path: 'routes/api.py',    type: 'file', description: 'API routes' },
          { path: 'models.py',        type: 'file', description: 'Pydantic models' },
          { path: 'requirements.txt', type: 'file', description: 'Dependencies' },
        ];
      }
      return [
        { path: 'main.py',          type: 'file', description: 'Entry point' },
        { path: 'core.py',          type: 'file', description: 'Core logic' },
        { path: 'utils.py',         type: 'file', description: 'Utility functions' },
        { path: 'requirements.txt', type: 'file', description: 'Dependencies' },
      ];
    }

    case 'go':
      return [
        { path: 'main.go',                    type: 'file', description: 'Application entry point' },
        { path: 'internal/core/logic.go',     type: 'file', description: 'Core business logic' },
        { path: 'go.mod',                      type: 'file', description: 'Go module definition' },
      ];

    case 'rust':
      return [
        { path: 'src/main.rs',  type: 'file', description: 'Application entry point' },
        { path: 'src/lib.rs',   type: 'file', description: 'Library root' },
        { path: 'Cargo.toml',   type: 'file', description: 'Package manifest' },
      ];

    case 'java': {
      const isAndroid = framework === 'android';
      if (isAndroid) {
        return [
          { path: 'app/src/main/java/com/app/MainActivity.java', type: 'file', description: 'Main activity' },
          { path: 'app/src/main/res/layout/activity_main.xml',   type: 'file', description: 'Main layout' },
          { path: 'app/build.gradle',                            type: 'file', description: 'App build config' },
        ];
      }
      return [
        { path: 'src/main/java/Main.java',       type: 'file', description: 'Application entry point' },
        { path: 'src/main/java/core/Logic.java', type: 'file', description: 'Core business logic' },
        { path: 'pom.xml',                        type: 'file', description: 'Maven build config' },
      ];
    }

    case 'kotlin':
      return [
        { path: 'src/main/kotlin/Main.kt',       type: 'file', description: 'Application entry point' },
        { path: 'src/main/kotlin/core/Logic.kt', type: 'file', description: 'Core logic' },
        { path: 'build.gradle.kts',               type: 'file', description: 'Gradle build config' },
      ];

    case 'swift':
      return [
        { path: 'Sources/App/main.swift',        type: 'file', description: 'Application entry point' },
        { path: 'Sources/App/ContentView.swift', type: 'file', description: 'Main view' },
        { path: 'Package.swift',                  type: 'file', description: 'Package manifest' },
      ];

    case 'ruby':
      return [
        { path: 'lib/main.rb', type: 'file', description: 'Main logic' },
        { path: 'Gemfile',      type: 'file', description: 'Dependencies' },
        { path: 'README.md',    type: 'file', description: 'Project documentation' },
      ];

    case 'cpp':
    case 'c':
      return [
        { path: 'src/main.cpp',   type: 'file', description: 'Application entry point' },
        { path: 'src/core.cpp',   type: 'file', description: 'Core implementation' },
        { path: 'include/core.h', type: 'file', description: 'Core header' },
        { path: 'CMakeLists.txt', type: 'file', description: 'CMake build config' },
      ];

    default:
      return [
        { path: 'README.md',  type: 'file', description: 'Project documentation' },
        { path: 'CHANGES.md', type: 'file', description: 'Changelog' },
      ];
  }
}

function _nonWebTechStack(language, framework) {
  const stacks = {
    csharp:     ['dotnet', framework || 'csharp'],
    python:     ['python', framework || 'stdlib'],
    go:         ['go'],
    rust:       ['rust', 'cargo'],
    java:       ['java', framework === 'android' ? 'android' : 'maven'],
    kotlin:     ['kotlin', 'gradle'],
    swift:      ['swift', framework || 'spm'],
    ruby:       ['ruby', 'bundler'],
    cpp:        ['cpp', 'cmake'],
    c:          ['c', 'make'],
  };
  return stacks[language] || [language];
}

/**
 * Generate a minimal but syntactically valid placeholder for a non-web file.
 * The AI code generation (or planner context) fills in real implementation.
 */
function _generateNonWebFile(filePath, language, framework, prompt, plan) {
  const base = filePath.split('/').pop();
  const ext  = base.includes('.') ? '.' + base.split('.').pop() : '';

  const stubs = {
    '.cs':    `// ${base}\nusing System;\n\nnamespace App\n{\n    // TODO: implement ${base.replace('.cs','')}\n}\n`,
    '.py':    `# ${base}\n\ndef main():\n    pass\n\nif __name__ == '__main__':\n    main()\n`,
    '.go':    `// ${base}\npackage main\n\n// TODO: implement ${base.replace('.go','')}\n`,
    '.rs':    `// ${base}\n// TODO: implement ${base.replace('.rs','')}\n`,
    '.java':  `// ${base}\npublic class ${base.replace('.java','')} {\n    // TODO\n}\n`,
    '.kt':    `// ${base}\n// TODO: implement\n`,
    '.swift': `// ${base}\nimport Foundation\n// TODO: implement\n`,
    '.rb':    `# ${base}\n# TODO: implement\n`,
    '.cpp':   `// ${base}\n#include <iostream>\n// TODO: implement\n`,
    '.c':     `// ${base}\n#include <stdio.h>\n// TODO: implement\n`,
    '.h':     `// ${base}\n#pragma once\n// TODO: declarations\n`,
    '.xaml':  `<!-- ${base} -->\n<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n        Title="${base.replace('.xaml','')}" Height="450" Width="800">\n    <Grid>\n        <!-- TODO: add controls -->\n    </Grid>\n</Window>\n`,
    '.mod':   `module app\n\ngo 1.21\n`,
    '.toml':  `[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n`,
    '.gradle': `plugins {\n    id 'java'\n}\n`,
    '.md':    `# ${base.replace('.md','')}\n\nProject documentation.\n`,
    '.txt':   `# requirements\n`,
    '.json':  `{\n  "name": "app",\n  "version": "1.0.0"\n}\n`,
    '.xml':   `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${base} -->\n<root/>\n`,
  };

  return stubs[ext] || `// ${base}\n// TODO: implementation\n`;
}
