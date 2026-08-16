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

  const notices = (
    <>
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

      {error ? <InlineStatus title="Could not open Google Drive" description={error} /> : null}
    </>
  );

  return (
    <section className="flex h-full min-h-full flex-col bg-background">
      <header className="chrome-rail">
        <h1 className="type-chrome-title">Workspace</h1>
        <DriveConnectionStatus connected={Boolean(connection)} loading={loading} />
      </header>

      {/* Editorial composition: one focal column, balanced in the canvas rather
          than pinned to the top, with the Drive selection carrying the mass. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-col justify-center px-6 pt-12 pb-20 lg:pt-14 lg:pb-24">
          <div className="mx-auto max-w-[34rem] text-center">
            <h2 className="type-hero-title text-balance">Start with a document</h2>
            <p className="type-hero-body mx-auto mt-3.5 max-w-[27rem] text-pretty">
              Connect a Google Doc and let DocRelay prepare reviewed, verifiable changes.
            </p>
          </div>

          {/* gap clears the stacked sheets peeking above the plate */}
          <div className="mt-9 flex w-full flex-col gap-5 lg:mt-11">
            {notices}
            <DriveSelectionPlate
              loading={loading}
              connected={Boolean(connection)}
              busy={pickerBusy}
              onConnect={handleConnect}
              onChoose={() => void openPicker()}
            />
          </div>

          <p className="mt-7 flex items-center justify-center gap-1.5 text-center text-[12.5px] text-muted">
            <icons.shield className="size-3.5 shrink-0 text-muted-soft" strokeWidth={ICON_STROKE} aria-hidden="true" />
            Every change is reviewed before write-back.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The product's primary action. It is one large, calm target: a page-like
 * plate resting on a short stack, so the first impression is a document
 * product rather than a settings form.
 */
function DriveSelectionPlate({
  loading,
  connected,
  busy,
  onConnect,
  onChoose,
}: {
  loading: boolean;
  connected: boolean;
  busy: boolean;
  onConnect: () => void;
  onChoose: () => void;
}) {
  const body = (
    <>
      <span
        className={cn(
          "grid size-[68px] place-items-center rounded-[18px] border border-border-light bg-surface-elevated",
          "shadow-[var(--shadow-subtle)] transition-transform duration-[var(--motion-duration-lg)] ease-[var(--motion-ease)]",
          connected && !busy ? "group-hover/plate:-translate-y-0.5" : "",
        )}
        aria-hidden="true"
      >
        <GoogleDriveMark className="h-[30px] w-[34px]" />
      </span>
      <span className="mt-6 block text-[19px] leading-[1.25] font-semibold tracking-[-0.026em] text-foreground">
        {connected ? "Choose a Google Doc" : "Connect Google Drive"}
      </span>
      <span className="mx-auto mt-2.5 block max-w-[25.5rem] text-[13.5px] leading-[1.62] text-muted">
        {connected
          ? "DocRelay reads the document you select and freezes its revision before anything changes."
          : "Authorize Drive once. DocRelay only ever reads the documents you pick."}
      </span>
    </>
  );

  const footnote = (
    <span className="mt-8 flex w-full items-center justify-center gap-1.5 border-t border-border-light pt-4 text-[12px] text-muted-soft">
      <icons.lock className="size-3 shrink-0" strokeWidth={ICON_STROKE} aria-hidden="true" />
      Only Google Docs are supported.
    </span>
  );

  return (
    <div className="relative">
      {/* A short stack behind the plate: depth from the product's own subject
          matter, not from decoration. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-11 -top-[17px] h-[18px] rounded-t-[13px] border border-b-0 border-border-light bg-surface/50"
      />
      <span
        aria-hidden="true"
        className="absolute inset-x-[22px] -top-[9px] h-[11px] rounded-t-[15px] border border-b-0 border-border-light bg-surface/80"
      />

      {loading ? (
        <div className="relative rounded-[var(--radius-plate)] border border-border-light bg-surface px-8 pt-11 pb-8 shadow-[var(--shadow-raised)]">
          <SelectorSkeleton />
        </div>
      ) : connected ? (
        <button
          type="button"
          onClick={onChoose}
          disabled={busy}
          aria-busy={busy}
          className={cn(
            "group/plate relative flex w-full flex-col items-center rounded-[var(--radius-plate)] border bg-surface px-8 pt-11 pb-8 text-center",
            "transition-[box-shadow,border-color,background-color] duration-[var(--motion-duration-lg)] ease-[var(--motion-ease)]",
            "border-border-light shadow-[var(--shadow-raised)]",
            "hover:border-border hover:bg-surface-elevated hover:shadow-[var(--shadow-lifted)]",
            "focus-visible:border-ring focus-visible:shadow-[var(--shadow-lifted)]",
            "disabled:pointer-events-none",
          )}
        >
          {body}
          <span
            className={cn(
              "type-button mt-7 inline-flex h-[38px] items-center justify-center gap-2 rounded-[9px] px-5",
              "bg-primary text-primary-foreground shadow-[var(--shadow-subtle)]",
              "transition-colors duration-[var(--motion-duration)] ease-[var(--motion-ease)]",
              busy ? "opacity-80" : "group-hover/plate:bg-primary-hover",
            )}
          >
            {busy ? (
              <icons.refresh className="size-3.5 animate-spin" strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : null}
            {busy ? "Opening Drive…" : "Choose from Drive"}
          </span>
          {footnote}
        </button>
      ) : (
        <div className="relative flex w-full flex-col items-center rounded-[var(--radius-plate)] border border-border-light bg-surface px-8 pt-11 pb-8 text-center shadow-[var(--shadow-raised)]">
          {body}
          <Button onClick={onConnect} className="mt-7 h-[38px] px-5">
            Connect Google Drive
          </Button>
          {footnote}
        </div>
      )}
    </div>
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
      className="flex w-full items-start gap-2.5 rounded-[10px] border border-border-light bg-surface/60 px-3.5 py-3"
    >
      <icons.warning
        className="mt-px size-4 shrink-0 text-warning"
        strokeWidth={ICON_STROKE}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-[1.55] text-muted">{description}</p>
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
    <p className="inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-muted">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", connected ? "bg-success" : "bg-border")}
        aria-hidden="true"
      />
      Google Drive
      <span className="text-muted-soft">·</span>
      {connected ? "Connected" : "Not connected"}
    </p>
  );
}

function GoogleDriveMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 87.3 78" className={className} aria-hidden="true" focusable="false">
      <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44C.41 49.88 0 51.44 0 53h27.5z" />
      <path fill="#ea4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.797l5.852 11.5z" />
      <path fill="#00832d" d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}

function SelectorSkeleton() {
  return (
    <div className="flex w-full flex-col items-center" aria-hidden="true">
      <Skeleton className="size-[68px] rounded-[18px]" />
      <Skeleton className="mt-6 h-5 w-48" />
      <Skeleton className="mt-3.5 h-3.5 w-full max-w-[24rem]" />
      <Skeleton className="mt-2 h-3.5 w-3/5" />
      <Skeleton className="mt-7 h-[38px] w-[11.5rem] rounded-[9px]" />
      <Skeleton className="mt-9 h-3 w-44" />
    </div>
  );
}
