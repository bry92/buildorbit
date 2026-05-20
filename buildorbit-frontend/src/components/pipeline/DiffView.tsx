/**
 * DiffView — renders a unified diff string for a phase output.
 * Owns: diff text display.
 * Not owned: diff parsing beyond basic display.
 */

interface DiffViewProps {
  diff: string;
}

export default function DiffView({ diff }: DiffViewProps) {
  if (!diff) return null;
  return (
    <pre className="bo-diff-view">
      {diff}
    </pre>
  );
}
