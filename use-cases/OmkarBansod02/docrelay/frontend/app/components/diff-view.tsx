import { ArrowRight } from "lucide-react";

export function extractText(html: string | null): string | null {
  if (!html) return null;
  if (typeof document !== "undefined") {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.textContent?.trim() || null;
  }
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() || null;
}

export function DiffView({ oldText, newText, compact = false }: { oldText: string | null; newText: string | null; compact?: boolean }) {
  if (!oldText && !newText) return <p className="text-[14px] italic text-muted">No text content is available for this change.</p>;
  const segments = changedSegments(oldText ?? "", newText ?? "");
  return (
    <div className={`grid gap-4 ${compact ? "md:grid-cols-[1fr_auto_1fr] md:items-center" : "md:grid-cols-2"}`}>
      <DiffSide label="Before" text={oldText} highlight={segments.oldChanged} tone="removed" />
      {compact ? <ArrowRight className="mx-auto hidden size-4 text-muted md:block" aria-hidden="true" /> : null}
      <DiffSide label="After" text={newText} highlight={segments.newChanged} tone="added" />
    </div>
  );
}

function DiffSide({ label, text, highlight, tone }: { label: string; text: string | null; highlight: string; tone: "removed" | "added" }) {
  const index = text && highlight ? text.indexOf(highlight) : -1;
  return (
    <section className="min-w-0">
      <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.045em] text-muted">{label}</h3>
      <p className="min-h-14 text-[15px] leading-7 text-ink sm:text-[16px]">
        {text ? (
          index >= 0 ? (
            <>
              {text.slice(0, index)}
              <mark className={tone === "removed" ? "bg-error-soft px-1 text-ink" : "bg-success-soft px-1 text-ink"}>{highlight}</mark>
              {text.slice(index + highlight.length)}
            </>
          ) : text
        ) : "—"}
      </p>
    </section>
  );
}

function changedSegments(oldText: string, newText: string): { oldChanged: string; newChanged: string } {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;

  return {
    oldChanged: oldText.slice(prefix, oldText.length - suffix).trim(),
    newChanged: newText.slice(prefix, newText.length - suffix).trim(),
  };
}
