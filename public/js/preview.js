/**
 * preview.js — Live iframe preview panel for pipeline run page.
 * Owns: preview rendering, device toggle, expand, polling.
 * Does NOT own: phase cards, SSE streaming, navigation.
 */
(function () {
  'use strict';

  const POLL_MS = 3000;
  const PLACEHOLDER = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#060a14;color:#38bdf8;font-family:'Space Mono',monospace;
      display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}
    .pulse{font-size:1.8rem;margin-bottom:16px;animation:pulse 1.6s ease-in-out infinite}
    .txt{font-size:.85rem;color:rgba(56,189,248,.6);line-height:1.6}
    @keyframes pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
  </style></head><body>
    <div><div class="pulse">⬡</div>
    <div class="txt">Preview will appear when code generation begins</div></div>
  </body></html>`;

  let _runId, _iframe, _expandBtn, _pollTimer, _lastHash = '', _liveUrl = null, _expanded = false;

  function getRunId() {
    const p = window.location.pathname.split('/').filter(Boolean);
    return (p[0] === 'run' && p[1] && /^[0-9a-f-]{36}$/i.test(p[1])) ? p[1] : null;
  }

  function writeToIframe(html) {
    try {
      const doc = _iframe.contentDocument || _iframe.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
    } catch (_) { _iframe.srcdoc = html; }
  }

  function setLive(url) {
    if (_liveUrl === url) return;
    _liveUrl = url;
    _iframe.removeAttribute('srcdoc');
    _iframe.src = url;
    setBadge('live');
  }

  // Detect if this is a React CDN build (has app.jsx)
  function isReactBuild(files) {
    return Object.keys(files).some(k => k === 'app.jsx' || k.endsWith('/app.jsx'));
  }

  // Build a self-contained React CDN HTML wrapper for app.jsx preview.
  // Uses Babel standalone + React 18 CDN — renders JSX in-browser without a build step.
  function buildReactHtml(files) {
    const entries = Object.entries(files);
    const appJsx = entries.find(([k]) => k === 'app.jsx' || k.endsWith('/app.jsx'));
    const indexHtml = entries.find(([k]) => k === 'index.html');
    const cssE = entries.find(([k]) => k.endsWith('.css') && !k.includes('node_modules'));

    // If index.html already has React CDN script tags, inject app.jsx and serve
    if (indexHtml && String(indexHtml[1]).includes('unpkg.com/react')) {
      let html = String(indexHtml[1]);
      if (appJsx) {
        const jsxTag = `<script type="text/babel">\n${appJsx[1]}\n</script>`;
        html = html.includes('</body>') ? html.replace(/<script[^>]+src[^>]+app\.jsx[^>]*><\/script>/gi, jsxTag)
             : html + jsxTag;
        // Inline app.jsx replacing any external reference
        html = html.replace(/<script[^>]+app\.jsx[^>]*><\/script>/gi, jsxTag);
      }
      return html;
    }

    // Build a fresh React CDN wrapper around the app.jsx content
    const jsxContent = appJsx ? String(appJsx[1]) : '// No app.jsx found';
    const cssContent = cssE ? `<style>${cssE[1]}</style>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://buildorbit.polsia.app/css/design-dna.css">
  ${cssContent}
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    html,body{margin:0;padding:0;background:#0a0a0f;min-height:100vh}
    #root{min-height:100vh}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
${jsxContent}
  </script>
</body>
</html>`;
  }

  function buildHtml(files) {
    // React CDN builds: wrap app.jsx in Babel standalone iframe
    if (isReactBuild(files)) {
      return buildReactHtml(files);
    }

    const entries = Object.entries(files);
    const htmlE = entries.find(([k]) => k === 'index.html') || entries.find(([k]) => k.endsWith('.html'));
    if (!htmlE) {
      const code = entries.slice(0,3).map(([n,c]) =>
        `<pre>/* ${n} */\n${String(c).slice(0,2000)}</pre>`).join('');
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body{background:#060a14;color:#38bdf8;font-family:'Space Mono',monospace;padding:24px;font-size:.75rem}
        pre{white-space:pre-wrap;word-break:break-word;margin-bottom:16px}
      </style></head><body>${code}</body></html>`;
    }
    let html = String(htmlE[1]);
    const cssE = entries.find(([k]) => k.endsWith('.css'));
    if (cssE) {
      const tag = `<style>${cssE[1]}</style>`;
      html = html.includes('.css"') ? html.replace(/<link[^>]+\.css[^>]*>/gi, tag)
           : html.includes('</head>') ? html.replace('</head>', tag + '</head>') : tag + html;
    }
    const jsE = entries.find(([k]) => k.endsWith('.js') && !k.includes('min'));
    if (jsE) {
      const tag = `<script>${jsE[1]}</script>`;
      html = html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag;
    }
    return html;
  }

  function hashFiles(f) { return Object.keys(f).sort().join('|') + Object.values(f).join('').length; }

  function setBadge(state) {
    const el = document.getElementById('preview-status-badge');
    if (!el) return;
    const map = { live:'⬤ LIVE|badge-live', preview:'◈ PREVIEW|badge-preview', waiting:'◎ WAITING|badge-waiting' };
    const [txt, cls] = (map[state] || map.waiting).split('|');
    el.textContent = txt; el.className = 'preview-status-badge ' + cls;
  }

  async function fetchJson(url) {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch(_) { return null; }
  }

  async function refreshPreview() {
    // 1. Deployed live app — iframe src
    const ds = await fetchJson('/api/pipeline/' + _runId + '/deploy/status');
    if (ds?.success && ds.url) { setLive(ds.url); stopPolling(); return; }

    // 2. Code generated — render inline
    const cf = await fetchJson('/api/pipeline/' + _runId + '/code-files');
    if (cf?.success && cf.count > 0) {
      const h = hashFiles(cf.files);
      if (h !== _lastHash) {
        _lastHash = h; _liveUrl = null;
        _iframe.removeAttribute('src');
        writeToIframe(buildHtml(cf.files));
        setBadge('preview');
      }
      return;
    }

    // 3. Placeholder
    if (!_lastHash && !_liveUrl) { writeToIframe(PLACEHOLDER); setBadge('waiting'); }
  }

  function startPolling() { if (!_pollTimer) _pollTimer = setInterval(refreshPreview, POLL_MS); }
  function stopPolling()  { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }

  function setDevice(device) {
    document.querySelectorAll('.preview-device-btn').forEach(b => b.classList.toggle('active', b.dataset.device === device));
    const wrap = document.getElementById('preview-iframe-wrap');
    if (!wrap) return;
    const w = { fill:'100%', '1440':'100%', '768':'768px', '375':'375px' }[device] || '100%';
    wrap.style.width = w;
    wrap.style.margin = (device !== 'fill' && device !== '1440') ? '0 auto' : '';
  }

  function toggleExpand() {
    _expanded = !_expanded;
    const main = document.getElementById('run-main');
    const phases = document.getElementById('preview-phases-col');
    main?.classList.toggle('preview-expanded', _expanded);
    if (phases) phases.style.display = _expanded ? 'none' : '';
    if (_expandBtn) _expandBtn.textContent = _expanded ? '⊠ Collapse' : '⊞ Expand';
  }

  window.switchPreviewTab = function(tab) {
    const phases = document.getElementById('preview-phases-col');
    const panel = document.getElementById('preview-panel');
    const tPhases = document.getElementById('tab-phases');
    const tPreview = document.getElementById('tab-preview');
    const showPhases = tab === 'phases';
    if (phases) phases.style.display = showPhases ? '' : 'none';
    if (panel)  { panel.style.display = showPhases ? 'none' : ''; if (!showPhases) refreshPreview(); }
    tPhases?.classList.toggle('active', showPhases);
    tPreview?.classList.toggle('active', !showPhases);
  };

  // Called from run-view.js
  window.previewOnDeployComplete = function(url) { stopPolling(); setLive(url); };
  window.previewOnCodePhaseStart = function() { startPolling(); refreshPreview(); };

  async function initPreview() {
    _runId = getRunId();
    if (!_runId) return;
    _iframe = document.getElementById('live-preview');
    _expandBtn = document.getElementById('btn-preview-expand');
    if (!_iframe) return;

    document.querySelectorAll('.preview-device-btn').forEach(b =>
      b.addEventListener('click', () => setDevice(b.dataset.device)));

    document.getElementById('btn-preview-refresh')
      ?.addEventListener('click', () => { _lastHash = ''; _liveUrl = null; refreshPreview(); });

    _expandBtn?.addEventListener('click', toggleExpand);

    writeToIframe(PLACEHOLDER);
    setBadge('waiting');

    const rs = await fetchJson('/api/pipeline/' + _runId);
    const finished = ['completed','failed','error','cancelled'].includes(rs?.run?.status);
    await refreshPreview();
    if (!finished || (!_liveUrl && !_lastHash)) startPolling();
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', initPreview)
    : initPreview();
})();
