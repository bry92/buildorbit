/**
 * terminal.js — Live terminal/sandbox panel for pipeline run pages.
 * Owns: SSE subscription for log streaming, terminal panel rendering, auto-scroll.
 * Does NOT own: phase card state (run-view.js), preview iframe (preview.js).
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────
  const PHASE_LABELS = {
    intent_gate: 'INTENT',
    plan:        'PLAN',
    scaffold:    'SCAFFOLD',
    code:        'CODE',
    save:        'SAVE',
    verify:      'VERIFY',
  };

  // ── State ─────────────────────────────────────────────
  let runId = null;
  let sse = null;
  let autoScroll = true;
  let lineCount = 0;
  let minimized = false;
  let currentPhase = null;
  let stopped = false;

  // ── DOM refs (set in init) ────────────────────────────
  let panel, body, lineContainer, topLabel, minimizeBtn;

  // ── Extract run ID from pathname ──────────────────────
  function getRunId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return (parts[0] === 'run' && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1]))
      ? parts[1] : null;
  }

  // ── HTML escape ───────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Append a line to the terminal ────────────────────
  function appendLine(phase, type, content) {
    if (!lineContainer) return;
    const phaseTag = PHASE_LABELS[phase] || (phase || '').toUpperCase();
    content.split('\n').forEach(function (rawLine) {
      const trimmed = rawLine.trimEnd();
      if (!trimmed) return;
      lineCount++;
      const row = document.createElement('div');
      row.className = 'term-row';
      const gutter = document.createElement('span');
      gutter.className = 'term-gutter';
      gutter.textContent = String(lineCount).padStart(4, ' ');
      row.appendChild(gutter);
      const chip = document.createElement('span');
      chip.className = 'term-phase term-phase-' + (phase || 'sys');
      chip.textContent = '[' + phaseTag + ']';
      row.appendChild(chip);
      const text = document.createElement('span');
      text.className = 'term-content term-type-' + (type || 'stdout');
      text.innerHTML = colorize(esc(trimmed));
      row.appendChild(text);
      lineContainer.appendChild(row);
    });
    if (autoScroll && !minimized) body.scrollTop = body.scrollHeight;
    // Keep DOM bounded
    while (lineContainer.children.length > 600) lineContainer.removeChild(lineContainer.firstChild);
  }

  // ── Simple regex-based syntax coloring (no eval) ──────
  // Returns HTML string — input is already HTML-escaped
  // Handles both JS/TS keywords and JSX-specific patterns (React, hooks, components)
  function colorize(s) {
    // Phase header lines: e.g. [CODE] or ### filename.js
    if (/^\[(?:INTENT|PLAN|SCAFFOLD|CODE|SAVE|VERIFY)\]/.test(s)) {
      return '<span class="tc-phase-hdr">' + s + '</span>';
    }
    // File/section headers: ### filename (including .jsx files)
    if (/^#{1,3}\s+\S+/.test(s)) {
      return '<span class="tc-filename">' + s + '</span>';
    }
    // JSX component tags: &lt;ComponentName (PascalCase = React component)
    s = s.replace(/(&lt;\/?)([A-Z][A-Za-z0-9]*)/g, '$1<span class="tc-jsx-component">$2</span>');
    // JSX event props: onClick, onChange, onSubmit etc.
    s = s.replace(/\b(on[A-Z][A-Za-z]+)\s*=/g, '<span class="tc-jsx-prop">$1</span>=');
    // React hooks: useState, useEffect, useRef, useMemo, useCallback, useContext
    s = s.replace(/\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer|useId)\s*\(/g,
      '<span class="tc-hook">$1</span>(');
    // React/Tailwind-specific keywords: className, createRoot, ReactDOM, Fragment
    s = s.replace(/\b(className|createRoot|ReactDOM|Fragment|StrictMode|Suspense|forwardRef)\b/g,
      '<span class="tc-jsx-kw">$1</span>');
    // Comments
    s = s.replace(/(\/\/[^\n]*)/, '<span class="tc-comment">$1</span>');
    s = s.replace(/(#\s[^\n]*)/, '<span class="tc-comment">$1</span>');
    // Strings (double or single quoted, simple)
    s = s.replace(/(&quot;[^&]*?&quot;)/g, '<span class="tc-string">$1</span>');
    s = s.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="tc-string">$1</span>');
    // JS/JSX keywords
    s = s.replace(/\b(function|const|let|var|return|if|else|for|while|class|import|export|from|async|await|new|try|catch|throw)\b/g,
      '<span class="tc-kw">$1</span>');
    return s;
  }

  // ── Update top label ──────────────────────────────────
  function setLabel(phase) {
    if (!topLabel) return;
    const tag = PHASE_LABELS[phase] || (phase || 'LOG').toUpperCase();
    topLabel.textContent = '\u25B6 ' + tag + ' PHASE \u2014 live output';
  }

  // ── SSE connection ────────────────────────────────────
  function connectSSE() {
    if (sse) { try { sse.close(); } catch (_) {} }
    const url = '/api/pipeline/' + runId + '/stream';
    const es = new EventSource(url);
    sse = es;

    es.addEventListener('connected', function (e) {
      try {
        const d = JSON.parse(e.data);
        if (d.state === 'completed' || d.state === 'failed') {
          // Run already done — show from replay instead
          loadReplay();
          es.close();
          sse = null;
          stopped = true;
        }
      } catch (_) {}
    });

    es.addEventListener('phase', function (e) {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'running') {
          currentPhase = d.phase;
          setLabel(d.phase);
          appendLine(d.phase, 'system', '\u250C\u2500 ' + (PHASE_LABELS[d.phase] || d.phase) + ' started');
        } else if (d.status === 'completed') {
          appendLine(d.phase, 'system', '\u2514\u2500 ' + (PHASE_LABELS[d.phase] || d.phase) + ' \u2713 complete');
        } else if (d.status === 'failed') {
          appendLine(d.phase, 'stderr', '\u2514\u2500 ' + (PHASE_LABELS[d.phase] || d.phase) + ' \u2717 failed');
        }
      } catch (_) {}
    });

    es.addEventListener('output', function (e) {
      try {
        const d = JSON.parse(e.data);
        if (!d.content) return;
        // Flatten structured output for display
        let text = d.content;
        if (typeof text === 'object') text = JSON.stringify(text, null, 2);
        appendLine(d.phase, 'stdout', String(text));
      } catch (_) {}
    });

    es.addEventListener('complete', function () {
      stopped = true;
      if (topLabel) topLabel.textContent = '\u25A0 BUILD COMPLETE \u2014 all phases done';
      es.close();
      sse = null;
    });

    es.addEventListener('error_event', function (e) {
      try {
        const d = JSON.parse(e.data);
        appendLine(currentPhase || 'sys', 'stderr', '\u26A0 ERROR: ' + (d.message || d.error || 'pipeline error'));
      } catch (_) {}
    });

    // Self-heal events — show retry progress in terminal
    es.addEventListener('self_heal_retry_start', function (e) {
      try {
        const d = JSON.parse(e.data);
        appendLine('verify', 'system', '\u21BB SELF-HEAL: ' + (d.message || 'Retrying CODE phase...'));
        if (d.failedChecks && d.failedChecks.length) {
          appendLine('verify', 'stderr', '  Failed checks: ' + d.failedChecks.join(', '));
        }
      } catch (_) {}
    });

    es.addEventListener('self_heal_succeeded', function (e) {
      try {
        const d = JSON.parse(e.data);
        appendLine('verify', 'system', '\u2713 SELF-HEAL SUCCEEDED: ' + (d.message || 'Fixed on retry'));
      } catch (_) {}
    });

    es.addEventListener('self_heal_exhausted', function (e) {
      try {
        const d = JSON.parse(e.data);
        appendLine('verify', 'stderr', '\u2717 SELF-HEAL EXHAUSTED: ' + (d.message || 'All retries failed'));
      } catch (_) {}
    });

    es.onerror = function () {
      if (!stopped) {
        es.close();
        sse = null;
      }
    };
  }

  // ── Load from replay (for completed runs) ─────────────
  function loadReplay() {
    fetch('/api/pipeline/' + runId + '/replay')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json || !json.success) return;
        var events = json.events || json.timeline || [];
        events.forEach(function (ev) {
          var phase = ev.stage || ev.phase || 'sys';
          if (ev.status === 'running') {
            setLabel(phase);
            appendLine(phase, 'system', '\u250C\u2500 ' + (PHASE_LABELS[phase] || phase) + ' started');
          }
          if (ev.payload) {
            var p = (typeof ev.payload === 'string') ? ev.payload : JSON.stringify(ev.payload, null, 2);
            // Truncate very large payloads to 60 lines max
            var lines = p.split('\n').slice(0, 60);
            appendLine(phase, 'stdout', lines.join('\n'));
          }
          if (ev.status === 'completed') {
            appendLine(phase, 'system', '\u2514\u2500 ' + (PHASE_LABELS[phase] || phase) + ' \u2713 complete');
          } else if (ev.status === 'failed') {
            appendLine(phase, 'stderr', '\u2514\u2500 ' + (PHASE_LABELS[phase] || phase) + ' \u2717 failed');
          }
        });
        if (topLabel) topLabel.textContent = '\u25A0 REPLAY \u2014 completed run';
      })
      .catch(function () {});
  }

  function onBodyScroll() {
    autoScroll = (body.scrollHeight - body.scrollTop - body.clientHeight) < 40;
  }

  function toggleMinimize() {
    minimized = !minimized;
    body.style.display = minimized ? 'none' : '';
    minimizeBtn.textContent = minimized ? '\u25BC' : '\u25B2';
    if (!minimized && autoScroll) body.scrollTop = body.scrollHeight;
  }

  // ── Build terminal DOM ────────────────────────────────
  function buildPanel() {
    var isMobile = window.innerWidth <= 767;

    if (isMobile) {
      panel = document.createElement('details');
      panel.className = 'terminal-panel-mobile';
      var summary = document.createElement('summary');
      summary.className = 'terminal-summary';
      summary.textContent = '\u25B6 Terminal Output';
      panel.appendChild(summary);
    } else {
      panel = document.createElement('div');
      panel.className = 'terminal-panel';
    }

    // Top bar
    var topBar = document.createElement('div');
    topBar.className = 'terminal-topbar';

    topLabel = document.createElement('span');
    topLabel.className = 'terminal-label';
    topLabel.textContent = '\u25B6 CONNECTING\u2026';
    topBar.appendChild(topLabel);

    if (!isMobile) {
      minimizeBtn = document.createElement('button');
      minimizeBtn.className = 'terminal-minimize';
      minimizeBtn.textContent = '\u25B2';
      minimizeBtn.title = 'Minimize';
      minimizeBtn.addEventListener('click', toggleMinimize);
      topBar.appendChild(minimizeBtn);
    }

    panel.appendChild(topBar);

    // Scrollable body
    body = document.createElement('div');
    body.className = 'terminal-body';
    body.addEventListener('scroll', onBodyScroll);

    lineContainer = document.createElement('div');
    lineContainer.className = 'terminal-lines';
    body.appendChild(lineContainer);

    panel.appendChild(body);

    return panel;
  }

  // ── Init ──────────────────────────────────────────────
  function init() {
    runId = getRunId();
    if (!runId) return;

    var el = buildPanel();

    // Insert after .run-split-grid, before .run-actions
    var grid = document.querySelector('.run-split-grid');
    var actions = document.querySelector('.run-actions');
    var content = document.getElementById('run-content');

    if (grid && grid.parentNode) {
      grid.parentNode.insertBefore(el, grid.nextSibling);
    } else if (actions && actions.parentNode) {
      actions.parentNode.insertBefore(el, actions);
    } else if (content) {
      content.appendChild(el);
    } else {
      document.body.appendChild(el);
    }

    connectSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // run-content is initially hidden; wait a tick for run-view.js to show it
    setTimeout(init, 200);
  }

})();
