"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ICON_STROKE, icons } from "@/lib/icons";
import { browserPickerTokenManager } from "../google-drive/picker-token";
import {
  configureWatch,
  configureWatchRule,
  getAuthorizeUrl,
  getConnections,
  listWatchRules,
  listWatchRuns,
  listWatchScanItems,
  listWatchScans,
  listWatches,
  triggerWatchScan,
  updateWatchSchedule,
  verifyWriteAuthorization,
  type GoogleConnection,
  type RunSummary,
  type WatchRoot,
  type WatchRule,
  type WatchScan,
  type WatchScanItem,
} from "../lib/api";
import { requestOpenRecentDocument } from "../lib/conversation";
import { extractSelectedFile, type SelectedDriveFile } from "../lib/import-state";
import {
  actionableWatchRuns,
  exactFilePickMatches,
  isGoogleFolder,
  proposalCountLabel,
  scanProgressLabel,
  scheduleLabel,
  watchActivityLabel,
  watchDocumentAction,
  watchDocumentSelection,
  watchErrorCopy,
} from "../lib/watch-state";
import { Button, InlineNotice, Skeleton } from "./ui";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID ?? "";
const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? "";
const CLOUD_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? "";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const INTERVALS = [
  { value: 3600, label: "Every hour" },
  { value: 21600, label: "Every 6 hours" },
  { value: 86400, label: "Every 24 hours" },
  { value: 900, label: "Every 15 min" },
  { value: 300, label: "Every 5 min" },
] as const;

type WatchData = {
  watch: WatchRoot;
  rules: WatchRule[];
  scans: WatchScan[];
  latestItems: WatchScanItem[];
  runs: RunSummary[];
};

export function WatchWorkspace() {
  const router = useRouter();
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [data, setData] = useState<WatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRule, setEditingRule] = useState<WatchRule | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [connections, watches] = await Promise.all([getConnections(signal), listWatches(signal)]);
      const active = connections.connections.find((item) => item.status === "CONNECTED") ?? null;
      setConnection(active);
      const watch = watches.watches.at(-1);
      if (!watch) {
        setData(null);
        return;
      }
      const [rulesResponse, scansResponse, runsResponse] = await Promise.all([
        listWatchRules(watch.watch_id, signal),
        listWatchScans(watch.watch_id, signal),
        listWatchRuns(watch.watch_id, signal),
      ]);
      const scans = [...scansResponse.scans].sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
      const latest = scans[0];
      const itemsResponse = latest
        ? await listWatchScanItems(watch.watch_id, latest.scan_id, signal)
        : { items: [] };
      setData({
        watch,
        rules: rulesResponse.rules,
        scans,
        latestItems: itemsResponse.items,
        runs: runsResponse.runs,
      });
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

  const openConversation = useCallback((run: RunSummary) => {
    requestOpenRecentDocument(watchDocumentSelection(run));
    router.push("/");
  }, [router]);

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

  async function chooseFolder() {
    if (!connection || pickerBusy) return;
    setPickerBusy(true);
    setError(null);
    try {
      const folder = await pickDriveFolder("Choose a Drive folder to watch");
      if (!folder) return;
      await configureWatch({
        connection_id: connection.connection_id,
        root_folder_id: folder.fileId,
        interval_seconds: data?.watch.interval_seconds ?? 3600,
        enabled: data?.watch.enabled ?? true,
      });
      setEditing(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The folder could not be selected.");
    } finally {
      setPickerBusy(false);
    }
  }

  if (loading && !data) return <WatchSkeleton />;

  if (!data) {
    return (
      <WatchEmpty
        connection={connection}
        error={error}
        pickerBusy={pickerBusy}
        onEnableWatch={() => window.location.assign(getAuthorizeUrl("watch"))}
        onChooseFolder={() => void chooseFolder()}
      />
    );
  }

  const { watch, rules, scans, latestItems, runs } = data;
  const latest = scans[0] ?? null;
  const scanning = busy || latest?.status === "RUNNING";
  const pending = actionableWatchRuns(runs);
  const runsById = new Map(runs.map((run) => [run.run_id, run]));
  const watchError = watchErrorCopy(watch.last_error_code ?? latest?.failure_code ?? null);
  const progress = scanProgressLabel(latest, busy);

  return (
    <div className="px-6 py-8 sm:px-8 lg:px-10 lg:py-10">
      <header className="max-w-[40rem]">
        <h1 className="type-page-title">Watch</h1>
        <p className="type-body-muted mt-2">Keep selected Drive folders in sync with DocRelay.</p>
        <WatchAccessStatus
          connection={connection}
          onEnable={() => window.location.assign(getAuthorizeUrl("watch"))}
        />
      </header>

      {error ? (
        <div className="mt-6 max-w-[40rem]">
          <InlineNotice tone="warning">{error}</InlineNotice>
        </div>
      ) : null}

      {watchError ? (
        <div className="mt-6 max-w-[40rem]">
          <Alert variant="warning" className="rounded-md">
            <icons.warning strokeWidth={ICON_STROKE} />
            <AlertTitle>{watchError.title}</AlertTitle>
            <AlertDescription>{watchError.detail}</AlertDescription>
            {watch.last_error_code === "GOOGLE_WATCH_AUTHORIZATION_REQUIRED" ? (
              <AlertAction>
                <Button variant="secondary" onClick={() => window.location.assign(getAuthorizeUrl("watch"))}>
                  Enable watch access
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </div>
      ) : null}

      <section className="mt-10 max-w-[40rem]" aria-labelledby="watching-heading">
        <h2 id="watching-heading" className="type-section-heading">Watching</h2>
        <div className="mt-4 border-t border-border pt-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center text-muted" aria-hidden="true">
              <icons.folderOpen className="size-4" strokeWidth={ICON_STROKE} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium tracking-[-0.015em] text-ink">{watch.root_name}</p>
              <p className="type-caption mt-0.5">Google Drive</p>
            </div>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              disabled={pickerBusy}
              className="type-caption min-h-8 shrink-0 text-accent hover:underline"
            >
              {pickerBusy ? "Opening Drive…" : "Change folder"}
            </button>
          </div>

          <p className="mt-5 text-[13px] text-muted">{scheduleLabel(watch.enabled, watch.interval_seconds)}</p>
          {progress ? <p className="mt-1 text-[13px] text-ink">{progress}</p> : null}

          <div className="mt-6 space-y-5">
            {rules.length === 0 ? (
              <p className="text-[14px] leading-6 text-muted">Add a rule so discovered documents know what to do.</p>
            ) : rules.map((rule) => (
              <div key={rule.rule_id}>
                <p className="text-[14px] font-medium text-ink">{rule.folder_name}</p>
                <p className="mt-1 text-[14px] leading-6 text-muted">“{rule.instruction}”</p>
                {editing ? (
                  <button
                    type="button"
                    onClick={() => { setEditingRule(rule); setShowRuleForm(true); }}
                    className="mt-1.5 text-[12px] font-medium text-accent hover:underline"
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button busy={scanning} disabled={scanning} onClick={() => void scanNow()}>
              {latest?.status === "RUNNING" ? "Scanning…" : "Scan now"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing((value) => !value);
                if (editing) {
                  setShowRuleForm(false);
                  setEditingRule(null);
                }
              }}
            >
              {editing ? "Done" : "Edit setup"}
            </Button>
          </div>

          {editing ? (
            <div className="mt-6 border-t border-border pt-5">
              <ScheduleEditor
                watch={watch}
                onSaved={() => { void load(); }}
              />
              <Button
                variant="ghost"
                className="mt-4"
                onClick={() => { setEditingRule(null); setShowRuleForm(true); }}
              >
                <icons.plus className="size-4" strokeWidth={ICON_STROKE} />
                Add rule
              </Button>
              {showRuleForm ? (
                <RuleEditor
                  watchId={watch.watch_id}
                  rule={editingRule}
                  onClose={() => { setShowRuleForm(false); setEditingRule(null); }}
                  onSaved={() => { setShowRuleForm(false); setEditingRule(null); void load(); }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-12 max-w-[40rem]" aria-labelledby="needs-review-heading">
        <h2 id="needs-review-heading" className="type-section-heading">Needs review</h2>
        <div className="mt-4 border-t border-border">
          {pending.length === 0 ? (
            <p className="py-5 text-[14px] leading-6 text-muted">
              {latest ? "Nothing needs review." : "Scan to discover documents."}
            </p>
          ) : pending.map((run) => {
            const action = watchDocumentAction(run);
            return (
              <article key={run.run_id} className="flex items-start gap-3 border-b border-border py-4 last:border-b-0">
                <icons.document className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] font-medium tracking-[-0.012em] text-ink">{run.document_name}</p>
                  {action.kind === "review" ? (
                    <p className="mt-0.5 text-[13px] text-muted">{proposalCountLabel(run.proposal_count)}</p>
                  ) : null}
                  {action.kind === "authorize" && action.detail ? (
                    <p className="mt-2 max-w-[34rem] text-[13px] leading-5 text-muted">{action.detail}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {action.kind === "authorize" ? (
                      <AuthorizeExactFileButton
                        run={run}
                        onAuthorized={() => void load()}
                        onError={setError}
                      />
                    ) : null}
                    <Button variant={action.kind === "authorize" ? "secondary" : "primary"} onClick={() => openConversation(run)}>
                      Open conversation
                    </Button>
                  </div>
                </div>
                <span className="type-caption shrink-0 pt-0.5">{action.statusLabel}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-12 max-w-[40rem]" aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="type-section-heading">Recent activity</h2>
        <div className="mt-4 border-t border-border">
          {latestItems.length === 0 ? (
            <p className="py-5 text-[14px] leading-6 text-muted">
              {latest?.status === "RUNNING" ? "Scan in progress." : "No recent Watch activity."}
            </p>
          ) : latestItems.map((item) => {
            const run = item.run_id ? runsById.get(item.run_id) : undefined;
            return (
              <div key={`${item.provider_file_id}-${item.outcome}`} className="flex items-center gap-3 border-b border-border py-3.5 last:border-b-0">
                <icons.document className="size-4 shrink-0 text-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
                <p className="min-w-0 flex-1 truncate text-[14px] text-ink">{item.name}</p>
                <p className="type-caption shrink-0">{watchActivityLabel(item, run)}</p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function WatchAccessStatus({
  connection,
  onEnable,
}: {
  connection: GoogleConnection | null;
  onEnable: () => void;
}) {
  if (connection?.watch_authorized) {
    return (
      <p className="mt-5 inline-flex items-center gap-1.5 text-[13px] text-muted">
        Google Drive
        <span className="inline-flex items-center gap-1 text-success">
          <span className="grid size-3.5 place-items-center rounded-full bg-success text-primary-foreground">
            <icons.check className="size-2.5" strokeWidth={2.5} />
          </span>
          Watch access enabled
        </span>
      </p>
    );
  }

  return (
    <div className="mt-6">
      <p className="text-[14px] font-medium text-ink">Watch access required</p>
      <p className="mt-1 text-[14px] leading-6 text-muted">
        DocRelay needs read access to discover files in the selected folder.
      </p>
      <Button className="mt-4" onClick={onEnable}>Enable watch access</Button>
    </div>
  );
}

function WatchEmpty({
  connection,
  error,
  pickerBusy,
  onEnableWatch,
  onChooseFolder,
}: {
  connection: GoogleConnection | null;
  error: string | null;
  pickerBusy: boolean;
  onEnableWatch: () => void;
  onChooseFolder: () => void;
}) {
  const watchReady = Boolean(connection?.watch_authorized);
  return (
    <section className="flex min-h-[calc(100dvh-156px)] items-center justify-center px-6 py-14">
      <div className="w-full max-w-[28rem]">
        <h1 className="type-page-title">Watch</h1>
        <p className="type-body-muted mt-2">
          Keep a Drive folder in sync with human-reviewed AI changes.
        </p>
        {error ? <div className="mt-6"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
        {!connection || !watchReady ? (
          <div className="mt-7">
            <p className="text-[14px] font-medium text-ink">Watch access required</p>
            <p className="mt-1 text-[14px] leading-6 text-muted">
              DocRelay needs read access to discover files in the selected folder.
            </p>
            <Button className="mt-5" onClick={onEnableWatch}>Enable Watch access</Button>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            <div>
              <p className="text-[14px] font-medium text-ink">Choose folder</p>
              <p className="mt-1 text-[13px] leading-5 text-muted">Select the Drive folder DocRelay should watch.</p>
              <Button className="mt-3" busy={pickerBusy} onClick={onChooseFolder}>
                {pickerBusy ? "Opening Drive…" : "Choose folder"}
              </Button>
            </div>
            <p className="text-[13px] leading-5 text-muted">Then add a rule and set a schedule.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function ScheduleEditor({ watch, onSaved }: { watch: WatchRoot; onSaved: () => void }) {
  const [interval, setIntervalValue] = useState(watch.interval_seconds);
  const [enabled, setEnabled] = useState(watch.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="grid gap-1.5 text-[12px] text-muted">
        Schedule
        <select
          value={enabled ? interval : 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (next === 0) {
              setEnabled(false);
              return;
            }
            setEnabled(true);
            setIntervalValue(next);
          }}
          className="min-h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-ink"
        >
          <option value={0}>Manual</option>
          {INTERVALS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await updateWatchSchedule(watch.watch_id, { enabled, interval_seconds: enabled ? interval : watch.interval_seconds });
            onSaved();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Schedule could not be saved.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save schedule
      </Button>
      {error ? <p className="w-full text-[13px] text-warning">{error}</p> : null}
    </div>
  );
}

function RuleEditor({
  watchId,
  rule,
  onClose,
  onSaved,
}: {
  watchId: string;
  rule: WatchRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [folder, setFolder] = useState<SelectedDriveFile | null>(
    rule ? { fileId: rule.folder_id, name: rule.folder_name, mimeType: FOLDER_MIME } : null,
  );
  const [instruction, setInstruction] = useState(rule?.instruction ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFolder() {
    if (rule || picking) return;
    setPicking(true);
    setError(null);
    try {
      const selected = await pickDriveFolder("Choose a folder for this rule");
      if (selected) setFolder(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The folder could not be selected.");
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="mt-5">
      <h3 className="text-[14px] font-medium text-ink">{rule ? `Edit ${rule.folder_name}` : "Add rule"}</h3>
      <div className="mt-4 grid gap-4">
        <div>
          <p className="text-[12px] text-muted">Folder</p>
          {folder ? (
            <p className="mt-1 text-[14px] text-ink">{folder.name}</p>
          ) : (
            <Button variant="secondary" className="mt-1.5" busy={picking} onClick={() => void pickFolder()}>
              {picking ? "Opening Drive…" : "Choose folder"}
            </Button>
          )}
        </div>
        <label className="grid gap-1.5 text-[12px] text-muted">
          Instruction
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={4}
            className="resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] leading-5 text-ink"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-accent" />
          Enabled
        </label>
        {error ? <InlineNotice tone="warning">{error}</InlineNotice> : null}
        <div className="flex gap-2">
          <Button
            busy={busy}
            disabled={!folder || !instruction.trim()}
            onClick={async () => {
              if (!folder) return;
              setBusy(true);
              setError(null);
              try {
                await configureWatchRule(watchId, {
                  folder_id: folder.fileId,
                  instruction: instruction.trim(),
                  enabled,
                });
                onSaved();
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "Rule could not be saved.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Save rule
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function AuthorizeExactFileButton({
  run,
  onAuthorized,
  onError,
}: {
  run: RunSummary;
  onAuthorized: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Button
      busy={busy}
      onClick={() => {
        void (async () => {
          if (busy) return;
          setBusy(true);
          try {
            const pickedId = await pickExactDocument(run.document_name);
            if (!pickedId) return;
            if (!exactFilePickMatches(pickedId, run.provider_file_id)) {
              onError(`Choose ${run.document_name}. DocRelay will not transfer permission from another file.`);
              return;
            }
            await verifyWriteAuthorization(run.run_id, pickedId);
            onAuthorized();
          } catch (reason) {
            onError(reason instanceof Error ? reason.message : "Exact-file authorization failed.");
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {busy ? "Opening Google Drive…" : "Authorize document"}
    </Button>
  );
}

function WatchSkeleton() {
  return (
    <div className="space-y-4 px-6 py-8 sm:px-8 lg:px-10">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="mt-8 h-40 w-full max-w-[40rem]" />
      <Skeleton className="h-32 w-full max-w-[40rem]" />
    </div>
  );
}

async function pickDriveFolder(title: string): Promise<SelectedDriveFile | null> {
  await ensurePicker();
  const token = await requestPickerToken(DRIVE_READONLY_SCOPE);
  return new Promise((resolve, reject) => {
    try {
      const view = new window.google!.picker!.DocsView();
      view.setMimeTypes(FOLDER_MIME);
      view.setIncludeFolders(true);
      view.setSelectFolderEnabled(true);
      const picker = new window.google!.picker!.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(CLOUD_PROJECT_NUMBER)
        .setOrigin(window.location.origin)
        .setTitle(title)
        .setCallback((data: google.picker.ResponseObject) => {
          if (data.action === "cancel") {
            resolve(null);
            return;
          }
          if (data.action === "error") {
            reject(new Error("Google Picker could not complete folder selection."));
            return;
          }
          if (data.action !== "picked") return;
          const file = extractSelectedFile(data);
          if (!file || (file.mimeType && !isGoogleFolder(file.mimeType))) {
            resolve(null);
            return;
          }
          resolve({ ...file, mimeType: file.mimeType || FOLDER_MIME });
        })
        .build();
      picker.setVisible(true);
    } catch (reason) {
      reject(reason);
    }
  });
}

async function pickExactDocument(documentName: string): Promise<string | null> {
  await ensurePicker();
  const token = await browserPickerTokenManager.getToken(
    (prompt) => requestPickerTokenResponse(DRIVE_FILE_SCOPE, prompt),
  );
  return new Promise((resolve, reject) => {
    try {
      const view = new window.google!.picker!.DocsView();
      view.setMimeTypes("application/vnd.google-apps.document");
      const picker = new window.google!.picker!.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(CLOUD_PROJECT_NUMBER)
        .setOrigin(window.location.origin)
        .setTitle(`Authorize ${documentName}`)
        .setCallback((data: google.picker.ResponseObject) => {
          if (data.action === "cancel") {
            resolve(null);
            return;
          }
          const file = extractSelectedFile(data);
          resolve(file?.fileId ?? null);
        })
        .build();
      picker.setVisible(true);
    } catch (reason) {
      reject(reason);
    }
  });
}

async function ensurePicker(): Promise<void> {
  if (!GOOGLE_CLIENT_ID || !PICKER_API_KEY || !CLOUD_PROJECT_NUMBER) {
    throw new Error("Google Drive is not fully configured in this environment.");
  }
  await Promise.all([loadGapiScript(), loadGisScript()]);
  await loadPickerLibrary();
}

function requestPickerToken(scope: string): Promise<string> {
  return requestPickerTokenResponse(scope, "").then((response) => response.accessToken);
}

function requestPickerTokenResponse(
  scope: string,
  prompt: "" | "consent",
): Promise<{ accessToken: string; expiresIn: number }> {
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts!.oauth2!.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        resolve({ accessToken: response.access_token, expiresIn: response.expires_in });
      },
      error_callback: (reason) => reject(new Error(reason.message || "OAuth popup was closed or denied")),
    });
    client.requestAccessToken({ prompt });
  });
}

let gapiLoadPromise: Promise<void> | null = null;
let gisLoadPromise: Promise<void> | null = null;

function loadGapiScript(): Promise<void> {
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    if (window.gapi) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google API script"));
    document.head.appendChild(script);
  });
  return gapiLoadPromise;
}

function loadGisScript(): Promise<void> {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

function loadPickerLibrary(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) { resolve(); return; }
    if (!window.gapi) { reject(new Error("GAPI not loaded")); return; }
    window.gapi.load("picker", () => window.google?.picker ? resolve() : reject(new Error("Picker library failed to initialize")));
  });
}
