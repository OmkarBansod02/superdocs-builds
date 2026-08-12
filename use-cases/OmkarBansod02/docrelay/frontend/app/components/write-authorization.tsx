"use client";

import { FileKey2, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { browserPickerTokenManager } from "../google-drive/picker-token";
import { verifyWriteAuthorization } from "../lib/api";
import type { DocumentIdentityData } from "./document-identity";
import { DocumentIdentity } from "./document-identity";
import { Button, InlineNotice, StateMark } from "./ui";
import { WorkflowProgress } from "./workflow-progress";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID ?? "";
const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? "";
const CLOUD_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? "";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let gapiLoadPromise: Promise<void> | null = null;
let gisLoadPromise: Promise<void> | null = null;

export function WriteAuthorization({
  runId,
  providerFileId,
  document,
  onAuthorized,
}: {
  runId: string;
  providerFileId: string;
  document: DocumentIdentityData;
  onAuthorized: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authorize = useCallback(async () => {
    if (busy) return;
    if (!GOOGLE_CLIENT_ID || !PICKER_API_KEY || !CLOUD_PROJECT_NUMBER) {
      setError("Frontend Google configuration is incomplete.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await Promise.all([loadGapiScript(), loadGisScript()]);
      await loadPickerLibrary();
      const token = await browserPickerTokenManager.getToken(
        (prompt) => new Promise<{ accessToken: string; expiresIn: number }>((resolve, reject) => {
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
            error_callback: (reason) => reject(new Error(reason.message || "OAuth popup was closed or denied")),
          });
          client.requestAccessToken({ prompt });
        }),
      );

      const view = new window.google!.picker!.DocsView();
      view.setMimeTypes("application/vnd.google-apps.document");
      const picker = new window.google!.picker!.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(CLOUD_PROJECT_NUMBER)
        .setOrigin(window.location.origin)
        .setTitle(`Authorize ${document.name}`)
        .setCallback((data: google.picker.ResponseObject) => {
          if (data.action === "cancel") {
            setBusy(false);
            return;
          }
          if (data.action !== "picked" || !data.docs?.length) {
            setBusy(false);
            return;
          }
          const pickedId = data.docs[0].id;
          if (pickedId !== providerFileId) {
            setError(`Choose ${document.name}. DocRelay will not transfer permission from another file.`);
            setBusy(false);
            return;
          }
          void verifyWriteAuthorization(runId, pickedId)
            .then(onAuthorized)
            .catch((reason) => setError(reason instanceof Error ? reason.message : "Exact-file authorization failed."))
            .finally(() => setBusy(false));
        })
        .build();
      picker.setVisible(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google Picker could not be opened.");
      setBusy(false);
    }
  }, [busy, document.name, onAuthorized, providerFileId, runId]);

  return (
    <div>
      <DocumentIdentity document={document} />
      <WorkflowProgress current="Safety check" />
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
        <section className="px-5 py-10 sm:px-8 lg:px-10 lg:py-12">
          <div className="grid size-11 place-items-center rounded-lg bg-info-soft text-info"><FileKey2 className="size-5" aria-hidden="true" /></div>
          <h1 className="mt-6 max-w-[690px] text-[31px] font-semibold tracking-[-0.04em] text-ink sm:text-[36px]">Authorize this exact document for write-back</h1>
          <p className="mt-3 max-w-[660px] text-[15px] leading-7 text-muted">DocRelay can read this watched document, but Google requires an explicit selection before it can write to the file.</p>
          <div className="mt-7 max-w-[680px]"><InlineNotice tone="info">This is a permission checkpoint, not a workflow failure. The approved proposal and safety evidence are preserved.</InlineNotice></div>
          {error ? <div className="mt-4 max-w-[680px]"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
          <Button busy={busy} onClick={() => void authorize()} className="mt-7 min-w-[250px]">{busy ? "Opening Google Drive…" : "Authorize exact file"}</Button>
          <p className="mt-4 max-w-[650px] text-[12px] leading-5 text-muted">Google Picker must return the same Drive file ID. Choosing any other document is rejected.</p>
        </section>
        <aside className="border-t border-border px-5 py-9 sm:px-8 lg:border-l lg:border-t-0 lg:px-8 lg:py-12">
          <h2 className="text-[19px] font-semibold text-ink">Authorization boundary</h2>
          <div className="mt-8 space-y-8">
            <div className="flex gap-3"><StateMark state="complete" /><span className="text-[14px] text-ink">Read access already verified</span></div>
            <div className="flex gap-3"><StateMark state="current" /><span className="text-[14px] text-ink">Exact file selection required</span></div>
            <div className="flex gap-3"><StateMark /><span className="text-[14px] text-ink">Safe write-back remains guarded</span></div>
          </div>
          <div className="mt-9 border-t border-border pt-6 text-[13px] leading-6 text-muted"><ShieldCheck className="mb-3 size-5 text-accent" />Picker tokens remain memory-only and are never persisted.</div>
        </aside>
      </div>
    </div>
  );
}

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
