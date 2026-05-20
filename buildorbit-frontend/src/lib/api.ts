/**
 * BuildOrbit shared API client
 * Owns: fetch wrappers for /api/* and /auth/* endpoints, CSRF token management.
 * Not owned: page-specific logic.
 *
 * CSRF: server requires X-CSRF-Token header on all state-changing requests
 * authenticated via session cookie. The token is fetched once on load and
 * refreshed automatically on 403 CSRF errors.
 */

// ── CSRF token management ─────────────────────────────────────────────────

let _csrfToken: string | null = null;

/**
 * Fetch (or return cached) CSRF token from /api/csrf-token.
 * Safe to call multiple times — only makes a network request when cache is empty.
 */
async function getCsrfToken(): Promise<string> {
  if (_csrfToken) return _csrfToken;
  try {
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json() as { token: string };
      _csrfToken = data.token;
      return _csrfToken;
    }
  } catch {
    // Non-fatal: if CSRF fetch fails, the subsequent request will 403 and the
    // user will see a clear error message.
  }
  return '';
}

// Kick off CSRF token prefetch immediately on module load (parallel to page render)
getCsrfToken().catch(() => {});

// ── Core fetch helpers ────────────────────────────────────────────────────

async function get<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  const csrfToken = await getCsrfToken();
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // On CSRF failure: clear the cached token so the next request fetches a fresh one
    if (res.status === 403) _csrfToken = null;
    const data = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(data.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function del<T = unknown>(url: string, body?: unknown): Promise<T> {
  const csrfToken = await getCsrfToken();
  const res = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 403) _csrfToken = null;
    const data = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(data.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = { get, post, delete: del };

/* ── Typed endpoint wrappers ─────────────────────────────────── */

export interface DashboardStats {
  total_builds: number;
  completed: number;
  failed: number;
  running: number;
  success_rate: number;
  avg_duration_seconds: number | null;
  intent_distribution: Record<string, number>;
}

export interface RecentRun {
  id: string;
  prompt: string;
  status: string;
  intent_class: string;
  duration_s: number | null;
  created_at: string;
}

export interface DashboardResponse {
  success: boolean;
  stats: DashboardStats;
  recent_runs: RecentRun[];
}

export interface BillingStatus {
  success: boolean;
  subscription_status: string;
  task_credits: number;
  is_admin: boolean;
}

export interface ApiToken {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export interface ApiTokensResponse {
  tokens: ApiToken[];
}

export interface PipelineRun {
  id: string;
  prompt: string;
  status: string;
  intent_class: string | null;
  current_phase: string | null;
  phases: Record<string, PhaseState>;
  github_pr_url?: string;
  polsia_app_url?: string;
  created_at: string;
  cost?: number;
}

export interface PhaseState {
  status: 'waiting' | 'running' | 'complete' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

export const fetchDashboard = () => api.get<DashboardResponse>('/api/dashboard/stats');
export const fetchBillingStatus = () => api.get<BillingStatus>('/api/billing/status');
export const startBillingCheckout = () => api.post<{ url: string }>('/api/billing/create-checkout', {});
export const activateSubscription = () => api.post('/api/billing/activate', {});
export const getBillingPortal = () => api.get<{ url: string }>('/api/billing/portal');

export const createPipeline = (prompt: string, opts?: Record<string, unknown>) =>
  api.post<{ id: string }>('/api/pipeline', { prompt, ...opts });

export const fetchRun = (runId: string) =>
  api.get<{ success: boolean; run: PipelineRun }>(`/api/pipeline/${runId}/details`);

export const deleteAllBuilds = () => api.delete<{ success: boolean; deleted: number }>('/api/builds/bulk', { all: true });

export const fetchApiTokens = () => api.get<ApiTokensResponse>('/auth/api-tokens');
export const createApiToken = (label: string, expiry: string) =>
  api.post<{ token: string; id: string }>('/auth/api-token', { label, expires_in: expiry });
export const revokeApiToken = (id: string) => api.delete(`/auth/api-token/${id}`);

export const fetchGithubStatus = () => api.get<{ connected: boolean; login?: string; repos?: unknown[] }>('/api/github/status');
export const fetchGithubRepos = () => api.get<{ repos: unknown[] }>('/api/github/repos');

/* ── Verify Fix ────────────────────────────────────────────── */
export interface VerifyFixResult {
  success: boolean;
  check: { name: string; passed: boolean; message: string };
  retryCount: number;
  exhausted: boolean;
  appliedFixes?: string[];
  analysis?: string;
}

export const triggerVerifyFix = (runId: string, checkName: string) =>
  api.post<VerifyFixResult>(`/api/pipeline/${runId}/verify-fix`, { checkName });

/* ── History ────────────────────────────────────────────────── */
export interface HistoryRun {
  id: string;
  prompt: string;
  status: string;
  intent_class: string;
  created_at: string;
  completed_at: string | null;
  duration_s: number | null;
}

export interface HistoryResponse {
  success: boolean;
  runs: HistoryRun[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export const fetchHistory = (opts?: { page?: number; limit?: number; status?: string; q?: string }) => {
  const params = new URLSearchParams();
  if (opts?.page) params.set('page', String(opts.page));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.status) params.set('status', opts.status);
  if (opts?.q) params.set('q', opts.q);
  const qs = params.toString();
  return api.get<HistoryResponse>(`/api/history${qs ? `?${qs}` : ''}`);
};

/* ── Phase Reasoning ────────────────────────────────────────── */
export interface ReasoningEntry {
  phase: string;
  summary: string;
  detail: string;
  ts: string;
}

export interface ReasoningResponse {
  success: boolean;
  runId: string;
  timeline: ReasoningEntry[];
}

export const fetchRunReasoning = (runId: string) =>
  api.get<ReasoningResponse>(`/api/runs/${runId}/reasoning`);
