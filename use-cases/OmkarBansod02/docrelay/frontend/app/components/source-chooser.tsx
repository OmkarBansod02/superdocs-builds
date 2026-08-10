"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, FileText, Loader2 } from "lucide-react";
import type { GoogleConnection, SourceRegistration } from "../lib/api";
import { getAuthorizeUrl, getConnections, registerSource } from "../lib/api";
import { PickerTokenManager } from "../google-drive/picker-token";

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
  const tokenManagerRef = useRef(new PickerTokenManager());

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

      const tm = tokenManagerRef.current;
      let token = tm.hasValidToken() ? tm.currentToken! : null;

      if (!token) {
        const gisResult = await new Promise<{ accessToken: string; expiresIn: number }>(
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
            client.requestAccessToken({ prompt: tm.promptHint });
          },
        );
        tm.handleTokenResponse(gisResult.accessToken, gisResult.expiresIn);
        token = gisResult.accessToken;
      }

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
      <div className="flex items-center justify-center py-20 text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Checking connection…
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-12">
      <div className="text-center mb-8">
        <div className="w-12 h-12 rounded-lg bg-accent-soft flex items-center justify-center mx-auto mb-4">
          <FileText className="w-6 h-6 text-accent" />
        </div>
        <h2 className="text-lg font-semibold text-ink mb-1">Select a document</h2>
        <p className="text-sm text-muted">
          Choose a Google Doc to review and modify safely through SuperDocs.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-error-soft border border-error/20 rounded text-sm text-error">
          {error}
        </div>
      )}

      {!connection ? (
        <div className="bg-surface border border-border rounded-md p-6 text-center">
          <Cloud className="w-8 h-8 text-muted mx-auto mb-3" />
          <p className="text-sm text-muted mb-4">Connect your Google Drive to get started.</p>
          <button
            onClick={handleConnect}
            className="px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors"
          >
            Connect Google Drive
          </button>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-md p-6 text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs text-success mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Google Drive connected
          </div>
          <button
            onClick={openPicker}
            disabled={pickerBusy}
            className="px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pickerBusy ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Selecting…
              </span>
            ) : (
              "Choose document"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
