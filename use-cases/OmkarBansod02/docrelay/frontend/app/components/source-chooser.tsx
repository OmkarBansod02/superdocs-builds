"use client";

import { useCallback, useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
    <section className="flex min-h-full flex-col px-6 py-10 sm:px-10 lg:px-16 lg:py-16">
      <div className="mx-auto w-full max-w-[34rem]">
        <p className="type-label">Workspace</p>
        <h1 className="type-page-title mt-3">Start with a document</h1>
        <p className="type-body-muted mt-3 max-w-[32rem]">
          Bring in a Google Doc and DocRelay will keep every AI change reviewed, backed up, and verifiable.
        </p>

        {apiUnavailable ? (
          <Alert variant="warning" className="mt-6 rounded-md">
            <icons.warning strokeWidth={ICON_STROKE} />
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
          <Alert variant="warning" className="mt-6 rounded-md">
            <icons.warning strokeWidth={ICON_STROKE} />
            <AlertTitle>Google Drive is not configured</AlertTitle>
            <AlertDescription>OAuth is not available on this backend.</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="warning" className="mt-6 rounded-md">
            <icons.warning strokeWidth={ICON_STROKE} />
            <AlertTitle>Could not open Google Drive</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-8 rounded-[10px] border border-dashed border-border bg-surface/80 px-6 py-7">
          {loading ? (
            <SelectorSkeleton />
          ) : (
            <div className="flex flex-col items-start gap-4">
              <icons.drive className="size-5 text-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
              {!connection ? (
                <Button onClick={handleConnect} className="min-h-9 min-w-[12rem] px-4">
                  <icons.drive data-icon="inline-start" strokeWidth={ICON_STROKE} aria-hidden="true" />
                  Connect Google Drive
                </Button>
              ) : (
                <Button
                  onClick={() => void openPicker()}
                  busy={pickerBusy}
                  disabled={pickerBusy}
                  aria-busy={pickerBusy}
                  className="min-h-9 min-w-[12rem] px-4"
                >
                  {pickerBusy ? "Opening Drive…" : "Choose from Google Drive"}
                </Button>
              )}
              <div className="flex flex-col gap-1">
                <p className="type-caption">Google Docs supported</p>
                <p className="type-caption">Review every change before write-back.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SelectorSkeleton() {
  return (
    <div className="flex flex-col items-start gap-4 py-1" aria-hidden="true">
      <Skeleton className="size-5 rounded-md" />
      <Skeleton className="h-9 w-48 rounded-md" />
      <Skeleton className="h-3 w-36" />
    </div>
  );
}
