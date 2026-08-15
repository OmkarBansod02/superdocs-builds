"use client";

import Link from "next/link";
import { FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { listRuns, listWatchRules, listWatches, type RunSummary } from "../lib/api";
import { RunStatus } from "./run-status";
import { Button, InlineNotice, Skeleton } from "./ui";

export function RunsWorkspace() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [runResponse, watchResponse] = await Promise.all([listRuns(signal), listWatches(signal)]);
      const rulesByWatch = await Promise.all(watchResponse.watches.map((watch) => listWatchRules(watch.watch_id, signal)));
      const names = new Map<string, string>();
      for (const response of rulesByWatch) for (const rule of response.rules) names.set(rule.rule_id, `${rule.folder_name}/`);
      setRuleNames(names);
      setRuns(runResponse.runs);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Runs could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  return (
    <section className="min-h-full bg-background px-6 py-9 sm:px-8 lg:px-10 lg:py-12">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="type-page-title">Activity</h1>
            <p className="type-body-muted mt-1.5">Manual and watched document operations, kept compact and independently actionable.</p>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh runs"><RefreshCw className="size-4" />Refresh</Button>
        </div>

        {error ? <div className="mt-7"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
        {loading ? <RunsSkeleton /> : runs.length === 0 ? <EmptyRuns /> : (
          <div className="surface-section mt-8 overflow-x-auto shadow-[var(--shadow-subtle)]">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead><tr className="type-section-heading border-b border-border-light"><th className="px-5 py-3 font-medium">Document</th><th className="px-3 py-3 font-medium">Origin</th><th className="px-3 py-3 font-medium">Matched rule</th><th className="px-3 py-3 font-medium">State</th><th className="px-3 py-3 font-medium">Updated</th><th className="px-5 py-3 text-right font-medium">Action</th></tr></thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.run_id} className="border-b border-border-light transition-colors duration-[var(--motion-duration)] last:border-b-0 hover:bg-surface-muted/50">
                    <td className="px-5 py-3.5"><span className="flex items-center gap-2.5 text-[13.5px] font-medium text-ink"><FileText className="size-4 text-muted" strokeWidth={1.75} />{run.document_name}</span></td>
                    <td className="px-3 py-3.5 text-[13px] text-muted">{run.watch_id ? "Watch" : "Manual"}</td>
                    <td className="px-3 py-3.5 text-[13px] text-muted">{run.matched_rule_id ? ruleNames.get(run.matched_rule_id) ?? `Rule v${run.matched_rule_version ?? "—"}` : "—"}</td>
                    <td className="px-3 py-3.5"><RunStatus run={run} /></td>
                    <td className="px-3 py-3.5 text-[13px] text-muted">{formatDateTime(run.updated_at)}</td>
                    <td className="px-5 py-3.5 text-right"><Link href={`/runs/${run.run_id}`} className="type-button inline-flex items-center gap-0.5 text-accent hover:underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function RunsSkeleton() { return <div className="mt-8 space-y-3"><Skeleton className="h-10 w-full rounded-[var(--radius-pane)]" />{[1,2,3,4].map((item) => <Skeleton key={item} className="h-14 w-full rounded-[var(--radius-pane)]" />)}</div>; }
function EmptyRuns() { return <div className="surface-section mt-8 px-6 py-14 text-center"><FileText className="mx-auto size-7 text-muted" strokeWidth={1.75} /><h2 className="mt-4 text-[15px] font-semibold tracking-[-0.018em] text-ink">No activity yet</h2><p className="mx-auto mt-2 max-w-[24rem] text-[13.5px] leading-[1.6] text-muted">Choose a document in Workspace or configure Watch to begin.</p></div>; }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
