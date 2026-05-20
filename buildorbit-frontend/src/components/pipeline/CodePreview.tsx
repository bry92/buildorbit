/**
 * CodePreview — renders a code snippet for a pipeline phase.
 * Owns: code block display with overflow scroll.
 * Not owned: syntax highlighting, file tree rendering.
 */

interface CodePreviewProps {
  code: string;
}

export default function CodePreview({ code }: CodePreviewProps) {
  if (!code) return null;
  return (
    <pre className="bo-code-preview">
      {code}
    </pre>
  );
}
