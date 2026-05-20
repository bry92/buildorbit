/**
 * ScaffoldPreviewPanel — context-aware preview shown before CODE phase completes.
 *
 * Owns: rendering scaffold output (file tree, tech stack, repo context) as a
 *       "glass-box" window into what the pipeline is building.
 * Not owned: pipeline data fetching, iframe rendering, reasoning timeline.
 *
 * Shows:
 *   - When scaffold has completed: file tree + tech stack from scaffold output
 *   - When pipeline is in earlier phases: "Build initializing" state
 *   - Never shows generic CRUD placeholder content
 */

import './ScaffoldPreviewPanel.css';

interface ScaffoldOutput {
  tree?: unknown[];
  files?: string[];
  techStack?: string[];
  summary?: string;
  structure?: Record<string, unknown>;
  constraints?: {
    entry?: string;
    hasServer?: boolean;
    hasFrontend?: boolean;
    hasDb?: boolean;
    hasAuth?: boolean;
    techStack?: string[];
  };
  output_stack?: string;
  _repoProfile?: {
    language?: string;
    framework?: string;
    isWebProject?: boolean;
    platform?: string;
    fileCount?: number;
    packageJson?: { name?: string; dependencies?: Record<string, string> };
  };
}

interface ScaffoldPreviewPanelProps {
  /** Current phase name */
  currentPhase: string | null;
  /** Scaffold phase output (if scaffold has completed) */
  scaffoldOutput: ScaffoldOutput | null;
  /** Plan phase summary (if plan has completed) */
  planSummary?: string | null;
  /** Original user prompt */
  prompt: string;
  /** Whether the pipeline is still running */
  isRunning: boolean;
}

const PHASE_ORDER = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];
const PHASE_LABELS: Record<string, string> = {
  intent_gate: 'Intent Gate',
  plan: 'Plan',
  scaffold: 'Scaffold',
  code: 'Code',
  save: 'Save',
  verify: 'Verify',
};

/** Map file extension to icon */
function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const base = name.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'package.json') return '📦';
  if (base === 'server.js' || base === 'server.ts') return '⚙️';
  if (base === 'index.html') return '🌐';
  if (base.startsWith('.env')) return '🔒';
  if (base === 'dockerfile' || base === 'docker-compose.yml') return '🐳';
  switch (ext) {
    case 'js': case 'jsx': case 'ts': case 'tsx': return '📜';
    case 'css': case 'scss': case 'less': return '🎨';
    case 'html': return '🌐';
    case 'json': return '📋';
    case 'md': return '📝';
    case 'py': return '🐍';
    case 'go': return '🔷';
    case 'sql': return '🗄';
    default: return '📄';
  }
}

/** Group files by directory prefix */
function groupByDir(files: string[]): Map<string, string[]> {
  const dirs = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split('/');
    const dir = parts.length > 1 ? parts[0] : '';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(f);
  }
  return dirs;
}

/** Derive a short label from the stack */
function stackLabel(techStack: string[], constraints?: ScaffoldOutput['constraints']): string {
  const stack = [...techStack];
  if (constraints?.hasServer) stack.push('server');
  if (constraints?.hasFrontend) stack.push('frontend');
  if (constraints?.hasDb) stack.push('postgres');

  const tags: string[] = [];
  if (stack.some(s => s.includes('react') || s.includes('vite'))) tags.push('React');
  if (stack.some(s => s.includes('express'))) tags.push('Express');
  if (stack.some(s => s.includes('tailwind'))) tags.push('Tailwind');
  if (stack.some(s => s.includes('postgres') || s.includes('pg') || s.includes('db'))) tags.push('PostgreSQL');
  if (stack.some(s => s.includes('sqlite'))) tags.push('SQLite');
  if (stack.some(s => s.includes('shadcn'))) tags.push('shadcn/ui');
  if (tags.length === 0 && techStack.length > 0) return techStack.slice(0, 3).join(', ');
  return tags.join(' + ');
}

export default function ScaffoldPreviewPanel({
  currentPhase,
  scaffoldOutput,
  planSummary,
  prompt,
  isRunning,
}: ScaffoldPreviewPanelProps) {
  const phaseIdx = PHASE_ORDER.indexOf(currentPhase ?? '');
  const scaffoldDone = scaffoldOutput !== null;

  // ── File list from scaffold output ──────────────────────────────────────
  const files: string[] = scaffoldOutput?.files
    ? scaffoldOutput.files
    : Array.isArray(scaffoldOutput?.tree)
      ? (scaffoldOutput.tree as Array<{ path?: string; type?: string }>)
          .filter(t => t.type === 'file' && t.path)
          .map(t => t.path!)
      : [];

  const grouped = groupByDir(files);

  const techStack: string[] = scaffoldOutput?.techStack ?? [];
  const stackStr = techStack.length > 0
    ? stackLabel(techStack, scaffoldOutput?.constraints)
    : null;

  const entryPoint = scaffoldOutput?.constraints?.entry ?? null;
  const repoProfile = scaffoldOutput?._repoProfile;

  // Derive a short project name from prompt (first meaningful words)
  const projectName = (() => {
    const words = prompt.trim().split(/\s+/).slice(0, 5).join(' ');
    return words.length > 40 ? words.slice(0, 40) + '…' : words;
  })();

  return (
    <div className={`sp-panel${isRunning ? ' sp-panel--live' : ''}`}>
      {/* Header */}
      <div className="sp-header">
        <span className="sp-header-icon">🏗</span>
        <span className="sp-header-title">
          {scaffoldDone ? 'Project Blueprint' : 'Build Initializing'}
        </span>
        {isRunning && (
          <span className="sp-live-badge">
            <span className="sp-live-dot" />
            Live
          </span>
        )}
      </div>

      {/* Phase progress bar */}
      <div className="sp-phases">
        {PHASE_ORDER.map((phase, idx) => (
          <div
            key={phase}
            className={`sp-phase-dot${idx < phaseIdx ? ' sp-phase-dot--done' : ''}${idx === phaseIdx ? ' sp-phase-dot--active' : ''}`}
            title={PHASE_LABELS[phase]}
          >
            <span className="sp-phase-dot-inner" />
            <span className="sp-phase-label">{PHASE_LABELS[phase]}</span>
          </div>
        ))}
      </div>

      {/* Repo context (if known) */}
      {repoProfile && (repoProfile.language || repoProfile.framework) && (
        <div className="sp-section sp-repo-context">
          <span className="sp-section-label">Repo Context</span>
          <div className="sp-tags">
            {repoProfile.language && (
              <span className="sp-tag sp-tag--lang">{repoProfile.language}</span>
            )}
            {repoProfile.framework && (
              <span className="sp-tag">{repoProfile.framework}</span>
            )}
            {repoProfile.fileCount && repoProfile.fileCount > 0 && (
              <span className="sp-tag sp-tag--dim">{repoProfile.fileCount} files</span>
            )}
          </div>
        </div>
      )}

      {/* Tech stack */}
      {stackStr && (
        <div className="sp-section">
          <span className="sp-section-label">Stack</span>
          <span className="sp-stack">{stackStr}</span>
          {entryPoint && (
            <span className="sp-entry">Entry: {entryPoint}</span>
          )}
        </div>
      )}

      {/* Scaffold summary */}
      {scaffoldOutput?.summary && (
        <div className="sp-section">
          <span className="sp-section-label">Scaffold Plan</span>
          <div className="sp-summary">{scaffoldOutput.summary}</div>
        </div>
      )}

      {/* Plan summary (if no scaffold yet) */}
      {!scaffoldDone && planSummary && (
        <div className="sp-section">
          <span className="sp-section-label">Architecture Plan</span>
          <div className="sp-summary">{planSummary}</div>
        </div>
      )}

      {/* File tree */}
      {files.length > 0 ? (
        <div className="sp-section">
          <span className="sp-section-label">{files.length} files planned</span>
          <div className="sp-file-tree">
            {Array.from(grouped.entries()).map(([dir, dirFiles]) => (
              <div key={dir || '__root'} className="sp-dir-group">
                {dir && (
                  <div className="sp-dir-name">
                    <span className="sp-dir-icon">📁</span>
                    <span>{dir}/</span>
                  </div>
                )}
                {dirFiles.map(f => (
                  <div key={f} className={`sp-file-entry${dir ? ' sp-file-entry--indent' : ''}`}>
                    <span className="sp-file-icon">{fileIcon(f)}</span>
                    <span className="sp-file-name">{f.split('/').pop()}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* No scaffold yet — show build initializing state */
        <div className="sp-initializing">
          <div className="sp-init-icon">⚡</div>
          <div className="sp-init-title">Analyzing task…</div>
          <div className="sp-init-subtitle">
            {projectName
              ? `Building: "${projectName}"`
              : 'Setting up your project structure'}
          </div>
          <div className="sp-init-steps">
            {PHASE_ORDER.slice(0, 3).map((phase, idx) => (
              <div
                key={phase}
                className={`sp-init-step${idx < phaseIdx ? ' sp-init-step--done' : ''}${idx === phaseIdx ? ' sp-init-step--active' : ''}`}
              >
                <span className="sp-init-step-indicator">
                  {idx < phaseIdx ? '✓' : idx === phaseIdx ? '↻' : '○'}
                </span>
                <span>{PHASE_LABELS[phase]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
