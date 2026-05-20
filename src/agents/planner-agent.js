/**
 * Planner Agent
 *
 * Owns the PLAN stage of the pipeline.
 *
 * Responsibilities:
 *   - Takes user prompt → outputs structured task decomposition (JSON)
 *   - Uses GPT-4o-mini for AI-powered planning
 *   - Falls back to deterministic simulation if AI unavailable
 *   - Injects product context when available so subtasks describe the real product
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
 *
 * Communication: Reads from previousOutputs (pipeline state).
 * No direct calls to other agents.
 */

const OpenAI = require('openai');
const { buildContextInstruction } = require('../lib/product-context');
const { formatConstraintBlock } = require('../phases/intent-gate');
const { validatePlanExpansionJustifications } = require('../lib/soft-expansion');
const { callMcpTool, listMcpTools, isMcpAvailable } = require('../mcp/pipeline-mcp-bridge');
const serena = require('../lib/serena-pipeline');

class PlannerAgent {
  constructor() {
    this.stages = ['plan'];
    this.openai = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI();
      }
    } catch (e) {
      console.log('[PlannerAgent] OpenAI not available, using simulated mode');
    }
  }

  /**
   * Execute the PLAN stage.
   *
   * @param {object} opts
   * @param {string} opts.runId      - Pipeline run UUID
   * @param {string} opts.stage      - Must be 'plan'
   * @param {string} opts.prompt     - User's original prompt
   * @param {object} opts.previousOutputs - Previous stage outputs (includes _productContext)
   * @param {function} opts.emitChunk - Streaming chunk emitter
   * @returns {object} Plan output: { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[PlannerAgent] Executing PLAN for run ${runId.slice(0, 8)}...`);

    // Extract product context injected by the orchestrator
    const productContext = previousOutputs._productContext || null;
    if (productContext) {
      const hasSourceRepo = productContext._sourceRepo || productContext._sourceRepoFullName;
      if (hasSourceRepo) {
        console.log(`[PlannerAgent] Source repo context detected — plan will account for existing codebase: ${productContext._sourceRepoFullName || '(unknown)'}`);
      } else {
        console.log('[PlannerAgent] Product context detected — will generate accurate plan');
      }
    } else {
      console.log('[PlannerAgent] No product context — plan will use placeholders');
    }

    // Extract Intent Gate constraint contract (immutable — set at Step 0)
    const constraintContract = previousOutputs._constraintContract || null;
    if (constraintContract) {
      console.log(`[PlannerAgent] Constraint contract: ${constraintContract.intent_class} (expansion_lock: ${constraintContract.expansion_lock})`);
      // Log when operating under hard_expansion (always generates complete structure)
      if (constraintContract.intent_class === 'hard_expansion') {
        console.log(`[PlannerAgent] hard_expansion active — will generate complete app structure`);
      }
    }

    // Extract repo profile (scanned from actual GitHub file tree at pipeline start)
    const repoProfile = previousOutputs._repoProfile
      || (constraintContract && constraintContract._repoProfile)
      || null;
    if (repoProfile && !repoProfile.isWebProject) {
      console.log(
        `[PlannerAgent] Non-web repo profile: ${repoProfile.language}/${repoProfile.framework || 'unknown'} ` +
        `platform=${repoProfile.platform} — plan will account for ${repoProfile.language} project structure`
      );
    }

    // ── MCP Schema Enrichment (if MCP is available) ──────────────────────────
    // Query the database schema so the plan can reference real table names and
    // column types. Fail-open — unavailable MCP never blocks planning.
    let mcpSchemaContext = null;
    if (isMcpAvailable(previousOutputs)) {
      try {
        const tableList = await callMcpTool(previousOutputs, 'postgres.list_tables', {}, { phase: 'plan' });
        if (tableList) {
          mcpSchemaContext = `\n\nDatabase schema (from MCP):\n${tableList.slice(0, 2000)}`;
          console.log('[PlannerAgent] MCP schema context loaded for plan enrichment');
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Serena Codebase Intelligence ─────────────────────────────────────────
    // When a source repo is connected OR repo_aware mode is active, run Serena
    // analysis before planning so the agent understands what already exists.
    // Fail-open — Serena errors never block.
    let serenaContext = null;
    const isRepoAware = constraintContract && constraintContract._repo_aware;
    const sourceRepoRoot = previousOutputs._sourceRepoLocalPath || null;

    if (sourceRepoRoot) {
      console.log(`[PlannerAgent] Running Serena onboarding for source repo: ${sourceRepoRoot}`);
      serenaContext = await serena.buildContextBlock(sourceRepoRoot, { shallow: false });
      if (serenaContext) {
        console.log('[PlannerAgent] Serena codebase context loaded — plan will account for existing structure');
      }
    }

    // ── Repo-Aware: Enhanced Codebase Context ─────────────────────────────
    // When the Intent Gate classified this as repo-aware, build a rich context
    // block from the repo's file tree and key files. This is separate from the
    // existing sourceRepoRoot path (which requires a local clone) — repo-aware
    // mode works with the file tree already fetched via GitHub API.
    let repoAwareContext = null;
    if (isRepoAware && constraintContract.repo_context) {
      const rc = constraintContract.repo_context;
      console.log(
        `[PlannerAgent] Repo-aware mode active: ${rc.repoFullName || 'unknown'} | ` +
        `intent=${constraintContract.intent_class} | files=${(rc.repoFiles || []).length}`
      );

      // Build repo context block from file tree + source repo summary
      const contextParts = [
        '=== EXISTING CODEBASE CONTEXT (Repo-Aware Mode) ===',
        `Repository: ${rc.repoFullName || 'connected'}`,
        `Language: ${rc.language || 'auto-detect'}`,
        `Framework: ${rc.framework || 'auto-detect'}`,
        `Web Project: ${rc.isWebProject !== false ? 'yes' : 'no'}`,
        '',
      ];

      // Include file tree from repo (up to 200 paths for context window)
      if (rc.repoFiles && rc.repoFiles.length > 0) {
        const treeEntries = rc.repoFiles.slice(0, 200);
        contextParts.push('File Tree:');
        for (const f of treeEntries) {
          contextParts.push(`  ${f}`);
        }
        if (rc.repoFiles.length > 200) {
          contextParts.push(`  ... and ${rc.repoFiles.length - 200} more files`);
        }
        contextParts.push('');
      }

      // If we have source repo summary from GitHub fetch, include it
      if (productContext && productContext._sourceRepo) {
        contextParts.push('Source Repository Analysis:');
        contextParts.push(productContext._sourceRepo);
        contextParts.push('');
      }

      // If Serena provided deeper analysis, merge it
      if (serenaContext) {
        contextParts.push(serenaContext);
        contextParts.push('');
      }

      contextParts.push('=== END CODEBASE CONTEXT ===');
      repoAwareContext = contextParts.join('\n');
    }

    // For repo-aware runs, repoAwareContext supersedes basic serenaContext
    const effectiveSerenaContext = repoAwareContext || serenaContext;

    let planOutput;
    if (this.openai) {
      try {
        planOutput = await this._aiPlan(prompt, emitChunk, productContext, constraintContract, repoProfile, mcpSchemaContext, effectiveSerenaContext);
      } catch (e) {
        console.log('[PlannerAgent] AI plan failed, falling back to simulated mode:', e.message);
      }
    }

    if (!planOutput) {
      planOutput = await this._simulatedPlan(prompt, emitChunk, constraintContract);
    }

    // Post-PLAN validation: check that plan steps don't reference prohibited layers
    if (constraintContract && constraintContract.expansion_lock && planOutput) {
      const violations = this._validatePlanAgainstContract(planOutput, constraintContract);
      if (violations.length > 0) {
        console.warn(`[PlannerAgent] CONSTRAINT_VIOLATION_DETECTED: plan references prohibited layers: ${violations.join('; ')}`);
        // Strip violating subtasks rather than failing — re-run would produce the same result
        planOutput.subtasks = (planOutput.subtasks || []).filter(t => {
          const desc = `${t.title || ''} ${t.description || ''}`.toLowerCase();
          return !this._subtaskViolatesContract(desc, constraintContract);
        });
        // Append warning to rawMarkdown
        planOutput.rawMarkdown = (planOutput.rawMarkdown || '') +
          `\n\n⚠️ **Constraint enforcement:** Removed plan steps that violate ${constraintContract.intent_class} boundaries (${violations.join('; ')}).`;
      }
    }

    return planOutput;
  }

  /**
   * Check if a plan's subtasks reference layers prohibited by the constraint contract.
   * Returns array of violation descriptions.
   */
  _validatePlanAgainstContract(planOutput, contract) {
    if (!contract || !contract.prohibited_layers || contract.prohibited_layers.length === 0) return [];

    const violations = [];
    const subtasks = planOutput.subtasks || [];

    for (const task of subtasks) {
      const desc = `${task.title || ''} ${task.description || ''}`.toLowerCase();
      if (this._subtaskViolatesContract(desc, contract)) {
        violations.push(`Subtask "${task.title}" references prohibited layer`);
      }
    }

    return violations;
  }

  /**
   * Check if a subtask description references prohibited layers.
   */
  _subtaskViolatesContract(descLower, contract) {
    if (contract.constraints.server === false) {
      if (/\b(express|server|endpoint|route|api|middleware|backend)\b/.test(descLower)) return true;
    }
    if (contract.constraints.db === false) {
      if (/\b(database|schema|migration|postgresql|sql|table|queries)\b/.test(descLower)) return true;
    }
    if (contract.constraints.auth === false) {
      if (/\b(auth|login|signup|jwt|bcrypt|session|password)\b/.test(descLower)) return true;
    }
    return false;
  }

  // ── AI-powered plan ──────────────────────────────────────

  async _aiPlan(prompt, emitChunk, productContext, constraintContract, repoProfile = null, mcpSchemaContext = null, serenaContext = null) {
    // Build the context instruction block
    const contextInstruction = buildContextInstruction(productContext);

    // Build the constraint contract block (injected as immutable rules)
    const constraintInstruction = constraintContract
      ? '\n\n' + formatConstraintBlock(constraintContract)
      : '';

    // Repo profile instruction: when the target repo is non-web, tell the planner
    // to plan language-appropriate changes (not React components).
    const repoProfileInstruction = (repoProfile && !repoProfile.isWebProject)
      ? `\n\n## TARGET REPO TECH STACK (SCANNED FROM GITHUB)
The target GitHub repository is a ${repoProfile.language.toUpperCase()} ${repoProfile.framework ? `(${repoProfile.framework}) ` : ''}project on the ${repoProfile.platform} platform.
This is NOT a web project. Your plan MUST:
1. Plan ${repoProfile.language}-appropriate changes only — NOT React components, HTML files, or CSS
2. Use ${repoProfile.language} idioms, patterns, and tooling (${repoProfile.buildSystem || 'native build system'})
3. Name files with correct ${repoProfile.language} extensions: ${(repoProfile.allowedArtifacts || []).join(', ')}
4. Do NOT plan to generate .jsx, .html, .css, or any web-frontend files
${repoProfile.entryPoints.length ? `5. Existing entry points: ${repoProfile.entryPoints.join(', ')}\n` : ''}
CRITICAL: This is a ${repoProfile.platform} application. All code and file plans must be appropriate for ${repoProfile.language}/${repoProfile.framework || repoProfile.platform}.`
      : '';

    // Source repo context: inject when user is building FROM an existing GitHub repo.
    // This tells the planner to analyze the codebase first, then plan improvements.
    const sourceRepoSummary = productContext && productContext._sourceRepo ? productContext._sourceRepo : null;
    const sourceRepoInstruction = sourceRepoSummary
      ? `\n\n## EXISTING CODEBASE (BUILD FROM REPO MODE)
The user is building ON TOP OF an existing GitHub repository. Your plan MUST:
1. Analyze the existing file structure and tech stack below
2. Understand what already exists (don't re-implement it)
3. Plan additions/improvements that fit the existing patterns
4. Identify files that need modification vs new files to create
5. Respect the existing architecture and naming conventions

${sourceRepoSummary}

CRITICAL: Do NOT plan to rebuild from scratch. Plan to EXTEND and IMPROVE the existing codebase.
The subtask descriptions should reference specific existing files where relevant (e.g. "Add endpoint to server.js", "Extend the User model in models/user.js").`
      : '';

    // ── Repo-Aware Mode: Override system prompt for change plans ────────────
    const _isRepoAware = constraintContract && constraintContract._repo_aware;
    const _repoIntentClass = constraintContract && constraintContract.intent_class;

    // Build repo-aware instruction block (only when modifying existing code)
    const repoAwareInstruction = _isRepoAware
      ? `\n\n## REPO-AWARE MODE — CHANGE PLAN (NOT GREENFIELD)
You are analyzing and planning changes to an EXISTING codebase. Intent: ${_repoIntentClass}.

CRITICAL RULES FOR REPO-AWARE PLANS:
1. Your plan describes CHANGES to existing files — not a new app from scratch
2. Every subtask must reference specific files from the codebase (e.g. "Add error handling to server.js", "Refactor auth middleware in middleware/auth.js")
3. planned_files must list ONLY the files that will be MODIFIED or CREATED — not every file in the repo
4. planned_components should reference existing components being modified, or new components being added to the existing structure
5. Respect the existing project's tech stack, patterns, and conventions
6. Do NOT suggest replacing the existing architecture — work within it
${_repoIntentClass === 'repo_hardening' ? `
HARDENING FOCUS: Plan production-readiness improvements:
- Error handling, input validation, security headers
- Testing (unit + integration), CI/CD setup
- Logging, monitoring, health checks
- Environment variable management, .env.example
- Database connection pooling, graceful shutdown
- Rate limiting, CORS configuration` : ''}
${_repoIntentClass === 'repo_refactor' ? `
REFACTOR FOCUS: Plan structural improvements:
- Code organization, module extraction
- Reducing file sizes (split god files)
- Improving naming conventions
- Removing dead code, consolidating duplicates
- Adding TypeScript types or JSDoc` : ''}
${_repoIntentClass === 'repo_fix' ? `
FIX FOCUS: Plan targeted bug fixes:
- Identify the specific bug from the user's description
- Trace the root cause through the codebase
- Plan minimal, focused changes
- Include regression test steps` : ''}
${_repoIntentClass === 'repo_feature' ? `
FEATURE FOCUS: Plan new feature addition:
- Identify where the feature fits in the existing architecture
- Plan API endpoints, database changes, and UI components
- Reference existing patterns (how similar features are built in the codebase)
- Plan integration points with existing code` : ''}`
      : '';

    const systemPrompt = _isRepoAware
      ? `You are a technical architect reviewing an existing codebase. Given the user's request and the codebase context below, create a structured CHANGE PLAN.

CRITICAL — YOU ARE NOT BUILDING FROM SCRATCH:
The codebase already exists. Your job is to plan MODIFICATIONS, ADDITIONS, and IMPROVEMENTS to the existing code. Every file reference, component name, and subtask must relate to the actual codebase structure shown below.

${contextInstruction}${constraintInstruction}${repoAwareInstruction}${repoProfileInstruction}${sourceRepoInstruction}${serenaContext ? '\n\n' + serenaContext : ''}

Your response MUST be valid JSON with this exact structure:`
      : `You are a technical architect. Given a user's project description, create a structured execution plan.

CRITICAL — READ FIRST:
Your ONLY job is to decompose the user's SPECIFIC request into an architecture plan. Every component name, file name, subtask title, and description MUST be derived directly from the user's prompt. Do NOT fall back to generic templates, boilerplate structures, or default app patterns.

ANTI-PATTERNS — NEVER DO THESE:
- Do NOT output generic CRUD components (Header, Footer, Sidebar, CRUDTable, TaskList, DataTable, UserList, Navigation, AuthForm, Dashboard, CreateForm, etc.) unless the user SPECIFICALLY asked for them.
- Do NOT plan a generic "task management" or "admin panel" app when the user asked for something else entirely.
- Do NOT default to standard SaaS scaffolding (login + dashboard + settings + user management) unless the user's prompt explicitly describes that kind of app.
- If the user asks for a "photo sharing app", plan Photo, Feed, Gallery, Upload, LikeButton components — NOT generic CRUD components.
- If the user asks for a "recipe finder", plan RecipeCard, SearchFilters, IngredientList, CookingSteps — NOT a DataTable with CreateForm.

HOW TO DERIVE COMPONENTS:
1. Read the user's prompt carefully. Identify the nouns (these become entities/components) and verbs (these become features/interactions).
2. Name components after the user's domain concepts, not generic UI primitives.
3. If the user says "restaurant booking system", your components should be things like: BookingCalendar, RestaurantMenu, TableSelector, ReservationForm — directly derived from their description.
4. The file list should reflect the actual app being built, not a generic template.

${contextInstruction}${constraintInstruction}${repoProfileInstruction}${sourceRepoInstruction}${serenaContext ? '\n\n' + serenaContext : ''}

TECH STACK — ALL BUILDS USE THIS STACK (non-negotiable, unless overridden by repo profile above):
- Frontend: React 18 (CDN via unpkg) + Babel standalone for JSX + Tailwind CSS (CDN)
- Components: shadcn-style inline components (Card, Button, Badge, Input, Table, Tabs, Dialog) defined directly in app.jsx — no npm install needed
- UI pattern: light-theme professional SaaS (bg-gray-50 page, bg-white cards with shadow-sm and border-gray-200, blue-600 accent, text-gray-900/600/400 hierarchy)
- Backend: Express.js (Node.js)
- No vanilla JS apps. No custom CSS frameworks. React + Tailwind on every build.
- Component state: React hooks (useState, useEffect) — no Redux, no external state libraries
- API integration: fetch() calls from app.jsx to Express REST endpoints

Your response MUST be valid JSON with this exact structure:
{
  "subtasks": [
    { "id": 1, "title": "...", "description": "...", "estimatedHours": 1 }
  ],
  "dependencies": {
    "2": [1],
    "3": [1, 2]
  },
  "estimatedComplexity": "low|medium|high",
  "planned_files": ["<files derived from user's project>"],
  "planned_components": ["<components derived from user's domain>"],
  "planned_techStack": ["react-cdn", "tailwindcss-cdn"],
  "rawMarkdown": "## Plan\\n\\nHuman-readable markdown plan...",
  "expansion_justifications": []
}

Rules:
- subtasks: 4-8 concrete, actionable tasks. Each has id, title, description, estimatedHours. Every subtask must reference the user's actual domain — no generic "Set up CRUD endpoints" or "Build admin panel" unless that IS what they asked for.
- dependencies: map of subtask id → array of prerequisite subtask ids. Omit if no deps.
- estimatedComplexity: "low" (simple app), "medium" (multi-entity with state), "high" (complex real-time/auth)
- planned_files: REQUIRED — array of exact file paths the build should produce. Derive from the project's actual needs, not from a template.
- planned_components: REQUIRED — array of UI component/section names derived from the user's domain. If the user asks for a "weather dashboard", output WeatherCard, ForecastChart, LocationSearch — NOT generic Dashboard, DataTable, Navigation.
- planned_techStack: REQUIRED — array of technologies to use. Match the constraint contract's allowed technologies.
- rawMarkdown: Full plan in markdown with ## headers, numbered steps, file list, architecture note. Under 300 words. Use the actual product name/description from the user's prompt — never generic placeholders.
- expansion_justifications: omit or set to [] — hard_expansion always generates complete structure, no justifications needed.

Return ONLY the JSON object, no markdown fences.${mcpSchemaContext || ''}`;

    const MODEL = 'gpt-4o-mini';
    const chunks = [];
    let tokenUsage = null;

    const stream = await this.openai.chat.completions.create({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        chunks.push(text);
        emitChunk(text);
      }
      // Final chunk carries usage when stream_options.include_usage = true
      if (chunk.usage) {
        tokenUsage = {
          model: MODEL,
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    const rawText = chunks.join('');

    // gpt-4o-mini frequently wraps JSON in markdown fences (```json ... ```)
    // Strip fences before parsing to prevent losing structured plan fields.
    const parsed = this._parseJsonResponse(rawText);

    if (parsed) {
      const output = {
        subtasks:    parsed.subtasks    || [],
        dependencies: parsed.dependencies || {},
        estimatedComplexity: parsed.estimatedComplexity || 'medium',
        rawMarkdown: parsed.rawMarkdown || rawText,
        _tokenUsage: tokenUsage,
      };
      // Structured plan fields — consumed by SCAFFOLD to derive its file tree
      if (parsed.planned_files && Array.isArray(parsed.planned_files) && parsed.planned_files.length > 0) {
        output.planned_files = parsed.planned_files;
      }
      if (parsed.planned_components && Array.isArray(parsed.planned_components) && parsed.planned_components.length > 0) {
        output.planned_components = parsed.planned_components;
      }
      if (parsed.planned_techStack && Array.isArray(parsed.planned_techStack) && parsed.planned_techStack.length > 0) {
        output.planned_techStack = parsed.planned_techStack;
      }
      // Phase 4: carry expansion_justifications if present
      if (parsed.expansion_justifications && Array.isArray(parsed.expansion_justifications)) {
        output.expansion_justifications = parsed.expansion_justifications;
      }
      console.log(`[PlannerAgent] AI plan parsed: planned_files=${(output.planned_files || []).length}, planned_components=${(output.planned_components || []).length}`);
      return output;
    }

    // JSON extraction failed — fall through to simulated plan which has
    // proper structured fields (planned_files, planned_components, planned_techStack).
    // The old fallback returned NO structured fields, causing SCAFFOLD to always
    // fall through to the hardcoded 3-file template.
    console.log('[PlannerAgent] Non-JSON response — using simulated plan with structured fields');
    const simulatedFallback = await this._simulatedPlan(prompt, emitChunk, constraintContract);
    simulatedFallback.rawMarkdown = rawText; // preserve AI's markdown output for context
    simulatedFallback._tokenUsage = tokenUsage;
    return simulatedFallback;
  }

  // ── Simulated plan (no AI) ───────────────────────────────

  async _simulatedPlan(prompt, emitChunk, constraintContract) {
    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── Repo-Aware: change plan for existing codebase ──────
    const _repoIntentClasses = ['repo_hardening', 'repo_refactor', 'repo_feature', 'repo_fix'];
    if (constraintContract && constraintContract._repo_aware && _repoIntentClasses.includes(intentClass)) {
      const rc = constraintContract.repo_context || {};
      const repoName = rc.repoFullName || 'connected repository';

      let subtasks;
      if (intentClass === 'repo_hardening') {
        subtasks = [
          { id: 1, title: 'Audit existing codebase', description: `Analyze ${repoName} for production-readiness gaps: error handling, security, testing`, estimatedHours: 1 },
          { id: 2, title: 'Add error handling and validation', description: 'Add try/catch blocks, input validation, and error response formatting to API endpoints', estimatedHours: 2 },
          { id: 3, title: 'Add security hardening', description: 'Security headers (helmet), rate limiting, CORS config, env var management', estimatedHours: 1.5 },
          { id: 4, title: 'Add health checks and logging', description: 'Structured logging, /health endpoint, graceful shutdown handler', estimatedHours: 1 },
          { id: 5, title: 'Add testing foundation', description: 'Test framework setup, key endpoint tests, CI configuration', estimatedHours: 2 },
        ];
      } else if (intentClass === 'repo_refactor') {
        subtasks = [
          { id: 1, title: 'Analyze code structure', description: `Map ${repoName} architecture: identify god files, duplicates, and dead code`, estimatedHours: 1 },
          { id: 2, title: 'Extract modules', description: 'Split oversized files into focused modules with clear boundaries', estimatedHours: 2 },
          { id: 3, title: 'Improve naming and patterns', description: 'Consistent naming conventions, remove dead code, consolidate duplicates', estimatedHours: 1.5 },
          { id: 4, title: 'Verify refactoring', description: 'Ensure all existing functionality works after restructuring', estimatedHours: 1 },
        ];
      } else if (intentClass === 'repo_fix') {
        subtasks = [
          { id: 1, title: 'Identify bug root cause', description: 'Trace the reported issue through the codebase to find the root cause', estimatedHours: 1 },
          { id: 2, title: 'Implement fix', description: 'Apply minimal, targeted fix to the identified root cause', estimatedHours: 1.5 },
          { id: 3, title: 'Add regression safeguard', description: 'Add test or validation to prevent the bug from recurring', estimatedHours: 1 },
        ];
      } else {
        // repo_feature
        subtasks = [
          { id: 1, title: 'Analyze integration points', description: `Identify where the new feature fits in ${repoName}'s existing architecture`, estimatedHours: 1 },
          { id: 2, title: 'Plan API changes', description: 'Design new/modified endpoints that follow existing API patterns', estimatedHours: 1 },
          { id: 3, title: 'Implement feature backend', description: 'Add server-side logic, database changes if needed', estimatedHours: 2 },
          { id: 4, title: 'Implement feature frontend', description: 'Add UI components following existing design patterns', estimatedHours: 2 },
          { id: 5, title: 'Integration verification', description: 'Verify feature works with existing functionality', estimatedHours: 1 },
        ];
      }

      const rawMarkdown = [
        `## Change Plan`,
        ``,
        `### ${intentClass.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${prompt}`,
        ``,
        `**Repository:** ${repoName}`,
        `**Mode:** Modifying existing codebase (not greenfield)`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**IMPORTANT:** All changes target the existing codebase. No new project scaffolding.`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: subtasks.length > 2 ? { [subtasks.length]: [subtasks.length - 1] } : {},
        estimatedComplexity: intentClass === 'repo_fix' ? 'medium' : 'high',
        planned_files: (rc.repoFiles || []).slice(0, 20),
        planned_components: [],
        planned_techStack: [rc.framework || 'existing', rc.language || 'auto-detect'],
        rawMarkdown,
        _repo_aware: true,
      };
    }

    // ── Static Surface: pure HTML/CSS/JS, no backend ──────
    if (intentClass === 'static_surface') {
      // Phase 4.2: ISE surfaces — generate surface-aware plan instead of generic steps
      const _iseSurfaces = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces) || [];

      if (_iseSurfaces.length > 0) {
        const surfaceList = _iseSurfaces.join(', ');
        const captureSurfaces = _iseSurfaces.filter(s => s !== 'confirmation_state');
        const primarySurface = captureSurfaces[0] || 'capture';
        const hasConfirmation = _iseSurfaces.includes('confirmation_state');

        const subtasks = [
          { id: 1, title: 'Design page layout with interaction surfaces', description: `Plan HTML structure with dedicated sections for: ${surfaceList}`, estimatedHours: 0.5 },
          { id: 2, title: `Build ${primarySurface.replace(/_/g, ' ')} form`, description: `Implement ${captureSurfaces.join(' + ')} as a functional HTML form with input validation`, estimatedHours: 1 },
          { id: 3, title: 'Style with CSS', description: 'Responsive CSS with modern design for form elements, inputs, buttons, and confirmation state', estimatedHours: 1 },
          { id: 4, title: 'Add form handling and state transitions', description: `JavaScript for form submission, validation, and ${hasConfirmation ? 'capture-to-confirmation state transition' : 'interaction feedback'}`, estimatedHours: 1 },
        ];

        const rawMarkdown = [
          `## Execution Plan`,
          ``,
          `### Task: ${prompt}`,
          ``,
          `**Intent:** Static surface with interaction surfaces — pure HTML/CSS/JS`,
          `**ISE Surfaces:** ${_iseSurfaces.join(' \u2192 ')}`,
          ``,
          `**Steps:**`,
          ...subtasks.map((t, i) => `${i + 1}. **${t.title}** \u2014 ${t.description}`),
          ``,
          `**Architecture:** Static HTML + CSS + Vanilla JS (with form handling)`,
          `**Files:** 3 files (index.html, styles.css, script.js)`,
          `**Complexity:** Low — static page with capture form(s)`,
        ].join('\n');

        await this._streamText(rawMarkdown, emitChunk, 8);

        return {
          subtasks,
          dependencies: { '3': [2], '4': [2, 3] },
          estimatedComplexity: 'low',
          planned_files: ['index.html', 'styles.css', 'script.js'],
          planned_components: _iseSurfaces.map(s => s.replace(/_/g, ' ')),
          planned_techStack: ['html', 'css', 'tailwindcss-cdn'],
          rawMarkdown,
        };
      }

      const subtasks = [
        { id: 1, title: 'Design page layout', description: 'Plan HTML structure and visual sections', estimatedHours: 0.5 },
        { id: 2, title: 'Write HTML markup', description: 'Semantic HTML5 with proper structure (index.html)', estimatedHours: 1 },
        { id: 3, title: 'Style with CSS', description: 'Responsive CSS with modern design (styles.css)', estimatedHours: 1.5 },
        { id: 4, title: 'Add interactivity', description: 'Vanilla JavaScript for smooth interactions (script.js)', estimatedHours: 1 },
      ];

      const rawMarkdown = [
        `## Execution Plan`,
        ``,
        `### Task: ${prompt}`,
        ``,
        `**Intent:** Static surface — pure HTML/CSS/JS (no backend, no database)`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**Architecture:** Static HTML + CSS + Vanilla JS`,
        `**Files:** 3 files (index.html, styles.css, script.js)`,
        `**Complexity:** Low — static page with no backend required`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: { '3': [2], '4': [2, 3] },
        estimatedComplexity: 'low',
        planned_files: ['index.html', 'styles.css', 'script.js'],
        planned_components: ['HeroSection', 'MainContent', 'Footer'],
        planned_techStack: ['html', 'css', 'tailwindcss-cdn'],
        rawMarkdown,
      };
    }

    // ── Light App: server + frontend, no auth, optional db ──────
    if (intentClass === 'light_app') {
      const subtasks = [
        { id: 1, title: 'Parse requirements', description: 'Identify core functionality and data model', estimatedHours: 0.5 },
        { id: 2, title: 'Set up Express server', description: 'Lightweight Express.js with json + static middleware', estimatedHours: 0.5 },
        { id: 3, title: 'Implement API endpoints', description: 'Minimal REST endpoints for core functionality', estimatedHours: 1.5 },
        { id: 4, title: 'Build frontend', description: 'Responsive UI with form handling and fetch calls', estimatedHours: 2 },
        { id: 5, title: 'Add error handling', description: 'Input validation and user feedback', estimatedHours: 0.5 },
      ];

      const rawMarkdown = [
        `## Execution Plan`,
        ``,
        `### Task: ${prompt}`,
        ``,
        `**Intent:** Light app — server + frontend, no authentication`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**Architecture:** Express.js + Vanilla JS (no auth, minimal backend)`,
        `**Complexity:** Medium — interactive app with clean separation`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: { '3': [2], '4': [3], '5': [3, 4] },
        estimatedComplexity: 'medium',
        planned_files: ['server.js', 'package.json', 'routes/api.js', 'index.html', 'styles.css', 'app.js'],
        planned_components: ['AppLayout', 'MainView', 'FormSection', 'DataList'],
        planned_techStack: ['express', 'tailwindcss-cdn'],
        rawMarkdown,
      };
    }

    // ── Soft Expansion: uses base_class constraints to decide shape ──────
    // soft_expansion with server=false → React CDN frontend (like light_app but client-only)
    // soft_expansion with server=true → light_app shape (server + frontend, no auth/db)
    // Without this, soft_expansion falls through to full_product and generates
    // db/auth files that violate the constraint contract (POL-1516856).
    if (intentClass === 'soft_expansion') {
      const hasServer = constraintContract && constraintContract.constraints && constraintContract.constraints.server !== false;
      if (!hasServer) {
        // Client-only soft expansion: React CDN scaffold
        const subtasks = [
          { id: 1, title: 'Parse requirements', description: 'Identify UI components and interactions', estimatedHours: 0.5 },
          { id: 2, title: 'Build React app', description: 'React CDN components with Tailwind styling', estimatedHours: 2 },
          { id: 3, title: 'Add state management', description: 'React hooks for interactive state', estimatedHours: 1 },
          { id: 4, title: 'Polish interactions', description: 'Responsive design and user feedback', estimatedHours: 1 },
        ];

        const rawMarkdown = [
          `## Execution Plan`,
          ``,
          `### Task: ${prompt}`,
          ``,
          `**Intent:** Soft expansion — React CDN frontend (no server, no database)`,
          ``,
          `**Steps:**`,
          ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
          ``,
          `**Architecture:** React 18 CDN + Tailwind CSS`,
          `**Complexity:** Medium — interactive client-side app`,
        ].join('\n');

        await this._streamText(rawMarkdown, emitChunk, 8);

        return {
          subtasks,
          dependencies: { '2': [1], '3': [2], '4': [2, 3] },
          estimatedComplexity: 'medium',
          planned_files: ['index.html', 'app.jsx', 'styles.css'],
          planned_components: ['AppLayout', 'MainView', 'InteractiveSection'],
          planned_techStack: ['react-cdn', 'tailwindcss-cdn', 'shadcn-inline'],
          rawMarkdown,
        };
      }

      // Server-enabled soft expansion: same as light_app
      const subtasks = [
        { id: 1, title: 'Parse requirements', description: 'Identify core functionality', estimatedHours: 0.5 },
        { id: 2, title: 'Set up Express server', description: 'Lightweight Express.js with static middleware', estimatedHours: 0.5 },
        { id: 3, title: 'Implement API endpoints', description: 'REST endpoints for core functionality', estimatedHours: 1.5 },
        { id: 4, title: 'Build frontend', description: 'React CDN UI with API integration', estimatedHours: 2 },
        { id: 5, title: 'Add error handling', description: 'Input validation and user feedback', estimatedHours: 0.5 },
      ];

      const rawMarkdown = [
        `## Execution Plan`,
        ``,
        `### Task: ${prompt}`,
        ``,
        `**Intent:** Soft expansion — server + frontend (no auth, no database)`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**Architecture:** Express.js + React CDN`,
        `**Complexity:** Medium — interactive app with minimal backend`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: { '3': [2], '4': [3], '5': [3, 4] },
        estimatedComplexity: 'medium',
        planned_files: ['server.js', 'package.json', 'routes/api.js', 'index.html', 'app.jsx', 'styles.css'],
        planned_components: ['AppLayout', 'MainView', 'FormSection', 'DataList'],
        planned_techStack: ['express', 'react-cdn', 'tailwindcss-cdn', 'shadcn-inline'],
        rawMarkdown,
      };
    }

    // ── Full Product: full-stack with auth, db, the works ──────
    const subtasks = [
      { id: 1, title: 'Parse requirements', description: 'Identify core entities and relationships', estimatedHours: 0.5 },
      { id: 2, title: 'Design database schema', description: 'PostgreSQL tables with proper constraints and indexes', estimatedHours: 1 },
      { id: 3, title: 'Set up Express server', description: 'Express.js with middleware stack (json, cors, static)', estimatedHours: 0.5 },
      { id: 4, title: 'Implement API endpoints', description: 'RESTful endpoints with input validation', estimatedHours: 2 },
      { id: 5, title: 'Build frontend', description: 'Responsive UI with form handling and fetch calls', estimatedHours: 2 },
      { id: 6, title: 'Add error handling', description: 'Proper error responses, validation, edge cases', estimatedHours: 1 },
      { id: 7, title: 'Integration testing', description: 'End-to-end data flow verification', estimatedHours: 1 },
    ];

    const rawMarkdown = [
      `## Execution Plan`,
      ``,
      `### Task: ${prompt}`,
      ``,
      `**Analysis:** Decomposing requirements into executable steps.`,
      ``,
      `**Steps:**`,
      ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
      ``,
      `**Architecture:** Express.js + PostgreSQL + Vanilla JS`,
      `**Files:** 8 files across 4 directories`,
      `**Complexity:** Medium — full-stack app with clean separation`,
    ].join('\n');

    await this._streamText(rawMarkdown, emitChunk, 8);

    return {
      subtasks,
      dependencies: { '3': [1, 2], '4': [3], '5': [4], '6': [4, 5], '7': [6] },
      estimatedComplexity: 'medium',
      planned_files: ['server.js', 'package.json', '.env.example', 'migrate.js', 'routes/api.js', 'routes/auth.js', 'middleware/auth.js', 'db/queries.js', 'db/pool.js', 'migrations/001_schema.js', 'public/index.html', 'public/styles.css', 'public/app.js'],
      planned_components: ['AuthForm', 'Dashboard', 'DataTable', 'CreateForm', 'Navigation'],
      planned_techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt'],
      rawMarkdown,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Parse JSON from AI response, handling common formatting issues:
   * - Markdown code fences (```json ... ```)
   * - Leading/trailing whitespace
   * - Embedded JSON within prose text
   * Returns parsed object or null if extraction fails.
   */
  _parseJsonResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    // Attempt 1: direct parse (cleanest case)
    try {
      return JSON.parse(rawText.trim());
    } catch (_) { /* continue */ }

    // Attempt 2: strip markdown code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch (_) { /* continue */ }
    }

    // Attempt 3: find first { ... } block (handles prose before/after JSON)
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
      } catch (_) { /* continue */ }
    }

    return null;
  }

  async _streamText(text, emitChunk, charsPerChunk = 5) {
    for (let i = 0; i < text.length; i += charsPerChunk) {
      emitChunk(text.slice(i, i + charsPerChunk));
      await this._delay(12);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { PlannerAgent };
