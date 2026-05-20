/**
 * ChatPreview — compact inline preview for Orbit chat messages.
 * Owns: fetching run data by ID, rendering compact PreviewPanel.
 * Not owned: chat message rendering, pipeline execution.
 */

import { useState, useEffect } from 'react';
import { fetchRun, type PipelineRun } from '../../lib/api';
import PreviewPanel from './PreviewPanel';

interface ChatPreviewProps {
  runId: string;
}

export default function ChatPreview({ runId }: ChatPreviewProps) {
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRun(runId)
      .then(data => {
        if (!cancelled && data.success) setRun(data.run);
      })
      .catch(() => { /* Silently fail — preview is optional */ });
    return () => { cancelled = true; };
  }, [runId]);

  if (!run) return null;

  // Only show for completed builds with code output
  const codePhase = run.phases?.code;
  if (!codePhase || codePhase.status !== 'complete') return null;

  return (
    <div className="nw-chat-preview">
      <button
        className="nw-chat-preview-toggle"
        onClick={() => setCollapsed(prev => !prev)}
      >
        {collapsed ? '▸ Show Preview' : '▾ Hide Preview'}
      </button>
      {!collapsed && (
        <PreviewPanel
          phases={run.phases}
          intentClass={run.intent_class}
          compact
          polsiaAppUrl={run.polsia_app_url}
        />
      )}
    </div>
  );
}
