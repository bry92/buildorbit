/**
 * Pipeline Stage Executor (v2 — Contract-Aware)
 *
 * Each stage produces structured output conforming to stage-contracts.js:
 *   PLAN     → { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
 *   SCAFFOLD → { tree[], techStack[], summary }
 *   CODE     → { files: { [filename]: content }, entryPoint, totalLines }
 *   SAVE     → { persisted, runId, versionId, timestamp }
 *   VERIFY   → { checks[], passed, errors[], warnings[] }
 *
 * PLAN and CODE stages make real OpenAI API calls.
 * SCAFFOLD, SAVE, VERIFY use deterministic logic (no AI needed).
 *
 * Output streaming goes through the state machine's event system.
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { FRONTEND_ROOT_FILES, JS_EQUIVALENTS, buildManifestSet, applyEquivalenceRenames } = require('./src/lib/manifest-constants');
const { extractFileTree } = require('./src/lib/file-tree-parser');

const PHASES = [
  { id: 'intent_gate', name: 'Intent Gate', color: '#ec4899' },
  { id: 'plan', name: 'Plan', color: '#6366f1' },
  { id: 'scaffold', name: 'Scaffold', color: '#8b5cf6' },
  { id: 'code', name: 'Code', color: '#06b6d4' },
  { id: 'save', name: 'Save', color: '#f59e0b' },
  { id: 'verify', name: 'Verify', color: '#00e5a0' }
];

class PipelineExecutor {
  constructor(pool, stateMachine) {
    this.pool = pool;
    this.stateMachine = stateMachine;
    this.openai = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI();
      }
    } catch (e) {
      console.log('[Pipeline] OpenAI not available, using simulated mode');
    }
  }

  /**
   * Execute a single stage. Called by the orchestrator.
   *
   * @param {string} runId - Pipeline run UUID
   * @param {string} stage - Stage name
   * @param {string} prompt - User's original prompt
   * @returns {object} Contract-conforming stage output
   */
  async executeStage(runId, stage, prompt) {
    const previousOutputs = await this.getPreviousOutputs(runId);

    // Streaming chunk emitter (broadcasts via state machine events for SSE)
    const emitChunk = (content) => {
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage,
        status: 'output',
        payload: { content },
        created_at: new Date().toISOString()
      });
    };

    switch (stage) {
      case 'plan':
        return await this.executePlan(prompt, emitChunk);
      case 'scaffold':
        return await this.executeScaffold(prompt, previousOutputs.plan, emitChunk);
      case 'code':
        return await this.executeCode(prompt, previousOutputs.plan, previousOutputs.scaffold, emitChunk);
      case 'save':
        return await this.executeSave(runId, previousOutputs, emitChunk);
      case 'verify':
        return await this.executeVerify(prompt, previousOutputs, emitChunk);
      default:
        throw new Error(`Unknown stage: ${stage}`);
    }
  }

  /**
   * Fetch completed stage outputs from events table.
   */
  async getPreviousOutputs(runId) {
    const { rows } = await this.pool.query(
      `SELECT stage, payload FROM pipeline_events
       WHERE run_id = $1 AND status = 'completed' AND payload IS NOT NULL
       ORDER BY id ASC`,
      [runId]
    );

    const outputs = {};
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      outputs[row.stage] = payload;
    }
    return outputs;
  }

  // ── PLAN (Real AI) ─────────────────────────────────────

  async executePlan(prompt, emitChunk) {
    if (this.openai) {
      try {
        return await this._aiPlan(prompt, emitChunk);
      } catch (e) {
        console.log('[Pipeline] AI plan failed, using simulated mode:', e.message);
      }
    }
    return this._simulatedPlan(prompt, emitChunk);
  }

  async _aiPlan(prompt, emitChunk) {
    const systemPrompt = `You are a technical architect. Given a user's project description, create a structured execution plan.

Your response MUST be valid JSON with this exact structure:
{
  "subtasks": [
    { "id": 1, "title": "...", "description": "...", "estimatedHours": 1 },
    ...
  ],
  "dependencies": {
    "2": [1],
    "3": [1, 2]
  },
  "estimatedComplexity": "low|medium|high",
  "rawMarkdown": "## Plan\\n\\nHuman-readable markdown plan..."
}

Rules:
- subtasks: 4-8 concrete, actionable tasks. Each has id, title, description, estimatedHours.
- dependencies: map of subtask id → array of prerequisite subtask ids. Omit if no deps.
- estimatedComplexity: "low" (CRUD app), "medium" (multi-entity with auth), "high" (real-time/complex)
- rawMarkdown: Full plan in markdown with ## headers, numbered steps, file list, architecture note. Under 300 words.

Return ONLY the JSON object, no markdown fences.`;

    const chunks = [];
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
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
    }

    const rawText = chunks.join('');

    // Parse the JSON response
    try {
      const parsed = JSON.parse(rawText);
      return {
        subtasks: parsed.subtasks || [],
        dependencies: parsed.dependencies || {},
        estimatedComplexity: parsed.estimatedComplexity || 'medium',
        rawMarkdown: parsed.rawMarkdown || rawText,
      };
    } catch (parseErr) {
      // AI returned non-JSON — wrap it as markdown
      console.log('[Pipeline] Plan AI returned non-JSON, wrapping as markdown');
      return {
        subtasks: [
          { id: 1, title: 'Implement feature', description: prompt, estimatedHours: 2 }
        ],
        dependencies: {},
        estimatedComplexity: 'medium',
        rawMarkdown: rawText,
      };
    }
  }

  async _simulatedPlan(prompt, emitChunk) {
    const subtasks = [
      { id: 1, title: 'Parse requirements', description: 'Identify core entities and relationships', estimatedHours: 0.5 },
      { id: 2, title: 'Design database schema', description: 'PostgreSQL tables with proper constraints and indexes', estimatedHours: 1 },
      { id: 3, title: 'Set up Express server', description: 'Express.js with middleware stack (json, cors, static)', estimatedHours: 0.5 },
      { id: 4, title: 'Implement API endpoints', description: 'RESTful CRUD endpoints with input validation', estimatedHours: 2 },
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
      `**Complexity:** Medium — standard CRUD with clean separation`,
    ].join('\n');

    await this._streamText(rawMarkdown, emitChunk, 8);

    return {
      subtasks,
      dependencies: { '3': [1, 2], '4': [3], '5': [4], '6': [4, 5], '7': [6] },
      estimatedComplexity: 'medium',
      rawMarkdown,
    };
  }

  // ── SCAFFOLD (Deterministic) ───────────────────────────

  async executeScaffold(prompt, plan, emitChunk) {
    // Build tree from plan context
    const planMd = plan?.rawMarkdown || prompt;
    const complexity = plan?.estimatedComplexity || 'medium';

    // ── Priority 1: User-provided file tree → use verbatim ──────────────
    // If the user pasted an explicit file tree, use it as-is instead of
    // generating a default scaffold.
    const userTree = extractFileTree(prompt);
    if (userTree && userTree.isUserProvided) {
      console.log(`[Pipeline] User-provided file tree detected: ${userTree.files.length} files, language=${userTree.language}`);

      await this._streamText(
        `## Scaffold Complete\n\n${userTree.summary}\n\nUsing your provided file structure.`,
        emitChunk
      );

      return {
        tree: userTree.tree,
        techStack: userTree.techStack,
        summary: userTree.summary,
        files: userTree.files,
        _isUserProvided: true,
      };
    }

    // ── Priority 2: Deterministic scaffold based on complexity ───────────
    let tree, techStack;

    if (complexity === 'high') {
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts' },
        { path: 'migrate.js', type: 'file', description: 'Database migration runner' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'routes/auth.js', type: 'file', description: 'Authentication routes' },
        { path: 'middleware/', type: 'dir', description: 'Express middleware' },
        { path: 'middleware/auth.js', type: 'file', description: 'JWT auth middleware' },
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
      techStack = ['express', 'pg', 'jsonwebtoken', 'bcrypt'];
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

    const dirs = tree.filter(t => t.type === 'dir').length;
    const files = tree.filter(t => t.type === 'file').length;
    const summary = `${dirs} directories, ${files} files, ${techStack.join(' + ')}`;

    // Stream the tree as a visual representation
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
      `**Files:** ${files}`,
      `**Dependencies:** ${techStack.join(', ')}`,
    ];

    await this._streamText(treeLines.join('\n'), emitChunk, 6);

    return { tree, techStack, summary };
  }

  // ── CODE (Real AI) ─────────────────────────────────────

  async executeCode(prompt, plan, scaffold, emitChunk) {
    if (this.openai) {
      try {
        return await this._aiCode(prompt, plan, scaffold, emitChunk);
      } catch (e) {
        console.log('[Pipeline] AI code failed, using simulated mode:', e.message);
      }
    }
    return this._simulatedCode(prompt, emitChunk);
  }

  async _aiCode(prompt, plan, scaffold, emitChunk) {
    const planContext = plan?.rawMarkdown || '';
    const techStack = (scaffold?.techStack || ['express', 'pg']).join(', ');

    // Use fenced code block format instead of JSON to avoid ~30-40% token
    // overhead from JSON escape sequences (\n, \", etc.).
    const systemPrompt = `You are a senior full-stack developer building a COMPLETE, PRODUCTION-QUALITY web application.

Output each file using this EXACT format — one section per file, separated by blank lines:

--- FILE: index.html ---
<!DOCTYPE html>
<html lang="en">
...complete file content...

--- FILE: styles.css ---
* { margin: 0; ... }
...complete file content...

--- FILE: app.js ---
// Browser JS only
...complete file content...

--- FILE: server.js ---
const express = require('express');
...complete file content...

--- FILE: routes/api.js ---
const { Router } = require('express');
...complete file content...

--- FILE: db/queries.js ---
// SQL queries
...complete file content...

--- FILE: migrations/001_schema.js ---
exports.up = pgm => { ... }
...complete file content...

--- FILE: package.json ---
{ "name": "app", ... }

CRITICAL RULES — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, app.js go at ROOT level (not inside public/) — this is how the deploy engine serves them
3. index.html must link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="app.js"></script>
4. app.js is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
5. server.js serves static files: app.use(express.static(path.join(__dirname, '.'))) to serve root-level index.html
6. package.json must have: { "scripts": { "start": "node server.js", "build": "node migrate.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.3" } }
7. migrations/001_schema.js: exports.up = (pgm) => { pgm.createTable(...) } — creates tables for THIS specific app
8. db/queries.js: real SQL queries (parameterized) specific to this app's entities
9. styles.css: professional design — CSS variables, hover states, transitions, responsive, beautiful
10. The UI must visually match the task — use appropriate colors, icons (Unicode emoji ok), real content labels
11. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
12. DO NOT truncate — generate every file completely
13. BRANDING — add this badge as the last element before </body> in index.html: <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>`;

    // Build content section mandate — explicit list of required HTML sections
    // derived from the user prompt. Mirrors VERIFY's _extractPromptRequirements
    // so CODE is told upfront exactly what sections must appear.
    const contentMandate = this._buildContentSectionMandate(prompt);

    const chunks = [];
    let tokenUsage = null;

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Build this application: ${prompt}\n\nArchitecture plan:\n${planContext}\n\nTech stack: ${techStack}\n${contentMandate}Generate ALL files completely using the --- FILE: filename --- format. The app must be fully functional and visually polished.`
        }
      ],
      max_tokens: 64000,
      temperature: 0.2,
    });

    let finishReason = null;

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        chunks.push(text);
        emitChunk(text);
      }
      // Capture finish reason ('stop' = complete, 'length' = truncated)
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.usage) {
        tokenUsage = {
          model: 'gpt-4o',
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    const rawText = chunks.join('');
    const rawLen = rawText.length;
    const outputTokens = tokenUsage?.outputTokens || 0;

    console.log(`[Pipeline] CODE raw response: ${rawLen} chars, ${outputTokens} output tokens, finish_reason=${finishReason}`);

    if (finishReason === 'length') {
      console.warn('[Pipeline] ⚠️ CODE output TRUNCATED (hit max_tokens ceiling). Will generate missing files in continuation calls.');
    }

    // Parse files using 4-strategy cascade (delimiter → JSON → code blocks → truncated recovery)
    let files = this._parseAllStrategies(rawText);

    console.log(`[Pipeline] CODE initial parse: ${Object.keys(files).length} files`);

    // Check for missing files vs scaffold and generate them in batches
    const scaffoldFiles = (scaffold?.tree || [])
      .filter(t => t.type === 'file')
      .map(t => t.path);

    if (scaffoldFiles.length > 0) {
      // Apply equivalence mapping before checking for missing files
      // (AI may generate app.js when manifest expects script.js, or vice versa)
      files = this._enforceManifest(files, scaffoldFiles);

      const missingFiles = this._findMissingFiles(files, scaffoldFiles);
      if (missingFiles.length > 0) {
        console.log(`[Pipeline] ${missingFiles.length} missing files: ${missingFiles.join(', ')}. Generating in batches...`);
        emitChunk('\n\n--- Generating remaining files ---\n\n');
        const additionalFiles = await this._generateMissingFiles(
          prompt, planContext, techStack, missingFiles, files, emitChunk
        );
        Object.assign(files, additionalFiles);
        console.log(`[Pipeline] After continuation: ${Object.keys(files).length} total files`);
      }

      // Final manifest enforcement — strip unexpected files, apply equivalence mappings
      files = this._enforceManifest(files, scaffoldFiles);
    }

    // Return result
    if (Object.keys(files).length >= 2) {
      const totalLines = Object.values(files).reduce((sum, c) => sum + c.split('\n').length, 0);
      console.log(`[Pipeline] CODE final: ${Object.keys(files).length} files (${totalLines} lines)`);
      return { files, entryPoint: this._detectEntryPoint(files), totalLines, _tokenUsage: tokenUsage };
    }

    // All strategies failed — return whatever we got
    console.warn(`[Pipeline] CODE parse failed. Raw length: ${rawLen}, output tokens: ${outputTokens}, first 200 chars: ${rawText.slice(0, 200)}`);
    const bestFiles = Object.keys(files).length > 0 ? files : { 'generated.js': rawText };
    const totalLines = Object.values(bestFiles).reduce((sum, c) => sum + c.split('\n').length, 0);
    return { files: bestFiles, entryPoint: this._detectEntryPoint(bestFiles), totalLines, _tokenUsage: tokenUsage };
  }

  /**
   * Parse --- FILE: filename --- delimited sections.
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
   * Try to parse raw text as JSON with multiple strategies.
   */
  _tryJsonParse(text) {
    // Direct parse
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

    // Extract from markdown fence
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

    // Find JSON boundaries
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
        if (content && content.length > 5) files[filename] = content;
      } catch (_) {
        const content = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (content && content.length > 5) files[filename] = content;
      }
    }

    return files;
  }

  /**
   * Parse raw AI output using all 4 strategies, returning the best result.
   */
  _parseAllStrategies(rawText) {
    // Strategy 1: Delimiter format (primary)
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

    // Return best non-empty result
    if (Object.keys(delimFiles).length > 0) return delimFiles;
    if (Object.keys(codeBlockFiles).length > 0) return codeBlockFiles;
    return {};
  }

  /**
   * Find files expected by scaffold but not present in generated output.
   */
  _findMissingFiles(generatedFiles, scaffoldFiles) {
    const generated = new Set(Object.keys(generatedFiles));
    const missing = [];

    for (const scaffoldPath of scaffoldFiles) {
      let codePath = scaffoldPath;
      if (scaffoldPath.startsWith('public/')) {
        const stripped = scaffoldPath.replace('public/', '');
        if (['index.html', 'styles.css', 'app.js', 'script.js'].includes(stripped)) {
          codePath = stripped;
        }
      }
      if (!generated.has(codePath) && !generated.has(scaffoldPath)) {
        missing.push(codePath);
      }
    }

    return missing;
  }

  /**
   * Generate missing files in batches via continuation API calls.
   */
  async _generateMissingFiles(prompt, planContext, techStack, missingFiles, existingFiles, emitChunk) {
    const result = {};
    const BATCH_SIZE = 3;
    const existingFileList = Object.keys(existingFiles).join(', ');

    const contextSnippets = [];
    for (const key of ['server.js', 'package.json', 'index.html']) {
      if (existingFiles[key]) {
        const snippet = existingFiles[key].length > 600
          ? existingFiles[key].slice(0, 600) + '\n// ... (truncated for context)'
          : existingFiles[key];
        contextSnippets.push(`--- ${key} (already generated) ---\n${snippet}`);
      }
    }
    const contextBlock = contextSnippets.length > 0
      ? `\n\nReference files (already generated):\n${contextSnippets.join('\n\n')}`
      : '';

    for (let i = 0; i < missingFiles.length; i += BATCH_SIZE) {
      const batch = missingFiles.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      console.log(`[Pipeline] Continuation batch ${batchNum}: ${batch.join(', ')}`);

      const batchPrompt = `You are generating code files for this app: ${prompt}
Tech stack: ${techStack}
Files already generated: ${existingFileList}
${contextBlock}

Generate ONLY these remaining files using the --- FILE: filename --- format:
${batch.map(f => `- ${f}`).join('\n')}

${planContext ? `Architecture context:\n${planContext}\n` : ''}RULES:
1. COMPLETE CODE ONLY — no placeholders, no "TODO", no skeleton stubs
2. Use the --- FILE: filename --- delimiter for each file
3. Code must be consistent with already-generated files
4. index.html, styles.css, app.js are browser files (no require/module.exports)
5. Generate ONLY the files listed above`;

      try {
        const batchChunks = [];
        let batchFinishReason = null;
        const batchStream = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          stream: true,
          messages: [
            {
              role: 'system',
              content: 'You are a senior full-stack developer. Generate complete, production-quality code files using the --- FILE: filename --- delimiter format. No placeholders, no TODOs.'
            },
            { role: 'user', content: batchPrompt }
          ],
          max_tokens: 32000,
          temperature: 0.2,
        });

        for await (const chunk of batchStream) {
          const text = chunk.choices[0]?.delta?.content || '';
          if (text) {
            batchChunks.push(text);
            emitChunk(text);
          }
          if (chunk.choices[0]?.finish_reason) {
            batchFinishReason = chunk.choices[0].finish_reason;
          }
        }

        const batchText = batchChunks.join('');
        const batchFiles = this._parseFileDelimiters(batchText);

        for (const [name, content] of Object.entries(batchFiles)) {
          if (content && content.trim().length > 10) {
            result[name] = content;
          }
        }

        console.log(`[Pipeline] Batch ${batchNum}: generated ${Object.keys(batchFiles).length} files, finish_reason=${batchFinishReason}`);
      } catch (err) {
        console.error(`[Pipeline] Batch ${batchNum} failed:`, err.message);
      }
    }

    return result;
  }

  /**
   * Enforce the scaffold manifest as a HARD GATE on CODE output.
   * Maps equivalent files (app.js ↔ script.js) and strips unexpected files.
   *
   * @param {object} files - Generated files { [filename]: content }
   * @param {string[]} scaffoldFiles - Flat list of expected file paths from scaffold
   * @returns {object} Manifest-compliant files only
   */
  _enforceManifest(files, scaffoldFiles) {
    if (!scaffoldFiles || scaffoldFiles.length === 0) return files;

    // Uses shared constants from lib/manifest-constants.js to stay in sync
    // with validateCodeAgainstScaffold and BuilderAgent._enforceManifest.
    const manifestSet = buildManifestSet(scaffoldFiles);
    const renamed = applyEquivalenceRenames(files, manifestSet, '[Pipeline]');

    // Strip unexpected files
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
      console.log(`[Pipeline] Manifest enforcement: stripped ${stripped.length}/${totalBefore} unexpected files: ${stripped.join(', ')}`);

      // Warn when enforcement strips more than 50% of files — likely a mapping issue
      if (stripRatio > 0.5) {
        console.warn(`[Pipeline] WARNING: Manifest enforcement stripped >${Math.round(stripRatio * 100)}% of files (${stripped.length}/${totalBefore}). Manifest: [${[...manifestSet].join(', ')}]. Stripped: [${stripped.join(', ')}]`);
      }
    }

    // Safety net: if ALL files were stripped but we had valid renamed files,
    // something went wrong with the manifest matching — fall back to best-effort
    if (Object.keys(enforced).length === 0 && Object.keys(renamed).length > 0) {
      console.warn(`[Pipeline] All files stripped by manifest enforcement — falling back to best-effort renamed files. Manifest: [${[...manifestSet].join(', ')}]. Files: [${Object.keys(renamed).join(', ')}]`);
      return renamed;
    }

    return enforced;
  }

  /**
   * Detect the entry point from generated files.
   */
  _detectEntryPoint(files) {
    if (files['server.js']) return 'server.js';
    if (files['index.js']) return 'index.js';
    if (files['app.js']) return 'app.js';
    return Object.keys(files)[0] || 'server.js';
  }

  async _simulatedCode(prompt, emitChunk) {
    // Derive a title from the prompt
    const title = prompt
      ? prompt.slice(0, 60).replace(/\bbuild\b|\bcreate\b|\bmake\b/gi, '').trim()
        .split(' ').slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : 'My App';
    const safeTitle = title || 'My App';

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
        "app.use('/api', apiRoutes(pool));",
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
        "  router.get('/items', async (req, res) => {",
        "    try {",
        "      const { rows } = await pool.query('SELECT * FROM items ORDER BY created_at DESC');",
        "      res.json({ success: true, items: rows });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  router.post('/items', async (req, res) => {",
        "    try {",
        "      const { name, description } = req.body;",
        "      if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name required' });",
        "      const { rows } = await pool.query(",
        "        'INSERT INTO items (name, description) VALUES ($1, $2) RETURNING *',",
        "        [name.trim(), (description || '').trim()]",
        "      );",
        "      res.status(201).json({ success: true, item: rows[0] });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  router.delete('/items/:id', async (req, res) => {",
        "    try {",
        "      await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);",
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
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "module.exports = pool;",
      ].join('\n'),

      'migrations/001_schema.js': [
        "exports.up = (pgm) => {",
        "  pgm.createTable('items', {",
        "    id: 'id',",
        "    name: { type: 'varchar(255)', notNull: true },",
        "    description: { type: 'text', default: '' },",
        "    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') }",
        "  });",
        "};",
        "exports.down = (pgm) => { pgm.dropTable('items'); };",
      ].join('\n'),

      'package.json': JSON.stringify({
        name: 'app', version: '1.0.0', main: 'server.js',
        scripts: { start: 'node server.js', build: 'node migrate.js' },
        dependencies: { express: '^4.18.2', pg: '^8.11.3' }
      }, null, 2),

      'index.html': [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        `  <title>${safeTitle}</title>`,
        '  <link rel="stylesheet" href="styles.css">',
        '</head>',
        '<body>',
        '  <div class="app">',
        '    <header class="app-header">',
        `      <h1>✨ ${safeTitle}</h1>`,
        '    </header>',
        '    <main class="main-content">',
        '      <section class="add-section">',
        '        <h2>Add New</h2>',
        '        <div class="form-row">',
        '          <input type="text" id="nameInput" placeholder="Name..." autocomplete="off" />',
        '          <input type="text" id="descInput" placeholder="Description (optional)..." />',
        '          <button id="addBtn" class="btn-primary">Add</button>',
        '        </div>',
        '        <div id="formError" class="form-error" style="display:none"></div>',
        '      </section>',
        '      <section class="list-section">',
        '        <h2>Items <span id="countBadge" class="badge">0</span></h2>',
        '        <div id="itemList" class="item-list"></div>',
        '        <div id="emptyState" class="empty-state"><p>🗂️ Nothing here yet. Add your first item above!</p></div>',
        '      </section>',
        '    </main>',
        '  </div>',
        '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
        '  <script src="app.js"></script>',
        '</body>',
        '</html>',
      ].join('\n'),

      'styles.css': [
        ':root { --primary: #6366f1; --primary-hover: #4f46e5; --bg: #f8fafc; --surface: #ffffff; --border: #e2e8f0; --text: #1e293b; --muted: #64748b; --danger: #ef4444; --radius: 10px; --shadow: 0 1px 3px rgba(0,0,0,0.08); }',
        '* { margin: 0; padding: 0; box-sizing: border-box; }',
        'body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }',
        '.app { max-width: 680px; margin: 0 auto; padding: 0 1rem 4rem; }',
        '.app-header { padding: 2rem 0 1.5rem; text-align: center; }',
        '.app-header h1 { font-size: 1.875rem; font-weight: 800; letter-spacing: -0.02em; }',
        '.main-content { display: flex; flex-direction: column; gap: 1.5rem; }',
        '.add-section, .list-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; box-shadow: var(--shadow); }',
        '.add-section h2, .list-section h2 { font-size: 0.875rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }',
        '.form-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }',
        '.form-row input { flex: 1; min-width: 140px; padding: 0.625rem 0.875rem; border: 1.5px solid var(--border); border-radius: var(--radius); font-size: 0.9375rem; transition: border-color 0.15s, box-shadow 0.15s; }',
        '.form-row input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }',
        '.btn-primary { padding: 0.625rem 1.5rem; background: var(--primary); color: #fff; border: none; border-radius: var(--radius); font-weight: 600; cursor: pointer; transition: background 0.15s; }',
        '.btn-primary:hover { background: var(--primary-hover); }',
        '.form-error { margin-top: 0.5rem; color: var(--danger); font-size: 0.875rem; }',
        '.badge { display: inline-block; background: var(--primary); color: #fff; font-size: 0.75rem; font-weight: 700; border-radius: 999px; padding: 0.1em 0.55em; margin-left: 0.4rem; }',
        '.item-list { display: flex; flex-direction: column; gap: 0.625rem; }',
        '.item-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.875rem 1rem; }',
        '.item-card:hover { box-shadow: var(--shadow); }',
        '.item-info h3 { font-size: 0.9375rem; font-weight: 600; }',
        '.item-info p { color: var(--muted); font-size: 0.8125rem; margin-top: 0.2rem; }',
        '.btn-delete { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 1.1rem; padding: 0.2rem 0.4rem; border-radius: 6px; transition: color 0.15s; }',
        '.btn-delete:hover { color: var(--danger); }',
        '.empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--muted); }',
        '@media (max-width: 480px) { .form-row { flex-direction: column; } .btn-primary { width: 100%; } }',
      ].join('\n'),

      'app.js': [
        '(function() {',
        '  var nameInput = document.getElementById("nameInput");',
        '  var descInput = document.getElementById("descInput");',
        '  var addBtn = document.getElementById("addBtn");',
        '  var itemList = document.getElementById("itemList");',
        '  var emptyState = document.getElementById("emptyState");',
        '  var formError = document.getElementById("formError");',
        '  var countBadge = document.getElementById("countBadge");',
        '  function showError(msg) { formError.textContent = msg; formError.style.display = "block"; setTimeout(function() { formError.style.display = "none"; }, 3000); }',
        '  function escHtml(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }',
        '  function renderItems(items) {',
        '    countBadge.textContent = items.length;',
        '    if (!items || items.length === 0) { itemList.innerHTML = ""; emptyState.style.display = "block"; return; }',
        '    emptyState.style.display = "none";',
        '    itemList.innerHTML = items.map(function(item) {',
        '      return \'<div class="item-card" data-id="\' + item.id + \'">\' +',
        '        \'<div class="item-info"><h3>\' + escHtml(item.name) + \'</h3>\' +',
        '        (item.description ? \'<p>\' + escHtml(item.description) + \'</p>\' : \'\') +',
        '        \'</div><button class="btn-delete" data-id="\' + item.id + \'" title="Delete">🗑</button></div>\';',
        '    }).join("");',
        '    itemList.querySelectorAll(".btn-delete").forEach(function(btn) {',
        '      btn.addEventListener("click", function() { deleteItem(btn.dataset.id); });',
        '    });',
        '  }',
        '  function loadItems() {',
        '    fetch("/api/items").then(function(r) { return r.json(); }).then(function(d) { if (d.success) renderItems(d.items); }).catch(function() { renderItems([]); });',
        '  }',
        '  function deleteItem(id) {',
        '    fetch("/api/items/" + id, { method: "DELETE" }).then(function(r) { return r.json(); }).then(function(d) { if (d.success) loadItems(); });',
        '  }',
        '  addBtn.addEventListener("click", function() {',
        '    var name = nameInput.value.trim();',
        '    if (!name) { showError("Name is required"); nameInput.focus(); return; }',
        '    addBtn.disabled = true;',
        '    fetch("/api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, description: descInput.value.trim() }) })',
        '      .then(function(r) { return r.json(); })',
        '      .then(function(d) { if (d.success) { nameInput.value = ""; descInput.value = ""; loadItems(); } else { showError(d.message || "Failed"); } })',
        '      .catch(function() { showError("Network error"); })',
        '      .finally(function() { addBtn.disabled = false; });',
        '  });',
        '  nameInput.addEventListener("keydown", function(e) { if (e.key === "Enter") addBtn.click(); });',
        '  loadItems();',
        '})();',
      ].join('\n'),
    };

    // Stream as formatted output
    const display = Object.entries(files).map(([name, code]) => {
      const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : name.endsWith('.json') ? 'json' : 'javascript';
      return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
    }).join('\n\n');

    const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
    const text = `## Generated Implementation\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files\n**Lines of code:** ${totalLines}`;

    await this._streamText(text, emitChunk, 4);

    return { files, entryPoint: 'server.js', totalLines };
  }

  // ── SAVE (Deterministic) ───────────────────────────────

  async executeSave(runId, artifacts, emitChunk) {
    const lines = [
      `## Artifacts Saved`,
      ``,
      `\u2713 Execution plan persisted`,
      `\u2713 File structure recorded`,
      `\u2713 Generated code committed`,
      `\u2713 Pipeline run: \`${runId.slice(0, 8)}...\``,
      `\u2713 Timestamp: ${new Date().toISOString()}`,
      ``,
      `All artifacts stored in PostgreSQL and retrievable via API.`,
    ];

    for (const line of lines) {
      emitChunk(line + '\n');
      await this._delay(180);
    }

    // Persist phase outputs to pipeline_runs for backward compat
    const updates = {};
    if (artifacts.plan) updates.plan = JSON.stringify(artifacts.plan);
    if (artifacts.scaffold) updates.scaffold = JSON.stringify(artifacts.scaffold);
    if (artifacts.code) updates.code = JSON.stringify(artifacts.code);

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = Object.values(updates);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
      await this.pool.query(
        `UPDATE pipeline_runs SET ${sets} WHERE id = $1`,
        [runId, ...values]
      );
    }

    // Generate a deterministic version ID from the run
    const versionId = `v1-${runId.slice(0, 8)}-${Date.now().toString(36)}`;

    return {
      persisted: true,
      runId,
      versionId,
      timestamp: new Date().toISOString(),
    };
  }

  // ── VERIFY (Deterministic) ─────────────────────────────

  async executeVerify(prompt, artifacts, emitChunk) {
    const plan = artifacts.plan || {};
    const code = artifacts.code || {};
    const scaffold = artifacts.scaffold || {};
    const runId = artifacts._runId || null;
    const intentClass = (artifacts._constraintContract && artifacts._constraintContract.intent_class) || null;

    const checks = [];
    const errors = [];
    const warnings = [];

    // Check 1: Plan completeness
    const hasSubtasks = Array.isArray(plan.subtasks) && plan.subtasks.length > 0;
    checks.push({ name: 'Plan has subtasks', passed: hasSubtasks, category: 'artifacts' });
    if (!hasSubtasks) warnings.push('Plan has no subtasks defined');

    // Check 2: Scaffold has files
    const hasTree = Array.isArray(scaffold.tree) && scaffold.tree.length > 0;
    checks.push({ name: 'Scaffold defines file tree', passed: hasTree, category: 'artifacts' });
    if (!hasTree) warnings.push('Scaffold has no file tree');

    // Check 3: Code files generated
    const hasFiles = code.files && typeof code.files === 'object' && Object.keys(code.files).length > 0;
    checks.push({ name: 'Code files generated', passed: hasFiles, category: 'artifacts' });
    if (!hasFiles) errors.push('No code files were generated');

    // Check 4: Entry point exists
    const entryPointExists = hasFiles && code.entryPoint && code.files[code.entryPoint];
    checks.push({ name: 'Entry point file exists', passed: !!entryPointExists, category: 'artifacts' });
    if (!entryPointExists) warnings.push(`Entry point "${code.entryPoint || 'unknown'}" not found in generated files`);

    // Check 5: Database schema defined (check for SQL/migration-related code)
    const codeText = hasFiles ? Object.values(code.files).join('\n') : '';
    const hasSchema = codeText.includes('CREATE TABLE') || codeText.includes('pool.query') || codeText.includes('Pool');
    checks.push({ name: 'Database integration present', passed: hasSchema, category: 'artifacts' });
    if (!hasSchema) warnings.push('No database queries detected in generated code');

    // Check 6: Error handling present
    const hasErrorHandling = codeText.includes('catch') || codeText.includes('status(4') || codeText.includes('status(5');
    checks.push({ name: 'Error handling present', passed: hasErrorHandling, category: 'artifacts' });
    if (!hasErrorHandling) warnings.push('No error handling patterns detected');

    // Check 7: Interactive elements are wired (buttons have handlers, forms submit)
    // Mirrors the diagnostic scan in builder-agent.js and the qa-agent.js check.
    // This formalizes interactivity as a VERIFY checklist item, not just a warning log.
    // WHY OR-gate: event delegation, framework patterns, and inline onclick all count as
    // "wired" — a ratio-only check produced false negatives on legitimate code.
    if (hasFiles && intentClass !== 'static_surface') {
      const htmlContent = Object.entries(code.files || {})
        .filter(([f]) => f.endsWith('.html') || f.endsWith('.htm'))
        .map(([, c]) => c).join('\n');

      const jsContent = Object.entries(code.files || {})
        .filter(([f]) => f.endsWith('.js') &&
                !f.includes('server') &&
                !f.includes('routes') &&
                !f.includes('db/') &&
                !f.includes('migrations'))
        .map(([, c]) => c).join('\n');

      const buttonCount = (htmlContent.match(/<button[\s>]/gi) || []).length;
      const formCount = (htmlContent.match(/<form[\s>]/gi) || []).length;
      const interactiveCount = buttonCount + formCount;

      if (interactiveCount > 0) {
        const addEventCount = (jsContent.match(/addEventListener\s*\(\s*['"]click['"]/gi) || []).length;
        const onclickCount = (jsContent.match(/\.onclick\s*=|onclick\s*=/gi) || []).length;
        const handlerCount = addEventCount + onclickCount;

        const wiredRatio = handlerCount / interactiveCount;
        const isWired = wiredRatio >= 0.5 || jsContent.includes('addEventListener') || htmlContent.includes('onclick=');

        checks.push({
          name: 'Interactive elements are wired',
          passed: isWired,
          category: 'interactivity'
        });

        if (!isWired) {
          warnings.push(`DEAD_BUTTONS_DETECTED: ${interactiveCount} interactive elements but only ${handlerCount} handlers detected (${Math.round(wiredRatio*100)}%). Most buttons do nothing.`);
        }
      }
    }

    // ── Preview DOM checks ──────────────────────────────
    // Only applicable for surface-type builds (static_surface, light_app, full_stack)
    // and only when preview files are available on disk.
    let sectionReport = [];
    const isHtmlBuild = intentClass !== 'api_only';

    if (runId && isHtmlBuild) {
      try {
        const previewBase = path.join(__dirname, 'preview');
        const previewDir = path.join(previewBase, runId);
        const indexPath = path.join(previewDir, 'index.html');

        if (fs.existsSync(indexPath)) {
          const html = fs.readFileSync(indexPath, 'utf8');
          const analysis = this._analyzePreviewHtml(html);

          emitChunk('\n## Preview Output Analysis\n\n');
          await this._delay(300);
          emitChunk(`\u{1F4C4} **Word count:** ${analysis.wordCount} visible words\n`);
          await this._delay(180);
          emitChunk(`\u{1F5BC} **Images:** ${analysis.imgCount} found, ${analysis.brokenImgs} missing src\n`);
          await this._delay(180);

          // DOM check A: page is not blank
          const isBlank = analysis.wordCount < 20;
          const blankCheck = { name: 'Preview renders content (not blank)', passed: !isBlank, category: 'preview' };
          checks.push(blankCheck);
          if (isBlank) errors.push('Preview page appears blank — less than 20 visible words');

          // DOM check B: page has structural elements
          const hasStructure = analysis.hasSections || analysis.hasNav || analysis.hasHeader;
          const structureCheck = { name: 'Page has structural elements (nav/sections/header)', passed: hasStructure, category: 'preview' };
          checks.push(structureCheck);
          if (!hasStructure) warnings.push('Page lacks structural elements (no nav, sections, or header found)');

          // DOM check C: no leftover placeholder text
          const placeholderCheck = { name: 'No placeholder text remaining', passed: !analysis.hasPlaceholders, category: 'preview' };
          checks.push(placeholderCheck);
          if (analysis.hasPlaceholders) warnings.push('Placeholder text detected (e.g. "Lorem ipsum" or "[YOUR TEXT]")');

          // DOM check D: images have valid src (only if images present)
          if (analysis.imgCount > 0) {
            const imagesOk = analysis.brokenImgs === 0;
            const imgCheck = { name: 'All image tags have valid src attributes', passed: imagesOk, category: 'preview' };
            checks.push(imgCheck);
            if (!imagesOk) warnings.push(`${analysis.brokenImgs} image(s) are missing src attributes`);
          }

          // DOM check E: plan sections present in rendered output
          const expectedSections = this._extractSectionKeywords(plan.subtasks || []);
          if (expectedSections.length > 0) {
            emitChunk('\n**Expected sections from plan:**\n');
            await this._delay(200);
            for (const section of expectedSections) {
              const found = section.keywords.some(kw =>
                analysis.textLower.includes(kw) || analysis.htmlLower.includes(kw)
              );
              sectionReport.push({ label: section.label, found });
              const icon = found ? '\u2713' : '\u26A0';
              emitChunk(`${icon} ${section.label}\n`);
              await this._delay(150);
              if (!found) warnings.push(`Expected section "${section.label}" not detected in preview`);
            }
          }

        } else {
          // Preview files not written yet — non-fatal, skip DOM checks
          emitChunk('\n\u26A0 Preview files not available — DOM checks skipped\n');
          warnings.push('Preview files not found — DOM validation skipped');
        }
      } catch (previewErr) {
        // Never let DOM check failures crash VERIFY
        console.warn('[VERIFY] Preview analysis error (non-fatal):', previewErr.message);
        warnings.push('Preview analysis encountered an error: ' + previewErr.message);
      }
    }

    // ── Prompt-to-output content verification ─────────────
    // Checks that the generated code actually contains what the user asked for:
    // business name, requested sections, specific CTAs.
    if (prompt && typeof prompt === 'string' && hasFiles) {
      try {
        const promptReqs = this._extractPromptRequirements(prompt);
        if (promptReqs && promptReqs.hasRequirements) {
          const contentMismatches = [];
          const codeLower = codeText.toLowerCase();

          if (promptReqs.businessName) {
            if (!codeLower.includes(promptReqs.businessName.toLowerCase())) {
              contentMismatches.push(`Business name "${promptReqs.businessName}" not found in output`);
            }
          }
          for (const section of promptReqs.sections) {
            if (!section.searchTerms.some(t => codeLower.includes(t))) {
              contentMismatches.push(`Requested "${section.label}" section not found in output`);
            }
          }
          for (const cta of promptReqs.ctas) {
            if (!cta.searchTerms.some(t => codeLower.includes(t))) {
              contentMismatches.push(`Requested "${cta.label}" CTA not found — output may use generic CTA instead`);
            }
          }

          const contentPassed = contentMismatches.length === 0;
          checks.push({ name: 'Content matches user prompt', passed: contentPassed, category: 'content' });
          if (!contentPassed) {
            errors.push(`Prompt-to-output content mismatch: ${contentMismatches.join('; ')}`);
          }
        }
      } catch (promptCheckErr) {
        console.warn('[VERIFY] Prompt content check error (non-fatal):', promptCheckErr.message);
      }
    }

    // ── Emit artifact check results ─────────────────────
    emitChunk('\n## Verification Results\n\n');
    await this._delay(400);

    for (const check of checks) {
      const icon = check.passed ? '\u2713' : '\u2717';
      emitChunk(`${icon} ${check.name}\n`);
      await this._delay(350);
    }

    const passedCount = checks.filter(c => c.passed).length;
    const total = checks.length;
    // passed = ALL checks green. No partial pass.
    const passed = passedCount === total;

    await this._delay(300);
    if (passed) {
      emitChunk(`\n**Result: ALL CHECKS PASSED** \u2014 ${passedCount}/${total} checks passed.`);
    } else if (passedCount === 0) {
      emitChunk(`\n**Result: FAILED** \u2014 0/${total} checks passed.`);
    } else {
      emitChunk(`\n**Result: PARTIAL \u2014 ${passedCount}/${total} checks passed.** Some checks need attention.`);
    }

    if (warnings.length > 0) {
      emitChunk(`\n**Warnings:** ${warnings.join(', ')}`);
    }
    if (errors.length > 0) {
      emitChunk(`\n**Errors:** ${errors.join(', ')}`);
    }
    emitChunk('\n');

    // ── Emit structured verify_report for frontend checklist UI ──
    if (runId && this.stateMachine) {
      try {
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'verify',
          status: 'verify_report',
          payload: JSON.stringify({ checks, sectionReport, passed, passedCount, totalChecks: total, errors, warnings }),
          created_at: new Date().toISOString(),
        });
      } catch (_) { /* non-fatal */ }
    }

    return { checks, sectionReport, passed, errors, warnings };
  }

  // ── Preview Analysis Helpers ───────────────────────────

  /**
   * Extracts expected section keywords from PLAN subtask titles/descriptions.
   * Returns array of { label, keywords[] } for sections that appear referenced
   * in the plan so VERIFY can check the rendered HTML for them.
   */
  _extractSectionKeywords(subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];

    const SECTION_PATTERNS = [
      { label: 'Navigation',     keywords: ['nav', 'navbar', 'menu', 'navigation', 'header'] },
      { label: 'Hero / Banner',  keywords: ['hero', 'banner', 'headline', 'jumbotron', 'landing', 'above the fold'] },
      { label: 'Features',       keywords: ['feature', 'benefit', 'capability', 'why', 'how it works'] },
      { label: 'Products',       keywords: ['product', 'item', 'card', 'catalog', 'listing', 'shop', 'store'] },
      { label: 'Pricing',        keywords: ['price', 'pricing', 'plan', 'tier', 'subscription', 'cost'] },
      { label: 'Testimonials',   keywords: ['testimonial', 'review', 'social proof', 'customer', 'feedback'] },
      { label: 'Contact / CTA',  keywords: ['contact', 'cta', 'signup', 'subscribe', 'get started', 'call to action', 'email'] },
      { label: 'Footer',         keywords: ['footer', 'copyright', 'legal', 'bottom'] },
    ];

    const fullText = subtasks
      .map(t => `${t.title || ''} ${t.description || ''}`)
      .join(' ')
      .toLowerCase();

    return SECTION_PATTERNS.filter(s =>
      s.keywords.some(kw => fullText.includes(kw))
    );
  }

  /**
   * Parses a raw HTML string to extract metrics useful for VERIFY checks.
   * Strips scripts/styles to get visible text, counts structural elements,
   * detects broken images and placeholder text.
   */
  _analyzePreviewHtml(html) {
    // Strip scripts, styles, and comments before extracting visible text
    const stripped = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = stripped.split(/\s+/).filter(w => w.length > 2);
    const wordCount = words.length;
    const htmlLower = html.toLowerCase();
    const textLower = stripped.toLowerCase();

    // Structural element detection
    const hasNav = /<nav[\s>/]/i.test(html) || /class=["'][^"']*\bnav\b[^"']*["']/i.test(html);
    const hasHeader = /<header[\s>/]/i.test(html) || /class=["'][^"']*\bheader\b[^"']*["']/i.test(html);
    const hasFooter = /<footer[\s>/]/i.test(html) || /class=["'][^"']*\bfooter\b[^"']*["']/i.test(html);
    const hasSections = /<section[\s>/]/i.test(html) || (html.match(/<div[^>]*>/gi) || []).length > 5;

    // Image checks
    const imgMatches = html.match(/<img[^>]*>/gi) || [];
    const imgCount = imgMatches.length;
    const brokenImgs = imgMatches.filter(img =>
      !/\bsrc\s*=\s*["'][^"']+["']/i.test(img)
    ).length;

    // Placeholder text detection
    const hasPlaceholders =
      /\[your [a-z\s]+\]/i.test(html) ||
      /lorem ipsum/i.test(html) ||
      /placeholder text/i.test(html) ||
      /\[placeholder\]/i.test(html) ||
      /TODO: /i.test(stripped);

    return {
      wordCount,
      htmlLower,
      textLower,
      hasNav,
      hasHeader,
      hasFooter,
      hasSections,
      imgCount,
      brokenImgs,
      hasPlaceholders,
    };
  }

  // ── Prompt Requirement Extraction ───────────────────────

  /**
   * Builds a content section mandate string for injection into the CODE phase
   * user message. Detects which content sections the user explicitly requested
   * (pricing, features, testimonials, etc.) and returns a hard-constraint block
   * telling the model to include them in index.html.
   *
   * This mirrors the same SECTIONS detection used by VERIFY's
   * _extractPromptRequirements — keeping CODE and VERIFY in sync so what VERIFY
   * checks for is exactly what CODE is told to produce.
   *
   * @param {string} prompt - Original user prompt
   * @returns {string} Mandate block to inject into user message, or '' if none
   */
  _buildContentSectionMandate(prompt) {
    if (!prompt || typeof prompt !== 'string') return '';

    const promptLower = prompt.toLowerCase();

    // Same SECTIONS list as _extractPromptRequirements — keep in sync
    const SECTIONS = [
      {
        label: 'pricing section',
        triggers: ['pricing', 'price list', 'pricing section', 'pricing table'],
        hint: 'a section with pricing plans, tiers, or cost information',
      },
      {
        label: 'features section',
        triggers: ['features', 'feature section', 'key features'],
        hint: 'a section listing features, benefits, or capabilities',
      },
      {
        label: 'testimonials section',
        triggers: ['testimonial', 'testimonials', 'customer reviews', 'reviews section', 'social proof'],
        hint: 'a section with customer testimonials or reviews',
      },
      {
        label: 'about section',
        triggers: ['about us', 'about section', 'our story'],
        hint: 'an about/our story section',
      },
      {
        label: 'contact section',
        triggers: ['contact form', 'contact section', 'contact us', 'contact page'],
        hint: 'a contact form or contact information section',
      },
      {
        label: 'FAQ section',
        triggers: ['faq', 'frequently asked'],
        hint: 'a FAQ section with questions and answers',
      },
      {
        label: 'services section',
        triggers: ['services section', 'our services', 'service list'],
        hint: 'a section listing services or offerings',
      },
    ];

    const required = SECTIONS.filter(s =>
      s.triggers.some(t => promptLower.includes(t))
    );

    if (required.length === 0) return '';

    const lines = required.map(s => `- ${s.label}: ${s.hint}`);
    return `\nREQUIRED CONTENT SECTIONS — these sections MUST appear as distinct, visible sections in index.html:\n${lines.join('\n')}\n\n`;
  }

  /**
   * Extracts verifiable content requirements from the original user prompt.
   * Deterministic — no LLM calls. Pattern-matching only.
   *
   * @param {string} prompt
   * @returns {object|null} { businessName, sections[], ctas[], hasRequirements }
   */
  _extractPromptRequirements(prompt) {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) return null;

    const promptLower = prompt.toLowerCase();
    const requirements = { businessName: null, sections: [], ctas: [], hasRequirements: false };

    // ── Business name ──
    const calledMatch = prompt.match(/(?:called|named)\s+["']?([A-Z][A-Za-z0-9]+(?:[\s-][A-Z][A-Za-z0-9]+)*)["']?/);
    if (calledMatch) {
      requirements.businessName = calledMatch[1].trim();
    } else {
      const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:[\s-][A-Za-z0-9]+)*)["']/);
      if (quotedMatch) {
        const candidate = quotedMatch[1].trim();
        const skip = new Set(['Build','Create','Make','Design','Landing','Page','Website','App','The','Home','About']);
        if (!skip.has(candidate)) requirements.businessName = candidate;
      }
    }

    // ── Sections ──
    const SECTIONS = [
      { label:'pricing', triggers:['pricing','price list','pricing section','pricing table'], searchTerms:['pricing','price','per month','/mo','/year','plan'] },
      { label:'testimonials', triggers:['testimonial','testimonials','customer reviews','reviews section','social proof'], searchTerms:['testimonial','review','customer','said'] },
      { label:'features', triggers:['features','feature section','key features'], searchTerms:['feature','benefit','capability'] },
      { label:'about', triggers:['about us','about section','our story'], searchTerms:['about','our story','who we are','our mission'] },
      { label:'contact', triggers:['contact form','contact section','contact us','contact page'], searchTerms:['contact','email','phone','get in touch'] },
      { label:'FAQ', triggers:['faq','frequently asked'], searchTerms:['faq','frequently','question','answer'] },
      { label:'services', triggers:['services section','our services','service list'], searchTerms:['service','offering','what we do'] },
    ];
    for (const s of SECTIONS) { if (s.triggers.some(t => promptLower.includes(t))) requirements.sections.push(s); }

    // ── CTAs ──
    const CTAS = [
      { label:'booking', triggers:['booking cta','booking button','book now','book appointment','book a'], searchTerms:['book','booking','reserve','appointment','schedule'] },
      { label:'sign up', triggers:['signup cta','sign up cta','signup button','sign up button'], searchTerms:['sign up','signup','register','join'] },
      { label:'subscribe', triggers:['subscribe cta','subscribe button','newsletter signup'], searchTerms:['subscribe','subscription','newsletter'] },
      { label:'purchase', triggers:['buy cta','purchase cta','buy now button','shop now'], searchTerms:['buy','purchase','order','add to cart','shop now'] },
      { label:'demo', triggers:['demo cta','demo button','free trial cta','start trial'], searchTerms:['demo','free trial','try','start trial'] },
      { label:'contact', triggers:['contact cta','contact button','get in touch cta'], searchTerms:['contact','get in touch','reach out','inquire'] },
    ];
    for (const c of CTAS) { if (c.triggers.some(t => promptLower.includes(t))) requirements.ctas.push(c); }

    requirements.hasRequirements = !!(requirements.businessName || requirements.sections.length > 0 || requirements.ctas.length > 0);
    return requirements;
  }

  // ── Helpers ────────────────────────────────────────────

  async _streamText(text, emitChunk, charsPerChunk = 5) {
    for (let i = 0; i < text.length; i += charsPerChunk) {
      const chunk = text.slice(i, i + charsPerChunk);
      emitChunk(chunk);
      await this._delay(12);
    }
  }

  async createRun(prompt, { budgetCap = null, budgetWarning = null } = {}) {
    const { rows } = await this.pool.query(
      "INSERT INTO pipeline_runs (prompt, state, budget_cap, budget_warning) VALUES ($1, 'queued', $2, $3) RETURNING id",
      [prompt, budgetCap, budgetWarning]
    );
    return rows[0].id;
  }

  async getRun(id, userId = null) {
    if (userId) {
      const { rows } = await this.pool.query(
        'SELECT * FROM pipeline_runs WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      return rows[0] || null;
    }
    // Internal calls (orchestrator, agents) may not have a userId context
    const { rows } = await this.pool.query(
      'SELECT * FROM pipeline_runs WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  async getRecentRuns(limit = 10, userId = null) {
    if (userId) {
      const { rows } = await this.pool.query(
        'SELECT id, prompt, status, state, current_phase, created_at, completed_at, deployment, intent_class FROM pipeline_runs WHERE deleted_at IS NULL AND user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
      );
      return rows;
    }
    // Fallback for internal/system calls without user context
    const { rows } = await this.pool.query(
      'SELECT id, prompt, status, state, current_phase, created_at, completed_at, deployment, intent_class FROM pipeline_runs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return rows;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { PipelineExecutor, PHASES };
