/**
 * PreviewPanel — wraps BuildOrbitPreview with data extraction logic.
 * Owns: deciding whether to show live preview or file tree, extracting assets.
 * Not owned: preview rendering internals, pipeline data fetching.
 */

import { useMemo, useState } from 'react';
import { BuildOrbitPreview } from './BuildOrbitPreview';
import {
  extractPreviewAssets,
  extractPreviewFromCodeString,
  isServerProject,
  getFileList,
  type PreviewAssets,
} from '../../lib/previewAssets';
import type { PhaseState } from '../../lib/api';
import './PreviewPanel.css';

interface PreviewPanelProps {
  phases: Record<string, PhaseState>;
  intentClass: string | null | undefined;
  /** Compact mode for chat widget inline cards */
  compact?: boolean;
  /** Polsia app URL if deployed */
  polsiaAppUrl?: string;
}

export default function PreviewPanel({ phases, intentClass, compact, polsiaAppUrl }: PreviewPanelProps) {
  const [showConsole, setShowConsole] = useState(!compact);

  const codePhase = phases.code;
  const verifyPhase = phases.verify;

  // Only show preview after CODE or VERIFY phase completes
  const isReady = codePhase?.status === 'complete' || verifyPhase?.status === 'complete';
  if (!isReady) return null;

  const output = codePhase?.output as Record<string, unknown> | undefined;
  if (!output) return null;

  const files = output.files as Record<string, unknown> | undefined;
  const code = typeof output.code === 'string' ? output.code : undefined;

  // Determine if this is a server-side project (no iframe preview)
  const serverProject = isServerProject(files, intentClass);

  // Extract preview assets
  const assets: PreviewAssets | null = useMemo(() => {
    if (serverProject) return null;
    // Try structured files first
    const fromFiles = extractPreviewAssets(files);
    if (fromFiles) return fromFiles;
    // Try monolithic code string
    if (code) return extractPreviewFromCodeString(code);
    return null;
  }, [files, code, serverProject]);

  // Server project — show file tree
  if (serverProject) {
    const fileList = getFileList(files);
    if (fileList.length === 0) return null;

    return (
      <div className={`bo-preview-panel ${compact ? 'bo-preview-compact' : ''}`}>
        <div className="bo-preview-header">
          <span className="bo-preview-header-icon">📁</span>
          <span className="bo-preview-header-title">Generated Files</span>
          <span className="bo-preview-header-count">{fileList.length} files</span>
        </div>
        <div className="bo-preview-file-tree">
          {fileList.map(f => (
            <div key={f} className="bo-preview-file-entry">
              <span className="bo-preview-file-icon">{getFileIcon(f)}</span>
              <span className="bo-preview-file-name">{f}</span>
            </div>
          ))}
        </div>
        {polsiaAppUrl && (
          <a href={polsiaAppUrl} target="_blank" rel="noreferrer" className="bo-preview-live-link">
            View Live App →
          </a>
        )}
      </div>
    );
  }

  // No renderable assets
  if (!assets) return null;

  return (
    <div className={`bo-preview-panel ${compact ? 'bo-preview-compact' : ''}`}>
      <div className="bo-preview-header">
        <span className="bo-preview-header-icon">👁</span>
        <span className="bo-preview-header-title">Live Preview</span>
        {compact && (
          <button
            className="bo-preview-toggle"
            onClick={() => setShowConsole(prev => !prev)}
          >
            {showConsole ? 'Hide Console' : 'Show Console'}
          </button>
        )}
      </div>
      <BuildOrbitPreview
        html={assets.html}
        css={assets.css}
        js={assets.js}
        className={compact ? 'bo-preview-iframe-compact' : ''}
      />
      {polsiaAppUrl && (
        <a href={polsiaAppUrl} target="_blank" rel="noreferrer" className="bo-preview-live-link">
          View Live App →
        </a>
      )}
    </div>
  );
}

/** Map file extension to a simple icon */
function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'jsx': case 'ts': case 'tsx': return '📜';
    case 'css': case 'scss': case 'less': return '🎨';
    case 'html': return '🌐';
    case 'json': return '📋';
    case 'md': return '📝';
    case 'py': return '🐍';
    case 'go': return '🔷';
    case 'sql': return '🗄';
    case 'env': return '🔒';
    case 'yml': case 'yaml': return '⚙';
    default: return '📄';
  }
}
