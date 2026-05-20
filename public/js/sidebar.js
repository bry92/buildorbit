/**
 * BuildOrbit Sidebar Navigation
 * Self-contained, injected via <script src="/js/sidebar.js"></script>
 * Persistent collapse state via localStorage.
 */
(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────── */
  const NAV_ITEMS = [
    {
      label: 'Dashboard',
      href: '/dashboard',
      match: ['/dashboard'],
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
      </svg>`,
    },
    {
      label: 'New Build',
      href: '/new',
      match: ['/new'],
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5,3 19,12 5,21"/>
      </svg>`,
    },
    {
      label: 'Build History',
      href: '/history',
      match: ['/history'],
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15,15"/>
      </svg>`,
    },
    {
      label: 'Elemental',
      href: '/elemental',
      match: ['/elemental'],
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5"/>
        <line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="8.5" x2="22" y2="8.5"/>
        <line x1="2" y1="15.5" x2="22" y2="15.5"/>
      </svg>`,
    },
    {
      label: 'Settings',
      href: '/settings/api-keys',
      match: ['/settings', '/settings/api-keys'],
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>`,
    },
  ];

  const W_OPEN = 240;   // px — expanded (icon + label)
  const W_CLOSED = 64;  // px — collapsed (icons only, 16px centered)
  const MOBILE_BREAKPOINT = 768;
  const LS_KEY = 'bo_sidebar_collapsed';

  /* ── State ───────────────────────────────────────────────── */
  let collapsed = localStorage.getItem(LS_KEY) === 'true';
  let mobileOpen = false;

  /* ── Inject CSS ──────────────────────────────────────────── */
  const css = `
    :root {
      --sb-w: ${W_OPEN}px;
      --sb-wc: ${W_CLOSED}px;
      --sb-bg: #111113;
      --sb-border: #27272a;
      --sb-accent: #14b8a6;
      --sb-accent-dim: rgba(20,184,166,0.10);
      --sb-text: #f4f4f5;
      --sb-text-muted: #a1a1aa;
      --sb-transition: 0.2s ease-out;
    }

    /* ── Sidebar shell ────────────────────────────────────── */
    #bo-sidebar {
      position: fixed;
      top: 0; left: 0;
      height: 100vh;
      width: var(--sb-w);
      background: var(--sb-bg);
      border-right: 1px solid var(--sb-border);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      transition: width var(--sb-transition);
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      pointer-events: auto;
    }
    #bo-sidebar.collapsed {
      width: var(--sb-wc);
    }

    /* ── Logo row ─────────────────────────────────────────── */
    .sb-logo-row {
      height: 56px;
      min-height: 56px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      border-bottom: 1px solid var(--sb-border);
      gap: 10px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .sb-logo-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--sb-accent);
      box-shadow: 0 0 10px var(--sb-accent);
      flex-shrink: 0;
      animation: sb-pulse 2s ease-in-out infinite;
    }
    @keyframes sb-pulse {
      0%,100% { opacity:1; box-shadow:0 0 10px var(--sb-accent); }
      50%      { opacity:0.6; box-shadow:0 0 5px var(--sb-accent); }
    }
    .sb-logo-text {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700;
      font-size: 1.05rem;
      letter-spacing: -0.4px;
      color: var(--sb-text);
      white-space: nowrap;
      opacity: 1;
      transition: opacity var(--sb-transition);
      text-decoration: none;
    }
    #bo-sidebar.collapsed .sb-logo-text { opacity: 0; pointer-events: none; }

    /* ── Nav items ────────────────────────────────────────── */
    .sb-nav {
      flex: 1;
      padding: 12px 0;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .sb-nav::-webkit-scrollbar { width: 0; }

    .sb-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 18px;
      margin: 2px 8px;
      border-radius: 8px;
      text-decoration: none;
      color: var(--sb-text-muted);
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.875rem;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.2s ease-out, color 0.2s ease-out, border-color 0.2s ease-out;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      border-left: 3px solid transparent;
    }
    .sb-item:hover {
      background: rgba(14,165,233,0.08);
      color: var(--sb-text);
    }
    .sb-item.active {
      background: transparent;
      color: var(--sb-text);
      font-weight: 600;
      border-left: 3px solid #0EA5E9;
      padding-left: 13px;
      box-shadow: none;
    }
    .sb-item.active .sb-item-icon svg {
      stroke: #0EA5E9;
    }
    .sb-item-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .sb-item-label {
      opacity: 1;
      transition: opacity var(--sb-transition);
      flex: 1;
    }
    #bo-sidebar.collapsed .sb-item-label { opacity: 0; }

    /* tooltip when collapsed */
    #bo-sidebar.collapsed .sb-item::after {
      content: attr(data-label);
      position: absolute;
      left: calc(var(--sb-wc) + 8px);
      top: 50%;
      transform: translateY(-50%);
      background: #27272a;
      color: var(--sb-text);
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.8rem;
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--sb-border);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 999;
    }
    #bo-sidebar.collapsed .sb-item:hover::after { opacity: 1; }

    /* ── Toggle button ────────────────────────────────────── */
    .sb-footer {
      padding: 12px 8px;
      border-top: 1px solid var(--sb-border);
      flex-shrink: 0;
    }
    .sb-toggle {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 8px;
      border-radius: 8px;
      cursor: pointer;
      color: var(--sb-text-muted);
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.8rem;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
      overflow: hidden;
    }
    .sb-toggle:hover {
      background: rgba(255,255,255,0.05);
      color: var(--sb-text);
    }
    .sb-toggle-icon {
      flex-shrink: 0;
      width: 20px; height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform var(--sb-transition);
    }
    #bo-sidebar.collapsed .sb-toggle-icon { transform: rotate(180deg); }
    .sb-toggle-label {
      opacity: 1;
      transition: opacity var(--sb-transition);
    }
    #bo-sidebar.collapsed .sb-toggle-label { opacity: 0; }

    /* ── Body offset ──────────────────────────────────────── */
    body.sb-ready {
      padding-left: var(--sb-w) !important;
      transition: padding-left var(--sb-transition);
    }
    body.sb-ready.sb-collapsed {
      padding-left: var(--sb-wc) !important;
    }
    /* Adjust fixed navbars — only elements with .bo-fixed-nav class (set by JS) */
    body.sb-ready .bo-fixed-nav {
      left: var(--sb-w) !important;
      width: calc(100% - var(--sb-w)) !important;
      transition: left var(--sb-transition), width var(--sb-transition);
    }
    body.sb-ready.sb-collapsed .bo-fixed-nav {
      left: var(--sb-wc) !important;
      width: calc(100% - var(--sb-wc)) !important;
    }

    /* ── Mobile overlay ───────────────────────────────────── */
    #bo-sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 999;
      backdrop-filter: blur(2px);
    }
    #bo-sidebar-overlay.visible { display: block; }

    /* ── Mobile hamburger ─────────────────────────────────── */
    #bo-hamburger {
      display: none;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 1100;
      background: var(--sb-bg);
      border: 1px solid var(--sb-border);
      border-radius: 8px;
      padding: 8px;
      cursor: pointer;
      color: var(--sb-text-muted);
      transition: color 0.15s, background 0.15s;
    }
    #bo-hamburger:hover { color: var(--sb-text); background: #27272a; }

    /* ── Responsive ───────────────────────────────────────── */
    @media (max-width: ${MOBILE_BREAKPOINT}px) {
      #bo-sidebar {
        transform: translateX(-100%);
        transition: transform var(--sb-transition);
        width: var(--sb-w) !important;
      }
      #bo-sidebar.mobile-open {
        transform: translateX(0);
      }
      body.sb-ready,
      body.sb-ready.sb-collapsed {
        padding-left: 0 !important;
      }
      body.sb-ready .bo-fixed-nav,
      body.sb-ready.sb-collapsed .bo-fixed-nav {
        left: 0 !important;
        width: 100% !important;
      }
      #bo-hamburger { display: flex; }
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.id = 'bo-sidebar-styles';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── Build HTML ──────────────────────────────────────────── */
  const currentPath = window.location.pathname;

  function isActive(item) {
    return item.match.includes(currentPath);
  }

  const itemsHtml = NAV_ITEMS.map(item => `
    <a class="sb-item ${isActive(item) ? 'active' : ''}" href="${item.href}" data-label="${item.label}">
      <span class="sb-item-icon">${item.icon}</span>
      <span class="sb-item-label">${item.label}</span>
    </a>
  `).join('');

  const toggleIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15,18 9,12 15,6"/>
  </svg>`;

  const sidebarHtml = `
    <div class="sb-logo-row">
      <span class="sb-logo-dot"></span>
      <a href="/" class="sb-logo-text">BuildOrbit</a>
    </div>
    <nav class="sb-nav">${itemsHtml}</nav>
    <div class="sb-footer">
      <div class="sb-toggle" id="bo-sidebar-toggle" title="Collapse sidebar">
        <span class="sb-toggle-icon">${toggleIconSvg}</span>
        <span class="sb-toggle-label">Collapse</span>
      </div>
    </div>
  `;

  /* ── Inject sidebar + overlay + hamburger ──────────────── */
  const sidebar = document.createElement('div');
  sidebar.id = 'bo-sidebar';
  sidebar.innerHTML = sidebarHtml;

  const overlay = document.createElement('div');
  overlay.id = 'bo-sidebar-overlay';

  const hamburger = document.createElement('button');
  hamburger.id = 'bo-hamburger';
  hamburger.setAttribute('aria-label', 'Open navigation');
  hamburger.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>`;

  document.body.prepend(hamburger);
  document.body.prepend(overlay);
  document.body.prepend(sidebar);

  /* ── Mark fixed navbars for CSS targeting ───────────────── */
  // Must run after DOMContentLoaded so computed styles are available
  function markFixedNavbars() {
    var candidates = document.querySelectorAll('nav, .topnav');
    candidates.forEach(function (el) {
      // Skip the sidebar's own nav
      if (el.closest('#bo-sidebar')) return;
      var pos = window.getComputedStyle(el).position;
      if (pos === 'fixed') {
        el.classList.add('bo-fixed-nav');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markFixedNavbars);
  } else {
    markFixedNavbars();
  }

  /* ── Apply initial state ────────────────────────────────── */
  function applyState() {
    if (collapsed) {
      sidebar.classList.add('collapsed');
      document.body.classList.add('sb-collapsed');
    } else {
      sidebar.classList.remove('collapsed');
      document.body.classList.remove('sb-collapsed');
    }
    document.body.classList.add('sb-ready');
  }

  applyState();

  /* ── Toggle collapse ────────────────────────────────────── */
  document.getElementById('bo-sidebar-toggle').addEventListener('click', function () {
    // On mobile, "Collapse" closes the sidebar instead of narrowing it
    if (isMobile()) {
      mobileOpen = false;
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
      return;
    }
    collapsed = !collapsed;
    localStorage.setItem(LS_KEY, collapsed);
    applyState();
  });

  /* ── Mobile: hamburger / overlay ────────────────────────── */
  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  hamburger.addEventListener('click', function () {
    mobileOpen = true;
    sidebar.classList.add('mobile-open');
    overlay.classList.add('visible');
  });

  overlay.addEventListener('click', function () {
    mobileOpen = false;
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('visible');
  });

  /* Close mobile sidebar on nav item click */
  sidebar.querySelectorAll('.sb-item').forEach(function (el) {
    el.addEventListener('click', function () {
      if (isMobile()) {
        mobileOpen = false;
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('visible');
      }
    });
  });

  /* ── Handle resize ──────────────────────────────────────── */
  window.addEventListener('resize', function () {
    if (!isMobile() && mobileOpen) {
      mobileOpen = false;
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
    }
  });

  /* ── Close mobile sidebar on Escape key ────────────────── */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isMobile() && mobileOpen) {
      mobileOpen = false;
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
    }
  });

})();
