"use client";

import { useCallback, useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { GoogleConnection } from "../lib/api";
import { getAuthorizeUrl, getConnections, listRuns } from "../lib/api";
import { browserPickerTokenManager } from "../google-drive/picker-token";
import {
  extractSelectedFile,
  formatRelativeTime,
  mapPickerFailure,
  recentDocumentsFromRuns,
  type RecentDocument,
  type SelectedDriveFile,
} from "../lib/import-state";
import { ICON_STROKE, icons } from "../lib/icons";
import { Button } from "./ui";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID ?? "";
const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? "";
const CLOUD_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? "";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let gapiLoadPromise: Promise<void> | null = null;
let gisLoadPromise: Promise<void> | null = null;

function loadGapiScript(): Promise<void> {
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    if (window.gapi) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google API script"));
    document.head.appendChild(s);
  });
  return gapiLoadPromise;
}

function loadGisScript(): Promise<void> {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return gisLoadPromise;
}

function loadPickerLibrary(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) { resolve(); return; }
    if (!window.gapi) { reject(new Error("GAPI not loaded")); return; }
    window.gapi.load("picker", () => {
      if (window.google?.picker) resolve();
      else reject(new Error("Picker library failed to initialize"));
    });
  });
}

export function SourceChooser({
  initialConnection,
  onDocumentPicked,
  onConnectionChange,
}: {
  initialConnection: GoogleConnection | null;
  onDocumentPicked: (conn: GoogleConnection, file: SelectedDriveFile) => void;
  onConnectionChange: (conn: GoogleConnection | null) => void;
}) {
  const [connection, setConnection] = useState<GoogleConnection | null>(initialConnection);
  const [loading, setLoading] = useState(true);
  const [apiUnavailable, setApiUnavailable] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentDocument[]>([]);

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setApiUnavailable(false);
    setError(null);
    try {
      const data = await getConnections(signal);
      if (signal?.aborted) return;
      if (!data.oauth_configured) {
        setOauthConfigured(false);
        setConnection(null);
        onConnectionChange(null);
        setRecent([]);
        return;
      }
      setOauthConfigured(true);
      const active = data.connections.find((item) => item.status === "CONNECTED") ?? null;
      setConnection(active);
      onConnectionChange(active);

      if (!active) {
        setRecent([]);
        return;
      }

      try {
        const runData = await listRuns(signal);
        if (signal?.aborted) return;
        setRecent(recentDocumentsFromRuns(runData.runs));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        setRecent([]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.name === "AbortError") return;
      setApiUnavailable(true);
      setConnection(null);
      onConnectionChange(null);
      setRecent([]);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [onConnectionChange]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void loadWorkspace(controller.signal));
    return () => controller.abort();
  }, [loadWorkspace]);

  const handleConnect = useCallback(() => {
    window.location.assign(getAuthorizeUrl());
  }, []);

  const openPicker = useCallback(async () => {
    if (!connection || pickerBusy) return;
    if (!GOOGLE_CLIENT_ID || !PICKER_API_KEY || !CLOUD_PROJECT_NUMBER) {
      setError("Google Drive is not fully configured in this environment.");
      return;
    }
    setPickerBusy(true);
    setError(null);
    try {
      await Promise.all([loadGapiScript(), loadGisScript()]);
      await loadPickerLibrary();

      const token = await browserPickerTokenManager.getToken(
        (prompt) => new Promise<{ accessToken: string; expiresIn: number }>(
          (resolve, reject) => {
            const client = window.google!.accounts!.oauth2!.initTokenClient({
              client_id: GOOGLE_CLIENT_ID,
              scope: DRIVE_FILE_SCOPE,
              callback: (response) => {
                if (response.error) {
                  reject(new Error(response.error_description || response.error));
                  return;
                }
                resolve({ accessToken: response.access_token, expiresIn: response.expires_in });
              },
              error_callback: (err) => {
                reject(new Error(err.message || "OAuth popup was closed or denied"));
              },
            });
            client.requestAccessToken({ prompt });
          },
        ),
      );

      const docsView = new window.google!.picker!.DocsView();
      docsView.setMimeTypes("application/vnd.google-apps.document");

      const picker = new window.google!.picker!.PickerBuilder()
        .addView(docsView)
        .setOAuthToken(token)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(CLOUD_PROJECT_NUMBER)
        .setOrigin(window.location.origin)
        .setTitle("Select a Google document")
        .setCallback((data: google.picker.ResponseObject) => {
          if (data.action === "cancel") {
            setPickerBusy(false);
            return;
          }
          const file = extractSelectedFile(data);
          if (file) {
            setPickerBusy(false);
            onDocumentPicked(connection, file);
            return;
          }
          setPickerBusy(false);
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      const mapped = mapPickerFailure(err);
      if (mapped) setError(mapped);
      setPickerBusy(false);
    }
  }, [connection, pickerBusy, onDocumentPicked]);

  return (
    <section className="px-5 py-8 sm:px-8 lg:px-10 lg:py-12">
      <div className="mx-auto w-full max-w-[840px]">
        <h1 className="type-page-title">Workspace</h1>
        <p className="type-body-muted mt-2 max-w-[36rem]">
          Choose a Google Doc to review and safely update with AI.
        </p>

        {apiUnavailable ? (
          <Alert variant="warning" className="mt-6 max-w-[28rem] rounded-md">
            <icons.warning className="size-4" strokeWidth={ICON_STROKE} />
            <AlertTitle>DocRelay API is unavailable</AlertTitle>
            <AlertDescription>Start the backend or try again.</AlertDescription>
            <AlertAction>
              <Button
                variant="secondary"
                onClick={() => void loadWorkspace()}
                className="min-h-8 px-2.5"
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {!apiUnavailable && !oauthConfigured ? (
          <Alert variant="warning" className="mt-6 max-w-[28rem] rounded-md">
            <icons.warning className="size-4" strokeWidth={ICON_STROKE} />
            <AlertTitle>Google Drive is not configured</AlertTitle>
            <AlertDescription>OAuth is not available on this backend.</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="warning" className="mt-6 max-w-[28rem] rounded-md">
            <icons.warning className="size-4" strokeWidth={ICON_STROKE} />
            <AlertTitle>Could not open Google Drive</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-8 rounded-lg border border-border bg-surface px-6 py-8 sm:px-8 sm:py-9">
          {loading ? (
            <SelectorSkeleton />
          ) : (
            <>
              <div className="flex flex-col items-start gap-4 sm:items-center sm:text-center">
                <DriveMark />
                <div>
                  <h2 className="type-document-title">Choose a Google Doc</h2>
                  <p className="type-body-muted mt-1.5 max-w-[28rem]">
                    Connect a document to start a reviewed edit.
                  </p>
                </div>
              </div>

              <div className="mt-6 flex flex-col items-start gap-3 sm:items-center">
                <DriveConnectionStatus connected={Boolean(connection)} />

                {!connection ? (
                  <Button onClick={handleConnect} className="min-h-11 min-w-[14rem] px-5">
                    <icons.drive className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
                    Connect Google Drive
                  </Button>
                ) : (
                  <Button
                    onClick={() => void openPicker()}
                    busy={pickerBusy}
                    disabled={pickerBusy}
                    aria-busy={pickerBusy}
                    className="min-h-11 min-w-[14rem] px-5"
                  >
                    {pickerBusy ? null : <icons.drive className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />}
                    {pickerBusy ? "Opening Drive…" : "Choose from Drive"}
                  </Button>
                )}

                <p className="type-caption">Google Docs supported</p>
              </div>
            </>
          )}
        </div>

        {recent.length > 0 ? (
          <div className="mt-8">
            <h2 className="type-section-heading">Recent documents</h2>
            <ul className="mt-2 divide-y divide-border border-y border-border">
              {recent.map((document) => (
                <li key={document.providerFileId}>
                  <button
                    type="button"
                    onClick={() => connection && onDocumentPicked(connection, {
                      fileId: document.providerFileId,
                      name: document.name,
                      mimeType: "application/vnd.google-apps.document",
                    })}
                    aria-label={`Import ${document.name}`}
                    disabled={!connection || pickerBusy}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 px-1 py-3 text-left transition-colors duration-[180ms]",
                      "hover:bg-surface-muted/70 focus-visible:bg-surface-muted/70",
                      "disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#e8f0fe] text-[#2878ed]">
                      <icons.document className="size-4" strokeWidth={ICON_STROKE} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-foreground">
                        {document.name}
                      </span>
                      <span className="type-caption">
                        {formatRelativeTime(document.updatedAt)}
                      </span>
                    </span>
                    <icons.chevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DriveMark() {
  return (
    <span
      className="grid size-10 place-items-center rounded-md border border-border bg-surface-muted text-muted"
      aria-hidden="true"
    >
      <icons.drive className="size-5" strokeWidth={ICON_STROKE} />
    </span>
  );
}

function DriveConnectionStatus({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <p className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <icons.drive className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden="true" />
        Google Drive
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1 text-success">
          Connected
          <icons.check className="size-3" strokeWidth={2.25} aria-hidden="true" />
        </span>
      </p>
    );
  }

  return (
    <p className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <icons.drive className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden="true" />
      Google Drive
    </p>
  );
}

function SelectorSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4 py-2" aria-hidden="true">
      <Skeleton className="size-10 rounded-md" />
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-56" />
      <Skeleton className="mt-2 h-11 w-[12.5rem] rounded-md" />
    </div>
  );
}
