/**
 * Admin — User management dashboard for admin accounts only.
 * Owns: /admin route, user listing, search, sort, enable/disable.
 * Not owned: billing, pipeline analytics, feature flags.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import './Admin.css';

interface AdminUser {
  id: number;
  email: string;
  created_at: string;
  last_login_at: string | null;
  subscription_status: string;
  is_admin: boolean;
  task_credits: number;
  disabled: boolean;
  run_count: number;
  github_connected: boolean;
}

type SortKey = 'created_at' | 'last_login_at' | 'run_count';
type SortOrder = 'asc' | 'desc';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(iso);
}

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Check admin access first
  useEffect(() => {
    api.get<{ success: boolean; is_admin: boolean }>('/api/admin/me')
      .then(d => setIsAdmin(d.is_admin))
      .catch(() => setIsAdmin(false));
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ success: boolean; users: AdminUser[] }>(
        `/api/admin/users?sort=${sortKey}&order=${sortOrder}`
      );
      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [sortKey, sortOrder]);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.trim().toLowerCase();
    return users.filter(u => u.email.toLowerCase().includes(q));
  }, [users, search]);

  const handleSort = useCallback((key: SortKey) => {
    if (key === sortKey) {
      setSortOrder(o => o === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  }, [sortKey]);

  const toggleDisabled = useCallback(async (user: AdminUser) => {
    const action = user.disabled ? 'enable' : 'disable';
    const verb   = user.disabled ? 'Enable' : 'Disable';
    if (!confirm(`${verb} ${user.email}?`)) return;

    setTogglingId(user.id);
    try {
      await api.post(`/api/admin/users/${user.id}/${action}`);
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, disabled: !u.disabled } : u));
      showToast(`${user.email} ${action}d`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to ${action} user`, 'error');
    } finally {
      setTogglingId(null);
    }
  }, [showToast]);

  function SortIcon({ col }: { col: SortKey }) {
    if (col !== sortKey) return <span className="sort-icon sort-icon--inactive">⇅</span>;
    return <span className="sort-icon sort-icon--active">{sortOrder === 'desc' ? '↓' : '↑'}</span>;
  }

  // Gate: not checked yet
  if (isAdmin === null) {
    return (
      <div className="admin-page">
        <div className="admin-loading"><div className="admin-spinner" /><span>Checking access…</span></div>
      </div>
    );
  }

  // Gate: not admin
  if (!isAdmin) {
    return (
      <div className="admin-page">
        <div className="admin-denied">
          <div className="admin-denied-icon">🔒</div>
          <h2>Access Denied</h2>
          <p>You don't have permission to view this page.</p>
          <a href="/dashboard" className="admin-back-btn">← Back to Dashboard</a>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      {/* Toast */}
      {toast && (
        <div className={`admin-toast admin-toast--${toast.type}`}>{toast.msg}</div>
      )}

      {/* Header */}
      <div className="admin-header">
        <div className="admin-header-left">
          <div className="admin-title">
            <span className="admin-title-icon">🛡️</span>
            Admin Panel
          </div>
          <p className="admin-subtitle">User management — {filteredUsers.length} of {users.length} users</p>
        </div>
        <button className="admin-refresh-btn" onClick={loadUsers} disabled={loading}>
          {loading ? '…' : '↺'} Refresh
        </button>
      </div>

      {/* Search bar */}
      <div className="admin-controls">
        <div className="admin-search-wrap">
          <span className="admin-search-icon">⌕</span>
          <input
            className="admin-search"
            type="text"
            placeholder="Search by email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="admin-search-clear" onClick={() => setSearch('')}>×</button>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="admin-error">{error}</div>
      )}

      {/* Table */}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="th-email">Email</th>
              <th className="th-sort" onClick={() => handleSort('created_at')}>
                Signed up <SortIcon col="created_at" />
              </th>
              <th>GitHub</th>
              <th className="th-sort" onClick={() => handleSort('last_login_at')}>
                Last active <SortIcon col="last_login_at" />
              </th>
              <th className="th-sort th-runs" onClick={() => handleSort('run_count')}>
                Runs <SortIcon col="run_count" />
              </th>
              <th>Plan</th>
              <th>Status</th>
              <th className="th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="td-empty">
                <div className="admin-spinner-row"><div className="admin-spinner" /> Loading users…</div>
              </td></tr>
            ) : filteredUsers.length === 0 ? (
              <tr><td colSpan={8} className="td-empty">
                {search ? `No users matching "${search}"` : 'No users found.'}
              </td></tr>
            ) : filteredUsers.map(user => (
              <tr key={user.id} className={user.disabled ? 'tr-disabled' : ''}>
                <td className="td-email">
                  <span className="user-email">{user.email}</span>
                  {user.is_admin && <span className="badge badge-admin">admin</span>}
                </td>
                <td className="td-date">{formatDate(user.created_at)}</td>
                <td className="td-center">
                  {user.github_connected
                    ? <span className="badge badge-yes">✓</span>
                    : <span className="badge badge-no">—</span>
                  }
                </td>
                <td className="td-date">{formatRelative(user.last_login_at)}</td>
                <td className="td-number">{user.run_count}</td>
                <td>
                  <span className={`badge badge-plan badge-plan--${user.subscription_status}`}>
                    {user.subscription_status}
                  </span>
                </td>
                <td>
                  <span className={`badge ${user.disabled ? 'badge-disabled' : 'badge-active'}`}>
                    {user.disabled ? 'disabled' : 'active'}
                  </span>
                </td>
                <td className="td-actions">
                  <button
                    className={`admin-action-btn ${user.disabled ? 'admin-action-btn--enable' : 'admin-action-btn--disable'}`}
                    onClick={() => toggleDisabled(user)}
                    disabled={togglingId === user.id}
                  >
                    {togglingId === user.id ? '…' : user.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
