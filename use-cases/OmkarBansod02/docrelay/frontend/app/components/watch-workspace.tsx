"use client";

import Link from "next/link";
import { Clock, FileText, Folder, FolderOpen, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  configureWatch,
  configureWatchRule,
  getAuthorizeUrl,
  getConnections,
  listWatchRules,
  listWatchScanItems,
  listWatchScanRuns,
  listWatchScans,
  listWatches,
  triggerWatchScan,
  updateWatchSchedule,
  type GoogleConnection,
  type RunSummary,
  type WatchRoot,
  type WatchRule,
  type WatchScan,
  type WatchScanItem,
} from "../lib/api";
import { runActionLabel, RunStatus } from "./run-status";
import { Button, InlineNotice, Skeleton, StateMark } from "./ui";

type WatchData = {
  watch: WatchRoot;
  rules: WatchRule[];
  scans: WatchScan[];
  latestItems: WatchScanItem[];
  latestRuns: RunSummary[];
};

export function WatchWorkspace() {
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [data, setData] = useState<WatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRule, setEditingRule] = useState<WatchRule | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [connections, watches] = await Promise.all([getConnections(signal), listWatches(signal)]);
      const active = connections.connections.find((item) => item.status === "CONNECTED") ?? null;
      setConnection(active);
      const watch = watches.watches[0];
      if (!watch) {
        setData(null);
        return;
      }
      const [rulesResponse, scansResponse] = await Promise.all([listWatchRules(watch.watch_id, signal), listWatchScans(watch.watch_id, signal)]);
      const scans = [...scansResponse.scans].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
      const latest = scans[0];
      const [itemsResponse, runsResponse] = latest
        ? await Promise.all([listWatchScanItems(watch.watch_id, latest.scan_id, signal), listWatchScanRuns(watch.watch_id, latest.scan_id, signal)])
        : [{ items: [] }, { runs: [] }];
      setData({ watch, rules: rulesResponse.rules, scans, latestItems: itemsResponse.items, latestRuns: runsResponse.runs });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Watch could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (data?.scans[0]?.status !== "RUNNING") return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [data?.scans, load]);

  async function scanNow() {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await triggerWatchScan(data.watch.watch_id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The scan could not be started.");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <WatchSkeleton />;

  if (!data) {
    return <WatchEmpty connection={connection} error={error} onCreated={() => void load()} />;
  }

  const { watch, rules, scans, latestItems, latestRuns } = data;
  const latest = scans[0] ?? null;
  const runsById = new Map(latestRuns.map((run) => [run.run_id, run]));
  const rulesById = new Map(rules.map((rule) => [rule.rule_id, rule]));

  return (
    <div>
      <header className="border-b border-border px-5 py-7 sm:px-8 lg:px-10">
        <h1 className="text-[30px] font-semibold tracking-[-0.04em] text-ink sm:text-[34px]">{watch.root_name}</h1>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4 text-[13px] text-muted">
          <div className="flex min-w-[220px] items-center gap-3"><span className="grid size-9 place-items-center rounded-md bg-[#2878ed] text-white"><FolderOpen className="size-4" /></span><span><span className="block text-[12px]">Google Drive folder</span><strong className="block font-medium text-ink">{watch.root_name}/</strong></span></div>
          <span className="hidden h-10 w-px bg-border sm:block" />
          <span className="flex items-center gap-2"><StateMark state={connection?.watch_authorized ? "complete" : "info"} />{connection?.watch_authorized ? "Watch access enabled" : "Watch access needs attention"}</span>
          <span className="hidden h-10 w-px bg-border xl:block" />
          <span className="flex items-center gap-2"><Clock className="size-4" />{watch.enabled ? intervalLabel(watch.interval_seconds) : "Schedule disabled"}</span>
          <span className="ml-auto grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[12px]"><span>Last scan</span><strong className="font-medium text-ink">{formatTime(watch.last_scan_at)}</strong><span>Next scan</span><strong className="font-medium text-ink">{watch.enabled ? formatTime(watch.next_scan_at) : "—"}</strong></span>
          <Button variant="secondary" onClick={() => setShowSchedule((value) => !value)}>Edit schedule</Button>
          <Button busy={busy || latest?.status === "RUNNING"} onClick={() => void scanNow()}>{latest?.status === "RUNNING" ? "Scanning…" : "Scan now"}</Button>
        </div>
        {showSchedule ? <ScheduleEditor watch={watch} onSaved={() => { setShowSchedule(false); void load(); }} /> : null}
        {error ? <div className="mt-5"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
      </header>

      <div className="grid xl:grid-cols-[335px_minmax(0,1fr)]">
        <aside className="border-b border-border px-5 py-8 sm:px-8 xl:min-h-[calc(100dvh-260px)] xl:border-b-0 xl:border-r lg:px-10 xl:px-8">
          <div className="flex items-center justify-between"><h2 className="text-[19px] font-semibold text-ink">Folder rules</h2><button type="button" onClick={() => { setEditingRule(null); setShowRuleForm(true); }} aria-label="Add folder rule" className="grid size-11 place-items-center rounded-md text-accent hover:bg-accent-soft"><Plus className="size-5" /></button></div>
          <div className="mt-7 flex items-center gap-2 text-[14px] font-medium text-ink"><Folder className="size-5" />{watch.root_name}/</div>
          <div className="ml-2 mt-4 border-l border-border pl-5">
            {rules.length === 0 ? <p className="py-4 text-[13px] leading-5 text-muted">No folder rules are configured yet.</p> : rules.map((rule) => (
              <div key={rule.rule_id} className="relative pb-8 last:pb-3">
                <span className="absolute -left-[21px] top-3 w-4 border-t border-border" aria-hidden="true" />
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink"><Folder className="size-4" />{rule.folder_name}/</div>
                <div className="mt-3 flex items-start gap-2"><StateMark state={rule.enabled ? "complete" : "idle"} /><p className="text-[13px] leading-5 text-ink">{rule.instruction}</p><span className="ml-auto text-[11px] text-muted">v{rule.version}</span></div>
                <button type="button" onClick={() => { setEditingRule(rule); setShowRuleForm(true); }} className="ml-7 mt-2 min-h-8 text-[12px] font-semibold text-accent hover:underline">Edit</button>
              </div>
            ))}
          </div>
          <Button variant="secondary" className="mt-5" onClick={() => { setEditingRule(null); setShowRuleForm(true); }}><Plus className="size-4" />Add folder rule</Button>
          <p className="mt-7 text-[12px] leading-5 text-muted">Nearest enabled folder rule applies.</p>
          {showRuleForm ? <RuleEditor watchId={watch.watch_id} rule={editingRule} onClose={() => { setShowRuleForm(false); setEditingRule(null); }} onSaved={() => { setShowRuleForm(false); setEditingRule(null); void load(); }} /> : null}
        </aside>

        <section className="min-w-0 px-5 py-8 sm:px-8 lg:px-10">
          <h2 className="text-[21px] font-semibold text-ink">Latest scan</h2>
          {!latest ? <p className="mt-5 text-[14px] text-muted">No scans have run yet. Use Scan now to discover documents.</p> : (
            <>
              <p className="mt-3 text-[14px] text-ink">{titleCase(latest.trigger)} scan · {formatTime(latest.started_at)}</p>
              <p className="mt-2 text-[13px] text-muted">{latest.discovered_count} discovered · {latestRuns.length} runs · {latest.unchanged_count} unchanged · {latest.skipped_count} skipped</p>
              <div className="mt-6 overflow-x-auto border-y border-border">
                <table className="w-full min-w-[760px] border-collapse text-left">
                  <thead><tr className="border-b border-border text-[12px] font-semibold text-muted"><th className="px-3 py-3">Document</th><th className="px-3 py-3">Matched rule</th><th className="px-3 py-3">State</th><th className="px-3 py-3 text-right">Action</th></tr></thead>
                  <tbody>
                    {latestItems.map((item) => {
                      const run = item.run_id ? runsById.get(item.run_id) : undefined;
                      const rule = item.matched_rule_id ? rulesById.get(item.matched_rule_id) : undefined;
                      const conflict = run?.write_back_status === "CONFLICT";
                      return (
                        <tr key={item.provider_file_id} className={`border-b border-border last:border-b-0 ${conflict ? "border-l-2 border-l-warning" : ""}`}>
                          <td className="px-3 py-4"><span className="flex items-center gap-2.5 text-[14px] font-medium text-ink"><FileText className="size-4 text-[#2878ed]" />{item.name}</span></td>
                          <td className="px-3 py-4 text-[13px] text-muted">{rule ? `${rule.folder_name}/` : "—"}</td>
                          <td className="px-3 py-4">{run ? <><RunStatus run={run} />{run.write_back_status === "WRITE_AUTHORIZATION_REQUIRED" ? <p className="ml-7 mt-1 max-w-[250px] text-[11px] leading-4 text-muted">Google requires permission for this exact file before write-back.</p> : null}</> : <ItemOutcome item={item} />}</td>
                          <td className="px-3 py-4 text-right">{run ? <Link href={`/runs/${run.run_id}`} className="inline-flex min-h-11 items-center px-2 text-[13px] font-semibold text-accent hover:underline">{runActionLabel(run)}</Link> : <span className="text-muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function WatchEmpty({ connection, error, onCreated }: { connection: GoogleConnection | null; error: string | null; onCreated: () => void }) {
  const [folderId, setFolderId] = useState("");
  const [interval, setIntervalValue] = useState(900);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  async function create() {
    if (!connection || !folderId.trim()) return;
    setBusy(true); setLocalError(null);
    try { await configureWatch({ connection_id: connection.connection_id, root_folder_id: folderId.trim(), interval_seconds: interval, enabled: true }); onCreated(); }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : "The watched folder could not be configured."); }
    finally { setBusy(false); }
  }
  return (
    <section className="flex min-h-[calc(100dvh-156px)] items-center justify-center px-5 py-14 sm:px-8">
      <div className="w-full max-w-[620px]">
        <FolderOpen className="size-10 text-accent" /><h1 className="mt-6 text-[30px] font-semibold tracking-[-0.04em] text-ink sm:text-[36px]">Watch a Google Drive folder</h1>
        <p className="mt-3 text-[15px] leading-7 text-muted">Discover changed Google Docs on a schedule, apply the nearest folder rule, and send each document through the same review and safe-write pipeline.</p>
        {error || localError ? <div className="mt-6"><InlineNotice tone="warning">{localError ?? error}</InlineNotice></div> : null}
        {!connection ? <Button className="mt-7" onClick={() => window.location.assign(getAuthorizeUrl())}>Connect Google Drive</Button> : !connection.watch_authorized ? <div className="mt-7"><InlineNotice tone="info">Watch needs read access to discover documents in the selected folder.</InlineNotice><Button className="mt-4" onClick={() => window.location.assign(getAuthorizeUrl())}>Enable watch access</Button></div> : (
          <div className="mt-8 grid gap-5 border-t border-border pt-7">
            <label className="grid gap-2 text-[13px] font-medium text-ink">Google Drive folder ID<input value={folderId} onChange={(event) => setFolderId(event.target.value)} placeholder="Paste the folder ID" className="min-h-11 rounded-md border border-border bg-surface px-3 text-[14px] outline-none focus:border-accent" /></label>
            <label className="grid gap-2 text-[13px] font-medium text-ink">Scan interval<select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} className="min-h-11 rounded-md border border-border bg-surface px-3 text-[14px] outline-none focus:border-accent"><option value={300}>Every 5 minutes</option><option value={900}>Every 15 minutes</option><option value={3600}>Every hour</option></select></label>
            <Button disabled={!folderId.trim()} busy={busy} onClick={() => void create()}>Configure watch</Button>
          </div>
        )}
      </div>
    </section>
  );
}

function ScheduleEditor({ watch, onSaved }: { watch: WatchRoot; onSaved: () => void }) {
  const [interval, setIntervalValue] = useState(watch.interval_seconds); const [enabled, setEnabled] = useState(watch.enabled); const [busy, setBusy] = useState(false);
  return <div className="mt-6 flex flex-wrap items-end gap-4 border-t border-border pt-5"><label className="grid gap-1.5 text-[12px] text-muted">Interval<select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} className="min-h-11 rounded-md border border-border bg-surface px-3 text-[13px] text-ink"><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={21600}>6 hours</option><option value={86400}>24 hours</option></select></label><label className="flex min-h-11 items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-accent" />Enabled</label><Button busy={busy} onClick={async () => { setBusy(true); await updateWatchSchedule(watch.watch_id, { enabled, interval_seconds: interval }); setBusy(false); onSaved(); }}>Save schedule</Button></div>;
}

function RuleEditor({ watchId, rule, onClose, onSaved }: { watchId: string; rule: WatchRule | null; onClose: () => void; onSaved: () => void }) {
  const [folderId, setFolderId] = useState(rule?.folder_id ?? ""); const [instruction, setInstruction] = useState(rule?.instruction ?? ""); const [enabled, setEnabled] = useState(rule?.enabled ?? true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return <div className="mt-6 border-t border-border pt-5"><h3 className="text-[15px] font-semibold text-ink">{rule ? `Edit ${rule.folder_name}/` : "Add folder rule"}</h3><div className="mt-4 grid gap-4"><label className="grid gap-1.5 text-[12px] text-muted">Folder ID<input value={folderId} readOnly={Boolean(rule)} onChange={(event) => setFolderId(event.target.value)} className="min-h-11 rounded-md border border-border bg-surface px-3 text-[13px] text-ink read-only:bg-surface-muted" /></label><label className="grid gap-1.5 text-[12px] text-muted">Instruction<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4} className="resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] leading-5 text-ink" /></label><label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-accent" />Enabled</label>{error ? <InlineNotice tone="warning">{error}</InlineNotice> : null}<div className="flex gap-2"><Button busy={busy} disabled={!folderId.trim() || !instruction.trim()} onClick={async () => { setBusy(true); setError(null); try { await configureWatchRule(watchId, { folder_id: folderId.trim(), instruction: instruction.trim(), enabled }); onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Rule could not be saved."); } finally { setBusy(false); } }}>Save rule</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div></div></div>;
}

function ItemOutcome({ item }: { item: WatchScanItem }) { const unchanged = item.outcome === "UNCHANGED"; return <span className="inline-flex items-center gap-2 text-[13px] text-ink"><StateMark state={unchanged ? "idle" : item.outcome === "FAILED" ? "warning" : "info"} />{titleCase(item.outcome)}</span>; }
function WatchSkeleton() { return <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10"><Skeleton className="h-10 w-64" /><Skeleton className="h-24 w-full" /><Skeleton className="h-[420px] w-full" /></div>; }
function intervalLabel(seconds: number): string { if (seconds < 3600) return `Every ${Math.round(seconds / 60)} minutes`; if (seconds === 3600) return "Every hour"; return `Every ${Math.round(seconds / 3600)} hours`; }
function formatTime(value: string | null): string { if (!value) return "—"; return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)); }
function titleCase(value: string): string { return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
