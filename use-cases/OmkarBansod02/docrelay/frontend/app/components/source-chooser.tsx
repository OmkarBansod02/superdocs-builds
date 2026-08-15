"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import type { GoogleConnection } from "../lib/api";
import { getAuthorizeUrl, getConnections } from "../lib/api";
import { browserPickerTokenManager } from "../google-drive/picker-token";
import {
  extractSelectedFile,
  mapPickerFailure,
  type SelectedDriveFile,
} from "../lib/import-state";
import { ICON_STROKE, icons } from "@/lib/icons";
import { cn } from "@/lib/utils";
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
        return;
      }
      setOauthConfigured(true);
      const active = data.connections.find((item) => item.status === "CONNECTED") ?? null;
      setConnection(active);
      onConnectionChange(active);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.name === "AbortError") return;
      setApiUnavailable(true);
      setConnection(null);
      onConnectionChange(null);
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
    <section className="flex h-full min-h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between px-6 lg:px-10">
        <h1 className="type-chrome-title">Workspace</h1>
        <DriveConnectionStatus connected={Boolean(connection)} loading={loading} />
      </header>

      {/* Editorial composition: content sits in a measured column near the top
          of the page rather than floating in the middle of the canvas. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-20 lg:px-10">
        <div className="mx-auto w-full max-w-[960px] pt-12 lg:pt-[84px]">
          <div className="max-w-[34rem]">
            <h2 className="type-hero-title">Start with a document</h2>
            <p className="type-hero-body mt-3">
              Connect a Google Doc and ask DocRelay to make reviewed, verifiable changes.
            </p>
          </div>

          <div className="mt-8 flex w-full max-w-[496px] flex-col gap-3">
            {apiUnavailable ? (
              <InlineStatus
                title="DocRelay API is unavailable"
                description="Start the backend or try again."
                action={
                  <Button variant="secondary" onClick={() => void loadWorkspace()} className="h-8 px-2.5">
                    Retry
                  </Button>
                }
              />
            ) : null}

            {!apiUnavailable && !oauthConfigured ? (
              <InlineStatus
                title="Google Drive is not configured"
                description="OAuth is not available on this backend."
              />
            ) : null}

            {error ? (
              <InlineStatus title="Could not open Google Drive" description={error} />
            ) : null}

            <div className="w-full rounded-[11px] border border-border bg-surface px-7 py-7 shadow-[var(--shadow-subtle)]">
              {loading ? (
                <SelectorSkeleton />
              ) : (
                <div className="flex w-full flex-col">
                  <GoogleDriveMark className="h-7 w-8" />
                  <h3 className="mt-4 text-[15.5px] font-semibold tracking-[-0.02em] text-foreground">
                    Choose a Google Doc
                  </h3>
                  <p className="mt-1.5 text-[13.5px] leading-[1.55] text-muted">
                    DocRelay reads the document you select and freezes its revision before
                    anything changes.
                  </p>
                  {!connection ? (
                    <Button onClick={handleConnect} className="mt-5 w-fit">
                      Connect Google Drive
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void openPicker()}
                      busy={pickerBusy}
                      disabled={pickerBusy}
                      aria-busy={pickerBusy}
                      className="mt-5 w-fit"
                    >
                      {pickerBusy ? "Opening Drive…" : "Choose from Drive"}
                    </Button>
                  )}
                  <p className="type-caption mt-5 border-t border-border-light pt-3">
                    Only Google Docs are supported.
                  </p>
                </div>
              )}
            </div>
          </div>

          <p className="type-caption mt-6 max-w-[496px]">
            Every change is reviewed before write-back.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Compact inline status surface — deliberately quieter than a full banner. */
function InlineStatus({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex w-full items-start gap-2.5 rounded-[9px] border border-border-light bg-transparent px-3.5 py-3"
    >
      <icons.warning
        className="mt-px size-4 shrink-0 text-muted"
        strokeWidth={ICON_STROKE}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function DriveConnectionStatus({
  connected,
  loading,
}: {
  connected: boolean;
  loading: boolean;
}) {
  if (loading && !connected) return null;

  return (
    <p className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
      <span
        className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-border")}
        aria-hidden="true"
      />
      Google Drive
      <span className="text-muted">·</span>
      {connected ? "Connected" : "Not connected"}
    </p>
  );
}

function GoogleDriveMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 87.3 78" className={className} aria-hidden="true">
      <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="M43.65 25 29.9 1.2C28.55 2 27.4 3.1 26.6 4.5L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" />
      <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 25.4-44c.8-1.4 1.2-2.95 1.2-4.5H59.8z" />
      <path fill="#00832d" d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="m73.4 26.5-25.4-44c-.8-1.4-1.95-2.5-3.3-3.3L31 25l16.15 28H74.6c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}

function SelectorSkeleton() {
  return (
    <div className="flex w-full flex-col" aria-hidden="true">
      <Skeleton className="size-7 rounded-md" />
      <Skeleton className="mt-4 h-4 w-40" />
      <Skeleton className="mt-2.5 h-3.5 w-full" />
      <Skeleton className="mt-2 h-3.5 w-3/4" />
      <Skeleton className="mt-5 h-9 w-[10.5rem] rounded-[8px]" />
      <Skeleton className="mt-6 h-3 w-44" />
    </div>
  );
}
