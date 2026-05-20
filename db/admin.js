/**
 * db/admin.js — Admin user management queries
 * Owns: all SQL queries for the /admin panel (user listing, enable/disable).
 * Not owned: auth/session logic, non-admin user queries.
 */

/**
 * Return all users with signup date, last active, pipeline run count,
 * GitHub connected status, subscription status, and admin flag.
 *
 * Supports search (email/name fragment) and sorting.
 *
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @param {string} [opts.search]  - filter by email ILIKE %search%
 * @param {string} [opts.sort]    - column: 'created_at' | 'last_login_at' | 'run_count'
 * @param {string} [opts.order]   - 'asc' | 'desc'
 * @returns {Promise<Array>}
 */
async function listUsers(pool, { search = '', sort = 'created_at', order = 'desc' } = {}) {
  const ALLOWED_SORT = {
    created_at:    'u.created_at',
    last_login_at: 'u.last_login_at',
    run_count:     'run_count',
  };
  const ALLOWED_ORDER = { asc: 'ASC', desc: 'DESC' };

  const sortCol   = ALLOWED_SORT[sort]    || 'u.created_at';
  const sortOrder = ALLOWED_ORDER[order]  || 'DESC';

  const params = [];
  let whereClause = '';
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    whereClause = `WHERE u.email ILIKE $1`;
  }

  const query = `
    SELECT
      u.id,
      u.email,
      u.created_at,
      u.last_login_at,
      u.subscription_status,
      u.is_admin,
      u.task_credits,
      u.disabled,
      (
        SELECT COUNT(*)::int
        FROM pipeline_runs pr
        WHERE pr.user_id = u.id
          AND pr.deleted_at IS NULL
      ) AS run_count,
      (
        SELECT EXISTS(
          SELECT 1 FROM github_connections gc WHERE gc.user_id = u.id
        )
      ) AS github_connected
    FROM users u
    ${whereClause}
    ORDER BY ${sortCol} ${sortOrder} NULLS LAST
    LIMIT 500
  `;

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Disable or re-enable a user account.
 * Sets disabled = true/false on the users table.
 * Also revokes all active sessions when disabling.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {boolean} disabled
 * @returns {Promise<boolean>} true if a row was updated
 */
async function setUserDisabled(pool, userId, disabled) {
  const { rowCount } = await pool.query(
    `UPDATE users SET disabled = $1 WHERE id = $2`,
    [disabled, userId]
  );

  // Revoke all sessions immediately when disabling
  if (disabled && rowCount > 0) {
    await pool.query(
      `UPDATE sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    ).catch(() => { /* sessions table may not exist — safe to ignore */ });
  }

  return rowCount > 0;
}

module.exports = { listUsers, setUserDisabled };
