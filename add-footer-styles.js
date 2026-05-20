const fs = require('fs');
const path = '/opt/polsia/workspaces/company-75550/agent-30/exec-2055496/buildorbit/public/css/buildorbit.css';
const content = fs.readFileSync(path, 'utf8');

// Find where to insert the new footer styles - after the existing footer p rule
const insertAfter = `footer p {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
}`;

const newStyles = `footer p {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
}

/* ── Structured Site Footer ─────────────────────────────── */
.site-footer {
  background: #0f1117;
  border-top: 1px solid #1e2433;
  padding: 4rem 2rem 0;
}

.footer-inner {
  max-width: 1140px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 3rem;
  padding-bottom: 3rem;
}

/* Brand */
.footer-brand {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.footer-logo {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.1rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: -0.01em;
}

.footer-logo-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.footer-tagline {
  font-size: 13px;
  line-height: 1.6;
  color: #64748b;
  margin: 0;
}

/* Link columns */
.footer-links {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2rem;
}

.footer-col {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.footer-col-heading {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #94a3b8;
  margin-bottom: 0.25rem;
}

.footer-link {
  font-size: 13px;
  color: #64748b;
  text-decoration: none;
  transition: color 0.2s ease;
  line-height: 1.4;
}

.footer-link:hover {
  color: #e2e8f0;
}

/* Bottom bar */
.footer-bottom {
  max-width: 1140px;
  margin: 0 auto;
  padding: 1.25rem 0;
  border-top: 1px solid #1e2433;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.footer-bottom-left {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.footer-pipeline-mono {
  font-family: 'DM Mono', monospace;
  font-size: 11px;
  color: #64748b;
  letter-spacing: 0.04em;
}

.footer-arrow {
  color: var(--accent);
  opacity: 0.4;
  font-size: 11px;
}

.footer-copy {
  font-size: 12px;
  color: #475569;
}

/* Responsive */
@media (max-width: 768px) {
  .site-footer {
    padding: 3rem 1.5rem 0;
  }

  .footer-inner {
    grid-template-columns: 1fr;
    gap: 2rem;
  }

  .footer-links {
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
  }

  .footer-bottom {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .footer-bottom-left {
    flex-wrap: wrap;
    gap: 0.3rem;
  }
}

@media (max-width: 480px) {
  .footer-links {
    grid-template-columns: 1fr 1fr;
  }
}`;

if (content.includes(insertAfter)) {
    const newContent = content.replace(insertAfter, newStyles);
    fs.writeFileSync(path, newContent);
    console.log('SUCCESS: Footer styles added');
} else {
    console.log('FAILED: Could not find insert point');
    // Try to find the existing footer styles
    const idx = content.indexOf('/* Footer */');
    if (idx >= 0) {
        console.log('Found footer comment at:', idx);
        console.log('Next 200 chars:', JSON.stringify(content.slice(idx, idx + 200)));
    }
}