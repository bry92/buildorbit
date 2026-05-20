/**
 * BuildOrbit Dashboard — Mission Control
 * Owns: stat card updates, intent pills, recent runs list, live status,
 *       modal handlers, auto-refresh (every 5s).
 * Not owned: nav, auth, page routing.
 */
(function() {
  'use strict';

  /* ── Intent helpers ─────────────────────────────────────── */
  const INTENT_MAP = {
    static_surface: { label: '🌐 Static',      cls: 'intent-static',  color: 'var(--accent)'  },
    light_app:      { label: '⚡ Light App',   cls: 'intent-light',   color: 'var(--success)' },
    soft_expansion: { label: '⚡ Adaptive',     cls: 'intent-soft',    color: 'var(--warning)' },
    full_product:   { label: '🏗 Full Product', cls: 'intent-full',    color: '#a78bfa'        },
  };

  const STATUS_LABELS = {
    completed:   'Completed',
    failed:      'Failed',
    running:     'Running',
    in_progress: 'Running',
    pending:     'Pending',
    queued:      'Queued',
  };

  function fmtDuration(secs) {
    if (!secs) return '—';
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs/60)}m ${secs%60}s`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso), now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    if (diff < 7*86400) return `${Math.floor(diff/86400)}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function intentBadge(ic) {
    if (!ic) return '<span class="intent-badge intent-unknown">—</span>';
    const m = INTENT_MAP[ic] || { label: ic, cls: 'intent-unknown' };
    return `<span class="intent-badge ${m.cls}">${m.label}</span>`;
  }

  function statusBadge(s) {
    const cls = 'status-' + (s || 'pending');
    const label = STATUS_LABELS[s] || s || '—';
    return `<span class="drs-status ${cls}"><span class="drs-dot"></span>${label}</span>`;
  }

  /* ── Stat cards ────────────────────────────────────────── */
  function updateStatCards(stats) {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('dsc-total-val', stats.total_builds ?? '—');
    set('dsc-total-sub', stats.total_builds === 1 ? '1 build all time' : `${stats.total_builds} builds all time`);

    if (stats.total_builds > 0) {
      set('dsc-success-val', `${stats.success_rate}%`);
      set('dsc-success-sub', `${stats.completed} completed`);
    } else {
      set('dsc-success-val', '—');
    }

    if (stats.avg_duration_seconds) {
      set('dsc-duration-val', fmtDuration(stats.avg_duration_seconds));
    } else {
      set('dsc-duration-val', '—');
    }

    set('dsc-running-val', stats.running ?? '0');
    set('dsc-running-sub', stats.running > 0 ? 'pipeline active' : 'idle');

    // Running card glow when active
    const runCard = document.getElementById('dsc-running');
    if (runCard) {
      if (stats.running > 0) {
        runCard.classList.add('active');
      } else {
        runCard.classList.remove('active');
      }
    }
  }

  /* ── System status dot ─────────────────────────────────── */
  function updateSystemStatus(running) {
    const dot = document.getElementById('dss-dot');
    const label = document.getElementById('dss-label');
    if (!dot || !label) return;
    if (running > 0) {
      dot.classList.remove('idle');
      dot.classList.add('running');
      label.textContent = `${running} build${running > 1 ? 's' : ''} running`;
    } else {
      dot.classList.remove('running');
      dot.classList.add('idle');
      label.textContent = 'Pipeline idle';
    }
  }

  /* ── Intent distribution pills ────────────────────────── */
  function updateIntentPills(intentDist) {
    const section = document.getElementById('dash-intent-section');
    const pills   = document.getElementById('dis-pills');
    if (!section || !pills) return;
    const entries = Object.entries(intentDist || {}).filter(([,v]) => v > 0);
    if (!entries.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    pills.innerHTML = entries.map(([ic, count]) => {
      const m = INTENT_MAP[ic] || { label: ic, color: 'var(--text-muted)' };
      return `<span class="dis-pill" style="border-color:${m.color}20;color:${m.color};background:${m.color}10">${m.label} <b>${count}</b></span>`;
    }).join('');
  }

  /* ── Recent runs list ──────────────────────────────────── */
  // Track total builds count for the confirmation modal
  let _totalBuilds = 0;

  function updateRecentRuns(runs, total) {
    const list = document.getElementById('dash-recent-list');
    const clearBtn = document.getElementById('clear-all-btn');
    if (!list) return;

    // Show Clear All button only when user has builds
    if (clearBtn) {
      clearBtn.style.display = (total > 0) ? '' : 'none';
    }

    if (!runs || !runs.length) {
      list.innerHTML = `
        <div class="drs-empty">
          <div class="drs-empty-icon">⊙</div>
          <div class="drs-empty-title">No builds yet</div>
          <div class="drs-empty-sub">Launch your first pipeline to see results here.</div>
          <a href="/new" class="drs-empty-cta">⊕ New Build</a>
        </div>`;
      return;
    }

    // Show upgrade banner for trial users with 3+ builds
    maybeShowTrialUpgradeBanner(total);

    list.innerHTML = runs.map(r => {
      const prompt = r.prompt ? r.prompt.slice(0, 80) + (r.prompt.length > 80 ? '…' : '') : 'Untitled';
      return `<a href="/run/${r.id}" class="drs-item">
        <div class="drs-item-left">
          ${statusBadge(r.status)}
          <span class="drs-prompt">${escapeHtml(prompt)}</span>
        </div>
        <div class="drs-item-right">
          ${intentBadge(r.intent_class)}
          <span class="drs-duration">${fmtDuration(r.duration_s)}</span>
          <span class="drs-time">${fmtTime(r.created_at)}</span>
          <span class="drs-arrow">→</span>
        </div>
      </a>`;
    }).join('');
  }

  /* ── Main fetch + render ─────────────────────────────────  */
  async function loadDashboard() {
    try {
      const data = await BO.api.get('/api/dashboard/stats');
      if (!data.success) return;
      _totalBuilds = data.stats.total_builds || 0;
      updateStatCards(data.stats);
      updateSystemStatus(data.stats.running);
      updateIntentPills(data.stats.intent_distribution);
      updateRecentRuns(data.recent_runs, _totalBuilds);
    } catch (err) {
      // Non-fatal — dashboard still shows structure on failure
      const label = document.getElementById('dss-label');
      if (label) label.textContent = 'Status unavailable';
    }
  }

  /* ── Modal helpers (referenced from dashboard.html) ─────── */
  window.openRunModal = function() {
    const m = document.getElementById('run-modal');
    if (m) { m.classList.add('visible'); document.getElementById('run-prompt')?.focus(); }
  };
  window.closeRunModal = function() {
    const m = document.getElementById('run-modal');
    if (m) m.classList.remove('visible');
  };
  window.closeRunModalIfOutside = function(e) {
    if (e.target === document.getElementById('run-modal')) window.closeRunModal();
  };
  window.openUpgradeModal = function() {
    const m = document.getElementById('upgrade-modal');
    if (m) m.classList.add('visible');
  };
  window.closeUpgradeModal = function() {
    const m = document.getElementById('upgrade-modal');
    if (m) m.classList.remove('visible');
  };
  window.closeUpgradeModalIfOutside = function(e) {
    if (e.target === document.getElementById('upgrade-modal')) window.closeUpgradeModal();
  };

  window.submitRun = async function() {
    const prompt = document.getElementById('run-prompt')?.value.trim();
    if (!prompt) { document.getElementById('run-prompt')?.focus(); return; }
    const btn = document.getElementById('submit-run-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Launching…'; }
    try {
      const data = await BO.api.post('/api/pipeline', { prompt });
      const runId = data.id || data.runId || data.run_id || data.run?.id;
      if (runId) window.location.href = `/run/${runId}`;
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Start Build'; }
      alert(err.message || 'Failed to start build.');
    }
  };

  /* ── Upgrade + subscription handlers ─────────────────────── */
  window.startUpgrade = function(e) {
    if (e) e.preventDefault();
    window.openUpgradeModal();
  };

  window.manageSubscription = async function(e) {
    if (e) e.preventDefault();
    try {
      const data = await BO.api.get('/api/billing/portal');
      if (data.url) window.location.href = data.url;
    } catch (err) {
      alert('Could not open billing portal. Please try again.');
    }
  };

  window.redirectToCheckout = async function() {
    const btn = document.getElementById('upgrade-checkout-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
    try {
      const data = await BO.api.post('/api/billing/create-checkout', {});
      if (data.url) window.location.href = data.url;
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Subscribe for $49/month →'; }
      alert('Could not start checkout. Please try again.');
    }
  };

  /* ── Handle post-checkout return (?subscription=active) ──── */
  // Stripe redirects back here after a successful subscription.
  // We call /api/billing/activate to provision credits idempotently,
  // then clean the URL so a refresh doesn't re-trigger.
  async function maybeActivateAfterCheckout() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') !== 'active') return;

    try {
      await BO.api.post('/api/billing/activate', {});
    } catch (_) { /* non-fatal — webhook already activated in most cases */ }

    // Remove the query param so a page refresh doesn't re-hit activate
    const clean = window.location.pathname + (params.toString() ? '' : '');
    window.history.replaceState({}, '', window.location.pathname);

    showToast('🎉 You\'re now on BuildOrbit Pro!');
  }

  /* ── Load billing status (show/hide plan badge + upgrade banner) ── */
  // Note: API returns task_credits (not credits) — use that field.
  async function loadBillingStatus() {
    try {
      const data = await BO.api.get('/api/billing/status');
      if (!data.success) return;
      const badge = document.getElementById('plan-badge');
      const creditsBadge = document.getElementById('plan-credits-badge');
      const upgradeBtn = document.getElementById('upgrade-btn');
      const manageBtn = document.getElementById('manage-sub-btn');
      if (!badge) return;

      const credits = data.task_credits ?? 0;
      const isPro   = data.subscription_status === 'active' || data.is_admin;

      badge.style.display = 'flex';
      if (creditsBadge) {
        creditsBadge.textContent = data.is_admin ? 'Unlimited credits' : `${credits} credits`;
      }
      if (isPro) {
        if (manageBtn) manageBtn.style.display = '';
        if (upgradeBtn) upgradeBtn.style.display = 'none';
      } else {
        if (upgradeBtn) upgradeBtn.style.display = '';
        if (manageBtn) manageBtn.style.display = 'none';
      }

      // Show upgrade banner once user has 3+ builds and is still on trial
      if (!isPro) {
        _pendingUpgradeBannerForTrialUser = true;
        _trialCreditsLeft = credits;
      }
    } catch (_) { /* non-fatal — badge stays hidden */ }
  }

  // Set by loadBillingStatus; consumed by updateRecentRuns once total_builds is known
  let _pendingUpgradeBannerForTrialUser = false;
  let _trialCreditsLeft = 0;

  function maybeShowTrialUpgradeBanner(totalBuilds) {
    if (!_pendingUpgradeBannerForTrialUser) return;
    if (totalBuilds < 3) return;
    const existing = document.getElementById('trial-upgrade-banner');
    if (existing) return; // already shown

    const banner = document.createElement('div');
    banner.id = 'trial-upgrade-banner';
    banner.className = 'trial-upgrade-banner';
    banner.innerHTML = `
      <div class="tub-left">
        <span class="tub-icon">🚀</span>
        <div>
          <div class="tub-title">You've built ${totalBuilds} projects — unlock unlimited builds</div>
          <div class="tub-sub">Pro plan: priority queue, GitHub auto-push, custom domains · ${_trialCreditsLeft} trial credits remaining</div>
        </div>
      </div>
      <div class="tub-right">
        <a href="/pricing" class="tub-cta">View Pro plan →</a>
        <button class="tub-dismiss" onclick="document.getElementById('trial-upgrade-banner').remove()">✕</button>
      </div>
    `;
    // Insert after the stat grid
    const statGrid = document.getElementById('dash-stat-grid');
    if (statGrid && statGrid.parentNode) {
      statGrid.parentNode.insertBefore(banner, statGrid.nextSibling);
    } else {
      const hero = document.getElementById('dash-hero');
      if (hero) hero.appendChild(banner);
    }
  }

  /* ── Clear All Builds ────────────────────────────────────── */
  window.openClearAllModal = function() {
    const m = document.getElementById('clear-all-modal');
    const countEl = document.getElementById('clear-all-count');
    if (!m) return;
    if (countEl) {
      const n = _totalBuilds;
      countEl.textContent = `${n} build${n !== 1 ? 's' : ''}`;
    }
    m.classList.add('visible');
  };

  window.closeClearAllModal = function() {
    const m = document.getElementById('clear-all-modal');
    if (m) m.classList.remove('visible');
  };

  window.closeClearAllModalIfOutside = function(e) {
    if (e.target === document.getElementById('clear-all-modal')) window.closeClearAllModal();
  };

  window.confirmClearAll = async function() {
    const btn = document.getElementById('confirm-clear-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const data = await BO.api['delete']('/api/builds/bulk', { all: true });
      window.closeClearAllModal();
      if (data.success) {
        showToast(`Deleted ${data.deleted} build${data.deleted !== 1 ? 's' : ''}`);
        // Immediately clear the list and stats
        _totalBuilds = 0;
        updateRecentRuns([], 0);
        updateStatCards({ total_builds: 0, completed: 0, failed: 0, running: 0, success_rate: 0, avg_duration_seconds: null, intent_distribution: {} });
        updateSystemStatus(0);
        updateIntentPills({});
      } else {
        alert(data.message || 'Failed to delete builds.');
      }
    } catch (err) {
      window.closeClearAllModal();
      alert(err.message || 'Failed to delete builds.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete all builds'; }
    }
  };

  /* ── Toast notification ──────────────────────────────────── */
  function showToast(message) {
    let toast = document.getElementById('bo-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'bo-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(13,20,36,0.97);border:1px solid rgba(52,211,153,0.3);border-radius:8px;padding:10px 20px;font-size:13px;font-family:"Space Grotesk",sans-serif;color:var(--success,#34d399);z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.5);transition:opacity 0.3s;pointer-events:none;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  }

  /* ── Init ────────────────────────────────────────────────── */
  maybeActivateAfterCheckout();
  loadDashboard();
  loadBillingStatus();
  setInterval(loadDashboard, 5000);

})();
