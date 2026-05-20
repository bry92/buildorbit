/**
 * GitHub Selector — /new page repo picker
 *
 * Owns: rendering the "Push to GitHub" and "Build from repo" sections inside the
 *       launch card, loading + caching repos via /api/github/repos, create-new-repo form.
 * Not owned: auth, pipeline launch logic (launchBuild lives in new.html).
 *
 * Exposes:
 *   window.GitHubSelector.getSelectedRepo()  → push target repo selection (or null)
 *   window.GitHubSelector.getSourceRepo()    → source repo to build FROM (or null)
 *   window.GitHubSelector._toggleNewRepo()   → internal: new repo form toggle
 */
(function (w) {
  'use strict';

  let _pushEnabled   = false;   // checkbox: "Push result to GitHub" is on
  let _sourceEnabled = false;   // checkbox: "Build from existing repo" is on
  let _repos         = null;    // cached repo list (null = not loaded yet)
  let _loading       = false;
  let _connected     = false;
  let _showNew       = false;   // "Create new repo" form visible (push section)
  let _userData      = null;

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const pushContainer   = document.getElementById('gh-push-section');
    const sourceContainer = document.getElementById('gh-source-section');
    if (!pushContainer && !sourceContainer) return; // not on /new page

    try {
      const res = await fetch('/api/github/status', { credentials: 'include' });
      if (!res.ok) {
        renderPush(pushContainer, false, null);
        renderSource(sourceContainer, false, null);
        return;
      }
      const data = await res.json();
      _connected = data.connected;
      _userData  = data;
      renderPush(pushContainer, data.connected, data);
      renderSource(sourceContainer, data.connected, data);
    } catch (_) {
      renderPush(pushContainer, false, null);
      renderSource(sourceContainer, false, null);
    }
  }

  // ── Connect CTA (shared between both sections when not connected) ─────────
  function connectCtaHtml() {
    return `
      <div class="gh-push-block">
        <div class="gh-connect-cta">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;flex-shrink:0">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          <a href="/github?return=/new">Connect GitHub</a> to enable repo features
        </div>
      </div>`;
  }

  // ── Render "Push to GitHub" section ──────────────────────────────────────
  function renderPush(container, connected, userData) {
    if (!container) return;

    if (!connected) {
      container.innerHTML = connectCtaHtml();
      return;
    }

    const avatarHtml = userData && userData.avatar_url
      ? `<img src="${esc(userData.avatar_url)}" style="width:18px;height:18px;border-radius:50%;flex-shrink:0" alt="">`
      : '';

    container.innerHTML = `
      <div class="gh-push-block">
        <label class="gh-push-label" id="gh-push-label">
          <input type="checkbox" id="gh-push-cb">
          ${avatarHtml}
          Push result to GitHub
          ${userData && userData.login ? `<span style="font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-left:2px">@${esc(userData.login)}</span>` : ''}
        </label>
        <div class="gh-push-content" id="gh-push-content">
          <div id="gh-repo-inner">
            <div class="gh-repo-row">
              <div class="gh-repo-select-wrap">
                <select class="gh-repo-select" id="gh-repo-select" disabled>
                  <option value="">Loading repositories…</option>
                </select>
              </div>
              <button type="button" class="gh-new-repo-toggle" id="gh-new-repo-btn" onclick="window.GitHubSelector._toggleNewRepo()">
                + New repo
              </button>
            </div>
            <div class="gh-new-repo-form" id="gh-new-repo-form">
              <input
                type="text"
                id="gh-new-repo-name"
                class="gh-new-repo-name"
                placeholder="my-new-repo"
                maxlength="100"
                autocomplete="off"
              >
              <div class="gh-new-repo-meta">
                <label><input type="radio" name="gh-vis" value="public" checked> Public</label>
                <label><input type="radio" name="gh-vis" value="private"> Private</label>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire push checkbox
    const cb = document.getElementById('gh-push-cb');
    cb.addEventListener('change', function () {
      _pushEnabled = this.checked;
      const content = document.getElementById('gh-push-content');
      content.classList.toggle('visible', _pushEnabled);
      if (_pushEnabled && !_repos && !_loading) _loadRepos('push');
    });
  }

  // ── Render "Build from existing repo" section ─────────────────────────────
  function renderSource(container, connected, userData) {
    if (!container) return;

    if (!connected) {
      // Only show connect CTA here if push section doesn't exist (avoid duplicate)
      const pushContainer = document.getElementById('gh-push-section');
      if (!pushContainer) {
        container.innerHTML = connectCtaHtml();
      } else {
        container.innerHTML = ''; // push section already shows the CTA
      }
      return;
    }

    const avatarHtml = userData && userData.avatar_url
      ? `<img src="${esc(userData.avatar_url)}" style="width:18px;height:18px;border-radius:50%;flex-shrink:0" alt="">`
      : '';

    container.innerHTML = `
      <div class="gh-push-block gh-source-block">
        <label class="gh-push-label" id="gh-source-label">
          <input type="checkbox" id="gh-source-cb">
          ${avatarHtml}
          Build from existing repo
          ${userData && userData.login ? `<span style="font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-left:2px">@${esc(userData.login)}</span>` : ''}
        </label>
        <div class="gh-push-content" id="gh-source-content">
          <div class="gh-repo-row">
            <div class="gh-repo-select-wrap" style="flex:1">
              <select class="gh-repo-select" id="gh-source-repo-select" disabled>
                <option value="">Loading repositories…</option>
              </select>
            </div>
          </div>
          <div id="gh-source-status" style="margin-top:6px;font-size:12px;color:var(--text-dim);display:none"></div>
          <p style="margin:6px 0 0;font-size:11px;color:var(--text-dim);line-height:1.5">
            BuildOrbit will read this repo's code and plan improvements on top of it.
            The result is pushed back as a PR.
          </p>
        </div>
      </div>
    `;

    // Wire source checkbox
    const cb = document.getElementById('gh-source-cb');
    cb.addEventListener('change', function () {
      _sourceEnabled = this.checked;
      const content = document.getElementById('gh-source-content');
      content.classList.toggle('visible', _sourceEnabled);
      if (_sourceEnabled && !_repos && !_loading) _loadRepos('source');
      // Update prompt area to reflect that description is optional in repo mode
      _updatePromptHint(_sourceEnabled);
    });

    // Wire source repo select — show status when a repo is picked
    const sel = document.getElementById('gh-source-repo-select');
    if (sel) {
      sel.addEventListener('change', function () {
        const statusEl = document.getElementById('gh-source-status');
        if (this.value && statusEl) {
          statusEl.textContent = `✓ Pipeline will analyze ${this.value} before planning`;
          statusEl.style.display = 'block';
        } else if (statusEl) {
          statusEl.style.display = 'none';
        }
      });
    }
  }

  // ── Load repos (shared, fills whichever select is active) ─────────────────
  async function _loadRepos(mode) {
    _loading = true;
    const selId = mode === 'source' ? 'gh-source-repo-select' : 'gh-repo-select';
    const sel = document.getElementById(selId);
    if (!sel) { _loading = false; return; }

    try {
      const res = await fetch('/api/github/repos', { credentials: 'include' });
      if (res.status === 401) {
        sel.innerHTML = '<option value="">Token expired — reconnect GitHub</option>';
        _loading = false;
        return;
      }
      if (!res.ok) throw new Error('Failed');

      const { repos } = await res.json();
      _repos = repos;

      // Also populate the other select if it exists
      const otherSelId = mode === 'source' ? 'gh-repo-select' : 'gh-source-repo-select';
      const otherSel   = document.getElementById(otherSelId);

      _populateSelect(sel, repos);
      if (otherSel && otherSel.disabled) _populateSelect(otherSel, repos);
    } catch (_err) {
      if (sel) sel.innerHTML = '<option value="">Could not load repos</option>';
    }
    _loading = false;
  }

  function _populateSelect(sel, repos) {
    sel.disabled = false;
    if (!repos.length) {
      sel.innerHTML = '<option value="">No repos found — create one on GitHub first</option>';
      return;
    }
    sel.innerHTML = `<option value="">— Select a repo —</option>` +
      repos.map(r =>
        `<option value="${esc(r.full_name)}">${esc(r.full_name)}${r.private ? ' 🔒' : ''}</option>`
      ).join('');
  }

  // ── Toggle new repo form (push section only) ──────────────────────────────
  function _toggleNewRepo() {
    _showNew = !_showNew;
    const form = document.getElementById('gh-new-repo-form');
    const sel  = document.getElementById('gh-repo-select');
    const btn  = document.getElementById('gh-new-repo-btn');
    if (!form) return;

    form.classList.toggle('visible', _showNew);
    if (sel) sel.disabled = _showNew;
    if (btn) btn.textContent = _showNew ? '← Existing repo' : '+ New repo';

    if (_showNew) {
      const inp = document.getElementById('gh-new-repo-name');
      if (inp) inp.focus();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the push-target repo selection, or null if push is disabled.
   * Called by launchBuild() in new.html before submitting the pipeline POST.
   */
  function getSelectedRepo() {
    if (!_pushEnabled) return null;

    if (_showNew) {
      const nameEl = document.getElementById('gh-new-repo-name');
      const name   = nameEl ? nameEl.value.trim() : '';
      if (!name) return null;
      const vis = document.querySelector('input[name="gh-vis"]:checked');
      return {
        full_name: null,
        create:    true,
        name,
        private: vis ? vis.value === 'private' : false,
      };
    }

    const sel = document.getElementById('gh-repo-select');
    const val = sel ? sel.value : '';
    if (!val) return null;

    return { full_name: val, create: false, private: false };
  }

  /**
   * Returns the source repo to build FROM, or null if not selected.
   * Called by launchBuild() in new.html — the value is posted as source_repo.
   */
  function getSourceRepo() {
    if (!_sourceEnabled) return null;
    const sel = document.getElementById('gh-source-repo-select');
    const val = sel ? sel.value : '';
    return val || null;
  }

  // ── Prompt hint update (when source repo mode toggles) ───────────────────
  // Shows the user that description is optional when building from an existing repo.
  function _updatePromptHint(sourceEnabled) {
    const textarea = document.getElementById('nb-prompt');
    const label    = document.querySelector('label[for="nb-prompt"]');
    const subtitle = document.querySelector('.nb-subtitle');
    if (sourceEnabled) {
      if (textarea) textarea.placeholder = 'Optional — describe specific improvements, or leave blank to let BuildOrbit analyze the repo automatically';
      if (label) label.textContent = 'Mission prompt (optional)';
      if (subtitle) subtitle.textContent = 'Select a repo below. BuildOrbit will analyze its code and plan improvements automatically. Add a prompt if you want to guide the direction.';
    } else {
      if (textarea) textarea.placeholder = 'e.g. A user authentication system with email verification, password reset, and protected dashboard routes…';
      if (label) label.textContent = 'Mission prompt';
      if (subtitle) subtitle.textContent = 'Describe what you want to build. The 6-phase pipeline will plan, code, verify, and deploy it — with a full audit trail at every step.';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Export ────────────────────────────────────────────────────────────────
  w.GitHubSelector = { init, getSelectedRepo, getSourceRepo, _toggleNewRepo };

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
