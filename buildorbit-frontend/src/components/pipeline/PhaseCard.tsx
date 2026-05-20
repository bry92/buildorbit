/**
 * PhaseCard — expandable glassmorphism card for a single pipeline phase.
 * Owns: card chrome, expand/collapse toggle, header + detail panels.
 * Not owned: page layout, phase ordering, data fetching.
 */

import { useState, useCallback } from 'react';
import PhaseHeader, { type PhaseHeaderData } from './PhaseHeader';
import PhaseDetail from './PhaseDetail';
import { type PhaseStatus } from './StatusBadge';

export interface PhaseCardData extends PhaseHeaderData {
  logs?: string[];
  diff?: string;
  code?: string;
  /** Raw phase output from pipeline_events payload — phase-specific detail renderers interpret this */
  output?: Record<string, unknown>;
  /** Error message from pipeline_events if phase failed */
  error?: string;
}

interface PhaseCardProps {
  phase: PhaseCardData;
}

export default function PhaseCard({ phase }: PhaseCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Card is expandable if the phase has any output data or has completed/failed/running.
  // Running phases are made expandable so users can see the phase header and status
  // even before the phase produces output — prevents the "static non-clickable cards"
  // issue when landing on /run/:id right after pipeline starts.
  const hasContent = !!(
    phase.output ||
    (phase.logs && phase.logs.length > 0) ||
    phase.diff ||
    phase.code
  );
  const isExpandable = hasContent || phase.status === 'complete' || phase.status === 'failed' || phase.status === 'running';

  const statusClass: PhaseStatus = phase.status;

  // WHY: keyboard events inside the expanded detail panel must not bubble to:
  // 1. The parent card's onKeyDown (which would toggle expand/collapse on Enter/Space)
  // 2. Global handlers on document/window (Sidebar Esc, ChatWidget Esc)
  // Escape is intercepted here to collapse the card without triggering those global handlers.
  const handleDetailKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setExpanded(false);
      return;
    }
    e.stopPropagation();
  }, []);

  return (
    <div
      className={`bo-phase-card status-${statusClass}${expanded ? ' expanded' : ''}${isExpandable ? ' expandable' : ''}`}
      onClick={isExpandable ? () => setExpanded(prev => !prev) : undefined}
      role={isExpandable ? 'button' : undefined}
      tabIndex={isExpandable ? 0 : undefined}
      onKeyDown={isExpandable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(prev => !prev); } } : undefined}
    >
      <PhaseHeader phase={phase} expanded={expanded} expandable={isExpandable} />
      {expanded && (
        <div
          className="bo-phase-detail-panel"
          onClick={e => e.stopPropagation()}
          onKeyDown={handleDetailKeyDown}
        >
          <PhaseDetail phase={phase} />
        </div>
      )}
    </div>
  );
}
