/**
 * BuildOrbit shared API client
 * Owns: fetch wrappers for /api/* endpoints used across pages.
 * Not owned: page-specific logic (lives in page-specific JS files).
 */
(function(w) {
  'use strict';

  w.BO = w.BO || {};

  /**
   * Generic JSON GET — returns parsed body or throws.
   */
  async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Generic JSON POST — returns parsed body or throws.
   */
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Generic JSON DELETE — returns parsed body or throws.
   */
  async function del(url, body) {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  w.BO.api = { get, post, delete: del };

})(window);
