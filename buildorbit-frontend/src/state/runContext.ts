/**
 * runContext — Global pipeline run state.
 * Owns: current PipelineRun data, setRun dispatcher.
 * Not owned: fetching logic, WebSocket connection.
 */
import { createContext, useContext, useState, useCallback, ReactNode, createElement } from 'react';
import type { PipelineRun } from '../lib/api';

type SetRunArg = PipelineRun | null | ((prev: PipelineRun | null) => PipelineRun | null);

interface RunContextValue {
  run: PipelineRun | null;
  setRun: (run: SetRunArg) => void;
}

export const RunContext = createContext<RunContextValue>({
  run: null,
  setRun: () => undefined,
});

interface RunProviderProps {
  children: ReactNode;
}

export function RunProvider({ children }: RunProviderProps) {
  const [run, setRunState] = useState<PipelineRun | null>(null);
  // Accept both direct values and functional updaters (mirrors React's setState API)
  const setRun = useCallback((arg: SetRunArg) => {
    if (typeof arg === 'function') {
      setRunState(arg);
    } else {
      setRunState(arg);
    }
  }, []);
  return createElement(RunContext.Provider, { value: { run, setRun } }, children);
}

export function useRun(): RunContextValue {
  return useContext(RunContext);
}
