/**
 * History — paginated build history at /history.
 * Owns: run list, filters, pagination.
 * Not owned: nav, individual run details, pipeline execution.
 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchHistory, type HistoryRun } from '../lib/api';
import { fmtDuration, fmtTime } from '../lib/utils';
import './History.css';

const STATUS_FILTERS = ['all', 'completed', 'partial_success', 'failed', 'running', 'pending'] as const;

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completed',
  partial_success: 'Partial',
  failed: 'Failed',
  running: 'Running',
  in_progress: 'Running',
  pending: 'Pending',
  queued: 'Queued',
};

const INTENT_MAP: Record<string, { label: string; color: string }> = {
  static_surface: { label: 'Static', color: 'var(--accent)' },
  light_app:      { label: 'Light App', color: 'var(--success)' },
  soft_expansion: { label: 'Adaptive', color: 'var(--warning)' },
  full_product:   { label: 'Full Product', color: '#a78bfa' },
};

export default function History() {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: number, status: string, q: string) => {
    setLoading(true);
    try {
      const data = await fetchHistory({
        page: p,
        limit: 20,
        status: status === 'all' ? undefined : status,
        q: q.trim() || undefined,
      });
      if (data.success) {
        setRuns(data.runs);
        setTotal(data.pagination.total);
        setPages(data.pagination.pages);
      }
    } catch { /* non-fatal */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(page, statusFilter, search);
  }, [page, statusFilter, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback(() => {
    setPage(1);
    load(1, statusFilter, search);
  }, [statusFilter, search, load]);

  return (
    <div className="page-history">
      <div className="hy-content">
        {/* Header */}
        <div className="hy-header">
          <div>
            <h1 className="hy-title">Build History</h1>
            <p className="hy-subtitle">{total} build{total !== 1 ? 's' : ''} total</p>
          </div>
          <Link to="/new" className="hy-new-btn">⊕ New Build</Link>
        </div>

        {/* Filters */}
        <div className="hy-filters">
          <div className="hy-status-tabs">
            {STATUS_FILTERS.map(s => (
              <button
                key={s}
                className={`hy-tab${statusFilter === s ? ' hy-tab--active' : ''}`}
                onClick={() => { setStatusFilter(s); setPage(1); }}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s] ?? s}
              </button>
            ))}
          </div>
          <div className="hy-search-row">
            <input
              className="hy-search"
              type="text"
              placeholder="Search prompts…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            />
          </div>
        </div>

        {/* Run list */}
        <div className="hy-list">
          {loading && runs.length === 0 ? (
            <div className="hy-loading">
              <span className="spinner" /> Loading…
            </div>
          ) : runs.length === 0 ? (
            <div className="hy-empty">
              <div className="hy-empty-icon">⊙</div>
              <div className="hy-empty-title">No builds found</div>
              <div className="hy-empty-sub">
                {statusFilter !== 'all' || search
                  ? 'Try adjusting your filters.'
                  : 'Launch your first build to see it here.'}
              </div>
              <Link to="/new" className="hy-empty-cta">⊕ New Build</Link>
            </div>
          ) : (
            runs.map(r => {
              const ptext = r.prompt ? r.prompt.slice(0, 100) + (r.prompt.length > 100 ? '…' : '') : 'Untitled';
              const intent = INTENT_MAP[r.intent_class];
              return (
                <Link key={r.id} to={`/run/${r.id}`} className="hy-item">
                  <div className="hy-item-main">
                    <span className={`hy-status-dot hy-status-dot--${r.status || 'pending'}`} />
                    <div className="hy-item-text">
                      <div className="hy-item-prompt">{ptext}</div>
                      <div className="hy-item-meta">
                        <span className={`hy-status-label hy-status-label--${r.status}`}>
                          {STATUS_LABELS[r.status] ?? r.status ?? '—'}
                        </span>
                        {intent && (
                          <span className="hy-intent" style={{ color: intent.color }}>{intent.label}</span>
                        )}
                        <span className="hy-time">{fmtTime(r.created_at)}</span>
                        {r.duration_s != null && (
                          <span className="hy-duration">{fmtDuration(r.duration_s)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="hy-arrow">→</span>
                </Link>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {pages > 1 && (
          <div className="hy-pagination">
            <button
              className="hy-page-btn"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >
              ← Prev
            </button>
            <span className="hy-page-info">
              Page {page} of {pages}
            </span>
            <button
              className="hy-page-btn"
              disabled={page >= pages}
              onClick={() => setPage(p => Math.min(pages, p + 1))}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
