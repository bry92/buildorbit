/**
 * Sidebar — persistent navigation for all authenticated routes.
 * Owns: nav links, collapse toggle, mobile hamburger, logo, upgrade prompt.
 * Not owned: page content, auth state, routing decisions.
 */
import { useState, useEffect, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { fetchBillingStatus } from '../../lib/api';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: '◎' },
  { to: '/new',       label: 'New Build',  icon: '⊕' },
  { to: '/history',   label: 'History',    icon: '☰' },
  { to: '/settings',  label: 'Settings',   icon: '⚙' },
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

  /* Close mobile nav on route change */
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  /* Close mobile nav on Escape */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  /* Show upgrade button only for trial/free users; detect admin */
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
      {/* Mobile hamburger — visible only on small screens */}
      <button
        className="sb-hamburger"
        onClick={() => setMobileOpen(prev => !prev)}
        aria-label="Toggle navigation"
      >
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
        <span className={`sb-hamburger-bar${mobileOpen ? ' open' : ''}`} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="sb-overlay" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`sb${collapsed ? ' sb--collapsed' : ''}${mobileOpen ? ' sb--mobile-open' : ''}`}>
        {/* Logo */}
        <div className="sb-logo">
          <div className="sb-logo-dot" />
          {!collapsed && <span className="sb-logo-text">BuildOrbit</span>}
        </div>

        {/* Navigation */}
        <nav className="sb-nav">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sb-link${isActive ? ' sb-link--active' : ''}`
              }
              title={collapsed ? item.label : undefined}
            >
              <span className="sb-link-icon">{item.icon}</span>
              {!collapsed && <span className="sb-link-label">{item.label}</span>}
            </NavLink>
          ))}
          {/* Admin link — only visible to admin users */}
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `sb-link sb-link--admin${isActive ? ' sb-link--active' : ''}`
              }
              title={collapsed ? 'Admin' : undefined}
            >
              <span className="sb-link-icon">🛡</span>
              {!collapsed && <span className="sb-link-label">Admin</span>}
            </NavLink>
          )}
        </nav>

        {/* Upgrade to Pro — shown only for trial users */}
        {showUpgrade && (
          <a
            href="/pricing"
            className={`sb-upgrade${collapsed ? ' sb-upgrade--collapsed' : ''}`}
            title={collapsed ? 'Upgrade to Pro — $29/mo' : undefined}
          >
            <span className="sb-upgrade-icon">⚡</span>
            {!collapsed && <span className="sb-upgrade-label">Upgrade to Pro</span>}
          </a>
        )}

        {/* Collapse toggle — desktop only */}
        <button className="sb-collapse-toggle" onClick={onToggle} aria-label="Collapse sidebar">
          <span className={`sb-chevron${collapsed ? ' sb-chevron--flipped' : ''}`}>‹</span>
        </button>
      </aside>
    </>
  );
}

/** Hook for sidebar collapse state — persisted in localStorage */
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
