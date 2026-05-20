/**
 * routes/admin.js — Admin panel API
 * Owns: /api/admin/* endpoints (user list, enable/disable).
 * Not owned: auth sessions, pipeline runs, billing.
 *
 * Admin access: users with is_admin=true in DB OR in ADMIN_USER_IDS env var.
 * Server-side check on every request — client-side hide is decorative only.
 */

const express = require('express');
const { listUsers, setUserDisabled } = require('../../db/admin');

/**
 * Build the admin middleware: checks is_admin flag.
 * Falls back to ADMIN_USER_IDS env var for bootstrapping.
 *
 * @param {import('pg').Pool} pool
 */
function makeRequireAdmin(pool) {
  return async function requireAdmin(req, res, next) {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // 1. Check env var (fast path, no DB round-trip needed for bootstrap)
    const envAdminIds = (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0);

    if (envAdminIds.includes(userId)) {
      return next();
    }

    // 2. Check ADMIN_EMAIL env var
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (adminEmail && req.user.email && req.user.email.toLowerCase() === adminEmail) {
      return next();
    }

    // 3. Check is_admin DB column
    try {
      const { rows } = await pool.query(
        'SELECT is_admin FROM users WHERE id = $1',
        [userId]
      );
      if (rows.length > 0 && rows[0].is_admin === true) {
        return next();
      }
    } catch (_) {
      // DB check failed — fall through to deny
    }

    return res.status(403).json({ success: false, message: 'Admin access required' });
  };
}

/**
 * @param {object} deps
 * @param {import('pg').Pool}  deps.pool
 * @param {object}             deps.auth  - auth module with requireApiAuth
 */
function createAdminRouter({ pool, auth }) {
  const router = express.Router();
  const requireAdmin = makeRequireAdmin(pool);

  // All admin routes require auth + admin
  router.use(auth.requireApiAuth, requireAdmin);

  // GET /api/admin/users — list all users
  // Query params: ?search=, ?sort=created_at|last_login_at|run_count, ?order=asc|desc
  router.get('/users', async (req, res) => {
    try {
      const { search = '', sort = 'created_at', order = 'desc' } = req.query;
      const users = await listUsers(pool, { search, sort, order });
      res.json({ success: true, users });
    } catch (err) {
      console.error('[Admin] listUsers error:', err);
      res.status(500).json({ success: false, message: 'Failed to load users' });
    }
  });

  // GET /api/admin/me — check if current user is admin (used by frontend to show/hide link)
  router.get('/me', async (req, res) => {
    res.json({ success: true, is_admin: true });
  });

  // POST /api/admin/users/:id/disable — disable a user account
  router.post('/users/:id/disable', async (req, res) => {
    try {
      const targetId = parseInt(req.params.id, 10);
      if (isNaN(targetId)) {
        return res.status(400).json({ success: false, message: 'Invalid user ID' });
      }
      // Prevent self-disable
      if (targetId === req.user.userId) {
        return res.status(400).json({ success: false, message: 'Cannot disable your own account' });
      }
      const updated = await setUserDisabled(pool, targetId, true);
      if (!updated) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, message: 'User disabled' });
    } catch (err) {
      console.error('[Admin] disable user error:', err);
      res.status(500).json({ success: false, message: 'Failed to disable user' });
    }
  });

  // POST /api/admin/users/:id/enable — re-enable a user account
  router.post('/users/:id/enable', async (req, res) => {
    try {
      const targetId = parseInt(req.params.id, 10);
      if (isNaN(targetId)) {
        return res.status(400).json({ success: false, message: 'Invalid user ID' });
      }
      const updated = await setUserDisabled(pool, targetId, false);
      if (!updated) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, message: 'User enabled' });
    } catch (err) {
      console.error('[Admin] enable user error:', err);
      res.status(500).json({ success: false, message: 'Failed to enable user' });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
