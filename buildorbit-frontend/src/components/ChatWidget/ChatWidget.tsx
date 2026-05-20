/**
 * ChatWidget — React port of the Orbit floating chat widget.
 * Owns: bubble + panel UI, POST /a2a/orbit/chat calls, localStorage conversationId.
 * Does NOT own: routing, auth, pipeline execution.
 * Open/close state is mirrored to global UIState so other components can
 * observe and control the widget (e.g. from Run page or BroadcastChannel).
 *
 * Response handling:
 *   - Build/modify intents → SSE stream with progressive phase updates.
 *   - Chat/query intents → plain JSON response.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIState } from '../../state/uiState';
import { useChatContext } from './useChatContext';
import ChatPreview from '../preview/ChatPreview';
import './ChatWidget.css';

const STORAGE_KEY = 'orbit_conversation_id';

interface AgentResponse {
  message?: string;
  type?: string;
  runId?: string;
  conversationId?: string;
}

interface Message {
  id: number;
  role: 'user' | 'agent' | 'thinking' | 'progress' | 'error';
  text: string;
  meta?: { type: string; runId?: string };
}

let msgIdCounter = 0;
function nextId() { return ++msgIdCounter; }

export default function ChatWidget() {
  // chatOpen is global — controlled by uiState so other components can open/close
  const { state: uiState, setChatOpen } = useUIState();
  // Run-aware context: injected into chat API calls so Orbit can answer
  // questions about the current pipeline run (phase status, errors, artifacts).
  const chatCtx = useChatContext();
  const isOpen = uiState.chatOpen;
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [hasDot, setHasDot] = useState(false);

  const conversationIdRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Tracks the in-progress "progress" message ID during SSE streaming
  const progressMsgIdRef = useRef<number | null>(null);

  const scrollBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollBottom(); }, [messages, scrollBottom]);

  const open = useCallback(() => {
    setChatOpen(true);
    setIsAnimatingOut(false);
    setHasDot(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [setChatOpen]);

  const close = useCallback(() => {
    setIsAnimatingOut(true);
    setTimeout(() => {
      setChatOpen(false);
      setIsAnimatingOut(false);
    }, 150);
  }, [setChatOpen]);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!isOpen) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, close]);

  // Escape key
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) close();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  const newConversation = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    conversationIdRef.current = null;
    setMessages([]);
    setInput('');
    setHasDot(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    resizeTextarea();
  }, [resizeTextarea]);

  // ── SSE stream handler ────────────────────────────────────────────────────

  const handleSSEStream = useCallback(async (
    response: Response,
    progressId: number,
    updateConversationId: (id: string) => void,
  ) => {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';
    let currentProgressLines: string[] = [];

    const updateProgress = (text: string) => {
      setMessages(prev => prev.map(m =>
        m.id === progressId ? { ...m, text } : m
      ));
    };

    try {
      let currentEventName = 'message';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventName = line.slice(7).trim();
            continue;
          }
          if (line === '') {
            currentEventName = 'message'; // reset on blank line (event boundary)
            continue;
          }
          if (line.startsWith('data: ')) {
            const rawData = line.slice(6);
            try {
              const data = JSON.parse(rawData);
              const eventType = currentEventName || _inferEventType(data);

              if (eventType === 'run_start') {
                currentProgressLines = [`🚀 Starting pipeline…`];
                updateProgress(currentProgressLines.join('\n'));
              } else if (eventType === 'phase_start') {
                currentProgressLines.push(data.message || `⏳ ${data.label || data.phase}…`);
                updateProgress(currentProgressLines.join('\n'));
              } else if (eventType === 'phase_complete') {
                // Replace last "⏳" line with completed version
                const lastIdx = currentProgressLines.length - 1;
                if (lastIdx >= 0 && currentProgressLines[lastIdx].startsWith('⏳')) {
                  currentProgressLines[lastIdx] = data.message || `✅ ${data.label || data.phase}`;
                } else {
                  currentProgressLines.push(data.message || `✅ ${data.label || data.phase}`);
                }
                updateProgress(currentProgressLines.join('\n'));
              } else if (eventType === 'complete' || eventType === 'pipeline_error') {
                // Replace progress message with final result
                setMessages(prev => prev.map(m =>
                  m.id === progressId
                    ? {
                        ...m,
                        role: eventType === 'complete' ? 'agent' : 'agent',
                        text: data.message || (eventType === 'complete' ? '✅ Done.' : '❌ Failed.'),
                        meta: { type: eventType === 'complete' ? 'build' : 'error', runId: data.runId },
                      }
                    : m
                ));
              } else if (eventType === 'done') {
                // Final JSON result with conversationId
                if (data.conversationId) updateConversationId(data.conversationId);
                // If we haven't already replaced the progress msg with complete/error,
                // replace it now with the final message
                setMessages(prev => {
                  const existing = prev.find(m => m.id === progressId);
                  if (existing && existing.role === 'progress') {
                    return prev.map(m =>
                      m.id === progressId
                        ? {
                            ...m,
                            role: 'agent' as const,
                            text: data.message || '✅ Done.',
                            meta: { type: data.type || 'message', runId: data.runId },
                          }
                        : m
                    );
                  }
                  return prev;
                });
              } else if (eventType === 'error') {
                setMessages(prev => prev.map(m =>
                  m.id === progressId
                    ? { ...m, role: 'error' as const, text: data.message || 'Unknown error' }
                    : m
                ));
              }
            } catch { /* malformed JSON line, skip */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isWaiting) return;

    setIsWaiting(true);
    setInput('');
    setHasDot(false);

    const userMsg: Message = { id: nextId(), role: 'user', text };
    const progressMsg: Message = { id: nextId(), role: 'thinking', text: '' };
    const progressId = progressMsg.id;
    progressMsgIdRef.current = progressId;
    setMessages(prev => [...prev, userMsg, progressMsg]);

    const updateConversationId = (newId: string) => {
      if (newId !== conversationIdRef.current) {
        conversationIdRef.current = newId;
        localStorage.setItem(STORAGE_KEY, newId);
      }
    };

    try {
      const body: Record<string, unknown> = { message: text };
      if (conversationIdRef.current) body.conversationId = conversationIdRef.current;
      // Attach run-aware context so Orbit can answer questions about the
      // current pipeline run. Only sent when a run is active (runId present).
      if (chatCtx.runId) body.context = chatCtx;

      const res = await fetch('/a2a/orbit/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Remove thinking indicator
        setMessages(prev => prev.filter(m => m.id !== progressId));
        let errMsg = `Server error (${res.status})`;
        try {
          const errData = await res.json();
          if (errData?.error) errMsg = errData.error;
        } catch { /* ignore */ }
        if (res.status === 401) errMsg = 'Session expired — please log in.';
        setMessages(prev => [...prev, { id: nextId(), role: 'error', text: errMsg }]);
        return;
      }

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // ── SSE streaming: switch thinking → progress bubble ──────────────
        setMessages(prev => prev.map(m =>
          m.id === progressId ? { ...m, role: 'progress' as const, text: '🚀 Starting pipeline…' } : m
        ));
        await handleSSEStream(res, progressId, updateConversationId);
      } else {
        // ── Plain JSON response ───────────────────────────────────────────
        setMessages(prev => prev.filter(m => m.id !== progressId));
        const data: AgentResponse = await res.json();

        if (data.conversationId) updateConversationId(data.conversationId);

        const agentMsg: Message = {
          id: nextId(),
          role: 'agent',
          text: data.message ?? '',
          meta: { type: data.type ?? 'message', runId: data.runId },
        };
        setMessages(prev => [...prev, agentMsg]);
      }

      if (!isOpen) setHasDot(true);
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== progressId));
      const errText = err instanceof Error ? err.message : 'could not reach server';
      setMessages(prev => [...prev, { id: nextId(), role: 'error', text: `Network error — ${errText}` }]);
    } finally {
      setIsWaiting(false);
      progressMsgIdRef.current = null;
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [input, isWaiting, isOpen, chatCtx, handleSSEStream]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isWaiting) sendMessage();
    }
  }, [input, isWaiting, sendMessage]);

  const panelClass = [
    'nw-panel',
    !isOpen && !isAnimatingOut ? 'nw-hidden' : '',
    isOpen && !isAnimatingOut ? 'nw-entering' : '',
    isAnimatingOut ? 'nw-leaving' : '',
  ].filter(Boolean).join(' ');

  const typeClass = (t: string) => ['build', 'modify', 'message'].includes(t) ? t : 'message';

  return (
    <div className="nw-container" id="nw-widget">
      {/* Bubble */}
      <button
        className="nw-bubble"
        onClick={open}
        style={isOpen ? { display: 'none' } : {}}
        aria-label="Open Orbit chat"
        title="Orbit"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <span className={`nw-bubble-dot${hasDot ? ' visible' : ''}`} aria-hidden="true" />
      </button>

      {/* Panel */}
      <div className={panelClass} ref={panelRef} role="dialog" aria-label="Orbit chat">
        <div className="nw-header">
          <div className="nw-header-left">
            <div className="nw-header-icon" aria-hidden="true">⚡</div>
            <div>
              <div className="nw-header-title">Orbit</div>
              <div className="nw-header-sub">Agentic copilot</div>
            </div>
          </div>
          <div className="nw-header-actions">
            <button className="nw-icon-btn" onClick={newConversation} title="New conversation" aria-label="Start new conversation">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button className="nw-icon-btn" onClick={close} title="Close" aria-label="Close chat widget">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="nw-messages">
          {messages.length === 0 && (
            <div className="nw-empty">
              <div className="nw-empty-icon">⚡</div>
              <h3>Orbit</h3>
              <p>Build, modify, ask questions about your runs. The pipeline executes right here.</p>
            </div>
          )}

          {messages.map(msg => {
            if (msg.role === 'thinking') {
              return (
                <div key={msg.id} className="nw-msg nw-agent nw-thinking">
                  <div className="nw-avatar">N</div>
                  <div className="nw-msg-body">
                    <div className="nw-bubble-msg">
                      <span>Thinking</span>
                      <div className="nw-dots"><span /><span /><span /></div>
                    </div>
                  </div>
                </div>
              );
            }
            if (msg.role === 'progress') {
              return (
                <div key={msg.id} className="nw-msg nw-agent nw-progress">
                  <div className="nw-avatar">N</div>
                  <div className="nw-msg-body">
                    <div className="nw-bubble-msg nw-progress-text" style={{ whiteSpace: 'pre-line' }}>
                      {msg.text}
                      <div className="nw-dots" style={{ display: 'inline-flex', marginLeft: '6px' }}><span /><span /><span /></div>
                    </div>
                  </div>
                </div>
              );
            }
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="nw-msg nw-user">
                  <div className="nw-avatar">U</div>
                  <div className="nw-msg-body">
                    <div className="nw-bubble-msg">{msg.text}</div>
                  </div>
                </div>
              );
            }
            if (msg.role === 'error') {
              return (
                <div key={msg.id} className="nw-msg nw-agent nw-error">
                  <div className="nw-avatar" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>!</div>
                  <div className="nw-msg-body">
                    <div className="nw-bubble-msg">{msg.text}</div>
                  </div>
                </div>
              );
            }
            // agent
            const t = msg.meta?.type ?? 'message';
            return (
              <div key={msg.id} className="nw-msg nw-agent">
                <div className="nw-avatar">N</div>
                <div className="nw-msg-body">
                  <div className="nw-bubble-msg" style={{ whiteSpace: 'pre-line' }}>{msg.text}</div>
                  <div className="nw-msg-meta">
                    <span className={`nw-meta-type ${typeClass(t)}`}>{t}</span>
                    {msg.meta?.runId && (
                      <span className="nw-meta-run">
                        <a href={`/run/${msg.meta.runId}`} target="_blank" rel="noreferrer">
                          #{msg.meta.runId.slice(0, 8)}
                        </a>
                      </span>
                    )}
                  </div>
                  {/* Inline preview for completed builds */}
                  {t === 'build' && msg.meta?.runId && (
                    <ChatPreview runId={msg.meta.runId} />
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="nw-input-area">
          <div className="nw-input-row">
            <textarea
              ref={textareaRef}
              className="nw-textarea"
              placeholder="Build, modify, or ask about your runs…"
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              aria-label="Message input"
            />
            <button
              className="nw-send"
              onClick={sendMessage}
              disabled={!input.trim() || isWaiting}
              title="Send (Enter)"
              aria-label="Send message"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <div className="nw-hint">Enter to send · Shift+Enter for new line</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Infer event type from SSE data object shape.
 * The server sends typed events but the EventSource line parsing above
 * reads only data: lines. We infer type from the data shape.
 */
function _inferEventType(data: Record<string, unknown>): string {
  if ('runId' in data && 'passed' in data) return 'complete';
  if ('phase' in data && 'runId' in data && !('message' in data && 'label' in data)) return 'pipeline_error';
  if ('phase' in data && 'label' in data && typeof data.message === 'string' && (data.message as string).startsWith('⏳')) return 'phase_start';
  if ('phase' in data && 'label' in data && typeof data.message === 'string' && (data.message as string).startsWith('✅')) return 'phase_complete';
  if ('runId' in data && 'message' in data && !('phase' in data) && !('passed' in data) && !('type' in data)) return 'run_start';
  if ('type' in data && 'conversationId' in data) return 'done';
  if ('message' in data && Object.keys(data).length === 1) return 'error';
  return 'unknown';
}
