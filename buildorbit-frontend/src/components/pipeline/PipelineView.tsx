/**
 * PipelineView — root component for displaying a full pipeline run.
 * Owns: timeline + ordered phase cards for a run.
 * Not owned: page chrome (nav, background, header), data fetching.
 */

import './Pipeline.css';
import Timeline from './Timeline';
import PhaseCard, { type PhaseCardData } from './PhaseCard';
import { type PhaseStatus } from './StatusBadge';

export interface PipelinePhase extends PhaseCardData {}

interface PipelineViewProps {
  phases: PipelinePhase[];
}

/**
 * Maps a phase to a timeline-compatible shape (name + status only).
 */
function toTimelineDot(phase: PipelinePhase) {
  return { name: phase.name, status: phase.status as PhaseStatus };
}

export default function PipelineView({ phases }: PipelineViewProps) {
  return (
    <div className="bo-pipeline">
      <Timeline phases={phases.map(toTimelineDot)} />
      {phases.map(phase => (
        <PhaseCard key={phase.name} phase={phase} />
      ))}
    </div>
  );
}
