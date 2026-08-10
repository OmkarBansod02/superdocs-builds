import type { ProposalView } from "../lib/api";

export function DocumentCanvas({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-muted rounded-lg p-6 sm:p-8">
      <div className="bg-surface rounded border border-border shadow-sm max-w-2xl mx-auto">
        <div className="px-8 py-8 sm:px-12 sm:py-10">
          {title && (
            <h2 className="text-lg font-semibold text-ink mb-6 leading-tight">{title}</h2>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

export function ProposalDiff({ proposal }: { proposal: ProposalView }) {
  const oldText = extractText(proposal.old_html);
  const newText = extractText(proposal.new_html);

  if (!oldText && !newText) {
    return (
      <p className="text-sm text-muted italic">No text content available for this change.</p>
    );
  }

  return (
    <div className="font-mono text-[13px] leading-relaxed rounded border border-border overflow-hidden">
      {oldText && (
        <div className="px-4 py-2.5 bg-error-soft border-b border-border">
          <span className="text-error select-none mr-2">−</span>
          <span className="text-error/80">{oldText}</span>
        </div>
      )}
      {newText && (
        <div className="px-4 py-2.5 bg-success-soft">
          <span className="text-success select-none mr-2">+</span>
          <span className="text-success/80">{newText}</span>
        </div>
      )}
    </div>
  );
}

function extractText(html: string | null): string | null {
  if (!html) return null;
  return html.replace(/<[^>]*>/g, "").trim() || null;
}
