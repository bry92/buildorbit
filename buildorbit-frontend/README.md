# BuildOrbit Frontend (React + Vite)

Phase 1: 1:1 React+Vite port of the existing BuildOrbit static HTML UI.

## Dev

```bash
npm install
npm run dev   # http://localhost:5173 — proxies /api, /auth, /a2a to localhost:3000
```

## Build

```bash
npm run build  # outputs to ../public/react-build/
```

## Architecture

```
src/
  main.tsx          — entry point, imports theme
  App.tsx           — BrowserRouter + Shell wrapping all routes
  theme/            — CSS variables (tokens.css) + global reset (globals.css)
  components/
    Shell/          — persistent layout wrapper (bg + ChatWidget)
    ChatWidget/     — NuclearAgent floating chat bubble + panel
    ui/             — Card, Button primitives
  routes/
    Dashboard.tsx   — Command Center (stat cards, recent runs)
    Run.tsx         — Pipeline execution view (6 phase cards)
    Settings.tsx    — API key management
    NotFound.tsx    — 404 fallback
  lib/
    api.ts          — typed fetch wrappers for all /api/* endpoints
    utils.ts        — fmtDuration, fmtTime, formatDate helpers
    websocket.ts    — SSE helper for pipeline streaming
  state/            — (reserved for shared state in Phase 2)
  assets/           — logo.svg
```

## Proxy

Vite dev server proxies `/api`, `/auth`, `/a2a` to `localhost:3000` (Express backend).
