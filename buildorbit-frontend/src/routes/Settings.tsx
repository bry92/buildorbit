/**
 * Settings — API Keys page.
 * Owns: API key generation, listing, revocation.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchApiTokens, createApiToken, revokeApiToken, type ApiToken } from '../lib/api';
import { formatDate, isExpired } from '../lib/utils';
import './Settings.css';

export default function Settings() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [isGenerating, setIsGenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const data = await fetchApiTokens();
      setTokens(data.tokens ?? []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  const generateKey = useCallback(async () => {
    setIsGenerating(true);
    try {
      const data = await createApiToken(label.trim(), expiry);
      setNewToken(data.token);
      setLabel('');
      await loadTokens();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to generate key.');
    } finally {
      setIsGenerating(false);
    }
  }, [label, expiry, loadTokens]);

  const copyToken = useCallback(() => {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken).then(() => showToast('Copied!'));
  }, [newToken, showToast]);

  const revokeToken = useCallback(async (id: string) => {
    if (!confirm('Revoke this key? It cannot be undone.')) return;
    try {
      await revokeApiToken(id);
      setTokens(prev => prev.filter(t => t.id !== id));
      showToast('Key revoked.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revoke key.');
    }
  }, [showToast]);

  const handleLogout = useCallback(() => {
    window.location.href = '/auth/logout';
  }, []);

  return (
    <div className="page-settings">
      <main className="settings-main">
        {/* Header */}
        <div className="page-header">
          <div className="page-title">
            <div className="page-title-icon">🔑</div>
            API Keys
          </div>
          <p className="page-desc">
            Generate API keys to authenticate the BuildOrbit CLI and headless integrations.
            Keys are shown once — copy and store them securely.
          </p>
        </div>

        {/* CLI Quick Start */}
        <div className="quickstart">
          <div className="quickstart-title">CLI Quick Start</div>
          <div className="code-steps">
            <div className="code-step">
              <div className="step-num">1</div>
              <code className="code-line">curl -sL https://buildorbit.polsia.app/cli/install.sh | sh</code>
            </div>
            <div className="code-step">
              <div className="step-num">2</div>
              <span className="step-desc">Generate a key below, then run:</span>
            </div>
            <div className="code-step">
              <div className="step-num" />
              <code className="code-line">buildorbit login</code>
            </div>
            <div className="code-step">
              <div className="step-num">3</div>
              <code className="code-line">buildorbit run "Build a SaaS waitlist page"</code>
            </div>
          </div>
        </div>

        {/* Generate */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">Generate New Key</div>
          </div>
          <div className="generate-form">
            <div className="form-row">
              <div className="form-field">
                <label className="form-label" htmlFor="key-label">Label (optional)</label>
                <input
                  id="key-label"
                  type="text"
                  className="form-input"
                  placeholder="e.g. my-laptop, CI"
                  maxLength={80}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                />
              </div>
              <div className="form-field form-field-narrow">
                <label className="form-label" htmlFor="key-expiry">Expires in</label>
                <select
                  id="key-expiry"
                  className="form-select"
                  value={expiry}
                  onChange={e => setExpiry(e.target.value)}
                >
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                  <option value="90">90 days</option>
                </select>
              </div>
            </div>
            <button
              className="btn-generate"
              onClick={generateKey}
              disabled={isGenerating}
            >
              {isGenerating ? 'Generating…' : '+ Generate key'}
            </button>
          </div>

          {/* Token reveal */}
          {newToken && (
            <div className="token-reveal">
              <div className="token-reveal-label">
                ✓ Key generated — copy it now, it won't be shown again
              </div>
              <div className="token-value-row">
                <code className="token-value">{newToken}</code>
                <button className="btn-copy" onClick={copyToken}>Copy</button>
              </div>
            </div>
          )}
        </div>

        {/* Active keys */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">Active Keys</div>
          </div>
          {tokens.length === 0 ? (
            <div className="token-empty">No keys yet — generate one above.</div>
          ) : (
            <div className="token-list">
              {tokens.map(t => {
                const expired = isExpired(t.expires_at);
                return (
                  <div key={t.id} className="token-item">
                    <div className="token-item-left">
                      <div className="token-item-label">{t.label || <em>unlabeled</em>}</div>
                      <div className="token-item-meta">
                        <code className="token-preview">{t.id.slice(0, 8)}…</code>
                        <span className="token-created">Created {formatDate(t.created_at)}</span>
                        <span className="token-expires">Expires {formatDate(t.expires_at)}</span>
                      </div>
                    </div>
                    <div className="token-item-right">
                      <span className={`token-status-badge ${expired ? 'expired' : 'active'}`}>
                        {expired ? 'Expired' : 'Active'}
                      </span>
                      <button
                        className="btn-revoke"
                        onClick={() => revokeToken(t.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Logout */}
        <div className="section section--account">
          <div className="section-header">
            <div className="section-title">Account</div>
          </div>
          <p className="section-desc">Need to sign out? Your session will be cleared and you'll be redirected to the landing page.</p>
          <button className="btn-logout" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </main>

      {toast && <div className="bo-toast visible">{toast}</div>}
    </div>
  );
}
