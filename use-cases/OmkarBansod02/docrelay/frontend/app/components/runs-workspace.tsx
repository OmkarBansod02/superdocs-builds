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
    <section className="px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h1 className="type-page-title">Activity</h1>
          <p className="mt-2 text-[14px] text-muted">Manual and watched document operations, kept compact and independently actionable.</p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh runs"><RefreshCw className="size-4" />Refresh</Button>
      </div>

      {error ? <div className="mt-7"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
      {loading ? <RunsSkeleton /> : runs.length === 0 ? <EmptyRuns /> : (
        <div className="mt-8 overflow-x-auto border-y border-border">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead><tr className="border-b border-border text-[12px] font-semibold text-muted"><th className="px-3 py-3">Document</th><th className="px-3 py-3">Origin</th><th className="px-3 py-3">Matched rule</th><th className="px-3 py-3">State</th><th className="px-3 py-3">Updated</th><th className="px-3 py-3 text-right">Action</th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id} className="border-b border-border last:border-b-0 hover:bg-surface-muted/60">
                  <td className="px-3 py-4"><span className="flex items-center gap-2.5 text-[14px] font-medium text-ink"><FileText className="size-4 text-[#2878ed]" />{run.document_name}</span></td>
                  <td className="px-3 py-4 text-[13px] text-muted">{run.watch_id ? "Watch" : "Manual"}</td>
                  <td className="px-3 py-4 text-[13px] text-muted">{run.matched_rule_id ? ruleNames.get(run.matched_rule_id) ?? `Rule v${run.matched_rule_version ?? "—"}` : "—"}</td>
                  <td className="px-3 py-4"><RunStatus run={run} /></td>
                  <td className="px-3 py-4 text-[13px] text-muted">{formatDateTime(run.updated_at)}</td>
                  <td className="px-3 py-4 text-right"><Link href={`/runs/${run.run_id}`} className="inline-flex min-h-11 items-center px-2 text-[13px] font-semibold text-accent hover:underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunsSkeleton() { return <div className="mt-8 space-y-3"><Skeleton className="h-11 w-full" />{[1,2,3,4].map((item) => <Skeleton key={item} className="h-16 w-full" />)}</div>; }
function EmptyRuns() { return <div className="mt-16 text-center"><FileText className="mx-auto size-8 text-muted" /><h2 className="mt-4 text-[18px] font-semibold">No activity yet</h2><p className="mt-2 text-[14px] text-muted">Choose a document in Workspace or configure Watch to begin.</p></div>; }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
