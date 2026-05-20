/**
 * ReasoningCard — live window into the agent's thinking per pipeline phase.
 *
 * Owns: rendering the phase reasoning timeline from GET /api/runs/:id/reasoning.
 * Not owned: data fetching (receives timeline as prop), polling interval (managed by Run.tsx).
 *
 * Collapsed: 1-liner summary of the most recent reasoning entry.
 * Expanded: full transcript per phase with timestamps.
 *
 * Glassmorphism style matching BuildOrbit aesthetic — blurred background, cyan accents.
 */

import { useState } from 'react';
import { type ReasoningEntry } from '../../lib/api';
import './ReasoningCard.css';

const PHASE_LABELS: Record<string, string> = {
  intent_gate: 'Intent Gate',
  plan:        'Plan',
  scaffold:    'Scaffold',
  code:        'Code',
  save:        'Save',
  verify:      'Verify',
};

const PHASE_ORDER = ['intent_gate', 'plan', 'scaffold', 'code', 'save', 'verify'];

interface ReasoningCardProps {
  timeline: ReasoningEntry[];
  /** True while the pipeline run is still active */
  isRunning: boolean;
}

/** Format an ISO timestamp to a short relative label */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/** Render markdown-style bold (**text**) inline without a full markdown parser */
function renderBold(text: string): React.ReactNode[] {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>
  );
}

export default function ReasoningCard({ timeline, isRunning }: ReasoningCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Nothing to show yet — hide card entirely if timeline is empty and run isn't active
  if (timeline.length === 0 && !isRunning) return null;

  // Sort by PHASE_ORDER so timeline always flows in pipeline order
  const sorted = [...timeline].sort((a, b) => {
    return PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase);
  });

  // Latest entry drives the collapsed summary
  const latest = sorted[sorted.length - 1];
  const collapsedText = latest
    ? `${latest.summary}`
    : (isRunning ? '⚡ Analyzing task…' : 'No reasoning captured yet.');

  return (
    <div
      className={`rc-card${expanded ? ' rc-card--expanded' : ''}${isRunning ? ' rc-card--live' : ''}`}
      onClick={() => setExpanded(prev => !prev)}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(p => !p); } }}
    >
      {/* Header */}
      <div className="rc-header">
        <div className="rc-header-left">
          <span className="rc-icon">🧠</span>
          <span className="rc-title">Agent Reasoning</span>
          {isRunning && (
            <span className="rc-live-badge">
              <span className="rc-live-dot" />
              Live
            </span>
          )}
        </div>
        <div className="rc-header-right">
          {timeline.length > 0 && (
            <span className="rc-phase-count">{timeline.length}/6 phases</span>
          )}
          <span className="rc-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Collapsed: one-liner latest summary */}
      {!expanded && (
        <div className="rc-collapsed-summary">
          {collapsedText}
        </div>
      )}

      {/* Expanded: full transcript per phase */}
      {expanded && (
        <div
          className="rc-transcript"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          role="presentation"
        >
          {sorted.length === 0 && (
            <div className="rc-empty">
              {isRunning
                ? 'Waiting for first phase to complete…'
                : 'No reasoning data available for this run.'}
            </div>
          )}

          {sorted.map((entry) => (
            <div key={entry.phase} className="rc-phase-entry">
              <div className="rc-phase-header">
                <span className="rc-phase-label">
                  {PHASE_LABELS[entry.phase] || entry.phase}
                </span>
                <span className="rc-phase-time">{fmtTime(entry.ts)}</span>
              </div>
              <div className="rc-phase-summary">{entry.summary}</div>
              {entry.detail && entry.detail !== entry.summary && (
                <div className="rc-phase-detail">
                  {entry.detail.split('\n').map((line, idx) => (
                    <div key={idx} className={line.startsWith('•') || line.startsWith('-') ? 'rc-detail-bullet' : 'rc-detail-line'}>
                      {renderBold(line)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Pending phases indicator */}
          {isRunning && sorted.length < 6 && (
            <div className="rc-pending">
              {PHASE_ORDER.filter(p => !sorted.find(e => e.phase === p)).map(phase => (
                <div key={phase} className="rc-pending-phase">
                  <span className="rc-pending-dot" />
                  <span className="rc-pending-label">{PHASE_LABELS[phase] || phase}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
