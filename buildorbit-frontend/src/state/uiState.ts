/**
 * uiState — Global UI state using React Context + useReducer.
 * Owns: chat widget open/close, active phase highlight, multi-tab sync.
 * Not owned: run data (see runContext), component rendering.
 *
 * No Jotai dependency — React context is simpler and we already use it.
 * Multi-tab sync uses BroadcastChannel (graceful fallback for old browsers).
 */
import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  ReactNode,
  createElement,
} from 'react';

export interface UIState {
  chatOpen: boolean;
  activePhase: string | null;
}

type UIAction =
  | { type: 'SET_CHAT_OPEN'; open: boolean }
  | { type: 'SET_ACTIVE_PHASE'; phase: string | null };

const initialState: UIState = {
  chatOpen: false,
  activePhase: null,
};

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'SET_CHAT_OPEN':
      return { ...state, chatOpen: action.open };
    case 'SET_ACTIVE_PHASE':
      return { ...state, activePhase: action.phase };
    default:
      return state;
  }
}

interface UIContextValue {
  state: UIState;
  setChatOpen: (open: boolean) => void;
  setActivePhase: (phase: string | null) => void;
}

const UIContext = createContext<UIContextValue>({
  state: initialState,
  setChatOpen: () => undefined,
  setActivePhase: () => undefined,
});

const BROADCAST_CHANNEL = 'buildorbit:ui';

interface UIProviderProps {
  children: ReactNode;
}

export function UIProvider({ children }: UIProviderProps) {
  const [state, dispatch] = useReducer(uiReducer, initialState);

  // BroadcastChannel for multi-tab state sync
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const action = event.data as UIAction;
      dispatch(action);
    };
    return () => channel.close();
  }, []);

  const broadcastAndDispatch = useCallback((action: UIAction) => {
    dispatch(action);
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(BROADCAST_CHANNEL);
      channel.postMessage(action);
      channel.close();
    }
  }, []);

  const setChatOpen = useCallback(
    (open: boolean) => broadcastAndDispatch({ type: 'SET_CHAT_OPEN', open }),
    [broadcastAndDispatch],
  );

  const setActivePhase = useCallback(
    (phase: string | null) => broadcastAndDispatch({ type: 'SET_ACTIVE_PHASE', phase }),
    [broadcastAndDispatch],
  );

  return createElement(UIContext.Provider, { value: { state, setChatOpen, setActivePhase } }, children);
}

export function useUIState(): UIContextValue {
  return useContext(UIContext);
}
