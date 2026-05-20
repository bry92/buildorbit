/**
 * websocket — WebSocket streaming helper for pipeline run updates.
 * Owns: WS connection lifecycle, message parsing, auto-reconnect with exponential backoff.
 * Not owned: run state management (see runContext), UI rendering.
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface StreamMessage {
  type: string;
  phase?: string;
  status?: string;
  log?: string;
  data?: unknown;
}

export interface RunStreamOptions {
  onMessage: (msg: StreamMessage) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (err: Event) => void;
}

// WHY these specific values: 1s is fast enough users don't notice a blip,
// 30s cap prevents hammering a down server, and the doubling is standard
// exponential backoff.
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

// WebSocket close code 1000 = normal closure (server finished the stream).
// Everything else is abnormal — reconnect.
const CLEAN_CLOSE_CODE = 1000;

export interface RunStreamConnection {
  /** Permanently close the connection and stop all reconnect attempts. */
  disconnect: () => void;
  /** Current connection state. */
  getState: () => ConnectionState;
}

/**
 * Open a WebSocket to /api/stream/:runId with automatic reconnect.
 *
 * Returns a connection handle with disconnect() for cleanup.
 * Reconnects with exponential backoff (1s → 2s → 4s → … → 30s max)
 * on unexpected drops. Does NOT reconnect on clean close (code 1000)
 * or after disconnect() is called.
 */
export function connectToRunStream(
  runId: string,
  { onMessage, onStateChange, onError }: RunStreamOptions,
): RunStreamConnection {
  let state: ConnectionState = 'connecting';
  let ws: WebSocket | null = null;
  let retryDelay = INITIAL_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  };

  function connect() {
    if (destroyed) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${window.location.host}/api/stream/${runId}`);

    ws.onopen = () => {
      retryDelay = INITIAL_DELAY_MS; // reset backoff on successful connect
      setState('connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as StreamMessage;
        onMessage(data);
      } catch {
        // Malformed frame — ignore, don't crash the stream
      }
    };

    ws.onerror = (err) => {
      onError?.(err);
    };

    ws.onclose = (event: CloseEvent) => {
      ws = null;

      if (destroyed) {
        setState('disconnected');
        return;
      }

      // Clean close (server intentionally ended the stream) — don't reconnect
      if (event.code === CLEAN_CLOSE_CODE) {
        setState('disconnected');
        return;
      }

      // Unexpected drop — schedule reconnect with backoff
      setState('reconnecting');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (destroyed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!destroyed) {
        setState('connecting');
        connect();
      }
    }, retryDelay);
    // Exponential backoff with cap
    retryDelay = Math.min(retryDelay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }

  function disconnect() {
    destroyed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) {
      // WHY null the handler: prevent onclose from triggering reconnect
      // during intentional teardown
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setState('disconnected');
  }

  // Start initial connection
  connect();

  return {
    disconnect,
    getState: () => state,
  };
}
