/**
 * Timeline — horizontal progress bar of pipeline phase dots.
 * Owns: ordered dot+connector visual for all phases.
 * Not owned: phase card rendering, status polling.
 */

import { type PhaseStatus } from './StatusBadge';

interface TimelinePhase {
  name: string;
  status: PhaseStatus;
}

interface TimelineProps {
  phases: TimelinePhase[];
}

export default function Timeline({ phases }: TimelineProps) {
  if (!phases || phases.length === 0) return null;

  return (
    <div className="bo-timeline">
      {phases.map((p, i) => {
        // Connector line adopts the status of the phase it follows
        const lineStatus = i < phases.length - 1 ? p.status : null;
        return (
          <div key={p.name} className="bo-timeline-segment">
            <div
              className={`bo-timeline-dot ${p.status}`}
              title={p.name}
            />
            {lineStatus !== null && (
              <div className={`bo-timeline-line ${lineStatus}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
