/**
 * Dashboard — Command Center page.
 * Owns: stat cards, intent pills, recent runs list, build/upgrade modals.
 * Not owned: nav, auth, routing.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchDashboard,
  fetchBillingStatus,
  startBillingCheckout,
  activateSubscription,
  getBillingPortal,
  deleteAllBuilds,
  createPipeline,
  type DashboardStats,
  type RecentRun,
} from '../lib/api';
import { fmtDuration, fmtTime } from '../lib/utils';
import './Dashboard.css';

/* ── Intent / Status helpers ─────────────────────────────── */
const INTENT_MAP: Record<string, { label: string; cls: string; color: string }> = {
  static_surface: { label: '🌐 Static',      cls: 'intent-static',  color: 'var(--accent)'  },
  light_app:      { label: '⚡ Light App',   cls: 'intent-light',   color: 'var(--success)' },
  soft_expansion: { label: '⚡ Adaptive',    cls: 'intent-soft',    color: 'var(--warning)' },
  full_product:   { label: '🏗 Full Product', cls: 'intent-full',    color: '#a78bfa'        },
};

const STATUS_LABELS: Record<string, string> = {
  completed:       'Completed',
  partial_success: 'Partial',
  failed:          'Failed',
  running:         'Running',
  in_progress:     'Running',
  pending:         'Pending',
  queued:          'Queued',
};

function StatusBadge({ status }: { status: string }) {
  const cls = `drs-status status-${status || 'pending'}`;
  const label = STATUS_LABELS[status] ?? status ?? '—';
  return (
    <span className={cls}>
      <span className="drs-dot" />
      {label}
    </span>
  );
}

function IntentBadge({ ic }: { ic?: string | null }) {
  if (!ic) return <span className="intent-badge intent-unknown">—</span>;
  const m = INTENT_MAP[ic] ?? { label: ic, cls: 'intent-unknown', color: 'var(--text-dim)' };
  return <span className={`intent-badge ${m.cls}`}>{m.label}</span>;
}

/* ── Toast ──────────────────────────────────────────────── */
function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  return { toast, showToast };
}

/* ── Main component ──────────────────────────────────────── */
export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [totalBuilds, setTotalBuilds] = useState(0);
  const [intentDist, setIntentDist] = useState<Record<string, number>>({});

  const [isPro, setIsPro] = useState(false);
  const [credits, setCredits] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showPlanBadge, setShowPlanBadge] = useState(false);
  const [showUpgradeBtn, setShowUpgradeBtn] = useState(false);
  const [showManageBtn, setShowManageBtn] = useState(false);
  const [showTrialBanner, setShowTrialBanner] = useState(false);
  const [trialCreditsLeft, setTrialCreditsLeft] = useState(0);

  const [showRunModal, setShowRunModal] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showClearAllModal, setShowClearAllModal] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const { toast, showToast } = useToast();

  /* ── Load dashboard data ─────────────────────────────── */
  const loadDashboard = useCallback(async () => {
    try {
      const data = await fetchDashboard();
      if (!data.success) return;
      setStats(data.stats);
      setTotalBuilds(data.stats.total_builds ?? 0);
      setIntentDist(data.stats.intent_distribution ?? {});
      setRecentRuns(data.recent_runs ?? []);
    } catch { /* non-fatal */ }
  }, []);

  /* ── Load billing status ─────────────────────────────── */
  const loadBilling = useCallback(async () => {
    try {
      const data = await fetchBillingStatus();
      if (!data.success) return;
      const c = data.task_credits ?? 0;
      const pro = data.subscription_status === 'active' || data.is_admin;
      setCredits(c);
      setIsPro(pro);
      setIsAdmin(data.is_admin);
      setShowPlanBadge(true);
      setShowUpgradeBtn(!pro);
      setShowManageBtn(pro);
      if (!pro) {
        setTrialCreditsLeft(c);
      }
    } catch { /* non-fatal */ }
  }, []);

  /* ── Handle subscription=active return from Stripe ───── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') === 'active') {
      activateSubscription().catch(() => {/* non-fatal */});
      window.history.replaceState({}, '', window.location.pathname);
      showToast('🎉 You\'re now on BuildOrbit Pro!');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Auto-show trial upgrade banner ─────────────────── */
  useEffect(() => {
    if (!isPro && totalBuilds >= 3) {
      setShowTrialBanner(true);
    }
  }, [isPro, totalBuilds]);

  /* ── Init + 5s auto-refresh ─────────────────────────── */
  useEffect(() => {
    loadDashboard();
    loadBilling();
    const interval = setInterval(loadDashboard, 5000);
    return () => clearInterval(interval);
  }, [loadDashboard, loadBilling]);

  /* ── Submit new run ──────────────────────────────────── */
  const submitRun = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setIsSubmitting(true);
    try {
      const data = await createPipeline(text);
      const runId = data.id;
      if (runId) window.location.href = `/run/${runId}`;
    } catch (err) {
      setIsSubmitting(false);
      alert(err instanceof Error ? err.message : 'Failed to start build.');
    }
  }, [prompt]);

  /* ── Billing actions ─────────────────────────────────── */
  const handleManageSubscription = useCallback(async () => {
    try {
      const data = await getBillingPortal();
      if (data.url) window.location.href = data.url;
    } catch { alert('Could not open billing portal. Please try again.'); }
  }, []);

  const handleCheckout = useCallback(async () => {
    setIsCheckoutLoading(true);
    try {
      const data = await startBillingCheckout();
      if (data.url) window.location.href = data.url;
    } catch {
      setIsCheckoutLoading(false);
      alert('Could not start checkout. Please try again.');
    }
  }, []);

  /* ── Clear all builds ────────────────────────────────── */
  const confirmClearAll = useCallback(async () => {
    setIsClearing(true);
    try {
      const data = await deleteAllBuilds();
      setShowClearAllModal(false);
      if (data.success) {
        showToast(`Deleted ${data.deleted} build${data.deleted !== 1 ? 's' : ''}`);
        setTotalBuilds(0);
        setRecentRuns([]);
        setStats(null);
        setIntentDist({});
      }
    } catch (err) {
      setShowClearAllModal(false);
      alert(err instanceof Error ? err.message : 'Failed to delete builds.');
    } finally {
      setIsClearing(false);
    }
  }, [showToast]);

  const running = stats?.running ?? 0;
  const intentEntries = Object.entries(intentDist).filter(([, v]) => v > 0);

  return (
    <div className="page-dashboard">
      {/* Background rings */}
      <div className="cloud-bg">
        <div className="cloud-layer-1" />
        <div className="cloud-layer-2" />
        <div className="cloud-layer-3" />
        <div className="cloud-layer-4" />
      </div>

      {/* Dashboard Hero — sidebar handles main navigation */}
      <div className="dash-hero" id="dash-hero">
        <div className="dash-hero-orbital">
          <div className="dho-ring dho-ring-1" />
          <div className="dho-ring dho-ring-2" />
          <div className="dho-ring dho-ring-3" />
        </div>

        {/* Welcome */}
        <div className="dash-hero-top">
          <div className="dash-hero-greeting">
            <h1 className="dash-hero-title">Command Center</h1>
            <p className="dash-hero-subtitle">6-phase glass-box pipeline · audit trail included</p>
          </div>
          <div className="dash-hero-actions">
            <div className="dash-system-status">
              <div className={`dss-dot${running > 0 ? ' running' : ' idle'}`} />
              <span>
                {running > 0
                  ? `${running} build${running > 1 ? 's' : ''} running`
                  : 'Pipeline idle'}
              </span>
            </div>
            <button className="dash-hero-cta" onClick={() => setShowRunModal(true)}>
              New Build
            </button>
            {showPlanBadge && (
              <div className="plan-badge">
                <span className="plan-credits-badge">
                  {isAdmin ? 'Unlimited credits' : `${credits} credits`}
                </span>
                {showUpgradeBtn && (
                  <button className="plan-link-btn" onClick={() => setShowUpgradeModal(true)}>
                    Upgrade ↑
                  </button>
                )}
                {showManageBtn && (
                  <button className="plan-link-btn" onClick={handleManageSubscription}>
                    Manage plan
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Stat cards */}
        <div className="dash-stat-grid" id="dash-stat-grid">
          <div className="dash-stat-card">
            <div className="dsc-label">Total Builds</div>
            <div className="dsc-value">{stats?.total_builds ?? '—'}</div>
            <div className="dsc-sub">{totalBuilds === 1 ? '1 build all time' : `${totalBuilds} builds all time`}</div>
          </div>
          <div className="dash-stat-card success">
            <div className="dsc-label">Success Rate</div>
            <div className="dsc-value dsc-success">
              {stats && stats.total_builds > 0 ? `${stats.success_rate}%` : '—'}
            </div>
            <div className="dsc-sub">{stats?.completed ?? 0} completed</div>
          </div>
          <div className="dash-stat-card accent">
            <div className="dsc-label">Avg Build Time</div>
            <div className="dsc-value dsc-accent">{fmtDuration(stats?.avg_duration_seconds)}</div>
            <div className="dsc-sub">per completed run</div>
          </div>
          <div className={`dash-stat-card live${running > 0 ? ' active' : ''}`}>
            <div className="dsc-label">Active Now</div>
            <div className="dsc-value dsc-live">{running}</div>
            <div className="dsc-sub">{running > 0 ? 'pipeline active' : 'idle'}</div>
          </div>
        </div>

        {/* Trial upgrade banner */}
        {showTrialBanner && !isPro && (
          <div className="trial-upgrade-banner">
            <div className="tub-left">
              <span className="tub-icon">🚀</span>
              <div>
                <div className="tub-title">
                  You've built {totalBuilds} projects — unlock unlimited builds
                </div>
                <div className="tub-sub">
                  Pro plan: priority queue, GitHub auto-push, custom domains ·{' '}
                  {trialCreditsLeft} trial credits remaining
                </div>
              </div>
            </div>
            <div className="tub-right">
              <Link to="/pricing" className="tub-cta">View Pro plan →</Link>
              <button className="tub-dismiss" onClick={() => setShowTrialBanner(false)}>✕</button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="dash-hero-body">
          {/* Intent distribution */}
          {intentEntries.length > 0 && (
            <div className="dash-intent-section">
              <div className="dis-label">Intent distribution</div>
              <div className="dis-pills">
                {intentEntries.map(([ic, count]) => {
                  const m = INTENT_MAP[ic] ?? { label: ic, color: 'var(--text-muted)' };
                  return (
                    <span
                      key={ic}
                      className="dis-pill"
                      style={{
                        borderColor: `${m.color}20`,
                        color: m.color,
                        background: `${m.color}10`,
                      }}
                    >
                      {m.label} <b>{count}</b>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent runs */}
          <div className="dash-recent-section">
            <div className="drs-header">
              <h2>Recent Builds</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {totalBuilds > 0 && (
                  <button
                    className="drs-clear-all-btn"
                    onClick={() => setShowClearAllModal(true)}
                    title="Delete all builds permanently"
                  >
                    ✕ Clear All
                  </button>
                )}
                <Link to="/history" className="drs-view-all">View All →</Link>
              </div>
            </div>
            <div className="drs-list">
              {recentRuns.length === 0 ? (
                <div className="drs-empty">
                  <div className="drs-empty-icon">⊙</div>
                  <div className="drs-empty-title">No builds yet</div>
                  <div className="drs-empty-sub">Launch your first pipeline to see results here.</div>
                  <Link to="/new" className="drs-empty-cta">⊕ New Build</Link>
                </div>
              ) : (
                recentRuns.map(r => {
                  const ptext = r.prompt ? r.prompt.slice(0, 80) + (r.prompt.length > 80 ? '…' : '') : 'Untitled';
                  return (
                    <Link key={r.id} to={`/run/${r.id}`} className="drs-item">
                      <div className="drs-item-left">
                        <StatusBadge status={r.status} />
                        <span className="drs-prompt">{ptext}</span>
                      </div>
                      <div className="drs-item-right">
                        <IntentBadge ic={r.intent_class} />
                        <span className="drs-duration">{fmtDuration(r.duration_s)}</span>
                        <span className="drs-time">{fmtTime(r.created_at)}</span>
                        <span className="drs-arrow">→</span>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* New Build Modal */}
      {showRunModal && (
        <div className="modal-overlay visible" onClick={e => { if (e.target === e.currentTarget) setShowRunModal(false); }}>
          <div className="modal">
            <div className="modal-header">
              <h2>New Build</h2>
              <button className="modal-close" onClick={() => setShowRunModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <textarea
                placeholder="Describe what you want to build..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) submitRun(); }}
                autoFocus
              />
              <button
                id="submit-run-btn"
                onClick={submitRun}
                disabled={!prompt.trim() || isSubmitting}
                style={{ marginTop: 12, width: '100%' }}
              >
                {isSubmitting ? 'Launching…' : 'Start Build'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upgrade Modal */}
      {showUpgradeModal && (
        <div className="modal-overlay visible" onClick={e => { if (e.target === e.currentTarget) setShowUpgradeModal(false); }}>
          <div className="modal">
            <div className="modal-header">
              <h2>BuildOrbit Pro</h2>
              <button className="modal-close" onClick={() => setShowUpgradeModal(false)}>✕</button>
            </div>
            <div className="upgrade-modal-body">
              <div className="upgrade-price">$49<span>/month</span></div>
              <p>Daily autonomous build cycles that ship features while you sleep.</p>
              <ul className="upgrade-features">
                <li><span>✓</span> Daily autonomous build cycles</li>
                <li><span>✓</span> <strong>10 bonus credits</strong> on signup</li>
                <li><span>✓</span> 5 renewal credits every month</li>
                <li><span>✓</span> Plan, build, verify, deploy — fully automated</li>
              </ul>
              <button
                className="upgrade-checkout-btn"
                onClick={handleCheckout}
                disabled={isCheckoutLoading}
              >
                {isCheckoutLoading ? 'Redirecting…' : 'Subscribe for $49/month →'}
              </button>
              <p className="upgrade-footer">Secured by Stripe · Cancel any time</p>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Modal */}
      {showClearAllModal && (
        <div className="modal-overlay visible" onClick={e => { if (e.target === e.currentTarget) setShowClearAllModal(false); }}>
          <div className="modal">
            <div className="modal-header">
              <h2>Clear All Builds</h2>
              <button className="modal-close" onClick={() => setShowClearAllModal(false)}>✕</button>
            </div>
            <div className="confirm-modal-body">
              <span className="confirm-modal-count">{totalBuilds} build{totalBuilds !== 1 ? 's' : ''}</span>
              <p>
                This will permanently delete all your builds and their execution data.
                <br />
                This action <strong>cannot be undone</strong>.
              </p>
              <button
                className="modal-danger-btn"
                onClick={confirmClearAll}
                disabled={isClearing}
              >
                {isClearing ? 'Deleting…' : 'Delete all builds'}
              </button>
              <button className="modal-cancel-btn" onClick={() => setShowClearAllModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div className="bo-toast visible">{toast}</div>}
    </div>
  );
}
