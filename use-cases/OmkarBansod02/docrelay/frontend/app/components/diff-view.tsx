import { ArrowRight } from "lucide-react";
import type { ContextSpan, DryRunView } from "../lib/api";

export function extractText(html: string | null): string | null {
  if (!html) return null;
  if (typeof document !== "undefined") {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.textContent?.trim() || null;
  }
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() || null;
}

export function DiffView({ oldText, newText, context, compact = false }: { oldText: string | null; newText: string | null; context?: DryRunView["context"]; compact?: boolean }) {
  if (!oldText && !newText) return <p className="text-[14px] italic text-muted">No text content is available for this change.</p>;
  const segments = changedSegments(oldText ?? "", newText ?? "");
  return (
    <div>
      <div className={`grid gap-4 ${compact ? "md:grid-cols-[1fr_auto_1fr] md:items-center" : "md:grid-cols-2"}`}>
        <DiffSide label="Before" text={context?.before.text ?? oldText} exactText={oldText} explicitSpan={context?.before} highlight={segments.oldChanged} tone="removed" />
        {compact ? <ArrowRight className="mx-auto hidden size-4 text-muted md:block" aria-hidden="true" /> : null}
        <DiffSide label="After" text={context?.after.text ?? newText} exactText={newText} explicitSpan={context?.after} highlight={segments.newChanged} tone="added" />
      </div>
      {context ? <p className="mt-4 text-[12px] text-muted">Context is read-only. Highlighted exact mutation span: <span className="font-mono text-ink">{JSON.stringify(oldText)} → {JSON.stringify(newText)}</span></p> : null}
    </div>
  );
}

function DiffSide({ label, text, exactText, explicitSpan, highlight, tone }: { label: string; text: string | null; exactText: string | null; explicitSpan?: ContextSpan; highlight: string; tone: "removed" | "added" }) {
  const range = contextRange(text, exactText, explicitSpan);
  const contextCharacters = range && text ? Array.from(text) : null;
  const index = explicitSpan
    ? range?.start ?? -1
    : text && highlight
      ? text.indexOf(highlight)
      : -1;
  const highlighted = range
    ? contextCharacters?.slice(range.start, range.end).join("") ?? ""
    : highlight;
  return (
    <section className="min-w-0">
      <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.045em] text-muted">{label}</h3>
      <p className="min-h-14 text-[15px] leading-7 text-ink sm:text-[16px]">
        {text ? (
          index >= 0 ? (
            <>
              {contextCharacters ? contextCharacters.slice(0, index).join("") : text.slice(0, index)}
              <mark className={tone === "removed" ? "bg-error-soft px-1 text-ink" : "bg-success-soft px-1 text-ink"}>{highlighted}</mark>
              {contextCharacters ? contextCharacters.slice(range?.end).join("") : text.slice(index + highlighted.length)}
            </>
          ) : text
        ) : "—"}
      </p>
    </section>
  );
}

export function contextRange(text: string | null, exactText: string | null, span?: ContextSpan): { start: number; end: number } | null {
  if (!text || !exactText || !span || span.text !== text) return null;
  const { highlight_start: start, highlight_end: end } = span;
  const characters = Array.from(text);
  if (start < 0 || end <= start || end > characters.length || characters.slice(start, end).join("") !== exactText) return null;
  return { start, end };
}

export function changedSegments(oldText: string, newText: string): { oldChanged: string; newChanged: string } {
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
