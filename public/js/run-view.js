/**
 * Run View Page — Pipeline execution viewer with 6-phase orbital cards,
 * real-time SSE streaming, confetti celebration, and delete support.
 * Does NOT own: navigation (sidebar.js), global responsive (responsive.css).
 */
(function() {
  'use strict';

  // ── Extract run ID from URL ──────────────────────────────
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const RUN_ID = (pathParts[0] === 'run' && pathParts[1]) ? pathParts[1] : null;

  if (!RUN_ID || !/^[0-9a-f-]{36}$/i.test(RUN_ID)) {
    showError('Invalid run URL. Expected /run/:id format.');
    return;
  }

  // ── State ──────────────────────────────────────────────
  const phaseStartTimes = {};
  const phaseEndTimes = {};
  let verifyData = null;
  let buildComplete = false;
  let currentIntentClass = null;
  let elapsedInterval = null;
  let _sseSource = null;
  let _reconnectTimer = null;
  let _reconnectAttempts = 0;
  const MAX_RECONNECT = 5;
  const RECONNECT_BASE_MS = 2000;

  // ── UI helpers ─────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    $('run-loading').style.display = 'none';
    $('run-error-state').classList.add('show');
    $('run-error-msg').textContent = msg;
    setNavStatus('failed', 'error');
  }

  function setNavStatus(state, label) {
    const dot = $('nav-dot');
    const text = $('nav-status-text');
    dot.className = 'run-nav-dot ' + state;
    text.textContent = label;
  }

  // ── Starfield ──────────────────────────────────────────
  (function initStars() {
    const sf = $('star-field');
    const count = window.innerWidth < 600 ? 40 : 80;
    for (let i = 0; i < count; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.cssText = [
        'left:' + Math.random()*100 + '%',
        'top:' + Math.random()*100 + '%',
        'opacity:' + (Math.random()*0.4+0.1),
        'animation-delay:' + Math.random()*4 + 's',
        'animation-duration:' + (Math.random()*3+2) + 's',
        'width:' + (Math.random()<0.2 ? '3px' : '2px'),
        'height:' + (Math.random()<0.2 ? '3px' : '2px'),
      ].join(';');
      sf.appendChild(s);
    }
  })();

  // ── Typewriter effect ──────────────────────────────────
  function typeText(targetEl, cursorEl, text, onDone) {
    let i = 0;
    cursorEl.style.display = 'inline-block';
    const chars = [...text];
    const speed = Math.max(12, Math.min(40, 1200 / chars.length));
    function tick() {
      if (i < chars.length) {
        targetEl.insertBefore(document.createTextNode(chars[i]), cursorEl);
        i++;
        setTimeout(tick, speed);
      } else {
        setTimeout(() => { cursorEl.style.display = 'none'; if(onDone) onDone(); }, 2000);
      }
    }
    setTimeout(tick, 300);
  }

  // ── Phase state machine ────────────────────────────────
  const PHASES = ['intent_gate','plan','scaffold','code','save','verify'];

  function setPhaseState(phase, state) {
    const card = $('phase-' + phase);
    if (!card) return;
    card.className = 'phase-card state-' + state;

    const badge = $('badge-' + phase);
    if (!badge) return;

    const texts = { waiting:'waiting', running:'running', complete:'complete', failed:'failed' };
    badge.querySelector('.badge-text').textContent = texts[state] || state;
    badge.className = 'phase-status-badge badge-' + state;

    const body = $('body-' + phase);
    if (body && (state === 'running' || state === 'complete' || state === 'failed')) {
      body.classList.add('open');
    }

    const idx = PHASES.indexOf(phase);
    if (idx > 0) {
      const conn = $('conn-' + (idx-1));
      if (conn) {
        conn.className = 'orbital-connector ' + (state === 'complete' ? 'complete' : (state === 'running' ? 'active' : ''));
      }
    }
  }

  function recordPhaseStart(phase) {
    phaseStartTimes[phase] = Date.now();
    setPhaseState(phase, 'running');
  }

  function recordPhaseEnd(phase, success) {
    phaseEndTimes[phase] = Date.now();
    const state = success ? 'complete' : 'failed';
    setPhaseState(phase, state);
    const el = $('elapsed-' + phase);
    if (el && phaseStartTimes[phase]) {
      const ms = phaseEndTimes[phase] - phaseStartTimes[phase];
      el.textContent = formatDuration(ms);
      el.style.display = 'inline';
    }
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms/1000).toFixed(1) + 's';
    const m = Math.floor(ms/60000);
    const s = Math.floor((ms%60000)/1000);
    return m + 'm' + s + 's';
  }

  function startElapsedTimer(phase) {
    if (elapsedInterval) clearInterval(elapsedInterval);
    const el = $('elapsed-' + phase);
    if (!el) return;
    el.style.display = 'inline';
    elapsedInterval = setInterval(() => {
      if (!phaseStartTimes[phase]) return;
      el.textContent = formatDuration(Date.now() - phaseStartTimes[phase]);
    }, 500);
  }

  function stopElapsedTimer() {
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  }

  // ── Phase content renderers ────────────────────────────

  const IC_MAP = {
    'static_surface': { label:'Static Surface', icon:'\u{1F310}', cls:'static' },
    'STATIC_SURFACE':  { label:'Static Surface', icon:'\u{1F310}', cls:'static' },
    'light_app':       { label:'Light App',      icon:'\u26A1',    cls:'' },
    'INTERACTIVE_LIGHT_APP': { label:'Light App', icon:'\u26A1',   cls:'' },
    'soft_expansion':  { label:'Adaptive Build',  icon:'\u26A1',    cls:'' },
    'full_product':    { label:'Full Product',   icon:'\u{1F3D7}', cls:'product' },
    'PRODUCT_SYSTEM':  { label:'Full Product',   icon:'\u{1F3D7}', cls:'product' },
  };

  function renderIntentGate(data) {
    const container = $('intent-gate-data');
    if (!container) return;

    const ic = data.intent_class || data.raw_class || '';
    const icInfo = IC_MAP[ic] || { label: ic || 'Classified', icon:'\u{1F50E}', cls:'' };

    const badge = $('intent-badge');
    if (badge) {
      badge.textContent = icInfo.icon + ' ' + icInfo.label;
      badge.className = 'intent-badge ' + icInfo.cls;
      badge.style.display = 'inline-flex';
      currentIntentClass = ic;
    }

    const confidence = data.confidence ? Math.round(data.confidence * 100) : null;
    const complexity = data.complexity_budget || null;

    let html = '';
    html += '<div class="intent-data-item">';
    html += '<div class="intent-data-label">Intent Class</div>';
    html += '<div class="intent-data-value">' + icInfo.icon + ' ' + icInfo.label + '</div>';
    html += '</div>';

    if (confidence !== null) {
      html += '<div class="intent-data-item">';
      html += '<div class="intent-data-label">Confidence</div>';
      html += '<div class="intent-data-value">' + confidence + '%</div>';
      html += '<div class="confidence-bar"><div class="confidence-fill" style="width:' + confidence + '%"></div></div>';
      html += '</div>';
    }

    if (complexity) {
      html += '<div class="intent-data-item">';
      html += '<div class="intent-data-label">Complexity Budget</div>';
      html += '<div class="intent-data-value">' + escHtml(String(complexity)) + '</div>';
      html += '</div>';
    }

    if (data.expansion_lock !== undefined) {
      html += '<div class="intent-data-item">';
      html += '<div class="intent-data-label">Expansion Lock</div>';
      html += '<div class="intent-data-value">' + (data.expansion_lock ? '\u{1F512} Locked' : '\u{1F513} Open') + '</div>';
      html += '</div>';
    }

    if (data.constraints && typeof data.constraints === 'object') {
      const entries = Object.entries(data.constraints);
      if (entries.length > 0) {
        html += '<div class="constraints-list">';
        html += '<div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;color:var(--text-dim)">Constraints</div>';
        entries.forEach(([k,v]) => {
          html += '<div><span style="color:var(--accent)">' + escHtml(k) + '</span>: ' + escHtml(String(v)) + '</div>';
        });
        html += '</div>';
      }
    }

    container.innerHTML = html;
  }

  function renderPlanChecklist(content) {
    const container = $('content-plan');
    if (!container) return;

    const lines = content.split('\n').filter(l => l.trim());
    const tasks = [];

    lines.forEach(line => {
      const trimmed = line.trim();
      const checkedMatch = trimmed.match(/^[-*]\s*\[x\]\s*(.*)/i);
      const uncheckedMatch = trimmed.match(/^[-*]\s*\[\s*\]\s*(.*)/i);
      const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
      const numberedMatch = trimmed.match(/^\d+[.)]\s+(.*)/);

      if (checkedMatch) tasks.push({ text: checkedMatch[1], checked: true });
      else if (uncheckedMatch) tasks.push({ text: uncheckedMatch[1], checked: false });
      else if (bulletMatch) tasks.push({ text: bulletMatch[1], checked: false });
      else if (numberedMatch) tasks.push({ text: numberedMatch[1], checked: false });
      else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('**')) {
        tasks.push({ text: trimmed, checked: false });
      }
    });

    if (tasks.length === 0) {
      container.innerHTML = '<div class="streaming-output">' + escHtml(content) + '</div>';
      return;
    }

    const html = tasks.map(t =>
      '<div class="plan-item' + (t.checked ? ' checked' : '') + '">' +
        '<div class="plan-check"><span class="plan-check-mark">\u2713</span></div>' +
        '<div class="plan-item-text">' + escHtml(t.text) + '</div>' +
      '</div>'
    ).join('');
    container.innerHTML = html;
  }

  function renderScaffoldTree(data) {
    const treeEl = $('scaffold-tree');
    const summaryEl = $('scaffold-summary');
    if (!treeEl) return;

    let tree = [];
    let techStack = [];

    if (typeof data === 'object' && data !== null) {
      tree = Array.isArray(data.tree) ? data.tree : [];
      techStack = Array.isArray(data.techStack) ? data.techStack : [];
    } else if (typeof data === 'string') {
      const lines = data.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      lines.forEach(l => {
        const m = l.match(/([📁📄]\s*)?(.+)/);
        if (m) tree.push({ path: m[2].trim(), type: l.includes('/') ? 'dir' : 'file' });
      });
    }

    if (tree.length === 0) {
      treeEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">Generating structure\u2026</div>';
      return;
    }

    treeEl.innerHTML = tree.map((item, i) => {
      const indent = item.depth ? '  '.repeat(item.depth) : '';
      const isDir = item.type === 'dir' || item.path.endsWith('/');
      return '<div class="tree-item ' + (isDir ? 'dir' : '') + '" style="animation-delay:' + (i*30) + 'ms">' +
        '<span class="tree-item-icon">' + (isDir ? '\u{1F4C1}' : '\u{1F4C4}') + '</span>' +
        '<span>' + escHtml(indent + item.path) + '</span>' +
      '</div>';
    }).join('');

    if (summaryEl) {
      const fileCount = tree.filter(t => t.type !== 'dir' && !t.path.endsWith('/')).length;
      const dirCount = tree.filter(t => t.type === 'dir' || t.path.endsWith('/')).length;
      let chips = '';
      if (fileCount > 0) chips += '<div class="scaffold-chip"><span>' + fileCount + '</span> files</div>';
      if (dirCount > 0) chips += '<div class="scaffold-chip"><span>' + dirCount + '</span> dirs</div>';
      if (techStack.length > 0) chips += '<div class="scaffold-chip">' + escHtml(techStack.join(' \u00B7 ')) + '</div>';
      summaryEl.innerHTML = chips;
    }
  }

  // Streaming code
  let codeBuffer = '';
  let codeFileCount = 0;

  function appendCodeChunk(content) {
    codeBuffer += content;
    const el = $('content-code');
    if (!el) return;

    const lines = codeBuffer.split('\n');
    const last = lines.slice(-40).join('\n');
    el.textContent = last;
    el.scrollTop = el.scrollHeight;

    const filenameMatch = content.match(/###\s+([^\n]+)|^\s*\/\/\s+([a-zA-Z0-9_./\-]+\.[a-z]{1,5})/m);
    if (filenameMatch) {
      const fn = filenameMatch[1] || filenameMatch[2];
      const fnEl = $('code-filename');
      if (fnEl) fnEl.textContent = fn.trim();
    }

    const codeBlockStarts = (codeBuffer.match(/^```[a-z]*/gm) || []).length;
    codeFileCount = Math.ceil(codeBlockStarts / 2) || 0;
    const cntEl = $('code-file-count');
    if (cntEl && codeFileCount > 0) cntEl.textContent = codeFileCount + ' file' + (codeFileCount !== 1 ? 's' : '');
  }

  function renderCodeComplete(data) {
    const el = $('content-code');
    if (!el) return;

    if (data && data.files && typeof data.files === 'object') {
      const entries = Object.entries(data.files);
      codeFileCount = entries.length;
      const cntEl = $('code-file-count');
      if (cntEl) cntEl.textContent = codeFileCount + ' file' + (codeFileCount !== 1 ? 's' : '') + ' generated';

      if (entries.length > 0) {
        const [firstName, firstContent] = entries[0];
        const fnEl = $('code-filename');
        if (fnEl) fnEl.textContent = firstName;
        const lines = String(firstContent).split('\n');
        el.textContent = lines.slice(0, 40).join('\n');
      }
    } else if (typeof data === 'string') {
      const lines = data.split('\n');
      el.textContent = lines.slice(-40).join('\n');
    }
  }

  function renderSavePhase(data) {
    const versionEl = $('save-version-id');
    const tsEl = $('save-timestamp');

    if (versionEl) {
      if (data && data.versionId) {
        versionEl.textContent = data.versionId.slice(0, 16) + '\u2026';
      } else {
        versionEl.textContent = '\u2713 Saved';
      }
    }
    if (tsEl) {
      tsEl.textContent = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';
    }
  }

  function renderVerifyChecks(checksData) {
    const container = $('content-verify');
    const passRate = $('verify-pass-rate');
    const fill = $('pass-rate-fill');
    const label = $('pass-rate-label');
    if (!container || !checksData) return;

    const checks = Array.isArray(checksData.checks) ? checksData.checks : [];
    if (checks.length === 0) return;

    const passed = checks.filter(c => c.passed).length;
    const total = checks.length;
    const pct = total > 0 ? Math.round(passed/total*100) : 0;
    const failedNames = checks.filter(c => !c.passed).map(c => c.name);

    const html = checks.map((c, idx) => {
      const tier = c.tier || c.type || '';
      const checkId = 'vcheck-' + idx;
      const encodedName = encodeURIComponent(c.name || '');
      let item = '<div id="' + checkId + '" class="verify-check-item ' + (c.passed ? 'pass' : 'fail') + '" data-check-name="' + escHtml(c.name || '') + '">' +
        '<div class="verify-check-icon">' + (c.passed ? '\u2713' : '\u2715') + '</div>' +
        '<div class="verify-check-name">' + escHtml(c.name || c.label || '') + '</div>' +
        (tier ? '<div class="verify-check-tier">' + escHtml(tier.toUpperCase()) + '</div>' : '');
      // Fix button on failed checks
      if (!c.passed) {
        item += '<button class="verify-fix-btn" id="fixbtn-' + checkId + '" onclick="event.stopPropagation(); window._triggerVerifyFix(this, \'' + encodedName + '\', \'' + checkId + '\')" title="Auto-fix this failed check">' +
          '<span class="fix-icon">&#x1F527;</span> Fix</button>';
      }
      item += '</div>';
      // Hidden details area for fix result messages
      if (!c.passed) {
        item += '<div class="verify-fix-details" id="details-' + checkId + '" style="display:none"></div>';
      }
      return item;
    }).join('');

    // Summary row with Fix All button
    let summary = '<div class="verify-summary-row" id="verify-summary-row">' +
      '<span>' + total + ' checks run</span>' +
      '<span class="verify-summary-badge ' + (passed === total ? 'all-pass' : (passed === 0 ? 'failed' : 'partial')) + '">' +
      (passed === total ? 'All checks passed' : passed + '/' + total + ' passed') + '</span>';
    if (failedNames.length > 0) {
      const failedJson = escHtml(JSON.stringify(failedNames));
      summary += '<button class="verify-fix-all-btn" id="verify-fix-all-btn" onclick="window._triggerVerifyFixAll(this, \'' + failedJson + '\')" title="Attempt automatic fix for all failed checks">&#x1F527; Fix All (' + failedNames.length + ')</button>';
    }
    summary += '</div>';

    container.innerHTML = html + summary;

    if (passRate) { passRate.style.display = 'flex'; }
    if (fill) { fill.style.width = pct + '%'; }
    if (label) { label.textContent = passed + '/' + total; }
  }

  // ── GitHub PR button ───────────────────────────────────
  function showGitHubPrButton(prUrl) {
    if (!prUrl) return;
    const btn = $('btn-github-pr');
    if (!btn) return;
    btn.href = prUrl;
    btn.style.display = 'inline-flex';
  }

  // ── Polsia live app button ─────────────────────────────
  function showPolsiaLiveButton(liveUrl) {
    if (!liveUrl) return;
    const btn = $('btn-polsia-live');
    if (!btn) return;
    btn.href = liveUrl;
    btn.style.display = 'inline-flex';
  }

  // ── CATASTROPHIC BLOCK BANNER ──────────────────────────
  // Shows a warning overlay when the SAVE phase blocks a catastrophic rewrite.
  // The user must explicitly confirm to override and proceed.
  function showCatastrophicBlockBanner(data) {
    // Remove any existing banner to avoid duplicates
    const existing = $('catastrophic-block-banner');
    if (existing) existing.remove();

    const stats = data.stats || {};
    const deletedCount = stats.deletedFileCount || 0;
    const rewriteRatio = ((stats.rewrittenRatio || 0) * 100).toFixed(0);
    const topoDelta = ((stats.topologyDelta || 0) * 100).toFixed(0);
    const removedPkgs = stats.removedPackageCount || 0;

    const violations = (stats.violations || []).map(v =>
      '<li style="margin:4px 0;color:#ef4444">' + escHtml(v.message) + '</li>'
    ).join('');

    const deletedList = (stats.deletedFiles || []).slice(0, 8).map(f =>
      '<code style="display:block;font-size:0.72rem;opacity:0.75;margin:1px 0">' + escHtml(f) + '</code>'
    ).join('');

    const banner = document.createElement('div');
    banner.id = 'catastrophic-block-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
      'max-width:440px', 'width:calc(100vw - 48px)',
      'background:#1a0a0a', 'border:1.5px solid #dc2626',
      'border-radius:12px', 'padding:20px 24px',
      'box-shadow:0 8px 32px rgba(220,38,38,0.25)',
      'font-family:inherit', 'color:#f1f5f9',
    ].join(';');

    banner.innerHTML = [
      '<div style="display:flex;align-items:flex-start;gap:12px">',
        '<span style="font-size:1.4rem;line-height:1">⛔</span>',
        '<div style="flex:1;min-width:0">',
          '<div style="font-weight:700;font-size:0.95rem;color:#ef4444;margin-bottom:6px">Catastrophic Rewrite Blocked</div>',
          '<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:10px">' + escHtml(data.reason || 'Dangerous changes detected') + '</div>',
          '<ul style="list-style:none;padding:0;margin:0 0 10px">' + violations + '</ul>',
          deletedCount > 0
            ? '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:4px">' + deletedCount + ' file(s) would be deleted:</div>' +
              '<div style="background:#0f172a;border-radius:6px;padding:8px;margin-bottom:10px;max-height:90px;overflow:auto">' + deletedList + '</div>'
            : '',
          '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">',
            '<button onclick="confirmCatastrophicOverride()" style="background:#dc2626;color:#fff;border:none;border-radius:7px;padding:8px 16px;font-size:0.82rem;font-weight:600;cursor:pointer;letter-spacing:0.02em">',
              'Override & Push Anyway',
            '</button>',
            '<button onclick="document.getElementById(\'catastrophic-block-banner\').remove()" style="background:transparent;color:#64748b;border:1px solid #334155;border-radius:7px;padding:8px 14px;font-size:0.82rem;cursor:pointer">',
              'Dismiss',
            '</button>',
          '</div>',
        '</div>',
      '</div>',
    ].join('');

    document.body.appendChild(banner);
  }

  // Called by the "Override & Push Anyway" button in the catastrophic block banner.
  window.confirmCatastrophicOverride = async function() {
    const banner = $('catastrophic-block-banner');
    const btn = banner && banner.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending override\u2026'; }

    try {
      const res = await fetch('/api/pipeline/' + RUN_ID + '/override-catastrophic-block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.message || 'Override failed. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Override & Push Anyway'; }
        return;
      }
      // Success — remove banner, update status
      if (banner) banner.remove();
      setNavStatus('running', 'override confirmed\u2026');
    } catch (err) {
      alert('Override request failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Override & Push Anyway'; }
    }
  };

  // ── FAILURE RECOVERY BANNER ────────────────────────────
  // Shows when status = 'failed': human-readable error, retry button, debug tips.
  // Idempotent — calling twice replaces the existing banner.

  const ERROR_TIPS = {
    intent_gate: [
      'Try rephrasing your task as a single clear goal.',
      'Avoid ambiguous pronouns — be specific about what you want built.',
      'Shorter prompts often classify better than long ones.',
    ],
    plan: [
      'Simplify your prompt — very broad scope can overwhelm the planner.',
      'Break the task into smaller, specific goals and retry one at a time.',
      'Avoid combining unrelated features in a single build request.',
    ],
    scaffold: [
      'Try a more specific prompt — vague tasks can produce invalid structures.',
      'If you selected a source repo, verify it is accessible and not empty.',
    ],
    code: [
      'Try simplifying your prompt — a narrower scope generates cleaner code.',
      'Retry: the code phase occasionally fails on complex multi-file builds.',
      'If this keeps failing, split your feature into smaller sub-tasks.',
    ],
    save: [
      'Check that your GitHub connection is still active in Settings.',
      'Try retrying — intermittent save failures often resolve on the second attempt.',
      'If a catastrophic rewrite was blocked, use the override option above.',
    ],
    verify: [
      'Use the 🔧 Fix buttons on individual failed checks below.',
      'Try "Fix All" to let the AI patch all failures automatically.',
      'Some checks may need a prompt refinement — retry with a clearer task.',
    ],
    default: [
      'Retry the build — transient failures often resolve immediately.',
      'If retrying fails repeatedly, try simplifying your prompt.',
      'Check your API connection status in Settings.',
    ],
  };

  function _humanizeError(raw) {
    if (!raw) return null;
    // Strip stack traces — keep only the first meaningful line
    const firstLine = raw.split('\n')[0].trim();
    // Remove common noisy prefixes
    const cleaned = firstLine
      .replace(/^Error:\s*/i, '')
      .replace(/^Unhandled rejection:\s*/i, '')
      .replace(/^TypeError:\s*/i, '')
      .replace(/^ReferenceError:\s*/i, '')
      .replace(/^SyntaxError:\s*/i, '');
    // Truncate if very long
    return cleaned.length > 200 ? cleaned.slice(0, 197) + '\u2026' : cleaned;
  }

  function showFailureBanner(rawReason, stage) {
    const existing = $('failure-recovery-banner');
    if (existing) existing.remove();

    const tips = ERROR_TIPS[stage] || ERROR_TIPS.default;
    const humanReason = _humanizeError(rawReason);

    const banner = document.createElement('div');
    banner.id = 'failure-recovery-banner';
    banner.className = 'failure-recovery-banner';

    const stageLabel = stage
      ? stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : null;

    let reasonHtml = '';
    if (humanReason) {
      reasonHtml = '<div class="frb-reason"><span class="frb-reason-icon">\u26A0\uFE0F</span>' +
        '<span class="frb-reason-text">' + escHtml(humanReason) + '</span></div>';
    }

    const tipsHtml = tips.map(t =>
      '<li class="frb-tip-item">' + escHtml(t) + '</li>'
    ).join('');

    banner.innerHTML =
      '<div class="frb-header">' +
        '<div class="frb-title-row">' +
          '<span class="frb-icon">\u274C</span>' +
          '<span class="frb-title">Build Failed' + (stageLabel ? ' \u2014 ' + stageLabel + ' Phase' : '') + '</span>' +
        '</div>' +
        reasonHtml +
      '</div>' +
      '<div class="frb-body">' +
        '<div class="frb-tips">' +
          '<div class="frb-tips-label">Debug tips</div>' +
          '<ul class="frb-tips-list">' + tipsHtml + '</ul>' +
        '</div>' +
        '<div class="frb-actions">' +
          '<button class="frb-retry-btn" id="frb-retry-btn" onclick="window._retryBuild()">&#x21BA; Retry Build</button>' +
          '<a href="/new" class="frb-new-btn">+ New Build</a>' +
        '</div>' +
      '</div>';

    // Insert after the orbital track, before run-actions
    const track = $('orbital-track');
    if (track && track.parentNode) {
      track.parentNode.insertBefore(banner, track.nextSibling);
    } else {
      const main = $('run-content');
      if (main) main.appendChild(banner);
    }
  }

  window._retryBuild = async function() {
    const btn = $('frb-retry-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '\u23F3 Retrying\u2026';

    try {
      const res = await fetch('/api/pipeline/' + RUN_ID + '/retry', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        // Remove the failure banner and reset nav status — stream will show progress
        const banner = $('failure-recovery-banner');
        if (banner) banner.remove();
        setNavStatus('running', 'retrying\u2026');
        // Re-connect SSE to pick up the new execution
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        _reconnectAttempts = 0;
        connectStream();
      } else {
        btn.disabled = false;
        btn.textContent = '\u21BA Retry Build';
        const msg = data.message || 'Retry failed — please try again.';
        // Show error inline in the banner
        let errEl = document.getElementById('frb-retry-error');
        if (!errEl) {
          errEl = document.createElement('div');
          errEl.id = 'frb-retry-error';
          errEl.className = 'frb-retry-error';
          btn.parentNode.insertBefore(errEl, btn.nextSibling);
        }
        errEl.textContent = msg;
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '\u21BA Retry Build';
    }
  };

  // ── BUILD COMPLETE ─────────────────────────────────────
  function triggerBuildComplete(passed, runData) {
    if (buildComplete) return;
    buildComplete = true;

    const banner = $('build-complete-banner');
    const title = $('bc-title');
    const sub = $('bc-sub');
    const traceBtn = $('bc-trace-btn');
    const editBtn = $('btn-edit');

    if (traceBtn) traceBtn.href = '/dag?run=' + RUN_ID;
    if (editBtn) { editBtn.href = '/run/' + RUN_ID + '/edit'; editBtn.style.display = 'inline-flex'; }

    // Show Expo export button on build complete
    const expoBtn = $('btn-expo-export');
    if (expoBtn) expoBtn.style.display = 'inline-flex';

    if (passed) {
      banner.classList.add('show');
      if (title) title.textContent = '\u{1F680} BUILD COMPLETE';
      if (sub) sub.textContent = 'All checks passed \u2014 artifacts saved and verified';
      setNavStatus('complete', 'complete');
      fireConfetti();
    } else {
      banner.classList.add('show');
      if (title) { title.textContent = '\u26A0 BUILD COMPLETE (partial)'; title.style.color = 'var(--warning)'; }
      if (sub) sub.textContent = 'Build finished with some verification warnings';
      const inner = banner.querySelector('.build-complete-inner');
      if (inner) {
        inner.style.background = 'linear-gradient(135deg,rgba(251,191,36,0.1),rgba(56,189,248,0.06))';
        inner.style.borderColor = 'rgba(251,191,36,0.3)';
      }
      setNavStatus('complete', 'done');
    }

    // Inject upgrade CTA for trial users (fire-and-forget billing check)
    maybeInjectUpgradeCta();

    updateRunDuration();
  }

  // ── Post-build upgrade CTA for trial users ─────────────
  // Fires after BUILD COMPLETE; checks billing status and injects
  // an upgrade nudge into bc-actions if the user is still on trial.
  async function maybeInjectUpgradeCta() {
    try {
      const r = await fetch('/api/billing/status');
      if (!r.ok) return;
      const d = await r.json();
      if (!d.success) return;
      if (d.subscription_status === 'active' || d.is_admin) return; // already pro

      const actions = $('bc-actions');
      if (!actions) return;

      const upgradeLink = document.createElement('a');
      upgradeLink.href = '/pricing';
      upgradeLink.className = 'bc-btn bc-btn-upgrade';
      upgradeLink.textContent = '⚡ Unlock unlimited builds →';
      // Insert before the first button so it sits left of "New Build"
      actions.insertBefore(upgradeLink, actions.firstChild);
    } catch (_) { /* non-fatal */ }
  }

  function updateRunDuration() {
    const chip = $('run-duration-chip');
    if (!chip) return;
    const starts = Object.values(phaseStartTimes);
    const ends = Object.values(phaseEndTimes);
    if (starts.length === 0) return;
    const totalMs = (ends.length > 0 ? Math.max(...ends) : Date.now()) - Math.min(...starts);
    chip.textContent = 'Total: ' + formatDuration(totalMs);
    chip.style.display = 'inline-block';
  }

  // ── Confetti ───────────────────────────────────────────
  function fireConfetti() {
    const container = $('confetti-container');
    if (!container) return;
    const colors = ['#38bdf8','#34d399','#fbbf24','#a78bfa','#f87171','#e8edf5'];
    const count = window.innerWidth < 600 ? 30 : 60;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const p = document.createElement('div');
        p.className = 'confetti-particle';
        p.style.cssText = [
          'left:' + (10 + Math.random()*80) + '%',
          'background:' + colors[Math.floor(Math.random()*colors.length)],
          'animation-delay:' + Math.random()*1.2 + 's',
          'animation-duration:' + (2 + Math.random()*2) + 's',
          'width:' + (4+Math.floor(Math.random()*8)) + 'px',
          'height:' + (4+Math.floor(Math.random()*8)) + 'px',
          'border-radius:' + (Math.random() > 0.5 ? '50%' : '2px'),
        ].join(';');
        container.appendChild(p);
        setTimeout(() => p.remove(), 5000);
      }, i * 50);
    }
  }

  // ── HTML escaping ──────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ── SSE stream connection ──────────────────────────────
  // Accumulator for scaffold streaming text chunks.
  // _streamText sends 6-char chunks; we accumulate here so the full tree
  // is visible during streaming instead of only the last fragment.
  let _scaffoldStreamBuf = '';

  function connectStream() {
    if (_sseSource) { _sseSource.close(); _sseSource = null; }
    _scaffoldStreamBuf = '';

    const url = '/api/pipeline/' + RUN_ID + '/stream';
    const es = new EventSource(url);
    _sseSource = es;

    es.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      setNavStatus('running', 'connected');
      _reconnectAttempts = 0;

      if (data.state === 'completed' || data.state === 'failed') {
        setNavStatus('complete', data.state);
      }
    });

    es.addEventListener('phase', (e) => {
      const data = JSON.parse(e.data);
      const { phase, status, payload } = data;

      if (status === 'running') {
        recordPhaseStart(phase);
        startElapsedTimer(phase);
        setNavStatus('running', phase.replace('_',' ') + '\u2026');
      } else if (status === 'completed') {
        stopElapsedTimer();
        recordPhaseEnd(phase, true);

        // If SAVE phase completed with action URLs, show the relevant buttons
        if (phase === 'save' && payload) {
          try {
            const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (p && p.githubPrUrl) showGitHubPrButton(p.githubPrUrl);
            if (p && p.polsiaAppUrl) showPolsiaLiveButton(p.polsiaAppUrl);
          } catch(_) {}
        }
      } else if (status === 'failed') {
        stopElapsedTimer();
        recordPhaseEnd(phase, false);
        setNavStatus('failed', phase + ' failed');
        // Show failure recovery banner — error text may arrive via error_event or phase payload
        const errMsg = (payload && typeof payload === 'object' && payload.error)
          ? payload.error
          : (typeof payload === 'string' ? payload : null);
        showFailureBanner(errMsg, phase);
      }
    });

    es.addEventListener('output', (e) => {
      const data = JSON.parse(e.data);
      const { phase, content } = data;
      if (!content) return;

      if (phase === 'intent_gate') {
        try {
          const parsed = JSON.parse(content);
          renderIntentGate(parsed);
        } catch(_) {
          const container = $('intent-gate-data');
          if (container) container.innerHTML = '<div class="streaming-output">' + escHtml(content) + '</div>';
        }
      } else if (phase === 'plan') {
        renderPlanChecklist(content);
      } else if (phase === 'scaffold') {
        try {
          const parsed = JSON.parse(content);
          renderScaffoldTree(parsed);
        } catch(_) {
          // Streaming text chunks — accumulate instead of replacing.
          // _streamText sends 6-char chunks; replacing innerHTML on each
          // chunk would show only the final fragment (e.g. "false" from
          // the constraints line "db=false").
          _scaffoldStreamBuf += content;
          const treeEl = $('scaffold-tree');
          if (treeEl) treeEl.innerHTML = '<div style="white-space:pre;font-size:0.8rem;color:var(--text-dim)">' + escHtml(_scaffoldStreamBuf) + '</div>';
        }
      } else if (phase === 'code') {
        appendCodeChunk(content);
      } else if (phase === 'save') {
        try { renderSavePhase(JSON.parse(content)); } catch(_) {}
      } else if (phase === 'verify') {
        const container = $('content-verify');
        if (container && !verifyData) {
          container.innerHTML = '<div class="streaming-output">' + escHtml(content) + '</div>';
        }
      }
    });

    es.addEventListener('intent_classified', (e) => {
      const data = JSON.parse(e.data);
      renderIntentGate(data);
    });

    es.addEventListener('scaffold_complete', (e) => {
      // Structured scaffold data — replaces streamed text with proper tree UI.
      // Emitted by the server on every scaffold completion (live + replay).
      const data = JSON.parse(e.data);
      _scaffoldStreamBuf = '';
      renderScaffoldTree(data);
    });

    es.addEventListener('verify_report', (e) => {
      const data = JSON.parse(e.data);
      verifyData = data;
      renderVerifyChecks(data);
      triggerBuildComplete(data.passed, data);
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      stopElapsedTimer();
      setNavStatus('complete', 'complete');
      es.close();
      _sseSource = null;
      updateRunDuration();

      if (!buildComplete) {
        triggerBuildComplete(data.passed !== false, data);
      }
    });

    es.addEventListener('catastrophic_rewrite_blocked', (e) => {
      try {
        const data = JSON.parse(e.data);
        showCatastrophicBlockBanner(data);
        setNavStatus('failed', 'blocked');
      } catch(_) {}
    });

    es.addEventListener('error_event', (e) => {
      try {
        const evData = JSON.parse(e.data);
        setNavStatus('failed', 'error');
        // Show failure recovery banner with live error message if available
        showFailureBanner(evData.message || evData.error || null, evData.stage || null);
      } catch(_) {}
    });

    es.onerror = () => {
      es.close();
      _sseSource = null;
      if (_reconnectAttempts >= MAX_RECONNECT) {
        setNavStatus('failed', 'disconnected');
        return;
      }
      _reconnectAttempts++;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, _reconnectAttempts - 1), 30000);
      setNavStatus('running', 'reconnecting\u2026');
      _reconnectTimer = setTimeout(connectStream, delay);
    };
  }

  // ── Initial data load ──────────────────────────────────
  async function init() {
    try {
      const res = await fetch('/api/pipeline/' + RUN_ID + '/details');
      if (res.status === 401) {
        window.location.href = '/auth/login?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Run not found');

      const run = json.run;

      $('run-loading').style.display = 'none';
      $('run-content').style.display = 'block';

      // Typewriter prompt
      const promptEl = $('run-prompt-text');
      const cursorEl = $('prompt-cursor');
      promptEl.innerHTML = '';
      promptEl.appendChild(cursorEl);
      typeText(promptEl, cursorEl, run.prompt || '');

      // Metadata
      const idEl = $('run-id-display');
      if (idEl) idEl.textContent = RUN_ID.slice(0,8) + '\u2026';

      const createdEl = $('run-created-at');
      if (createdEl && run.created_at) {
        createdEl.textContent = new Date(run.created_at).toLocaleString();
      }

      // Action links
      const traceBtn = $('btn-trace');
      if (traceBtn) traceBtn.href = '/dag?run=' + RUN_ID;
      const exportBtn = $('btn-export');
      // Download ZIP includes all generated files (React project or standard build).
      // Falls back to compliance JSON export if run has no code files yet.
      if (exportBtn) {
        exportBtn.href = '/api/pipeline/' + RUN_ID + '/code-files/download';
        exportBtn.download = '';  // triggers browser download instead of navigation
        exportBtn.title = 'Download project as ZIP (React + all files)';
        exportBtn.textContent = '\u2193 Download ZIP';
      }
      const editBtn = $('btn-edit');
      if (editBtn) editBtn.href = '/run/' + RUN_ID + '/edit';

      const isFinished = ['completed','failed','error','cancelled'].includes(run.status);

      if (run.intent_class) {
        const badge = $('intent-badge');
        const icInfo = IC_MAP[run.intent_class] || { label: run.intent_class, icon:'\u{1F50E}', cls:'' };
        if (badge) {
          badge.textContent = icInfo.icon + ' ' + icInfo.label;
          badge.className = 'intent-badge ' + icInfo.cls;
          badge.style.display = 'inline-flex';
        }
        renderIntentGate({ intent_class: run.intent_class });
        setPhaseState('intent_gate', 'complete');
      }

      if (run.plan) {
        const planText = typeof run.plan === 'object'
          ? (run.plan.rawMarkdown || run.plan.raw || JSON.stringify(run.plan, null, 2))
          : String(run.plan);
        renderPlanChecklist(planText);
        setPhaseState('plan', 'complete');
      }

      if (run.scaffold) {
        renderScaffoldTree(run.scaffold);
        setPhaseState('scaffold', 'complete');
      }

      if (run.files && Object.keys(run.files).length > 0) {
        renderCodeComplete({ files: run.files });
        setPhaseState('code', 'complete');
        if (editBtn) editBtn.style.display = 'inline-flex';
      }

      // Show Expo export button if build already finished
      const expoBtn2 = $('btn-expo-export');
      if (expoBtn2 && isFinished && run.status === 'completed') {
        expoBtn2.style.display = 'inline-flex';
      }

      // Show "View PR on GitHub" button if this run has a PR URL
      if (run.github_pr_url) {
        showGitHubPrButton(run.github_pr_url);
      }

      // Show "View Live App" button if this run has a Polsia CDN URL
      if (run.polsia_app_url) {
        showPolsiaLiveButton(run.polsia_app_url);
      }

      // Show catastrophic block banner if a block was persisted on this run
      if (run.catastrophic_block && run.catastrophic_block.reason) {
        showCatastrophicBlockBanner({
          reason:      run.catastrophic_block.reason,
          stats:       run.catastrophic_block.stats || {},
          overrideUrl: '/api/pipeline/' + RUN_ID + '/override-catastrophic-block',
        });
        setNavStatus('failed', 'blocked');
      }

      if (isFinished) {
        if (run.status === 'completed') {
          setPhaseState('save', 'complete');
          renderSavePhase({ versionId: RUN_ID });
          setNavStatus('complete', 'complete');
          fetchVerifyData();
        } else if (run.status === 'failed') {
          // Only set failed status if not already overridden by catastrophic block banner
          if (!run.catastrophic_block) {
            setNavStatus('failed', 'failed');
            // Show failure recovery UI with error reason and retry button
            showFailureBanner(run.failure_reason || null, run.failed_stage || null);
          }
        }
      }

      connectStream();

    } catch (err) {
      showError(err.message || 'Failed to load run');
    }
  }

  async function fetchVerifyData() {
    try {
      const res = await fetch('/api/pipeline/' + RUN_ID + '/replay');
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success) return;

      const events = json.events || json.timeline || [];
      for (const ev of events) {
        if ((ev.stage === 'verify' || ev.phase === 'verify') && ev.payload) {
          try {
            const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
            if (p.checks && Array.isArray(p.checks)) {
              verifyData = { checks: p.checks, passed: p.checks.every(c => c.passed) };
              renderVerifyChecks(verifyData);
              setPhaseState('verify', verifyData.passed ? 'complete' : 'failed');
              if (!buildComplete) {
                triggerBuildComplete(verifyData.passed, verifyData);
              }
              break;
            }
          } catch(_) {}
        }
      }
    } catch(_) {}
  }

  // ── Expo Project Download ──────────────────────────────
  window.downloadExpoProject = async function() {
    const btn = $('btn-expo-export');
    if (!btn) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '\u23F3 Generating\u2026';
    try {
      const res = await fetch('/api/builds/' + RUN_ID + '/export/expo', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.message || 'Failed to generate Expo project. Please try again.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'expo-project.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    } catch (err) {
      alert('Network error generating Expo project. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  // ── Delete build ──────────────────────────────────────
  window.showDeleteModal = function() {
    document.getElementById('delete-modal').classList.add('visible');
  };
  window.hideDeleteModal = function() {
    document.getElementById('delete-modal').classList.remove('visible');
  };
  window.confirmDelete = async function() {
    const btn = document.getElementById('confirm-delete-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting\u2026';
    try {
      const res = await fetch('/api/pipeline/' + RUN_ID, { method: 'DELETE' });
      if (res.ok) {
        window.location.href = '/history';
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.message || 'Failed to delete build. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Delete Build';
      }
    } catch (err) {
      alert('Network error. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Delete Build';
    }
  };
  // Close modal on overlay click or Escape
  document.getElementById('delete-modal').addEventListener('click', function(e) {
    if (e.target === this) window.hideDeleteModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.hideDeleteModal();
  });

  // ── Verify Fix — targeted auto-fix for failed checks ──
  window._triggerVerifyFix = async function(btn, encodedCheckName, checkId) {
    if (!btn || btn.disabled) return;
    const checkName = decodeURIComponent(encodedCheckName);
    btn.disabled = true;
    btn.classList.add('fixing');
    btn.innerHTML = '<span class="fix-icon">&#x1F527;</span> Fixing\u2026';

    const card = document.getElementById(checkId);
    if (card) card.classList.add('fixing');

    try {
      const res = await fetch('/api/pipeline/' + RUN_ID + '/verify-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkName: checkName }),
      });
      const data = await res.json();

      if (data.success && data.check) {
        if (data.check.passed) {
          // Fix succeeded — update the check item to passed state
          if (card) {
            card.className = 'verify-check-item pass';
            card.removeAttribute('data-check-name');
            const icon = card.querySelector('.verify-check-icon');
            if (icon) { icon.textContent = '\u2713'; }
            btn.style.display = 'none';
          }
          _showFixResult(checkId, true, data.check.message || 'Fixed');
        } else {
          // Fix did not pass
          btn.classList.remove('fixing');
          if (data.exhausted) {
            btn.innerHTML = '\u26A0 Manual review needed';
            btn.disabled = true;
          } else {
            btn.disabled = false;
            btn.innerHTML = '<span class="fix-icon">&#x1F527;</span> Retry Fix';
          }
          if (card) card.classList.remove('fixing');
          _showFixResult(checkId, false, data.check.message || 'Fix did not resolve the issue');
        }
      } else {
        btn.classList.remove('fixing');
        btn.disabled = false;
        btn.innerHTML = '<span class="fix-icon">&#x1F527;</span> Fix';
        if (card) card.classList.remove('fixing');
      }
    } catch (err) {
      btn.classList.remove('fixing');
      btn.disabled = false;
      btn.innerHTML = '<span class="fix-icon">&#x1F527;</span> Fix';
      if (card) card.classList.remove('fixing');
      _showFixResult(checkId, false, 'Network error — please try again');
    }
  };

  window._triggerVerifyFixAll = async function(btn, failedNamesJson) {
    if (!btn || btn.disabled) return;
    let failedNames;
    try { failedNames = JSON.parse(failedNamesJson); } catch(_) { return; }
    if (!Array.isArray(failedNames) || failedNames.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = '&#x1F527; Fixing all\u2026';

    for (let i = 0; i < failedNames.length; i++) {
      const name = failedNames[i];
      const encodedName = encodeURIComponent(name);
      // Find the card for this check by data-check-name attribute
      const cards = document.querySelectorAll('.verify-check-item[data-check-name]');
      let targetCard = null;
      let targetCheckId = null;
      cards.forEach(function(c) {
        if (c.getAttribute('data-check-name') === name) {
          targetCard = c;
          targetCheckId = c.id;
        }
      });
      if (targetCard) {
        const fixBtn = targetCard.querySelector('.verify-fix-btn');
        if (fixBtn && !fixBtn.disabled) {
          await window._triggerVerifyFix(fixBtn, encodedName, targetCheckId);
        }
      }
      btn.innerHTML = '&#x1F527; Fixing ' + (i + 1) + '/' + failedNames.length + '\u2026';
    }

    // Check if any failures remain
    const remaining = document.querySelectorAll('.verify-check-item.fail');
    if (remaining.length === 0) {
      btn.style.display = 'none';
    } else {
      btn.disabled = false;
      btn.innerHTML = '&#x1F527; Fix All (' + remaining.length + ')';
    }
  };

  function _showFixResult(checkId, success, message) {
    const detailsEl = document.getElementById('details-' + checkId);
    if (!detailsEl) return;
    detailsEl.style.display = 'block';
    // Remove existing fix result if present
    const existing = detailsEl.querySelector('.verify-fix-result');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'verify-fix-result ' + (success ? 'success' : 'fail');
    el.textContent = (success ? '\u2713 ' : '\u2717 ') + message;
    detailsEl.appendChild(el);
  }

  // ── Boot ──────────────────────────────────────────────
  init();

})();
