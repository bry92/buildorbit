/**
 * Shell — root layout wrapper for all authenticated routes.
 * Owns: sidebar nav, main content area, chat widget.
 * Not owned: individual page content, auth, API calls.
 */
import { Outlet, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import './Shell.css';
import Sidebar, { useSidebarCollapse } from './Sidebar';
import ChatWidget from '../ChatWidget/ChatWidget';
import { RunProvider } from '../../state/runContext';
import { UIProvider, useUIState } from '../../state/uiState';

/**
 * ShellContent — inner component that can access UIContext.
 * Handles auto-opening chat widget when ?chat=open query param is present.
 */
function ShellContent() {
  const [searchParams] = useSearchParams();
  const { setChatOpen } = useUIState();
  const { collapsed, toggle } = useSidebarCollapse();

  useEffect(() => {
    if (searchParams.get('chat') === 'open') {
      setChatOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [searchParams, setChatOpen]);

  return (
    <div className={`bo-shell${collapsed ? ' bo-shell--sb-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <main className="bo-main">
        <Outlet />
      </main>
      <ChatWidget />
    </div>
  );
}

export default function Shell() {
  return (
    <UIProvider>
      <RunProvider>
        <ShellContent />
      </RunProvider>
    </UIProvider>
  );
}
