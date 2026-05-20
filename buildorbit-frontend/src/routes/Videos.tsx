/**
 * Videos — BuildOrbit promo video downloads.
 * Owns: /videos page listing downloadable HTML5 Canvas animation files.
 * No auth required — public marketing page.
 */
import { useState } from 'react';
import './Videos.css';

const VIDEOS = [
  {
    id: 'vibe-coding',
    title: 'Vibe Coding',
    description: 'Watch BuildOrbit navigate the chaos of vibe-coded prompts with a deterministic 6-phase pipeline. Green orbital aesthetic.',
    duration: '20s',
    theme: '#4ade80',
    themeBg: 'rgba(74, 222, 128, 0.08)',
    filename: 'vibe-coding.html',
    tags: ['green', 'orbital', 'ai coding'],
  },
  {
    id: 'deterministic-pipeline',
    title: 'Deterministic Pipeline',
    description: 'Six phases, one traceable path. Watch Intent Gate → Plan → Scaffold → Code → Save → Verify execute in sequence with full audit.',
    duration: '20s',
    theme: '#22d3ee',
    themeBg: 'rgba(34, 211, 238, 0.08)',
    filename: 'deterministic-pipeline.html',
    tags: ['cyan', 'pipeline', 'traceable'],
  },
  {
    id: 'audit-trail',
    title: 'Audit Trail',
    description: 'Every decision logged. Every file traced. Watch the complete event log build as each phase completes with timestamp precision.',
    duration: '20s',
    theme: '#f97316',
    themeBg: 'rgba(249, 115, 22, 0.08)',
    filename: 'audit-trail.html',
    tags: ['orange', 'audit', 'compliance'],
  },
];

export default function Videos() {
  const [playingId, setPlayingId] = useState<string | null>(null);

  return (
    <div className="videos-root">
      {/* Background */}
      <div className="orbital-bg" aria-hidden>
        <div className="orbital-ring orbital-ring-1" />
        <div className="orbital-ring orbital-ring-2" />
      </div>

      <div className="videos-content">
        {/* Header */}
        <header className="videos-header">
          <div className="videos-badge">PROMO VIDEOS</div>
          <h1 className="videos-title">BuildOrbit in Motion</h1>
          <p className="videos-subtitle">
            HTML5 Canvas animations — open in your browser and screen-record for social media.
            Download the HTML file, open it, and use your browser's built-in screen recorder.
          </p>
          <div className="videos-meta">
            <span className="meta-chip">3 videos</span>
            <span className="meta-chip">~20s each</span>
            <span className="meta-chip">HTML5 Canvas</span>
            <span className="meta-chip">1280×720</span>
          </div>
        </header>

        {/* Video Grid */}
        <div className="videos-grid">
          {VIDEOS.map((video) => (
            <div key={video.id} className="video-card">
              {/* Preview */}
              <div
                className="video-preview"
                style={{ '--video-theme': video.theme, '--video-theme-bg': video.themeBg } as React.CSSProperties}
              >
                {playingId === video.id ? (
                  <iframe
                    src={`/videos/${video.filename}`}
                    title={video.title}
                    className="video-iframe"
                    sandbox="allow-scripts"
                  />
                ) : (
                  <div className="video-placeholder">
                    <div className="placeholder-orb" />
                    <div className="placeholder-rings">
                      <div className="ring ring-1" />
                      <div className="ring ring-2" />
                      <div className="ring ring-3" />
                    </div>
                    <div className="placeholder-label">{video.title}</div>
                  </div>
                )}

                {/* Play button overlay */}
                <button
                  className="play-btn"
                  onClick={() => setPlayingId(playingId === video.id ? null : video.id)}
                  aria-label={playingId === video.id ? 'Close preview' : 'Preview animation'}
                >
                  {playingId === video.id ? (
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                      <rect x="4" y="4" width="12" height="12" rx="2" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M6 4l10 6-10 6V4z" />
                    </svg>
                  )}
                </button>

                {/* Duration badge */}
                <div className="duration-badge">{video.duration}</div>
              </div>

              {/* Info */}
              <div className="video-info">
                <div
                  className="video-tag"
                  style={{ color: video.theme, borderColor: video.theme + '44', background: video.themeBg }}
                >
                  {video.tags[0]}
                </div>
                <h2 className="video-title">{video.title}</h2>
                <p className="video-desc">{video.description}</p>

                {/* Tags */}
                <div className="video-tags">
                  {video.tags.map(tag => (
                    <span key={tag} className="tag">{tag}</span>
                  ))}
                </div>

                {/* Actions */}
                <div className="video-actions">
                  <a
                    href={`/videos/${video.filename}`}
                    download={video.filename}
                    className="download-btn"
                    style={{ '--btn-color': video.theme } as React.CSSProperties}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 2v8m0 0l-3-3m3 3l3-3M2 13h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Download HTML
                  </a>
                  <a
                    href={`/videos/${video.filename}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="open-btn"
                  >
                    Open in Browser
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 10L10 2M10 2H5M10 2v5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* How-to record */}
        <section className="how-to">
          <h2 className="how-to-title">How to Record</h2>
          <div className="how-to-steps">
            <div className="step">
              <div className="step-num">1</div>
              <div className="step-body">
                <strong>Download the HTML file</strong>
                <span>Click "Download HTML" on any video card above</span>
              </div>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <div className="step-body">
                <strong>Open in your browser</strong>
                <span>Double-click the downloaded .html file to open it</span>
              </div>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <div className="step-body">
                <strong>Screen record</strong>
                <span>macOS: ⌘+⇧+5 → Record Window → select the browser tab<br/>Windows: Win+G → Record → select browser<br/>Or use OBS Studio for more control</span>
              </div>
            </div>
            <div className="step">
              <div className="step-num">4</div>
              <div className="step-body">
                <strong>Export as MP4</strong>
                <span>Your screen recorder exports directly to MP4 — ready for social media</span>
              </div>
            </div>
          </div>
        </section>

        {/* Footer note */}
        <div className="videos-footer">
          <p>Videos are HTML5 Canvas animations — no video encoding required. The animation auto-plays and loops for 20 seconds.</p>
          <a href="/overview" className="footer-link">← Back to BuildOrbit overview</a>
        </div>
      </div>
    </div>
  );
}