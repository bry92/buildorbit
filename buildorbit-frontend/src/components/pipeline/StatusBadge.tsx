/**
 * StatusBadge — inline pill for a phase execution status.
 * Owns: visual badge, spinner for running state.
 * Not owned: phase layout, card structure.
 */

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
      {status === 'running' && <span className="bo-spinner" />}
      {LABELS[status] ?? status.toUpperCase()}
    </span>
  );
}
