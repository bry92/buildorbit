'use strict';

/**
 * Public app base URL for links, redirects, and email templates.
 */
function getAppUrl() {
  const url = process.env.APP_URL || 'http://localhost:3000';
  return url.replace(/\/$/, '');
}

module.exports = { getAppUrl };
