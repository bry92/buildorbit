/**
 * Sidebar - persistent navigation for authenticated routes.
 * Owns nav links, collapse state, mobile drawer, logo, and upgrade prompt.
 */
import { useState, useEffect, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { fetchBillingStatus } from '../../lib/api';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: 'DB' },
  { to: '/new', label: 'New Build', icon: '+' },
  { to: '/history', label: 'History', icon: 'H' },
  { to: '/settings', label: 'Settings', icon: 'S' },
] as const;

const STORAGE_KEY = 'bo_sidebar_collapsed';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    fetchBillingStatus().then(data => {
      if (!data.success) return;
      const isPro = data.subscription_status === 'active' || data.is_admin;
      setShowUpgrade(!isPro);
      if (data.is_admin) setIsAdmin(true);
    }).catch(() => { /* non-fatal */ });
  }, []);

  return (
    <>
      <button
        className="sb-hamburger"
        onClick={() => setMobileOpen(prev => !prev)}
        aria-label="Toggle navigation"
      >
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
      </button>

      {mobileOpen && (
        <div className="sb-overlay" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`sb${collapsed ? ' sb--collapsed' : ''}${mobileOpen ? ' sb--mobile-open' : ''}`}>
        <div className="sb-logo">
          <div className="sb-logo-dot" />
          {!collapsed && <span className="sb-logo-text">BuildOrbit</span>}
        </div>

        <nav className="sb-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sb-link${isActive ? ' sb-link--active' : ''}`
              }
              title={item.label}
              aria-label={item.label}
            >
              <span className="sb-link-icon" aria-hidden="true">{item.icon}</span>
              {!collapsed && <span className="sb-link-label">{item.label}</span>}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `sb-link sb-link--admin${isActive ? ' sb-link--active' : ''}`
              }
              title="Admin"
              aria-label="Admin"
            >
              <span className="sb-link-icon" aria-hidden="true">AD</span>
              {!collapsed && <span className="sb-link-label">Admin</span>}
            </NavLink>
          )}
        </nav>

        {showUpgrade && (
          <a
            href="/pricing"
            className={`sb-upgrade${collapsed ? ' sb-upgrade--collapsed' : ''}`}
            title="Upgrade to Pro - $29/mo"
            aria-label="Upgrade to Pro"
          >
            <span className="sb-upgrade-icon" aria-hidden="true">PRO</span>
            {!collapsed && <span className="sb-upgrade-label">Upgrade to Pro</span>}
          </a>
        )}

        <button className="sb-collapse-toggle" onClick={onToggle} aria-label="Collapse sidebar">
          <span className={`sb-chevron${collapsed ? ' sb-chevron--flipped' : ''}`}>&lt;</span>
        </button>
      </aside>
    </>
  );
}

/** Persisted sidebar collapse state. */
export function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; }
    catch { return false; }
  });

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
