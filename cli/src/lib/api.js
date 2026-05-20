/**
 * API client — wraps BuildOrbit A2A endpoints
 * Parses SSE streams from /a2a/execute
 */

import { BASE_URL, getToken } from './config.js';

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ── SSE Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw SSE line buffer into events.
 * Yields { event, data } objects.
 */
function* parseSSEChunk(buffer) {
  const lines = buffer.split('\n');
  let eventType = 'message';
  let dataLines = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line === '') {
      // Blank line = dispatch event
      if (dataLines.length > 0) {
        const dataStr = dataLines.join('\n');
        try {
          yield { event: eventType, data: JSON.parse(dataStr) };
        } catch {
          yield { event: eventType, data: dataStr };
        }
      }
      eventType = 'message';
      dataLines = [];
    } else if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // ignore 'id:' and 'retry:' fields
  }
}

// ── Execute ────────────────────────────────────────────────────────────────

/**
 * POST /a2a/execute — stream SSE events via async generator
 *
 * @param {object} payload  { task_description, intent_class?, product_context?, constraints? }
 * @param {string} [token]  override token
 * @yields {{ event: string, data: object }}
 */
export async function* executeStream(payload, token) {
  const tok = token || getToken();
  if (!tok) throw new Error('Not authenticated. Run `buildorbit login` first.');

  const response = await fetch(`${BASE_URL}/a2a/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!response.body) throw new Error('No response body from server');

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines (keep incomplete last line in buffer)
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline !== -1) {
        const chunk = buffer.slice(0, lastNewline + 1);
        buffer = buffer.slice(lastNewline + 1);
        yield* parseSSEChunk(chunk);
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      yield* parseSSEChunk(buffer + '\n');
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * GET /a2a/status/:runId
 */
export async function getStatus(runId, token) {
  const tok = token || getToken();
  if (!tok) throw new Error('Not authenticated. Run `buildorbit login` first.');

  const response = await fetch(`${BASE_URL}/a2a/status/${runId}`, {
    headers: authHeaders(tok),
  });

  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  return response.json();
}

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * POST /a2a/keys — creates a new API key (requires session cookie, not bearer)
 * This only works when the user is authenticated via browser session.
 * The CLI `login` command accepts an existing key instead.
 */
export async function listKeys(sessionCookie) {
  const response = await fetch(`${BASE_URL}/a2a/keys`, {
    headers: {
      'Cookie': sessionCookie,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
