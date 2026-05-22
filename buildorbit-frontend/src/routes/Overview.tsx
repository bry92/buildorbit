/**
 * Overview — BuildOrbit one-pager.
 * Owns: public marketing page at /overview. No auth, no nav chrome.
 */
import './Overview.css';

const PHASES = [
  {
    num: '01',
    name: 'Intent Gate',
    desc: 'Classifies the prompt and outputs immutable scope boundaries. The agent cannot expand beyond what this phase authorized.',
  },
  {
    num: '02',
    name: 'Plan',
    desc: 'Reads your actual codebase via MCP connections before planning. Generates a change plan against real files, not a greenfield architecture.',
  },
  {
    num: '03',
    name: 'Scaffold',
    desc: 'Creates the file and project structure. For repo aware builds, this phase is skipped entirely because the scaffold already exists.',
  },
  {
    num: '04',
    name: 'Code',
    desc: 'Generates targeted patches to existing files. Not a full app rewrite. Scoped to exactly what the plan specified.',
  },
  {
    num: '05',
    name: 'Save',
    desc: 'Commits the diff as a clean changeset to your connected repo with traceable provenance.',
  },
  {
    num: '06',
    name: 'Verify',
    desc: 'Validates the output against the actual repo structure. If verification fails, the pipeline self heals and reruns the fix with full context from the failure trace.',
  },
];

const FEATURES = [
  {
    title: 'Repo Aware Execution',
    desc: 'Orbit reads your actual codebase before planning. It generates targeted patches to real files instead of hallucinating a new app from scratch.',
  },
  {
    title: 'Full Audit Trail',
    desc: 'Every phase logs its reasoning, inputs, and outputs. You can trace any failure back to the exact decision that caused it.',
  },
  {
    title: 'MCP Infrastructure Access',
    desc: 'The agent connects to real tools (GitHub, databases, deployment) through standardized protocols. Not simulated environments.',
  },
  {
    title: 'Self Healing Pipeline',
    desc: 'When verification fails, the pipeline traces the root cause across all 6 phases and generates a scoped fix. No manual debugging.',
  },
  {
    title: 'Multi Language Support',
    desc: 'Deterministic pipeline supports TypeScript, Python, Go, Rust, C#, PowerShell. Repo profiling detects your tech stack automatically.',
  },
];

const ARCH_LAYERS = [
  {
    label: 'Agent Layer',
    desc: 'Runs the self healing 6 phase pipeline with inline execution.',
  },
  {
    label: 'MCP Connections',
    desc: 'Provide real infrastructure access (databases, APIs, version control, CI/CD).',
  },
  {
    label: 'Production Sync',
    desc: 'Pushes output to real repos and environments with full provenance.',
  },
];

export default function Overview() {
  return (
    <div className="ov-root">
      {/* Orbital background */}
      <div className="orbital-bg" aria-hidden="true">
        <div className="orbital-ring orbital-ring-1" />
        <div className="orbital-ring orbital-ring-2" />
        <div className="orbital-ring orbital-ring-3" />
        <div className="orbital-ring orbital-ring-4" />
        <div className="orbital-glow" />
      </div>

      <main className="ov-main">
        {/* ── Hero ── */}
        <section className="ov-hero">
          <div className="ov-hero-eyebrow">
            <span className="ov-live-dot" aria-hidden="true" />
            Live Product
          </div>
          <h1 className="ov-hero-title">BuildOrbit</h1>
          <p className="ov-hero-sub">
            Deterministic execution runtime for AI agent orchestration.
          </p>
          <p className="ov-hero-body">
            AI writes the code. Nobody audits the structure.{' '}
            <strong>BuildOrbit fixes that.</strong>
          </p>
          <div className="ov-hero-visual" aria-hidden="true">
            <div className="ov-hero-orbit orbit-small" />
            <div className="ov-hero-orbit orbit-medium" />
            <div className="ov-hero-orbit orbit-large" />
            <div className="ov-hero-core" />
          </div>
          <a href="https://buildorbit.polsia.app" className="ov-cta-btn">
            Try BuildOrbit
          </a>
        </section>

        {/* ── The Problem ── */}
        <section className="ov-section">
          <div className="ov-section-label">The Problem</div>
          <h2 className="ov-section-heading">Context blind AI tools</h2>
          <p className="ov-section-body">
            AI coding tools are context blind. Agents lose state between runs, cannot access real
            infrastructure, and leave no audit trail. You get output but no understanding of how it
            got there. If you cannot inspect what the agent did and why, you do not own the output.
          </p>
        </section>

        {/* ── How It Works ── */}
        <section className="ov-section">
          <div className="ov-section-label">How It Works</div>
          <h2 className="ov-section-heading">Six phases. Every decision traced.</h2>
          <p className="ov-section-body">
            Every build runs through a 6 phase pipeline. Each phase produces an inspectable
            artifact so you can trace exactly what the agent decided and why.
          </p>
          <div className="ov-phases-grid">
            {PHASES.map((phase) => (
              <div key={phase.num} className="ov-phase-card">
                <div className="ov-phase-num">{phase.num}</div>
                <div className="ov-phase-content">
                  <h3 className="ov-phase-name">{phase.name}</h3>
                  <p className="ov-phase-desc">{phase.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── What Makes It Different ── */}
        <section className="ov-section">
          <div className="ov-section-label">What Makes It Different</div>
          <h2 className="ov-section-heading">Built for trust, not throughput.</h2>
          <div className="ov-features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="ov-feature-card">
                <div className="ov-feature-accent" aria-hidden="true" />
                <h3 className="ov-feature-title">{f.title}</h3>
                <p className="ov-feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Architecture ── */}
        <section className="ov-section">
          <div className="ov-section-label">Architecture</div>
          <h2 className="ov-section-heading">Three layer system</h2>
          <div className="ov-arch-layers">
            {ARCH_LAYERS.map((layer, i) => (
              <div key={layer.label} className="ov-arch-layer">
                <div className="ov-arch-num">{String(i + 1).padStart(2, '0')}</div>
                <div className="ov-arch-content">
                  <h3 className="ov-arch-label">{layer.label}</h3>
                  <p className="ov-arch-desc">{layer.desc}</p>
                </div>
                {i < ARCH_LAYERS.length - 1 && (
                  <div className="ov-arch-connector" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ── Who It's For ── */}
        <section className="ov-section">
          <div className="ov-section-label">Who It's For</div>
          <h2 className="ov-section-heading">Trust the agents you deploy.</h2>
          <p className="ov-section-body">
            Teams that need autonomous agents they can actually trust. Regulated industries
            (finance, legal, healthcare) where explainability and auditability are not optional.
            Any engineering org that wants AI assistance without giving up control.
          </p>
          <div className="ov-verticals">
            {['Finance', 'Legal', 'Healthcare', 'AI Infrastructure', 'Engineering Teams'].map(
              (v) => (
                <span key={v} className="ov-vertical-tag">
                  {v}
                </span>
              )
            )}
          </div>
        </section>

        {/* ── Current Status ── */}
        <section className="ov-section">
          <div className="ov-section-label">Current Status</div>
          <h2 className="ov-section-heading">Live and running.</h2>
          <p className="ov-section-body">
            Available at buildorbit.polsia.app with GitHub OAuth connected, persistent agent
            sidebar, repo aware execution, multi language support, and inline copilot execution.
          </p>
          <div className="ov-status-pills">
            {[
              'GitHub OAuth',
              'Repo Aware Execution',
              'Multi Language',
              'Inline Copilot',
              'Audit Trail',
            ].map((s) => (
              <span key={s} className="ov-status-pill">
                <span className="ov-status-dot" aria-hidden="true" />
                {s}
              </span>
            ))}
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="ov-cta-section">
          <h2 className="ov-cta-heading">Ready to own your agent output?</h2>
          <a href="https://buildorbit.polsia.app" className="ov-cta-btn ov-cta-btn-lg">
            Try BuildOrbit
          </a>
        </section>
      </main>
    </div>
  );
}