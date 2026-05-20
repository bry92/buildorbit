/**
 * Orbit floating chat widget
 * Owns: mounting/unmounting the fixed chat bubble+panel, calling POST /a2a/orbit/chat.
 * Does NOT own: routing, auth, page layout, pipeline execution.
 *
 * Self-contained — no framework dependencies. Drop one <script> tag to activate.
 * localStorage key: orbit_conversation_id persists conversation state across sessions.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'orbit_conversation_id';
  const CSS_VERSION = '20260512a';

  // ── Inject CSS link if not already present ────────────────────
  function injectCSS() {
    if (document.getElementById('nw-styles')) return;
    const link = document.createElement('link');
    link.id = 'nw-styles';
    link.rel = 'stylesheet';
    link.href = '/css/orbit-widget.css?v=' + CSS_VERSION;
    document.head.appendChild(link);
  }

  // ── Build widget DOM ──────────────────────────────────────────
  function buildWidget() {
    const container = document.createElement('div');
    container.className = 'nw-container';
    container.id = 'nw-widget';

    container.innerHTML = `
      <!-- Bubble (collapsed state) -->
      <button class="nw-bubble" id="nwBubble" aria-label="Open Orbit chat" title="Orbit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        <span class="nw-bubble-dot" id="nwDot" aria-hidden="true"></span>
      </button>

      <!-- Panel (expanded state) -->
      <div class="nw-panel nw-hidden" id="nwPanel" role="dialog" aria-label="Orbit chat">
        <div class="nw-header">
          <div class="nw-header-left">
            <div class="nw-header-icon" aria-hidden="true">⚡</div>
            <div>
              <div class="nw-header-title">Orbit</div>
              <div class="nw-header-sub">Agentic supervisor</div>
            </div>
          </div>
          <div class="nw-header-actions">
            <button class="nw-icon-btn" id="nwNewChat" title="New conversation" aria-label="Start new conversation">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
            <button class="nw-icon-btn" id="nwClose" title="Close" aria-label="Close chat widget">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="nw-messages" id="nwMessages">
          <div class="nw-empty" id="nwEmpty">
            <div class="nw-empty-icon">⚡</div>
            <h3>Orbit</h3>
            <p>Describe what to build or modify. The agent will route, plan, and execute.</p>
          </div>
        </div>

        <div class="nw-input-area">
          <div class="nw-input-row">
            <textarea
              class="nw-textarea"
              id="nwInput"
              placeholder="Build or modify something…"
              rows="1"
              aria-label="Message input"
            ></textarea>
            <button class="nw-send" id="nwSend" disabled title="Send (Enter)" aria-label="Send message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
          <div class="nw-hint">Enter to send · Shift+Enter for new line</div>
        </div>
      </div>
    `;

    return container;
  }

  // ── State ─────────────────────────────────────────────────────
  let isOpen = false;
  let isWaiting = false;
  let conversationId = localStorage.getItem(STORAGE_KEY) || null;

  // ── DOM refs (set after mount) ────────────────────────────────
  let bubble, panel, messagesEl, emptyEl, textarea, sendBtn, dot;

  // ── Open / close ──────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;
    bubble.style.display = 'none';
    panel.classList.remove('nw-hidden', 'nw-leaving');
    panel.classList.add('nw-entering');
    panel.addEventListener('animationend', function onEnd() {
      panel.classList.remove('nw-entering');
      panel.removeEventListener('animationend', onEnd);
    });
    // Focus textarea after panel opens
    requestAnimationFrame(function () { textarea.focus(); });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.add('nw-leaving');
    panel.addEventListener('animationend', function onEnd() {
      panel.classList.remove('nw-leaving');
      panel.classList.add('nw-hidden');
      bubble.style.display = '';
      panel.removeEventListener('animationend', onEnd);
    });
  }

  // ── Empty state helpers ───────────────────────────────────────
  function hideEmpty() {
    if (emptyEl && emptyEl.parentNode) emptyEl.remove();
  }

  // ── Scroll ────────────────────────────────────────────────────
  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── HTML escape ───────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Append user bubble ────────────────────────────────────────
  function appendUser(text) {
    hideEmpty();
    var el = document.createElement('div');
    el.className = 'nw-msg nw-user';
    el.innerHTML =
      '<div class="nw-avatar">U</div>' +
      '<div class="nw-msg-body">' +
        '<div class="nw-bubble-msg">' + esc(text) + '</div>' +
      '</div>';
    messagesEl.appendChild(el);
    scrollBottom();
  }

  // ── Append thinking indicator ─────────────────────────────────
  function appendThinking() {
    hideEmpty();
    var el = document.createElement('div');
    el.className = 'nw-msg nw-agent nw-thinking';
    el.id = 'nwThinking';
    el.innerHTML =
      '<div class="nw-avatar">N</div>' +
      '<div class="nw-msg-body">' +
        '<div class="nw-bubble-msg">' +
          '<span>Thinking</span>' +
          '<div class="nw-dots"><span></span><span></span><span></span></div>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function removeThinking() {
    var el = document.getElementById('nwThinking');
    if (el) el.remove();
  }

  // ── Append agent response ─────────────────────────────────────
  function appendAgent(data) {
    var el = document.createElement('div');
    el.className = 'nw-msg nw-agent';

    var typeLabel = data.type || 'message';
    var typeClass = ['build', 'modify', 'message'].includes(typeLabel) ? typeLabel : 'message';

    var metaHtml = '<span class="nw-meta-type ' + typeClass + '">' + esc(typeLabel) + '</span>';
    if (data.runId) {
      metaHtml += '<span class="nw-meta-run"><a href="/run/' + esc(data.runId) + '" target="_blank">#' + esc(data.runId.slice(0, 8)) + '</a></span>';
    }

    el.innerHTML =
      '<div class="nw-avatar">N</div>' +
      '<div class="nw-msg-body">' +
        '<div class="nw-bubble-msg">' + esc(data.message || '') + '</div>' +
        '<div class="nw-msg-meta">' + metaHtml + '</div>' +
      '</div>';

    messagesEl.appendChild(el);
    scrollBottom();

    // Flash the dot if panel is closed
    if (!isOpen) {
      dot.classList.add('visible');
    }
  }

  // ── Append error ──────────────────────────────────────────────
  function appendError(text) {
    var el = document.createElement('div');
    el.className = 'nw-msg nw-agent nw-error';
    el.innerHTML =
      '<div class="nw-avatar" style="background:rgba(239,68,68,0.1);color:#f87171;border-color:rgba(239,68,68,0.2);">!</div>' +
      '<div class="nw-msg-body">' +
        '<div class="nw-bubble-msg">' + esc(text) + '</div>' +
      '</div>';
    messagesEl.appendChild(el);
    scrollBottom();
  }

  // ── Auto-resize textarea ──────────────────────────────────────
  function resizeTextarea() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
  }

  // ── New conversation ──────────────────────────────────────────
  function newConversation() {
    localStorage.removeItem(STORAGE_KEY);
    conversationId = null;
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyEl);
    emptyEl.style.display = '';
    textarea.value = '';
    resizeTextarea();
    sendBtn.disabled = true;
    textarea.focus();
    dot.classList.remove('visible');
  }

  // ── Send message ──────────────────────────────────────────────
  async function sendMessage() {
    var text = textarea.value.trim();
    if (!text || isWaiting) return;

    isWaiting = true;
    sendBtn.disabled = true;
    textarea.value = '';
    resizeTextarea();
    dot.classList.remove('visible');

    appendUser(text);
    appendThinking();

    try {
      var body = { message: text };
      if (conversationId) body.conversationId = conversationId;

      var res = await fetch('/a2a/orbit/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      removeThinking();

      if (!res.ok) {
        var errMsg = 'Server error (' + res.status + ')';
        try {
          var errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch (_) {}
        if (res.status === 401) errMsg = 'Session expired — please log in.';
        appendError(errMsg);
        return;
      }

      var data = await res.json();

      // Persist conversationId from first response
      if (data.conversationId && data.conversationId !== conversationId) {
        conversationId = data.conversationId;
        localStorage.setItem(STORAGE_KEY, conversationId);
      }

      appendAgent(data);
    } catch (err) {
      removeThinking();
      appendError('Network error — ' + (err.message || 'could not reach server'));
    } finally {
      isWaiting = false;
      sendBtn.disabled = !textarea.value.trim();
      textarea.focus();
    }
  }

  // ── Mount ─────────────────────────────────────────────────────
  function mount() {
    injectCSS();

    var widget = buildWidget();
    document.body.appendChild(widget);

    // Cache refs
    bubble     = document.getElementById('nwBubble');
    panel      = document.getElementById('nwPanel');
    messagesEl = document.getElementById('nwMessages');
    emptyEl    = document.getElementById('nwEmpty');
    textarea   = document.getElementById('nwInput');
    sendBtn    = document.getElementById('nwSend');
    dot        = document.getElementById('nwDot');

    // Event listeners
    bubble.addEventListener('click', open);

    document.getElementById('nwClose').addEventListener('click', close);

    document.getElementById('nwNewChat').addEventListener('click', newConversation);

    textarea.addEventListener('input', function () {
      resizeTextarea();
      sendBtn.disabled = !this.value.trim() || isWaiting;
    });

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    // Close panel when clicking outside (but not on bubble or panel itself)
    document.addEventListener('click', function (e) {
      if (!isOpen) return;
      if (panel.contains(e.target) || bubble.contains(e.target)) return;
      close();
    });

    // Escape key closes panel
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) close();
    });
  }

  // ── Init: wait for DOM ready ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
