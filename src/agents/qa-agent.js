/**
 * QA Agent
 *
 * Owns the VERIFY stage of the pipeline.
 *
 * Responsibilities:
 *   - Runs automated checks: lint, build, tests, sanity validation
 *   - Produces verification report with pass/fail per check
 *   - Can flag issues back to pipeline state for retry via flagIssue()
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { checks[], passed: boolean, errors[], warnings[] }
 *
 * Communication: Reads plan + code from previousOutputs (pipeline state).
 * Issues can be flagged via agent.flagIssue(runId, issue) — stored in memory
 * and queryable by the orchestrator / ops agent.
 * No direct calls to other agents.
 */

const { validateCodeAgainstContract } = require('../phases/intent-gate');
const { validateConstraintsAgainstSchema } = require('../lib/scaffold-schemas');
const { auditExpansions } = require('../lib/soft-expansion');
const { classifyDbEvidence } = require('../lib/db-evidence-classifier');
const { callMcpTool, isMcpAvailable } = require('../mcp/pipeline-mcp-bridge');
const serena = require('../lib/serena-pipeline');

class QAAgent {
  /**
   * @param {import('pg').Pool} [pool] - Optional PostgreSQL pool for ACL violation logging
   */
  constructor(pool = null) {
    this.stages = ['verify'];
    this._pool = pool; // ACL Phase 1: used for constraint_violations inserts
    // In-memory issue tracker: runId → issue[]
    // Ops agent can query this to decide on escalation
    this._issues = new Map();
  }

  /**
   * Execute the VERIFY stage.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - Must be 'verify'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, scaffold, code, save }
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   * @returns {object} { checks[], passed, errors[], warnings[] }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[QAAgent] Executing VERIFY for run ${runId.slice(0, 8)}...`);
    return this._runChecks(runId, prompt, previousOutputs, emitChunk);
  }

  // ── Core verification logic ──────────────────────────────

  async _runChecks(runId, prompt, artifacts, emitChunk) {
    const plan = artifacts.plan || {};
    const code = artifacts.code || {};
    const scaffold = artifacts.scaffold || {};

    const checks = [];
    const errors = [];
    const warnings = [];

    // ── Non-web detection: multi-layered (repo profile → contract → prompt) ──
    // WHY three layers: the repo scanner can silently fail (no token, API error,
    // null return), so relying only on _repoProfile left C#/WPF repos running
    // React checks. The intent gate and prompt keywords are fallback signals.
    const constraintContract = artifacts._constraintContract || null;
    const repoProfile = artifacts._repoProfile
      || (scaffold && scaffold._repoProfile)
      || (constraintContract && constraintContract._repoProfile)
      || null;
    const isNonWebByProfile = repoProfile && !repoProfile.isWebProject;
    const isNonWebByContract = constraintContract && (
      constraintContract._non_web === true
      || (constraintContract.constraints && constraintContract.constraints.frontend === false)
    );
    const isNonWebByPrompt = !isNonWebByProfile && !isNonWebByContract
      && /\b(c#|wpf|desktop|winforms|\.csproj|\.xaml|dotnet|avalonia|kotlin|swift|flutter|react[- ]native)\b/i.test(prompt || '');
    const isNonWebRepo = isNonWebByProfile || isNonWebByContract || isNonWebByPrompt;

    if (isNonWebRepo) {
      const lang = (repoProfile && repoProfile.language) || 'non-web';
      const detectedBy = isNonWebByProfile ? 'repo_profile' : isNonWebByContract ? 'constraint_contract' : 'prompt_keywords';
      console.log(`[QAAgent] Non-web project detected (${lang}, via ${detectedBy}) — skipping React checks`);

      // Non-web VERIFY: just confirm files were generated with correct extensions
      const hasFiles = code.files && typeof code.files === 'object' && Object.keys(code.files).length > 0;
      checks.push({ name: 'Code files generated', passed: hasFiles });
      if (!hasFiles) errors.push('No code files were generated');

      if (hasFiles) {
        const fileKeys = Object.keys(code.files);
        // Use profile artifacts if available, otherwise use generic web-only artifact list
        const WEB_ONLY_EXTS = ['.jsx', '.tsx', '.html', '.css', '.scss', '.sass', '.vue', '.svelte'];
        const allowed = new Set(repoProfile ? (repoProfile.allowedArtifacts || []) : []);
        const prohibited = new Set(repoProfile ? (repoProfile.prohibitedArtifacts || []) : WEB_ONLY_EXTS);

        const hasWebFiles = fileKeys.some(f => {
          const ext = '.' + f.split('.').pop();
          return prohibited.has(ext);
        });
        checks.push({ name: 'No web-only files in non-web project', passed: !hasWebFiles });
        if (hasWebFiles) {
          const offenders = fileKeys.filter(f => prohibited.has('.' + f.split('.').pop()));
          warnings.push(`Non-web repo has unexpected web files: ${offenders.join(', ')}`);
        }

        // Only check for language-specific files when we have a profile with allowed artifacts
        if (repoProfile && allowed.size > 0) {
          const hasLangFiles = fileKeys.some(f => {
            const ext = '.' + f.split('.').pop();
            return allowed.has(ext);
          });
          checks.push({ name: `Has ${lang} source files`, passed: hasLangFiles });
          if (!hasLangFiles) warnings.push(`No ${lang} source files found`);
        }
      }

      const passed = errors.length === 0;
      const report = { checks, passed, errors, warnings };
      if (emitChunk) emitChunk(`\n[VERIFY] Non-web project (${lang}): ${passed ? '✓ PASSED' : '✗ FAILED'} — ${checks.filter(c => c.passed).length}/${checks.length} checks\n`);
      return report;
    }

    // Check 1: Plan completeness
    const hasSubtasks = Array.isArray(plan.subtasks) && plan.subtasks.length > 0;
    checks.push({ name: 'Plan has subtasks', passed: hasSubtasks });
    if (!hasSubtasks) warnings.push('Plan has no subtasks defined');

    // Check 2: Scaffold defines files
    const hasTree = Array.isArray(scaffold.tree) && scaffold.tree.length > 0;
    checks.push({ name: 'Scaffold defines file tree', passed: hasTree });
    if (!hasTree) warnings.push('Scaffold has no file tree');

    // Check 3: Code files generated
    const hasFiles = code.files && typeof code.files === 'object' && Object.keys(code.files).length > 0;
    checks.push({ name: 'Code files generated', passed: hasFiles });
    if (!hasFiles) errors.push('No code files were generated');

    // Check 4: Entry point exists in generated files
    // For Vite React builds, the entry point is src/main.jsx (may not be set in code.entryPoint)
    const fileKeys = hasFiles ? Object.keys(code.files) : [];
    const hasViteEntry = fileKeys.includes('src/main.jsx');
    const entryPointExists = hasFiles && (
      (code.entryPoint && code.files[code.entryPoint]) ||
      hasViteEntry ||
      fileKeys.includes('index.html')
    );
    checks.push({ name: 'Entry point file exists', passed: !!entryPointExists });
    if (!entryPointExists) {
      warnings.push(`Entry point "${code.entryPoint || 'unknown'}" not found in generated files`);
    }

    // Intent-class-aware checks: skip backend checks for static_surface
    const intentClass = constraintContract ? constraintContract.intent_class : null;
    const isStaticSurface = intentClass === 'static_surface';
    const isLightApp = intentClass === 'light_app';
    const codeText = hasFiles ? Object.values(code.files).join('\n') : '';

    // ── React Build Checks (Vite + legacy CDN) ─────────────────────────────
    // Detects React builds by presence of src/App.jsx (Vite) or app.jsx (legacy CDN)
    // and runs JSX-specific checks. Vite builds use ES module imports; CDN builds
    // use Babel standalone with global React destructuring.
    const isViteReactBuild = hasFiles && (
      Object.keys(code.files).includes('src/App.jsx') ||
      Object.keys(code.files).includes('src/main.jsx') ||
      Object.keys(code.files).some(k => k === 'src/App.jsx' || k === 'src/main.jsx')
    );
    const isCdnReactBuild = hasFiles && !isViteReactBuild && (
      Object.keys(code.files).includes('app.jsx') ||
      Object.keys(code.files).some(k => k.endsWith('/app.jsx'))
    );
    const isReactBuild = isViteReactBuild || isCdnReactBuild;

    if (isReactBuild) {
      const appJsxKey = isViteReactBuild
        ? (Object.keys(code.files).find(k => k === 'src/App.jsx') || Object.keys(code.files).find(k => k === 'src/main.jsx'))
        : Object.keys(code.files).find(k => k === 'app.jsx' || k.endsWith('/app.jsx'));
      const appJsxContent = appJsxKey ? String(code.files[appJsxKey]) : '';

      // React Check A: Valid JSX syntax — component definitions and createRoot/export present
      const hasComponentDef = /function\s+[A-Z][A-Za-z]+\s*\(/.test(appJsxContent) ||
                              /const\s+[A-Z][A-Za-z]+\s*=\s*(\(|function|\()/.test(appJsxContent) ||
                              /class\s+[A-Z][A-Za-z]+\s+extends\s+React\.Component/.test(appJsxContent);
      const hasCreateRoot = appJsxContent.includes('createRoot') || appJsxContent.includes('ReactDOM.render');
      const hasExportDefault = /export\s+default\s/.test(appJsxContent);
      const hasEsImports = /import\s+.*\s+from\s+['"]react['"]/.test(appJsxContent) ||
                            /import\s+\{.*\}\s+from\s+['"]react['"]/.test(appJsxContent);
      const hasJsxSyntax = /<[A-Z][A-Za-z]/.test(appJsxContent) || /<div[\s>]/.test(appJsxContent) ||
                           /<section[\s>]/.test(appJsxContent) || /<span[\s>]/.test(appJsxContent);

      // Vite builds: component def + (export default OR JSX syntax)
      // CDN builds: component def + (createRoot OR JSX syntax)
      const jsxStructureOk = hasComponentDef && (hasCreateRoot || hasExportDefault || hasJsxSyntax);
      const componentCheckName = isViteReactBuild ? 'React: App.jsx has valid component structure' : 'React: app.jsx has valid component structure';
      checks.push({ name: componentCheckName, passed: jsxStructureOk });
      if (!jsxStructureOk) {
        warnings.push(
          hasComponentDef
            ? (isViteReactBuild
                ? 'React: App.jsx missing export default — component will not be importable'
                : 'React: app.jsx missing createRoot/ReactDOM.render — app may not mount')
            : `React: ${isViteReactBuild ? 'App.jsx' : 'app.jsx'} has no component definitions (function or const PascalCase)`
        );
      }

      // React Check A2: No vanilla DOM patterns bleeding into JSX
      // document.getElementById / innerHTML in JSX = app won't render correctly with React
      const hasVanillaDom = /document\.getElementById\s*\(/.test(appJsxContent) ||
                            /\.innerHTML\s*=/.test(appJsxContent) ||
                            /document\.querySelector\s*\(/.test(appJsxContent) ||
                            /document\.createElement\s*\(/.test(appJsxContent);
      // Only flag as error if combined with real JSX — pure vanilla script is caught by the non-React path
      const hasRealJsx = /return\s*\([\s\S]{0,20}</.test(appJsxContent) || /<[A-Z][A-Za-z]/.test(appJsxContent);
      const noVanillaDomBleed = !hasVanillaDom || !hasRealJsx;
      checks.push({ name: 'React: no vanilla DOM mutation inside JSX', passed: noVanillaDomBleed });
      if (!noVanillaDomBleed) {
        errors.push('React: document.getElementById/innerHTML found in JSX — app will not render correctly. React owns the DOM; vanilla DOM mutations cause rendering conflicts.');
      }

      // React Check A3: JSX syntax integrity — detect unclosed/malformed tags
      // Common LLM failure: unmatched angle brackets, template literals inside JSX attributes
      const jsxLines = appJsxContent.split('\n');
      let jsxSyntaxIssues = [];
      let returnBlockDepth = 0;
      let inReturnBlock = false;
      for (const line of jsxLines) {
        const trimmed = line.trim();
        // Detect template literals inside JSX attributes (very common LLM bug)
        // e.g., className={`text-${value}`} is fine, but className=`text-red` is not
        if (/\w+=`[^`]*`/.test(trimmed) && !trimmed.includes('{`')) {
          jsxSyntaxIssues.push('template literal used directly as JSX attribute value (missing curly brace wrapper)');
          break;
        }
        // Detect HTML style attribute instead of JSX style object
        // e.g., style="color:red" should be style={{color:'red'}}
        if (/style=["'][^"']+["']/.test(trimmed) && trimmed.includes('<') && !trimmed.startsWith('//')) {
          jsxSyntaxIssues.push('style attribute uses string instead of JSX object — will cause React error');
          break;
        }
      }
      const jsxSyntaxOk = jsxSyntaxIssues.length === 0;
      checks.push({ name: 'React: JSX syntax patterns valid', passed: jsxSyntaxOk });
      if (!jsxSyntaxOk) {
        warnings.push(`React: JSX syntax issues detected: ${jsxSyntaxIssues[0]}`);
      }

      // React Check B: Tailwind classes present — not empty className props
      const hasTailwindClasses = /className=["'][^"']*\b(flex|grid|p-|m-|bg-|text-|border|rounded|shadow|w-|h-)\b/.test(appJsxContent) ||
                                  /className=\{[^}]*\b(flex|grid|p-|m-|bg-|text-|border|rounded)\b/.test(appJsxContent) ||
                                  /className=\{`[^`]*(flex|grid|p-|m-|bg-|text-|border|rounded)/.test(appJsxContent);
      const hasClassNameAtAll = appJsxContent.includes('className=');
      const tailwindOk = hasTailwindClasses || (hasClassNameAtAll && appJsxContent.includes('cdn.tailwindcss.com'));
      checks.push({ name: 'React: Tailwind utility classes present', passed: tailwindOk || !hasClassNameAtAll });
      if (!tailwindOk && hasClassNameAtAll) {
        warnings.push('React: className props found but no Tailwind utility classes detected — UI may be unstyled');
      }

      // React Check C: Vite builds must NOT have CDN scripts; CDN builds must have them
      const indexHtmlKey = Object.keys(code.files).find(k => k === 'index.html');
      const indexHtmlContent = indexHtmlKey ? String(code.files[indexHtmlKey]) : '';
      const hasBabelOrReactCdn = indexHtmlContent.includes('babel') ||
                                  indexHtmlContent.includes('unpkg.com/react') ||
                                  indexHtmlContent.includes('cdn.jsdelivr.net/npm/react');

      if (isViteReactBuild) {
        // Vite builds: CDN scripts are an anti-pattern — they conflict with bundled imports
        const hasModuleScript = indexHtmlContent.includes('type="module"') || indexHtmlContent.includes("type='module'");
        const viteHtmlOk = !hasBabelOrReactCdn && (hasModuleScript || !indexHtmlKey);
        checks.push({ name: 'React: Vite HTML (no CDN scripts, module entry)', passed: viteHtmlOk });
        if (!viteHtmlOk) {
          if (hasBabelOrReactCdn) {
            warnings.push('React: index.html contains CDN scripts (Babel/React) — Vite builds must NOT use CDN; imports are bundled');
          } else if (!hasModuleScript && indexHtmlKey) {
            warnings.push('React: index.html missing <script type="module"> entry point — Vite app will not load');
          }
        }
      } else {
        // Legacy CDN builds: CDN scripts are required
        const cdnOk = hasBabelOrReactCdn || !indexHtmlKey;
        checks.push({ name: 'React: CDN loader (Babel + React) in index.html', passed: cdnOk });
        if (!cdnOk && indexHtmlKey) {
          warnings.push('React: index.html missing React CDN and/or Babel standalone — app will not render in browser');
        }
      }

      // React Check C2 (Vite only): Verify ES module imports instead of CDN globals
      if (isViteReactBuild) {
        const hasCdnGlobals = /const\s+\{[^}]*\}\s*=\s*React\b/.test(appJsxContent) ||
                               /ReactDOM\.createRoot/.test(appJsxContent) && !appJsxContent.includes("from 'react-dom");
        const hasEsModuleImports = hasEsImports || /import\s+.*from\s+['"]react-dom/.test(appJsxContent);
        const viteImportsOk = hasEsModuleImports && !hasCdnGlobals;
        checks.push({ name: 'React: ES module imports (no CDN globals)', passed: viteImportsOk });
        if (!viteImportsOk) {
          if (hasCdnGlobals) {
            warnings.push('React: Vite build uses CDN-style globals (const { useState } = React) — must use ES module imports (import { useState } from "react")');
          } else if (!hasEsModuleImports) {
            warnings.push('React: Vite build missing ES module imports from "react" — components will not work');
          }
        }
      }

      // React Check D: Responsive — Tailwind responsive prefixes used (sm:, md:, lg:)
      const hasResponsivePrefixes = /\b(sm:|md:|lg:|xl:|2xl:)/.test(appJsxContent);
      checks.push({ name: 'React: responsive breakpoints in JSX', passed: hasResponsivePrefixes });
      if (!hasResponsivePrefixes) {
        warnings.push('React: no Tailwind responsive prefixes (sm:/md:/lg:) found — layout may break on mobile');
      }

      // React Check E: useState hook present AND connected for interactive builds
      // Only for full_product / light_app — static pages don't need state
      const needsInteractivity = intentClass === 'full_product' || intentClass === 'light_app' || !intentClass;
      if (needsInteractivity) {
        const hasHooks = appJsxContent.includes('useState') || appJsxContent.includes('useReducer');
        const hasAnyHandlers = /onClick\s*=\s*\{/.test(appJsxContent) ||
                               /onChange\s*=\s*\{/.test(appJsxContent) ||
                               /onSubmit\s*=\s*\{/.test(appJsxContent);
        // Pass if hooks present OR if no interactive handlers at all (display-only app)
        const stateOk = hasHooks || !hasAnyHandlers;
        checks.push({ name: 'React: state management (hooks) present', passed: stateOk });
        if (!stateOk) {
          errors.push('React: interactive handlers (onClick/onChange) detected but no useState/useReducer — buttons will have no effect');
        }

        // React Check E2: useState setters must actually be called
        // Detects dead state: const [x, setX] = useState() where setX is never called.
        // WHY enhanced: The original regex only matched direct calls `setX(value)`.
        // It missed setters passed as callbacks: onChange={setName}, .then(setData),
        // or used in dependency arrays. This caused false positives on valid async code.
        if (hasHooks && appJsxContent.includes('useState')) {
          const stateDeclarations = [...appJsxContent.matchAll(/const\s+\[(\w+),\s*(\w+)\]\s*=\s*useState/g)];
          const deadSetters = stateDeclarations.filter(([, , setter]) => {
            // Count direct calls: setX(value)
            const directCalls = (appJsxContent.match(new RegExp(`\\b${setter}\\s*\\(`, 'g')) || []).length;
            if (directCalls > 0) return false;
            // Count any reference beyond the declaration: onChange={setX}, .then(setX), [setX]
            // The destructuring itself is 1 reference, so >1 total means it's used somewhere
            const allRefs = (appJsxContent.match(new RegExp(`\\b${setter}\\b`, 'g')) || []).length;
            return allRefs <= 1; // Only the declaration = truly dead
          });
          const hasDeadState = deadSetters.length > 0 && deadSetters.length >= stateDeclarations.length;
          // Only fail if ALL state setters are dead (not just some)
          checks.push({ name: 'React: useState setters are actually called', passed: !hasDeadState });
          if (hasDeadState) {
            const deadNames = deadSetters.map(([, , s]) => s).join(', ');
            warnings.push(`React: state setters [${deadNames}] declared but never called — state never updates, UI is static`);
          }
        }

        // React Check E3: JSX onClick handlers must call actual functions (not empty arrows)
        // Detects: onClick={() => {}} or onClick={() => null} — buttons that do nothing
        const emptyHandlers = (appJsxContent.match(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}/g) || []).length +
                              (appJsxContent.match(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*null\s*\}/g) || []).length +
                              (appJsxContent.match(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*undefined\s*\}/g) || []).length;
        const totalOnClicks = (appJsxContent.match(/onClick\s*=\s*\{/g) || []).length;
        // Fail if more than half of onClick handlers are empty
        const deadButtonsDetected = totalOnClicks > 0 && emptyHandlers > totalOnClicks * 0.5;
        checks.push({ name: 'React: onClick handlers have implementations', passed: !deadButtonsDetected });
        if (deadButtonsDetected) {
          errors.push(`React: ${emptyHandlers}/${totalOnClicks} onClick handlers are empty (() => {}) — buttons will do nothing when clicked`);
        }
      }

      // React Check F: No broken local imports (imports must reference files that exist)
      // Detects: import X from './components/Header' when Header.jsx isn't in code.files
      const importLines = appJsxContent.match(/import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g) || [];
      const allFileKeys = new Set(Object.keys(code.files));
      const brokenImports = [];
      for (const importLine of importLines) {
        const pathMatch = importLine.match(/from\s+['"](\.[^'"]+)['"]/);
        if (!pathMatch) continue;
        const importPath = pathMatch[1];
        // Try common extensions if no extension specified
        const extensions = importPath.includes('.') ? [''] : ['.js', '.jsx', '.ts', '.tsx', '.json'];
        const resolves = extensions.some(ext => {
          const candidate = importPath.replace(/^\.\//, '') + ext;
          return allFileKeys.has(candidate) || allFileKeys.has('src/' + candidate) || allFileKeys.has(importPath.slice(2) + ext);
        });
        // Flag unresolved relative imports (both ./ and ../ prefixes)
        // WHY parens: && binds tighter than ||. Without grouping, ../X always flags as broken.
        if ((importPath.startsWith('./') || importPath.startsWith('../')) && !resolves) {
          brokenImports.push(importPath);
        }
      }
      const hasNoBrokenImports = brokenImports.length === 0;
      checks.push({ name: 'React: local imports resolve to actual files', passed: hasNoBrokenImports });
      if (!hasNoBrokenImports) {
        errors.push(`React: broken imports detected — ${brokenImports.slice(0, 3).join(', ')} do not exist in generated files. App will crash on load.`);
      }

      // React Check G: No components return null or empty (implementation stubs)
      // Catches LLM pattern: function MyComponent() { return null; } or return <></>;
      const stubComponents = [];
      const componentDefs = appJsxContent.match(/function\s+([A-Z][A-Za-z]+)\s*\([^)]*\)\s*\{[\s\S]{0,500}?\}/g) || [];
      for (const def of componentDefs.slice(0, 15)) { // Check up to 15 components
        const bodyMatch = def.match(/\{([\s\S]+)\}$/);
        if (!bodyMatch) continue;
        const body = bodyMatch[1].trim();
        // Stub patterns: return null; return undefined; return <>; (empty fragment)
        if (/^return\s+(null|undefined|\(\s*\)|<>\s*<\/>)\s*;?\s*$/.test(body)) {
          const nameMatch = def.match(/function\s+([A-Z][A-Za-z]+)/);
          if (nameMatch) stubComponents.push(nameMatch[1]);
        }
      }
      // Only fail if the ROOT App component or main component is a stub
      const rootIsStub = stubComponents.some(name => name === 'App' || name === 'Root' || name === 'Main');
      checks.push({ name: 'React: root component renders content (not stub)', passed: !rootIsStub });
      if (rootIsStub) {
        errors.push(`React: root component (App/Root/Main) returns null or empty — nothing will render. Component is a stub.`);
      }

      const buildType = isViteReactBuild ? 'Vite' : 'CDN';
      console.log(`[QAAgent] React ${buildType} build detected — ran ${7 + (needsInteractivity ? 3 : 0)} JSX-specific checks (${appJsxKey}: ${appJsxContent.length}B)`);
    }

    // ── Check: package.json validity (for server builds with dependencies) ──────────────────
    // Validates that package.json is parseable, has a start script, and no obviously broken
    // dependency declarations (empty version strings, malformed semver).
    if (hasFiles) {
      const pkgJsonKey = Object.keys(code.files).find(k => k === 'package.json');
      if (pkgJsonKey) {
        const pkgJsonContent = String(code.files[pkgJsonKey]);
        let pkgJsonIssues = [];
        let parsedPkg = null;
        try {
          parsedPkg = JSON.parse(pkgJsonContent);
        } catch (e) {
          pkgJsonIssues.push('package.json is not valid JSON — npm install will fail');
        }

        if (parsedPkg) {
          // Must have a start script for Render/Express deployments
          const hasStartScript = parsedPkg.scripts && (parsedPkg.scripts.start || parsedPkg.scripts.serve);
          if (!hasStartScript) {
            pkgJsonIssues.push('package.json missing "start" script — app cannot be deployed');
          }

          // Detect placeholder/empty version strings in dependencies
          const allDeps = { ...(parsedPkg.dependencies || {}), ...(parsedPkg.devDependencies || {}) };
          const brokenDeps = Object.entries(allDeps).filter(([, v]) => {
            if (typeof v !== 'string') return true;
            // Empty version, placeholder version, or clearly invalid
            return v.trim() === '' || v === 'VERSION' || v === '*' || v.includes('[VERSION]') || v.includes('TODO');
          });
          if (brokenDeps.length > 0) {
            pkgJsonIssues.push(`package.json has ${brokenDeps.length} dependency with invalid version: ${brokenDeps.map(([k]) => k).slice(0, 3).join(', ')}`);
          }
        }

        const pkgJsonValid = pkgJsonIssues.length === 0;
        checks.push({ name: 'package.json valid with start script', passed: pkgJsonValid });
        if (!pkgJsonValid) {
          errors.push(`BUILD: ${pkgJsonIssues.join('; ')}`);
        }
      }
    }

    // Check 5: Database integration — 3-tier forensic certainty model.
    // Runs ONLY when constraints.db === true (full_product). Skips for:
    //   - static_surface (db=false)
    //   - light_app (db='maybe' — in-memory storage is valid)
    //   - soft_expansion (inherits base constraints; db is never strictly true)
    //   - no contract (unknown intent — can't assert DB requirement)
    // Previously used binary string matching ("CREATE TABLE" found → pass, else fail).
    // Replaced with 3-tier evidence scoring to prevent false failures when schema is
    // abstracted, split across files, or hidden in template literals.
    const dbRequired = constraintContract && constraintContract.constraints && constraintContract.constraints.db === true;
    if (dbRequired) {
      const dbEvidence = this._classifyDbEvidence(codeText, hasFiles ? code.files : {});
      const { finalDecision, tier, hardScore, probableScore, inferredScore } = dbEvidence;

      if (finalDecision === 'PASS') {
        checks.push({ name: 'Database integration present', passed: true, dbTier: tier });
      } else if (finalDecision === 'PASS_WITH_RISK') {
        // DB is clearly intended — engine imported, CRUD ops present — but schema is
        // abstracted or externalized. Pass with a warning so the run isn't blocked.
        checks.push({ name: 'Database integration present', passed: true, dbTier: tier });
        warnings.push(
          `DB_SCHEMA_ABSTRACTED: Database engine detected (probable score ${probableScore}) ` +
          `but no explicit schema definition found (hard score ${hardScore}). ` +
          `Schema may be in a migration file, ORM model, or external service.`
        );
      } else {
        // FAIL: only inferred signals or nothing at all.
        checks.push({ name: 'Database integration present', passed: false, dbTier: tier });
        if (inferredScore > 0 && hardScore === 0 && probableScore < 3) {
          warnings.push(
            `DB_INFERRED_ONLY: Weak signals suggest a database may be needed ` +
            `(inferred score ${inferredScore}) but no database engine or schema was detected.`
          );
        } else {
          warnings.push('No database integration detected in generated code');
        }
      }

      console.log(
        `[QAAgent] DB evidence: tier=${tier} decision=${finalDecision} ` +
        `hard=${hardScore} probable=${probableScore} inferred=${inferredScore}`
      );
    }

    // Check 6: Error handling present (skip when no server expected)
    const serverRequired = constraintContract && constraintContract.constraints && constraintContract.constraints.server === true;
    if (serverRequired || (!constraintContract && !isStaticSurface)) {
      const hasErrorHandling = codeText.includes('catch') || codeText.includes('status(4') || codeText.includes('status(5');
      checks.push({ name: 'Error handling present', passed: hasErrorHandling });
      if (!hasErrorHandling) warnings.push('No error handling patterns detected');
    }

    // Check 7: Express server present — only when contract requires server.
    // Skips for static_surface (server=false) and soft_expansion with static base.
    // Previously only skipped for static_surface, letting soft_expansion through.
    if (serverRequired) {
      const hasExpress = codeText.includes("require('express')") || codeText.includes('express()');
      checks.push({ name: 'Express.js server detected', passed: hasExpress });
      if (!hasExpress) warnings.push('Express.js not detected in generated code');
    }

    // Check 5a (static_surface only): Verify scaffold metadata matches schema
    if (isStaticSurface && scaffold.constraints) {
      const schemaCheck = validateConstraintsAgainstSchema(scaffold.constraints, intentClass);
      checks.push({ name: 'Scaffold metadata matches schema', passed: schemaCheck.valid });
      if (!schemaCheck.valid) {
        errors.push(`Schema mismatch: ${schemaCheck.violations.join('; ')}`);
      }
    }

    // Check 8: Content accuracy — only runs when product context was provided.
    // Verifies generated content references the actual product, not a hallucination.
    const productContext = artifacts._productContext || null;
    if (productContext) {
      // Parse key terms from the formatted context block
      const contextLines = productContext.split('\n');
      const companyLine = contextLines.find(l => l.startsWith('Company:'));
      const productLine = contextLines.find(l => l.startsWith('Product:'));
      const companyName = companyLine ? companyLine.replace('Company:', '').trim() : null;
      const productName = productLine ? productLine.replace('Product:', '').trim() : null;

      // Build list of expected terms (first significant word of each)
      const expectedTerms = [];
      if (companyName) expectedTerms.push(companyName.split(/\s+/)[0]);
      if (productName) expectedTerms.push(productName.split(/\s+/)[0]);

      const codeTextLower = codeText.toLowerCase();
      const matchedTerms = expectedTerms.filter(t => codeTextLower.includes(t.toLowerCase()));
      const contentIsAccurate = expectedTerms.length === 0 || matchedTerms.length > 0;

      checks.push({ name: 'Content matches product context', passed: contentIsAccurate });
      if (!contentIsAccurate) {
        warnings.push(
          `Generated content may not match the product context. ` +
          `Expected references to: ${expectedTerms.join(', ')}. ` +
          `Possible hallucination — check that copy, pricing, and features match the actual product.`
        );
      }
    }

    // ── Prompt-to-output content verification ──────────────────────────
    // Extracts explicit requirements from the original user prompt (business name,
    // requested sections, specific CTAs) and verifies they appear in the generated code.
    // This catches the critical gap where output is structurally valid but completely
    // ignores what the user actually asked for.
    const promptRequirements = this._extractPromptRequirements(prompt);
    if (promptRequirements && promptRequirements.hasRequirements) {
      const contentMismatches = [];
      const codeTextLower = codeText.toLowerCase();

      // Business/brand name must appear in the output
      if (promptRequirements.businessName) {
        const nameInOutput = codeTextLower.includes(promptRequirements.businessName.toLowerCase());
        if (!nameInOutput) {
          contentMismatches.push(`Business name "${promptRequirements.businessName}" not found in output`);
        }
      }

      // Explicitly requested sections must have matching content
      for (const section of promptRequirements.sections) {
        const sectionFound = section.searchTerms.some(term => codeTextLower.includes(term));
        if (!sectionFound) {
          contentMismatches.push(`Requested "${section.label}" section not found in output`);
        }
      }

      // Specific CTA requirements must be reflected (not generic "Get Started")
      for (const cta of promptRequirements.ctas) {
        const ctaFound = cta.searchTerms.some(term => codeTextLower.includes(term));
        if (!ctaFound) {
          contentMismatches.push(`Requested "${cta.label}" CTA not found — output may use generic CTA instead`);
        }
      }

      const contentPassed = contentMismatches.length === 0;
      checks.push({ name: 'Content matches user prompt', passed: contentPassed });
      if (!contentPassed) {
        const detail = contentMismatches.join('; ');
        errors.push(`Prompt-to-output content mismatch: ${detail}`);
        this.flagIssue(runId, {
          severity: 'error',
          message: `CONTENT_MISMATCH: ${detail}`,
          stage: 'verify',
          run_event: 'CONTENT_MISMATCH_DETECTED',
          requirements: promptRequirements,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ── Intent Gate compliance: domain keyword check ───────────────────────
    // Verifies that the generated output contains domain-specific keywords
    // from the user's original prompt. This catches the critical failure
    // where CODE generates a generic app that ignores the user's actual domain
    // (e.g., "photo sharing" prompt → generic name/description CRUD output).
    //
    // Only runs when prompt is substantive (> 10 words) and not a generic tool request.
    if (hasFiles && prompt && prompt.split(/\s+/).length > 10) {
      const DOMAIN_KEYWORD_GROUPS = [
        { label: 'photo sharing', keywords: ['photo', 'image', 'upload', 'gallery', 'instagram', 'sharing', 'picture', 'album', 'like', 'comment', 'follow', 'feed'], minMatch: 3 },
        { label: 'e-commerce', keywords: ['product', 'cart', 'checkout', 'shop', 'store', 'order', 'purchase', 'buy', 'payment', 'inventory', 'catalog', 'price'], minMatch: 3 },
        { label: 'social', keywords: ['post', 'feed', 'follow', 'like', 'comment', 'share', 'profile', 'timeline', 'notification', 'community', 'friend', 'message'], minMatch: 3 },
        { label: 'task management', keywords: ['task', 'todo', 'project', 'board', 'kanban', 'sprint', 'deadline', 'assign', 'status', 'milestone', 'backlog', 'complete'], minMatch: 3 },
        { label: 'fitness', keywords: ['workout', 'exercise', 'fitness', 'gym', 'routine', 'health', 'calories', 'training', 'muscle', 'cardio', 'weight', 'reps'], minMatch: 3 },
        { label: 'restaurant', keywords: ['restaurant', 'menu', 'food', 'reservation', 'dining', 'meal', 'recipe', 'table', 'delivery', 'cuisine', 'dish', 'order'], minMatch: 3 },
        { label: 'finance', keywords: ['budget', 'expense', 'income', 'transaction', 'account', 'balance', 'money', 'savings', 'invest', 'crypto', 'portfolio', 'payment'], minMatch: 3 },
        { label: 'travel', keywords: ['travel', 'trip', 'hotel', 'flight', 'booking', 'destination', 'itinerary', 'vacation', 'tour', 'accommodation', 'passport', 'guide'], minMatch: 2 },
        { label: 'education', keywords: ['course', 'lesson', 'student', 'teacher', 'quiz', 'learn', 'class', 'grade', 'enroll', 'assignment', 'lecture', 'school'], minMatch: 2 },
        { label: 'real estate', keywords: ['property', 'listing', 'real estate', 'rent', 'apartment', 'house', 'bedroom', 'location', 'agent', 'mortgage', 'lease', 'landlord'], minMatch: 2 },
      ];

      const promptLower = prompt.toLowerCase();

      // Find which domain groups the prompt matches
      const matchedGroups = DOMAIN_KEYWORD_GROUPS.filter(g =>
        g.keywords.filter(kw => promptLower.includes(kw)).length >= g.minMatch
      );

      if (matchedGroups.length > 0) {
        const codeTextLowerFull = codeText.toLowerCase();
        const missingDomainKeywords = [];

        for (const group of matchedGroups) {
          // Count how many domain keywords the prompt uses
          const promptKeywords = group.keywords.filter(kw => promptLower.includes(kw));
          // Require at least half of those keywords appear in generated code
          const requiredInCode = Math.max(2, Math.floor(promptKeywords.length * 0.5));
          const foundInCode = promptKeywords.filter(kw => codeTextLowerFull.includes(kw)).length;

          if (foundInCode < requiredInCode) {
            const missingKws = promptKeywords.filter(kw => !codeTextLowerFull.includes(kw));
            missingDomainKeywords.push(
              `${group.label}: missing domain keywords [${missingKws.slice(0, 5).join(', ')}] ` +
              `(found ${foundInCode}/${requiredInCode} required)`
            );
          }
        }

        const intentGatePassed = missingDomainKeywords.length === 0;
        checks.push({ name: 'Intent Gate compliance: domain keywords in output', passed: intentGatePassed });
        if (!intentGatePassed) {
          const msg = `INTENT_GATE_KEYWORD_MISS: Generated output is missing domain keywords from user prompt. ${missingDomainKeywords.join('; ')}`;
          errors.push(msg);
          this.flagIssue(runId, {
            severity: 'error',
            message: msg,
            stage: 'verify',
            run_event: 'INTENT_GATE_KEYWORD_MISS',
            missingDomainKeywords,
            timestamp: new Date().toISOString(),
          });
          console.log(`[QAAgent] Intent Gate keyword check FAILED: ${msg.slice(0, 200)}`);
        } else {
          console.log(`[QAAgent] Intent Gate keyword check passed — domain keywords present for: ${matchedGroups.map(g => g.label).join(', ')}`);
        }
      }
    }

    // Check: No obvious fake/placeholder content (runs always)
    const hasFakePlaceholders = codeText.includes('[PRODUCT_NAME]') ||
      codeText.includes('[COMPANY_NAME]') ||
      codeText.includes('[PRODUCT_DESCRIPTION]') ||
      codeText.includes('[FEATURE_');
    if (hasFakePlaceholders) {
      checks.push({ name: 'No unfilled placeholders in output', passed: false });
      warnings.push('Output contains unfilled placeholders ([PRODUCT_NAME], etc.) — product context was not provided');
    }

    // Check: Intent Gate constraint contract compliance
    // Ensures generated output respects the scope boundaries set at Step 0.
    // (constraintContract already extracted above for intent-class-aware checks)
    if (constraintContract) {
      try {
        // Layer 1: validateCodeAgainstContract (db/server/auth file checks)
        const contractCheck = validateCodeAgainstContract(code, constraintContract);
        const checkName = `Intent Gate compliance (${constraintContract.intent_class})`;
        checks.push({ name: checkName, passed: contractCheck.valid });

        if (!contractCheck.valid) {
          const violationSummary = `CONSTRAINT_VIOLATION_DETECTED: ${contractCheck.violations.join('; ')}`;
          errors.push(violationSummary);
          this.flagIssue(runId, {
            severity: 'error',
            message: violationSummary,
            stage: 'verify',
            run_event: 'CONSTRAINT_VIOLATION_DETECTED',
            intent_class: constraintContract.intent_class,
            violations: contractCheck.violations,
            timestamp: new Date().toISOString(),
          });
        }

        // Layer 2: Explicit prohibited_layers check against file paths
        if (constraintContract.prohibited_layers && constraintContract.prohibited_layers.length > 0 && hasFiles) {
          const fileKeys = Object.keys(code.files);
          const prohibitedViolations = [];

          for (const layer of constraintContract.prohibited_layers) {
            const layerLower = layer.toLowerCase();
            const violatingFiles = fileKeys.filter(f => {
              const fLower = f.toLowerCase();
              return fLower.includes(layerLower) || fLower.startsWith(layerLower + '/');
            });
            if (violatingFiles.length > 0) {
              prohibitedViolations.push(`prohibited layer "${layer}": ${violatingFiles.join(', ')}`);
            }
          }

          const prohibitedPassed = prohibitedViolations.length === 0;
          checks.push({ name: 'No files in prohibited layers', passed: prohibitedPassed });
          if (!prohibitedPassed) {
            const msg = `Files exist in prohibited layers: ${prohibitedViolations.join('; ')}`;
            errors.push(msg);
            this.flagIssue(runId, {
              severity: 'error',
              message: msg,
              stage: 'verify',
              run_event: 'CONSTRAINT_VIOLATION_DETECTED',
              intent_class: constraintContract.intent_class,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Layer 3: allowed_artifacts check — all generated files should match allowed types
        // WHY scaffold-aware: The intent gate's allowed_artifacts are generic
        // (e.g., ['html', 'css', 'js', 'server.js', 'package.json']) and don't
        // account for Vite React builds that generate .jsx/.tsx files, vite.config.js,
        // tailwind.config.js, etc. The scaffold manifest defines the ACTUAL expected
        // file tree. Files that appear in the scaffold manifest are always allowed.
        if (constraintContract.allowed_artifacts && constraintContract.allowed_artifacts.length > 0 && hasFiles) {
          const fileKeys = Object.keys(code.files);
          const allowedExts = new Set(constraintContract.allowed_artifacts.map(a => {
            // Normalize: 'html' → '.html', 'server.js' → 'server.js'
            return a.includes('.') ? a : '.' + a;
          }));
          const allowedNames = new Set(constraintContract.allowed_artifacts.filter(a => a.includes('.')));

          // Include scaffold-defined files as allowed — the scaffold IS the contract
          const scaffoldFiles = new Set();
          if (Array.isArray(scaffold.tree)) {
            for (const item of scaffold.tree) {
              if (item && item.path) scaffoldFiles.add(item.path);
            }
          }
          // Also include planned_files from the plan as allowed
          if (plan && Array.isArray(plan.planned_files)) {
            for (const f of plan.planned_files) {
              if (typeof f === 'string') scaffoldFiles.add(f);
              else if (f && f.path) scaffoldFiles.add(f.path);
            }
          }

          // For React/Vite builds, .jsx and .tsx are equivalent to .js
          // WHY: The intent gate lists 'js' but the build pipeline generates .jsx
          if (isReactBuild || isViteReactBuild) {
            allowedExts.add('.jsx');
            allowedExts.add('.tsx');
          }

          const disallowedFiles = fileKeys.filter(f => {
            // Check against scaffold manifest first — scaffold-defined files are always OK
            if (scaffoldFiles.has(f)) return false;
            // Check by name match
            if (allowedNames.has(f)) return false;
            // Check by extension
            const ext = '.' + f.split('.').pop();
            if (allowedExts.has(ext)) return false;
            // Check by path prefix (e.g., 'routes' matches 'routes/api.js')
            for (const allowed of constraintContract.allowed_artifacts) {
              if (f.startsWith(allowed + '/') || f === allowed) return false;
            }
            // Common build config files are always allowed
            const configFiles = ['vite.config.js', 'tailwind.config.js', 'postcss.config.js',
                                  'tsconfig.json', '.env.example', '.gitignore', 'src/index.css'];
            if (configFiles.includes(f)) return false;
            // Files under src/ are allowed for Vite builds
            if ((isReactBuild || isViteReactBuild) && f.startsWith('src/')) return false;
            return true;
          });

          const artifactsPassed = disallowedFiles.length === 0;
          checks.push({ name: 'All files within allowed artifacts', passed: artifactsPassed });
          if (!artifactsPassed) {
            const msg = `Files outside allowed artifacts (${constraintContract.allowed_artifacts.join(', ')}): ${disallowedFiles.join(', ')}`;
            warnings.push(msg);
          }
        }
        // ACL Phase 1: Detect violations and persist to constraint_violations table.
        // Violations are informational — they do NOT cause the run to fail.
        // The enforcement checks above already prevent prohibited files from reaching deploy.
        // Here we log what the system caught (over_scoped) or where it may have been
        // too restrictive (under_scoped) so ACL Phase 2 can learn from the patterns.
        if (this._pool) {
          await this._logAclViolations(runId, code, constraintContract);
        }

        // ── Phase 4: Expansion Audit ──────────────────────────────────────────
        // For soft_expansion contracts, audit whether expansions were actually used.
        // Violations:
        //   unnecessary_expansion (0.6)  — expansion justified but not used in code
        //   expansion_scope_exceeded (0.9) — expansion used beyond stated scope
        // Both violation types are fed to Phase 2 learning (weights update).
        if (constraintContract.intent_class === 'soft_expansion') {
          await this._auditSoftExpansions(runId, plan, code, constraintContract, checks);
        }

      } catch (contractErr) {
        // Non-fatal — constraint check error shouldn't block verify
        console.warn('[QAAgent] Constraint check error (non-fatal):', contractErr.message);
      }
    }

    // ── Check: Interactive elements are wired ──────────────────────────────
    // For vanilla JS builds: count HTML buttons/forms vs addEventListener counts.
    // For React JSX builds: count JSX <button> and <input> elements vs onClick/onChange props.
    // This catches the #1 product-killing bug: beautiful UI with zero interactivity.
    if (hasFiles) {
      if (isReactBuild) {
        // ── React JSX interactivity check ──────────────────────────────────
        // In React, all wiring lives in JSX via onClick={fn}, onChange={fn}, onSubmit={fn}
        // We check that interactive JSX elements have corresponding event props
        const appJsxKeyInteractivity = isViteReactBuild
          ? (Object.keys(code.files).find(k => k === 'src/App.jsx') || Object.keys(code.files).find(k => k === 'src/main.jsx'))
          : Object.keys(code.files).find(k => k === 'app.jsx' || k.endsWith('/app.jsx'));
        const jsxContent = appJsxKeyInteractivity ? String(code.files[appJsxKeyInteractivity]) : codeText;

        // Count JSX interactive elements: <button, <input, <select, <textarea, <a (nav)
        const jsxButtons = (jsxContent.match(/<button[\s>]/g) || []).length;
        const jsxInputs = (jsxContent.match(/<input[\s>]/g) || []).length;
        const jsxSelects = (jsxContent.match(/<select[\s>]/g) || []).length;
        const jsxForms = (jsxContent.match(/<form[\s>]/g) || []).length;
        const jsxInteractiveTotal = jsxButtons + jsxInputs + jsxSelects + jsxForms;

        // Count JSX event props (actual wiring)
        const jsxOnClicks = (jsxContent.match(/onClick\s*=\s*\{/g) || []).length;
        const jsxOnChanges = (jsxContent.match(/onChange\s*=\s*\{/g) || []).length;
        const jsxOnSubmits = (jsxContent.match(/onSubmit\s*=\s*\{/g) || []).length;
        const jsxOnKeyDowns = (jsxContent.match(/onKeyDown\s*=\s*\{/g) || []).length;
        const jsxHandlerTotal = jsxOnClicks + jsxOnChanges + jsxOnSubmits + jsxOnKeyDowns;

        // fetch() and state setters are additional wiring signals
        const fetchSignals = Math.min((jsxContent.match(/fetch\s*\(/g) || []).length, 5);
        const axiosSignals = Math.min((jsxContent.match(/axios\./g) || []).length, 3);
        const totalWiring = jsxHandlerTotal + fetchSignals + axiosSignals;

        if (jsxInteractiveTotal > 0) {
          const ratio = totalWiring / jsxInteractiveTotal;
          const reactInteractivityPassed = ratio >= 0.4 || (jsxHandlerTotal >= 1 && jsxInteractiveTotal <= 3);

          checks.push({
            name: 'React: interactive JSX elements are wired (onClick/onChange)',
            passed: reactInteractivityPassed
          });

          if (!reactInteractivityPassed) {
            const msg = `DEAD_BUTTONS_DETECTED: Found ${jsxInteractiveTotal} interactive JSX elements (<button>/${jsxInputs} inputs/${jsxForms} forms) but only ${jsxHandlerTotal} event handlers (onClick/onChange/onSubmit). Most interactive elements have no wired behavior.`;
            warnings.push(msg);
            this.flagIssue(runId, {
              severity: 'warning',
              message: msg,
              stage: 'verify',
              run_event: 'DEAD_BUTTONS_DETECTED',
              interactiveElements: jsxInteractiveTotal,
              eventHandlers: jsxHandlerTotal,
              ratio: Math.round(ratio * 100) + '%',
              timestamp: new Date().toISOString(),
            });
          }
        }
      } else {
        // ── Vanilla HTML/JS interactivity check ────────────────────────────
        const htmlFiles = Object.entries(code.files).filter(([f]) => f.endsWith('.html'));
        const jsFiles = Object.entries(code.files).filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/') && !f.includes('migrate') && !f.includes('package'));

        let interactiveElementCount = 0;
        let eventHandlerCount = 0;

        // Count interactive elements in HTML
        for (const [, content] of htmlFiles) {
          const buttonMatches = content.match(/<button[\s>]/gi) || [];
          interactiveElementCount += buttonMatches.length;

          const formMatches = content.match(/<form[\s>]/gi) || [];
          interactiveElementCount += formMatches.length;

          const navLinkMatches = content.match(/<a\s[^>]*href=["']#/gi) || [];
          interactiveElementCount += navLinkMatches.length;

          const onclickMatches = content.match(/onclick=/gi) || [];
          eventHandlerCount += onclickMatches.length;
        }

        // Count event listeners in JS files
        for (const [, content] of jsFiles) {
          const addEventMatches = content.match(/addEventListener\s*\(/gi) || [];
          eventHandlerCount += addEventMatches.length;

          const onclickAssignMatches = content.match(/\.onclick\s*=/gi) || [];
          eventHandlerCount += onclickAssignMatches.length;

          const jqClickMatches = content.match(/\.on\s*\(['"]click/gi) || [];
          eventHandlerCount += jqClickMatches.length;
          const jqSubmitMatches = content.match(/\.on\s*\(['"]submit/gi) || [];
          eventHandlerCount += jqSubmitMatches.length;

          const fetchMatches = content.match(/fetch\s*\(/gi) || [];
          eventHandlerCount += Math.min(fetchMatches.length, 3);
        }

        if (interactiveElementCount > 0) {
          const ratio = eventHandlerCount / interactiveElementCount;
          const interactivityPassed = ratio >= 0.5;

          checks.push({
            name: 'Interactive elements are wired',
            passed: interactivityPassed
          });

          if (!interactivityPassed) {
            const msg = `DEAD_BUTTONS_DETECTED: Found ${interactiveElementCount} interactive elements (buttons, forms, nav) but only ${eventHandlerCount} event handlers in JS. ${Math.round((1 - ratio) * 100)}% of interactive elements have no wired behavior.`;
            warnings.push(msg);
            this.flagIssue(runId, {
              severity: 'warning',
              message: msg,
              stage: 'verify',
              run_event: 'DEAD_BUTTONS_DETECTED',
              interactiveElements: interactiveElementCount,
              eventHandlers: eventHandlerCount,
              ratio: Math.round(ratio * 100) + '%',
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }

    // ── Check: Interaction contract fulfilled ──────────────────────────────
    // If SCAFFOLD produced an interaction_contract, verify CODE implements every item.
    // Polymorphic: checks interactions[], routing[], and forms[] based on what the contract has.
    // Non-static builds without any contract items skip this check (nothing to verify).
    const interactionContract = scaffold.interaction_contract;
    if (interactionContract && interactionContract.intent_class !== 'static_surface' && hasFiles) {
      const { interactions = [], routing = [], forms = [] } = interactionContract;
      const totalContractItems = interactions.length + routing.length + forms.length;

      if (totalContractItems > 0) {
        const allCodeLower = Object.values(code.files).join('\n').toLowerCase();
        const htmlContent  = Object.entries(code.files).filter(([f]) => f.endsWith('.html')).map(([, c]) => c).join('\n').toLowerCase();
        const jsContent    = Object.entries(code.files).filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/')).map(([, c]) => c).join('\n').toLowerCase();
        const serverContent = Object.entries(code.files).filter(([f]) => f.includes('server') || f.includes('routes/')).map(([, c]) => c).join('\n').toLowerCase();

        let fulfilledItems = 0;

        // Check interactions: need an addEventListener/handler AND some keyword match
        // Also check for CONTRACT: markers as direct evidence of implementation.
        const hasHandlers = jsContent.includes('addeventlistener') || jsContent.includes('.onclick') || jsContent.includes('onclick=') || htmlContent.includes('onclick=');
        for (const ix of interactions) {
          // Strategy 1: CONTRACT marker in code (most reliable — CODE phase tags these)
          const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          if (allCodeLower.includes('contract:') && allCodeLower.includes(contractId)) {
            fulfilledItems++;
            continue;
          }

          // Strategy 2: keyword matching (original approach, enhanced)
          const stopWords = new Set(['button', 'input', 'form', 'the', 'and', 'or', 'a', 'an', 'primary', 'per', 'each', 'all', 'every', 'any']);
          const elementKeywords = ix.element.toLowerCase().split(/[\s\/,\(\)]+/).filter(w => w.length > 3 && !stopWords.has(w));
          const behaviorKeywords = ix.behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4 && !stopWords.has(w)).slice(0, 5);

          // Also extract state variable names as keywords (strong signal of implementation)
          const stateKeywords = Array.isArray(ix.state) ? ix.state.map(s => s.toLowerCase()).filter(s => s.length > 3) : [];

          const combinedKeywords = [...elementKeywords, ...behaviorKeywords, ...stateKeywords];
          const keywordHit = combinedKeywords.some(kw => allCodeLower.includes(kw));

          if (hasHandlers && keywordHit) {
            fulfilledItems++;
          } else if (hasHandlers && interactions.length === 1) {
            // Single interaction: if handlers exist and JS is non-trivial, count it
            fulfilledItems += jsContent.split('addeventlistener').length > 2 ? 1 : 0;
          }
        }

        // Check routing: paths or their semantic equivalents must appear in code.
        // Routing contracts may use ISE-derived view paths (/sign-up, /dashboard)
        // while CODE generates API routes (/api/auth/signup, /api/tasks).
        // We check: (1) exact path in server code, (2) path segments in all code,
        // (3) component/behavior keywords in all code, (4) CONTRACT markers.
        for (const route of routing) {
          const basePath = route.path.replace('/:id', '').replace(/\/$/, '');
          let routeFulfilled = false;

          // Strategy 1: exact path in server code (original check)
          if (basePath && serverContent.includes(basePath.toLowerCase())) {
            routeFulfilled = true;
          } else if (basePath === '' || basePath === '/') {
            if (serverContent.includes('app.get') || serverContent.includes('router.get')) routeFulfilled = true;
          }

          // Strategy 2: path segments as keywords in ALL code (catches /sign-up → "signup" in server, "sign" in frontend)
          if (!routeFulfilled && basePath) {
            const pathSegments = basePath.replace(/^\//, '').split('-').filter(s => s.length > 2);
            // Also try joined form: /sign-up → "signup"
            const joinedPath = pathSegments.join('');
            const pathKeywords = [...pathSegments, joinedPath].filter(k => k.length > 2);
            routeFulfilled = pathKeywords.some(kw => allCodeLower.includes(kw));
          }

          // Strategy 3: component name or behavior keywords in all code
          if (!routeFulfilled && route.component) {
            const componentLower = route.component.toLowerCase().replace(/\s+/g, '');
            const componentWords = route.component.toLowerCase().split(/[\s-]+/).filter(w => w.length > 3);
            routeFulfilled = allCodeLower.includes(componentLower) ||
              componentWords.some(w => allCodeLower.includes(w));
          }

          // Strategy 4: CONTRACT marker in code
          if (!routeFulfilled) {
            const markerPath = basePath || '/';
            routeFulfilled = allCodeLower.includes(`contract:`) && allCodeLower.includes(markerPath.toLowerCase().replace(/[^a-z0-9]/g, ''));
          }

          if (routeFulfilled) fulfilledItems++;
        }

        // Check forms: form IDs, field names, or CONTRACT markers must appear in code
        for (const f of forms) {
          // Strategy 1: CONTRACT marker
          const formContractId = f.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (allCodeLower.includes('contract:') && allCodeLower.includes(formContractId)) {
            fulfilledItems++;
            continue;
          }

          // Strategy 2: keyword matching in HTML + JS (enhanced)
          const formIdParts = f.id.replace(/-/g, ' ').split(' ').filter(p => p.length > 3);
          const fieldKeywords = Array.isArray(f.fields) ? f.fields.flatMap(fld => fld.split(/[\s,]+/)).filter(w => w.length > 3) : [];
          // Also check submit_behavior for action keywords (POST, fetch, validate, etc.)
          const behaviorKeywords = f.submit_behavior ? f.submit_behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4).slice(0, 3) : [];
          const allFormKeywords = [...formIdParts, ...fieldKeywords, ...behaviorKeywords];

          const formHit = allFormKeywords.some(kw => htmlContent.includes(kw.toLowerCase()) || allCodeLower.includes(kw.toLowerCase()));
          const hasFormHandler = jsContent.includes('submit') || jsContent.includes('preventdefault') || allCodeLower.includes('onsubmit');
          if (formHit && hasFormHandler) fulfilledItems++;
        }

        const ratio = fulfilledItems / totalContractItems;
        const contractPassed = ratio >= 0.5; // ≥50% fulfilled

        checks.push({
          name: 'Interaction contract fulfilled',
          passed: contractPassed,
        });

        if (!contractPassed) {
          const msg = `INTERACTION_CONTRACT_UNFULFILLED: ${fulfilledItems}/${totalContractItems} contract items implemented (${Math.round(ratio * 100)}%). Listed interactions, routes, or forms may be missing or unimplemented.`;
          warnings.push(msg);
          this.flagIssue(runId, {
            severity: 'warning',
            message: msg,
            stage: 'verify',
            run_event: 'INTERACTION_CONTRACT_UNFULFILLED',
            contractItems: totalContractItems,
            fulfilledItems,
            ratio: Math.round(ratio * 100) + '%',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Stream results
    emitChunk('## Verification Results\n\n');
    await this._delay(400);

    for (const check of checks) {
      const icon = check.passed ? '\u2713' : '\u2717';
      emitChunk(`${icon} ${check.name}\n`);
      await this._delay(350);
    }

    const passedCount = checks.filter(c => c.passed).length;
    const total = checks.length;
    // passed = ≥75% of checks green. Below 75% triggers VERIFY→CODE retry in orchestrator.
    // This prevents a single non-critical check failure from blocking an otherwise good build.
    const PASS_THRESHOLD = 0.75;
    const passRate = total === 0 ? 1 : passedCount / total;
    const passed = passRate >= PASS_THRESHOLD;

    await this._delay(300);
    if (passed && passedCount === total) {
      emitChunk(`\n**Result: ALL CHECKS PASSED** \u2014 ${passedCount}/${total} checks passed.`);
    } else if (passed) {
      emitChunk(`\n**Result: PASSED (${Math.round(passRate * 100)}%)** \u2014 ${passedCount}/${total} checks passed. Minor issues noted but build is viable.`);
    } else if (passedCount === 0) {
      emitChunk(`\n**Result: FAILED** \u2014 0/${total} checks passed.`);
    } else {
      emitChunk(`\n**Result: PARTIAL \u2014 ${passedCount}/${total} checks passed (${Math.round(passRate * 100)}% — below 75% threshold).** VERIFY→CODE retry triggered.`);
    }

    if (warnings.length > 0) {
      emitChunk(`\n**Warnings:** ${warnings.join(', ')}`);
    }
    if (errors.length > 0) {
      emitChunk(`\n**Errors:** ${errors.join(', ')}`);
    }
    emitChunk('\n');

    // Flag any errors as issues in the issue tracker
    if (errors.length > 0) {
      for (const err of errors) {
        this.flagIssue(runId, { severity: 'error', message: err, stage: 'verify', timestamp: new Date().toISOString() });
      }
    }

    // ── MCP VERIFY checks (additive — never block passing builds) ─────────────
    // If MCP is available and code references a database, verify the schema
    // contains the tables the generated code expects. Informational only.
    if (isMcpAvailable(artifacts)) {
      try {
        const dbCheckCode = hasFiles ? Object.values(code.files || {}).join('\n') : '';
        const mentionsDb = /\b(pool\.query|db\.query|knex|sequelize|prisma|INSERT INTO|SELECT.*FROM|CREATE TABLE)\b/i.test(dbCheckCode);
        if (mentionsDb) {
          const schemaResult = await callMcpTool(artifacts, 'postgres.list_tables', {}, { phase: 'verify' });
          if (schemaResult) {
            checks.push({ name: 'MCP: database schema accessible', passed: true });
          }
        }
      } catch (_) { /* non-fatal — MCP verify checks must never block */ }
    }

    // ── Serena Structural Diagnostics (additive — never blocks passing builds) ──
    // Run Serena's structural analysis on the source repo (if provided) to catch
    // issues that weren't visible from just the generated code artifacts.
    // Also validates generated JS files for unbalanced braces and duplicate imports.
    const sourceRepoRoot = artifacts._sourceRepoLocalPath || null;
    if (sourceRepoRoot || hasFiles) {
      try {
        // Validate the source repo structure if present
        if (sourceRepoRoot) {
          const { passed: structPassed, text: structText } = await serena.checkDiagnostics(sourceRepoRoot, false);
          if (structText) {
            checks.push({
              name: 'Serena: source codebase structural integrity',
              passed: structPassed,
              category: 'serena',
              detail: structText.slice(0, 500),
            });
            if (!structPassed) {
              warnings.push(`Serena detected structural issues in source repo: ${structText.slice(0, 200)}`);
            }
          }
        }

        // Validate generated JS/TS artifacts for obvious syntax issues
        if (hasFiles) {
          const jsFiles = Object.entries(code.files || {})
            .filter(([f]) => /\.[jt]sx?$/.test(f));
          let serenaErrors = 0;
          for (const [fileName, content] of jsFiles.slice(0, 5)) {
            // Heuristic: unbalanced braces in generated file
            const braceBalance = (content.match(/\{/g) || []).length - (content.match(/\}/g) || []).length;
            if (Math.abs(braceBalance) > 2) {
              serenaErrors++;
            }
          }
          const genStructOk = serenaErrors === 0;
          checks.push({
            name: 'Serena: generated code structural integrity',
            passed: genStructOk,
            category: 'serena',
          });
          if (!genStructOk) {
            warnings.push(`Serena detected brace-balance issues in ${serenaErrors} generated file(s) — may indicate truncated generation`);
          }
        }
      } catch (_) { /* non-fatal — Serena verify checks must never block */ }
    }

    return { checks, passed, errors, warnings };
  }

  // ── Issue tracking ───────────────────────────────────────

  /**
   * Flag an issue back to pipeline state.
   * Stored in memory — queryable by ops agent for escalation decisions.
   *
   * @param {string} runId  - Pipeline run UUID
   * @param {object} issue  - { severity, message, stage, timestamp }
   */
  flagIssue(runId, issue) {
    const issues = this._issues.get(runId) || [];
    issues.push(issue);
    this._issues.set(runId, issues);
    console.log(`[QAAgent] Issue flagged for ${runId.slice(0, 8)}...: [${issue.severity}] ${issue.message}`);
  }

  /**
   * Get all issues flagged for a run.
   *
   * @param {string} runId
   * @returns {object[]}
   */
  getIssues(runId) {
    return this._issues.get(runId) || [];
  }

  /**
   * Clear issues for a run (called on successful retry).
   */
  clearIssues(runId) {
    this._issues.delete(runId);
  }

  // ── ACL Phase 1: Violation Logging ───────────────────────

  /**
   * Detect constraint violations from generated artifacts and persist to DB.
   *
   * Violations are INFORMATIONAL — they never fail the run.
   * The enforcement layer (orchestrator scaffold/code gates, VERIFY contract checks)
   * already prevents prohibited artifacts from shipping. This method captures what
   * the enforcement layer caught so ACL Phase 2 can learn from patterns.
   *
   * Violation types:
   *   over_scoped  — output includes something the contract prohibits
   *   under_scoped — output is missing something that would have benefited the task
   *                  (detected only for full_product where all layers are expected)
   *
   * @param {string} runId           - Pipeline run UUID
   * @param {object} code            - CODE stage output ({ files: { [path]: content } })
   * @param {object} contract        - Constraint Contract from Intent Gate
   */
  async _logAclViolations(runId, code, contract) {
    if (!contract || contract.intent_class === 'full_product') {
      // full_product has no prohibited layers — nothing to flag as over_scoped.
      // under_scoped for full_product would require semantic analysis; skip for Phase 1.
      return;
    }

    const fileKeys = Object.keys((code && code.files) ? code.files : {});
    const violations = [];

    // ── Over-scoped detection ──────────────────────────────────────────────
    // Check each constrained layer: if constraint says false but files exist → over_scoped

    // server layer
    if (contract.constraints.server === false) {
      const serverFiles = fileKeys.filter(f =>
        f === 'server.js' || f.startsWith('routes/') || f.startsWith('middleware/')
      );
      if (serverFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'server',
          severity: this._calcSeverity(serverFiles.length),
        });
      }
    }

    // db layer
    if (contract.constraints.db === false) {
      const dbFiles = fileKeys.filter(f =>
        f.includes('db/') || f.includes('migrations/') ||
        f === 'migrate.js' || f.endsWith('queries.js') || f.endsWith('pool.js')
      );
      if (dbFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'db',
          severity: this._calcSeverity(dbFiles.length),
        });
      }
    }

    // auth layer
    if (contract.constraints.auth === false) {
      const authFiles = fileKeys.filter(f =>
        f.toLowerCase().includes('auth') || f.includes('jwt') || f.includes('bcrypt')
      );
      if (authFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'auth',
          severity: this._calcSeverity(authFiles.length),
        });
      }
    }

    // api layer
    if (contract.constraints.api === false) {
      const apiFiles = fileKeys.filter(f =>
        f.startsWith('routes/') || f.startsWith('api/') ||
        f.includes('/api.js') || f.includes('/routes.js')
      );
      if (apiFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'api',
          severity: this._calcSeverity(apiFiles.length),
        });
      }
    }

    if (violations.length === 0) {
      // Clean run — no violations for this contract class
      return;
    }

    // Persist each violation (non-fatal — wrapped in try/catch)
    try {
      for (const v of violations) {
        await this._pool.query(
          `INSERT INTO constraint_violations (run_id, violation_type, violated_layer, severity)
           VALUES ($1, $2, $3, $4)`,
          [runId, v.violation_type, v.violated_layer, v.severity]
        );
        console.log(
          `[QAAgent] ACL violation logged: ${v.violation_type} | layer=${v.violated_layer} | severity=${v.severity} | run=${runId.slice(0, 8)}`
        );
      }
    } catch (dbErr) {
      // Non-fatal — ACL logging must never block the verify result
      console.warn('[QAAgent] ACL violation logging failed (non-fatal):', dbErr.message);
    }
  }

  /**
   * Compute severity (0–1) from the number of violating files.
   * 1–3 files → minor (0.3), 4–7 → moderate (0.6), 8+ → critical (0.9)
   *
   * @param {number} fileCount
   * @returns {number}
   */
  _calcSeverity(fileCount) {
    if (fileCount <= 3) return 0.3;
    if (fileCount <= 7) return 0.6;
    return 0.9;
  }

  // ── Phase 4: Soft Expansion Audit ────────────────────────

  /**
   * Audit soft expansion usage for a soft_expansion contract.
   *
   * Checks each authorized soft_expansion capability:
   *   - Used but not justified → should have been caught by SCAFFOLD (log only)
   *   - Justified but not used → unnecessary_expansion violation (severity 0.6)
   *   - Used beyond stated scope → expansion_scope_exceeded violation (severity 0.9)
   *
   * Violations are persisted to constraint_violations for Phase 2 learning.
   * Also logged as run events via flagIssue() for orchestrator observability.
   *
   * @param {string} runId
   * @param {object} plan              - PLAN stage output (may have expansion_justifications)
   * @param {object} code              - CODE stage output ({ files: {...} })
   * @param {object} contract          - Soft expansion constraint contract
   * @param {Array}  checks            - Mutated: expansion audit results added here
   */
  async _auditSoftExpansions(runId, plan, code, contract, checks) {
    try {
      const { audits, violations } = auditExpansions(plan, code, contract);

      if (audits.length === 0) return;  // No soft expansion capabilities to audit

      // Add audit results as VERIFY checks
      for (const audit of audits) {
        const { capability, justified, used, scopeExceeded } = audit;

        let checkName, passed;
        if (scopeExceeded) {
          checkName = `Adaptive capability "${capability}" within scope`;
          passed = false;
        } else if (justified && !used) {
          checkName = `Adaptive capability "${capability}" actually used`;
          passed = false;
        } else if (used && !justified) {
          // Should have been caught at SCAFFOLD — log as warning
          checkName = `Adaptive capability "${capability}" justified by PLAN`;
          passed = false;
        } else {
          // Clean path: either used+justified or not used+not justified
          checkName = `Adaptive capability "${capability}" (${used ? 'used + justified' : 'not needed'})`;
          passed = true;
        }
        checks.push({ name: checkName, passed });
      }

      // Persist violations to constraint_violations for Phase 2 learning
      if (violations.length > 0 && this._pool) {
        try {
          for (const v of violations) {
            await this._pool.query(
              `INSERT INTO constraint_violations (run_id, violation_type, violated_layer, severity)
               VALUES ($1, $2, $3, $4)`,
              [runId, v.type, v.capability, v.severity]
            );
            console.log(
              `[QAAgent] Phase 4 expansion violation logged: ${v.type} | capability=${v.capability} | severity=${v.severity} | run=${runId.slice(0, 8)}`
            );
            // Flag as issue for orchestrator observability
            this.flagIssue(runId, {
              severity:  v.severity >= 0.9 ? 'error' : 'warning',
              message:   v.message,
              stage:     'verify',
              run_event: v.type === 'expansion_scope_exceeded' ? 'EXPANSION_SCOPE_EXCEEDED' : 'EXPANSION_UNNECESSARY',
              capability: v.capability,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (dbErr) {
          // Non-fatal — logging must never block verify
          console.warn('[QAAgent] Phase 4 expansion violation logging failed (non-fatal):', dbErr.message);
        }
      }

      const cleanAudits  = audits.filter(a => !a.scopeExceeded && !(a.justified && !a.used));
      const violAudits   = audits.filter(a => a.scopeExceeded || (a.justified && !a.used));
      console.log(
        `[QAAgent] Phase 4 expansion audit: ${cleanAudits.length} clean, ${violAudits.length} violation(s) | run=${runId.slice(0, 8)}`
      );

    } catch (auditErr) {
      // Non-fatal — expansion audit must never block pipeline completion
      console.warn('[QAAgent] Phase 4 expansion audit failed (non-fatal):', auditErr.message);
    }
  }

  // ── Prompt Requirement Extraction ─────────────────────────

  /**
   * Extracts verifiable content requirements from the original user prompt.
   *
   * Returns structured requirements:
   *   - businessName:  Proper noun from "called X" / "named X" / quoted name
   *   - sections[]:    Explicitly requested sections (pricing, testimonials, etc.)
   *   - ctas[]:        Specific CTA types requested (booking, signup, etc.)
   *   - hasRequirements: true if any extractable requirements found
   *
   * Deterministic — no LLM calls. Pattern-matching only.
   *
   * @param {string} prompt - Original user prompt
   * @returns {object|null}
   */
  _extractPromptRequirements(prompt) {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) return null;

    const promptLower = prompt.toLowerCase();
    const requirements = {
      businessName: null,
      sections: [],
      ctas: [],
      hasRequirements: false,
    };

    // ── Extract business/brand name ──────────────────────────
    // Pattern 1: "called X" or "named X" (most explicit)
    // Subsequent words must start with uppercase to avoid capturing "FreshPaws with pricing"
    const calledMatch = prompt.match(/(?:called|named)\s+["']?([A-Z][A-Za-z0-9]+(?:[\s-][A-Z][A-Za-z0-9]+)*)["']?/);
    if (calledMatch) {
      requirements.businessName = calledMatch[1].trim();
    } else {
      // Pattern 2: Quoted proper name: "FreshPaws" or 'FreshPaws'
      const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:[\s-][A-Za-z0-9]+)*)["']/);
      if (quotedMatch) {
        const candidate = quotedMatch[1].trim();
        const skipWords = new Set(['Build', 'Create', 'Make', 'Design', 'Landing', 'Page', 'Website', 'App', 'The', 'Home', 'About']);
        if (!skipWords.has(candidate.split(/\s+/)[0])) {
          requirements.businessName = candidate;
        }
      }
    }

    // ── Extract requested sections ───────────────────────────
    // Each entry: triggers (what we look for in the prompt) → searchTerms (what we look for in the output)
    const SECTION_MAP = [
      {
        label: 'pricing',
        triggers: ['pricing', 'price list', 'pricing section', 'pricing table', 'pricing page'],
        searchTerms: ['pricing', 'price', 'per month', '/mo', '/year', 'plan'],
      },
      {
        label: 'testimonials',
        triggers: ['testimonial', 'testimonials', 'customer reviews', 'reviews section', 'social proof'],
        searchTerms: ['testimonial', 'review', 'customer', 'said'],
      },
      {
        label: 'features',
        triggers: ['features', 'feature section', 'key features', 'feature list'],
        searchTerms: ['feature', 'benefit', 'capability'],
      },
      {
        label: 'about',
        triggers: ['about us', 'about section', 'our story', 'about page'],
        searchTerms: ['about', 'our story', 'who we are', 'our mission'],
      },
      {
        label: 'contact',
        triggers: ['contact form', 'contact section', 'contact us', 'contact page', 'contact info'],
        searchTerms: ['contact', 'email', 'phone', 'address', 'reach us', 'get in touch'],
      },
      {
        label: 'FAQ',
        triggers: ['faq', 'frequently asked', 'questions section'],
        searchTerms: ['faq', 'frequently', 'question', 'answer'],
      },
      {
        label: 'team',
        triggers: ['team section', 'our team', 'meet the team', 'team members'],
        searchTerms: ['team', 'member', 'founder', 'staff'],
      },
      {
        label: 'gallery',
        triggers: ['gallery', 'portfolio', 'showcase', 'photo gallery'],
        searchTerms: ['gallery', 'portfolio', 'showcase'],
      },
      {
        label: 'services',
        triggers: ['services section', 'our services', 'services page', 'service list'],
        searchTerms: ['service', 'offering', 'what we do', 'we offer'],
      },
    ];

    for (const section of SECTION_MAP) {
      if (section.triggers.some(t => promptLower.includes(t))) {
        requirements.sections.push(section);
      }
    }

    // ── Extract CTA requirements ─────────────────────────────
    // Only matches explicit CTA/button requests (not just topic mentions)
    const CTA_MAP = [
      {
        label: 'booking',
        triggers: ['booking cta', 'booking button', 'book now', 'booking call to action', 'book appointment', 'book a'],
        searchTerms: ['book', 'booking', 'reserve', 'appointment', 'schedule'],
      },
      {
        label: 'sign up',
        triggers: ['signup cta', 'sign up cta', 'signup button', 'sign up button', 'registration cta'],
        searchTerms: ['sign up', 'signup', 'register', 'create account', 'join'],
      },
      {
        label: 'subscribe',
        triggers: ['subscribe cta', 'subscribe button', 'subscription cta', 'newsletter signup'],
        searchTerms: ['subscribe', 'subscription', 'newsletter'],
      },
      {
        label: 'download',
        triggers: ['download cta', 'download button', 'download call to action'],
        searchTerms: ['download', 'get the app', 'install'],
      },
      {
        label: 'purchase',
        triggers: ['buy cta', 'purchase cta', 'buy now button', 'buy button', 'purchase button', 'shop now'],
        searchTerms: ['buy', 'purchase', 'order', 'add to cart', 'shop now'],
      },
      {
        label: 'demo',
        triggers: ['demo cta', 'demo button', 'free trial cta', 'try it cta', 'start trial'],
        searchTerms: ['demo', 'free trial', 'try', 'start trial'],
      },
      {
        label: 'contact',
        triggers: ['contact cta', 'contact button', 'get in touch cta', 'reach out cta', 'inquire cta'],
        searchTerms: ['contact', 'get in touch', 'reach out', 'inquire', 'request'],
      },
    ];

    for (const cta of CTA_MAP) {
      if (cta.triggers.some(t => promptLower.includes(t))) {
        requirements.ctas.push(cta);
      }
    }

    requirements.hasRequirements = !!(
      requirements.businessName ||
      requirements.sections.length > 0 ||
      requirements.ctas.length > 0
    );

    return requirements;
  }

  // ── DB Evidence Classifier ────────────────────────────────

  /**
   * Delegates to the shared classifyDbEvidence() module.
   * See src/lib/db-evidence-classifier.js for the full tier/scoring documentation.
   *
   * @param {string} codeText  - All code files concatenated
   * @param {object} codeFiles - Map of filePath → content
   * @returns {{ tier: string, hardScore: number, probableScore: number, inferredScore: number, finalDecision: string, evidences: object[] }}
   */
  _classifyDbEvidence(codeText, codeFiles) {
    return classifyDbEvidence(codeText, codeFiles);
  }

  // ── Helpers ──────────────────────────────────────────────

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { QAAgent };
