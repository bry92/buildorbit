/**
 * PhaseHeader — top row of a pipeline phase card.
 * Owns: icon + name/desc + status badge + expand chevron.
 * Not owned: card borders, expanded content panels.
 */

import StatusBadge, { type PhaseStatus } from './StatusBadge';

export interface PhaseHeaderData {
  name: string;
  label: string;
  icon: string;
  desc: string;
  status: PhaseStatus;
}

interface PhaseHeaderProps {
  phase: PhaseHeaderData;
  expanded?: boolean;
  expandable?: boolean;
}

export default function PhaseHeader({ phase, expanded = false, expandable = false }: PhaseHeaderProps) {
  return (
    <div className="bo-phase-header">
      <div className="bo-phase-header-left">
        <span className="bo-phase-icon">{phase.icon}</span>
        <div className="bo-phase-meta">
          <div className="bo-phase-name">{phase.label}</div>
          <div className="bo-phase-desc">{phase.desc}</div>
        </div>
      </div>
      <div className="bo-phase-header-right">
        <StatusBadge status={phase.status} />
        {expandable && (
          <span className={`bo-phase-chevron${expanded ? ' expanded' : ''}`}>
            &#x25BE;
          </span>
        )}
      </div>
    </div>
  );
}
