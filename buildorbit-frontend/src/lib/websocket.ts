/**
 * SSE (Server-Sent Events) helper for pipeline run streaming.
 * Owns: EventSource lifecycle management.
 */

export interface SSEOptions {
  onMessage: (data: unknown) => void;
  onError?: (err: Event) => void;
  onClose?: () => void;
}

export function openSSE(url: string, opts: SSEOptions): () => void {
  const es = new EventSource(url, { withCredentials: true });

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string);
      opts.onMessage(data);
    } catch {
      // non-JSON messages are ignored
    }
  };

  es.onerror = (err) => {
    opts.onError?.(err);
  };

  return () => {
    es.close();
    opts.onClose?.();
  };
}
