/**
 * LogPanel — scrollable monospace log output for a pipeline phase.
 * Owns: log display with overflow scroll, auto-scroll on streaming output.
 * Not owned: phase data fetching, status management.
 */
import { useRef, useEffect, useCallback } from 'react';

interface LogPanelProps {
  logs: string[];
}

/** Pixel threshold — if user is within this many px of the bottom, auto-scroll stays on. */
const SCROLL_THRESHOLD = 40;

export default function LogPanel({ logs }: LogPanelProps) {
  const containerRef = useRef<HTMLPreElement>(null);
  // WHY ref instead of state: updating state on every scroll event would thrash renders.
  // We only need to read this value when logs change — no re-render needed.
  const isAtBottomRef = useRef(true);

  /** Check if the container is scrolled to (or near) the bottom. */
  const checkIfAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
  }, []);

  /** Track user scroll position — if they scroll up, stop auto-scrolling. */
  const handleScroll = useCallback(() => {
    isAtBottomRef.current = checkIfAtBottom();
  }, [checkIfAtBottom]);

  /** When logs change, scroll to bottom if user hasn't scrolled up. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  if (!logs || logs.length === 0) return null;

  return (
    <pre
      ref={containerRef}
      className="bo-log-panel"
      onScroll={handleScroll}
    >
      {logs.join('\n')}
    </pre>
  );
}
