/**
 * useChatContext — Derives run-aware context from global RunContext.
 * Owns: flattening pipeline state into a shape the chat API can consume.
 * Not owned: fetching, WebSocket, message state.
 */
import { useRun } from '../../state/runContext';

export interface ChatRunContext {
  runId: string | undefined;
  currentPhase: string | null | undefined;
  phases: Record<string, { status: string; error?: string; output?: unknown }> | undefined;
  logs: string[];
}

export function useChatContext(): ChatRunContext {
  const { run } = useRun();

  // Flatten all phase logs into a single array for easy consumption
  const logs: string[] = [];
  if (run?.phases) {
    for (const [phaseName, phase] of Object.entries(run.phases)) {
      if (phase.error) {
        logs.push(`[${phaseName}] ERROR: ${phase.error}`);
      }
      if (phase.output && typeof phase.output === 'string') {
        logs.push(`[${phaseName}] ${phase.output}`);
      }
    }
  }

  return {
    runId: run?.id,
    currentPhase: run?.current_phase,
    phases: run?.phases,
    logs,
  };
}
