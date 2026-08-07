/**
 * StatusBadge — inline pill for a phase execution status.
 * Owns: visual badge, spinner for running state.
 * Not owned: phase layout, card structure.
 */
import OrbitLoader from '../ui/OrbitLoader';

export type PhaseStatus = 'waiting' | 'running' | 'complete' | 'failed' | 'skipped';

const LABELS: Record<PhaseStatus, string> = {
  waiting:  'Waiting',
  running:  'Running',
  complete: 'Complete',
  failed:   'Failed',
  skipped:  'Skipped',
};

interface StatusBadgeProps {
  status: PhaseStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`bo-status-badge ${status}`}>
      {status === 'running' && <OrbitLoader size="sm" />}
      {LABELS[status] ?? status.toUpperCase()}
    </span>
  );
}
