"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, FileText, Loader2, Triangle } from "lucide-react";
import type { GoogleConnection, SourceRegistration } from "../lib/api";
import { getAuthorizeUrl, getConnections, registerSource } from "../lib/api";
import { browserPickerTokenManager } from "../google-drive/picker-token";
import { Button, InlineNotice, StateMark } from "./ui";

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
  onSourceSelected,
  onConnectionChange,
}: {
  onSourceSelected: (conn: GoogleConnection, source: SourceRegistration) => void;
  onConnectionChange: (conn: GoogleConnection | null) => void;
}) {
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = await getConnections(controller.signal);
        if (!data.oauth_configured) {
          setError("Google OAuth is not configured on the backend.");
          setLoading(false);
          return;
        }
        const active = data.connections.find((c) => c.status === "CONNECTED") ?? null;
        setConnection(active);
        onConnectionChange(active);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Could not reach the DocRelay API.");
      } finally {
        setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [onConnectionChange]);

  const handleConnect = useCallback(() => {
    window.location.assign(getAuthorizeUrl());
  }, []);

  const openPicker = useCallback(async () => {
    if (!connection || pickerBusy) return;
    if (!GOOGLE_CLIENT_ID || !PICKER_API_KEY || !CLOUD_PROJECT_NUMBER) {
      setError("Frontend Google configuration is incomplete.");
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
          if (data.action === "picked" && data.docs?.length) {
            const doc = data.docs[0];
            void doRegister(doc.id);
          } else {
            setPickerBusy(false);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Picker failed to open";
      if (msg.includes("popup_closed") || msg.includes("access_denied")) {
        setPickerBusy(false);
      } else {
        setError(msg);
        setPickerBusy(false);
      }
    }

    async function doRegister(fileId: string) {
      try {
        const result = await registerSource(connection!.connection_id, fileId);
        onSourceSelected(connection!, result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Source registration failed.");
      } finally {
        setPickerBusy(false);
      }
    }
  }, [connection, pickerBusy, onSourceSelected]);

  if (loading) {
    return (
      <div className="flex min-h-[calc(100dvh-156px)] items-center justify-center text-[14px] text-muted">
        <Loader2 className="mr-2 size-5 animate-spin" />
        Checking connection…
      </div>
    );
  }

  return (
    <section className="flex min-h-[calc(100dvh-156px)] items-center justify-center px-5 py-14 sm:px-8">
      <div className="w-full max-w-[720px] text-center">
        <div className="mx-auto mb-7 grid size-12 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden="true">
          <FileText className="size-6" strokeWidth={1.8} />
        </div>
        <h1 className="text-[30px] font-semibold tracking-[-0.035em] text-ink sm:text-[36px]">Choose a Google Drive document</h1>
        <p className="mx-auto mt-4 max-w-[610px] text-[15px] leading-7 text-muted sm:text-[16px]">
          Connect a document, ask SuperDocs to prepare a change, review exactly what will change, then write it back safely.
        </p>

        {error ? <div className="mx-auto mt-7 max-w-lg text-left"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}

        <div className="relative mx-auto mt-10 max-w-[670px] border-x border-t border-border px-6 pb-2 pt-0 sm:px-10">
          <div className="-translate-y-1/2 bg-background px-4">
            {!connection ? (
              <Button onClick={handleConnect} className="min-w-[220px]">
                <Cloud className="size-4" aria-hidden="true" />
                Connect Google Drive
              </Button>
            ) : (
              <Button onClick={openPicker} busy={pickerBusy} className="min-w-[220px]">
                <Triangle className="size-4 fill-current" aria-hidden="true" />
                {pickerBusy ? "Opening Drive…" : "Choose from Drive"}
              </Button>
            )}
          </div>
          <p className="-mt-2 text-[13px] text-muted">Only Google Docs are supported.</p>
        </div>

        <ol className="mx-auto mt-14 flex max-w-[620px] items-start" aria-label="Safe write-back overview">
          {["Select", "Propose", "Review", "Verify & write"].map((label, index, items) => (
            <li key={label} className="flex flex-1 items-start last:flex-none">
              <div className="flex flex-col items-center gap-3 text-[13px] text-muted">
                <StateMark />
                <span className="whitespace-nowrap">{label}</span>
              </div>
              {index < items.length - 1 ? <span className="mx-3 mt-2.5 h-px flex-1 bg-border sm:mx-5" aria-hidden="true" /> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
