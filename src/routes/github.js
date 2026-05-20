/**
 * GitHub OAuth + API routes
 *
 * Owns: GitHub OAuth connect/callback/disconnect, GitHub REST API proxy (list repos, create repo).
 * Not owned: pipeline run execution, user auth session management (handled by auth module).
 *
 * Exported routers:
 *   oauthRouter  → mounted at /auth/github
 *   apiRouter    → mounted at /api/github
 *
 * Endpoints:
 *   GET  /auth/github            → redirect to GitHub OAuth
 *   GET  /auth/github/callback   → handle OAuth callback, store encrypted token
 *   POST /auth/github/disconnect → revoke and delete connection
 *   GET  /api/github/status      → connected state + GitHub user info
 *   GET  /api/github/repos        → list user's repos (30s in-memory cache)
 *   POST /api/github/repos        → create a new repo
 *   GET  /api/github/analyze-repo → lightweight intent inference for a repo (stack, purpose, suggestion)
 *   GET  /api/github/repo-contents → full repo file tree + content for pipeline context
 */

const express = require('express');
const crypto  = require('crypto');

// ── Token encryption (AES-256-GCM) ───────────────────────────────────────
// Key derived from JWT_SECRET — must be set (validated at startup by auth module).
function getEncKey() {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET env var required for token encryption');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET).digest(); // 32 bytes
}

function encryptToken(plain) {
  const key = getEncKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':');
}

function decryptToken(enc) {
  const [ivHex, tagHex, ctHex] = enc.split(':');
  const key     = getEncKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), null, 'utf8') + decipher.final('utf8');
}

// ── In-memory repo cache (busted on connect/disconnect/create) ────────────
// userId → { repos: Array, fetchedAt: number }
const repoCache = new Map();
const REPO_CACHE_TTL_MS = 30_000;

/**
 * Build and return both routers.
 * @param {{ pool, auth }} opts
 * @returns {{ oauthRouter: Router, apiRouter: Router }}
 */
function createGitHubRouters({ pool, auth }) {
  const APP_URL              = process.env.APP_URL || 'https://buildorbit.polsia.app';
  const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
  const CALLBACK_URL         = `${APP_URL}/auth/github/callback`;

  // ── OAuth router (mounted at /auth/github) ────────────────────────────
  const oauthRouter = express.Router();

  // GET /auth/github — initiate OAuth
  oauthRouter.get('/', auth.requireAuth, (req, res) => {
    if (!GITHUB_CLIENT_ID) {
      return res.status(503).send('GitHub OAuth not configured (GITHUB_CLIENT_ID missing)');
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('github_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 min
    });

    const params = new URLSearchParams({
      client_id:    GITHUB_CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      scope:        'repo user:email',
      state,
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // GET /auth/github/callback — handle code exchange
  oauthRouter.get('/callback', auth.requireAuth, async (req, res) => {
    const { code, state } = req.query;
    const storedState     = req.cookies?.github_oauth_state;

    res.clearCookie('github_oauth_state');

    if (!state || state !== storedState) {
      return res.redirect('/github?error=state_mismatch');
    }
    if (!code) {
      return res.redirect('/github?error=no_code');
    }
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return res.redirect('/github?error=not_configured');
    }
    // Guard: auth middleware must resolve a userId
    if (!req.user?.userId) {
      console.error('[GitHub] Callback reached with no userId on req.user:', req.user);
      return res.redirect('/github?error=server_error');
    }

    try {
      // Exchange code → access token
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          client_id:     GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri:  CALLBACK_URL,
        }),
      });

      const tokenData = await tokenRes.json();

      if (tokenData.error || !tokenData.access_token) {
        console.error('[GitHub] Token exchange failed:', tokenData.error_description || tokenData.error);
        return res.redirect('/github?error=token_exchange_failed');
      }

      const accessToken = tokenData.access_token;

      // Fetch GitHub user profile
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!userRes.ok) {
        return res.redirect('/github?error=user_fetch_failed');
      }

      const ghUser          = await userRes.json();
      const encryptedToken  = encryptToken(accessToken);

      // Upsert connection record
      await pool.query(`
        INSERT INTO github_connections
          (user_id, github_user_id, github_login, github_name, github_avatar_url,
           access_token_enc, token_scope, connected_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          github_user_id    = EXCLUDED.github_user_id,
          github_login      = EXCLUDED.github_login,
          github_name       = EXCLUDED.github_name,
          github_avatar_url = EXCLUDED.github_avatar_url,
          access_token_enc  = EXCLUDED.access_token_enc,
          token_scope       = EXCLUDED.token_scope,
          updated_at        = NOW()
      `, [
        req.user.userId,
        ghUser.id,
        ghUser.login,
        ghUser.name || null,
        ghUser.avatar_url || null,
        encryptedToken,
        tokenData.scope || null,
      ]);

      repoCache.delete(req.user.userId);
      res.redirect('/new?github_connected=1');
    } catch (err) {
      console.error('[GitHub] Callback error:', err);
      res.redirect('/github?error=server_error');
    }
  });

  // POST /auth/github/disconnect
  oauthRouter.post('/disconnect', auth.requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM github_connections WHERE user_id = $1', [req.user.userId]);
      repoCache.delete(req.user.userId);
      res.json({ success: true });
    } catch (err) {
      console.error('[GitHub] Disconnect error:', err);
      res.status(500).json({ error: 'Failed to disconnect GitHub' });
    }
  });

  // ── API router (mounted at /api/github) ───────────────────────────────
  const apiRouter = express.Router();
  apiRouter.use(auth.requireApiAuth);

  // GET /api/github/status
  apiRouter.get('/status', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT github_login, github_name, github_avatar_url, connected_at
           FROM github_connections WHERE user_id = $1`,
        [req.user.userId]
      );

      if (!rows.length) return res.json({ connected: false });

      const c = rows[0];
      res.json({
        connected:    true,
        login:        c.github_login,
        name:         c.github_name,
        avatar_url:   c.github_avatar_url,
        connected_at: c.connected_at,
      });
    } catch (err) {
      console.error('[GitHub] Status error:', err);
      res.status(500).json({ error: 'Failed to fetch GitHub status' });
    }
  });

  // GET /api/github/repos
  apiRouter.get('/repos', async (req, res) => {
    try {
      // Serve from cache if fresh
      const cached = repoCache.get(req.user.userId);
      if (cached && Date.now() - cached.fetchedAt < REPO_CACHE_TTL_MS) {
        return res.json({ repos: cached.repos });
      }

      const { rows } = await pool.query(
        'SELECT access_token_enc FROM github_connections WHERE user_id = $1',
        [req.user.userId]
      );

      if (!rows.length) {
        return res.status(401).json({ error: 'GitHub not connected', code: 'NOT_CONNECTED' });
      }

      const token = decryptToken(rows[0].access_token_enc);

      const ghRes = await fetch(
        'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator',
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (ghRes.status === 401) {
        // Token revoked — clear connection so user re-connects
        await pool.query('DELETE FROM github_connections WHERE user_id = $1', [req.user.userId]);
        repoCache.delete(req.user.userId);
        return res.status(401).json({ error: 'GitHub token expired. Please reconnect.', code: 'TOKEN_EXPIRED' });
      }

      if (!ghRes.ok) {
        return res.status(502).json({ error: `GitHub API error: ${ghRes.status}` });
      }

      const allRepos = await ghRes.json();
      const repos    = allRepos.map(r => ({
        id:          r.id,
        full_name:   r.full_name,
        name:        r.name,
        private:     r.private,
        description: r.description || '',
        html_url:    r.html_url,
        pushed_at:   r.pushed_at,
      }));

      repoCache.set(req.user.userId, { repos, fetchedAt: Date.now() });
      res.json({ repos });
    } catch (err) {
      console.error('[GitHub] Repos error:', err);
      res.status(500).json({ error: 'Failed to fetch repos' });
    }
  });

  // POST /api/github/repos — create a new repo
  apiRouter.post('/repos', async (req, res) => {
    const { name, private: isPrivate = false, description = '' } = req.body;

    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.length > 100) {
      return res.status(400).json({ error: 'Invalid repo name. Use letters, numbers, hyphens, underscores, dots.' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT access_token_enc, github_login FROM github_connections WHERE user_id = $1',
        [req.user.userId]
      );

      if (!rows.length) {
        return res.status(401).json({ error: 'GitHub not connected', code: 'NOT_CONNECTED' });
      }

      const token = decryptToken(rows[0].access_token_enc);

      const ghRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          name,
          private:     Boolean(isPrivate),
          description: description || 'Created by BuildOrbit',
          auto_init:   false,
        }),
      });

      if (ghRes.status === 422) {
        const body = await ghRes.json().catch(() => ({}));
        const msg  = body.errors?.[0]?.message || 'Repository already exists or name is invalid';
        return res.status(422).json({ error: msg });
      }

      if (!ghRes.ok) {
        return res.status(502).json({ error: `GitHub API error: ${ghRes.status}` });
      }

      const repo = await ghRes.json();
      repoCache.delete(req.user.userId);

      res.status(201).json({
        id:        repo.id,
        full_name: repo.full_name,
        name:      repo.name,
        private:   repo.private,
        html_url:  repo.html_url,
      });
    } catch (err) {
      console.error('[GitHub] Create repo error:', err);
      res.status(500).json({ error: 'Failed to create repo' });
    }
  });

  // GET /api/github/analyze-repo?repo=owner/repo
  // Returns a lightweight inferred intent summary for a repo — stack detection,
  // purpose inference, feature list, and a pre-fill suggestion for the build prompt.
  // Used by the new-build page to auto-populate context when the user picks a repo.
  apiRouter.get('/analyze-repo', async (req, res) => {
    const { repo } = req.query;
    if (!repo || !/^[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+$/.test(repo)) {
      return res.status(400).json({ error: 'Invalid repo format. Use "owner/repo".' });
    }

    try {
      const { analyzeRepoIntent } = require('../services/github-fetch');
      const result = await analyzeRepoIntent({
        pool,
        userId: req.user.userId,
        repoFullName: repo,
      });

      res.json({
        repoFullName:  repo,
        stack:         result.stack,
        purpose:       result.purpose,
        features:      result.features,
        suggestion:    result.suggestion,
        totalFiles:    result.totalFiles,
        defaultBranch: result.defaultBranch,
      });
    } catch (err) {
      console.error('[GitHub] analyze-repo error:', err);
      if (err.code === 'NOT_CONNECTED') {
        return res.status(401).json({ error: 'GitHub not connected', code: 'NOT_CONNECTED' });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
      }
      res.status(500).json({ error: 'Failed to analyze repo' });
    }
  });

  // GET /api/github/repo-contents?repo=owner/repo
  // Fetches a lightweight summary of an existing repo (file tree + key file contents)
  // for injecting into the PLAN phase as context.
  apiRouter.get('/repo-contents', async (req, res) => {
    const { repo } = req.query;
    if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.\-]+$/.test(repo)) {
      return res.status(400).json({ error: 'Invalid repo format. Use "owner/repo".' });
    }

    try {
      const { fetchRepoContext } = require('../services/github-fetch');
      const context = await fetchRepoContext({
        pool,
        userId: req.user.userId,
        repoFullName: repo,
      });

      res.json({
        repoFullName:  context.repoFullName,
        defaultBranch: context.defaultBranch,
        totalFiles:    context.totalFiles,
        fetchedFiles:  context.fetchedFiles,
        fileTree:      context.fileTree.slice(0, 200), // cap for response size
        summary:       context.summary,
      });
    } catch (err) {
      console.error('[GitHub] repo-contents error:', err);
      if (err.code === 'NOT_CONNECTED') {
        return res.status(401).json({ error: 'GitHub not connected', code: 'NOT_CONNECTED' });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
      }
      res.status(500).json({ error: 'Failed to fetch repo contents' });
    }
  });

  return { oauthRouter, apiRouter };
}

module.exports = { createGitHubRouters };
