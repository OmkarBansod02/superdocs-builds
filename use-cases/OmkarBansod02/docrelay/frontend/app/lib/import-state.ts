import { ApiError, type RunSummary } from "./api";

export type SelectedDriveFile = {
  fileId: string;
  name: string;
  mimeType: string;
};

export type ImportStageId =
  | "FILE_SELECTED"
  | "READING_SOURCE"
  | "FREEZING_REVISION"
  | "PREPARING_WORKSPACE";

export type ImportStageStatus = "complete" | "active" | "pending";

export type ImportPhase = "READING_SOURCE" | "FAILED";

export type ImportFailure = {
  title: string;
  protection: string;
  retryable: boolean;
};

export type RecentDocument = {
  providerFileId: string;
  name: string;
  updatedAt: string;
};

export const IMPORT_STAGES: readonly { id: ImportStageId; label: string }[] = [
  { id: "FILE_SELECTED", label: "File selected" },
  { id: "READING_SOURCE", label: "Reading Google document" },
  { id: "FREEZING_REVISION", label: "Freezing source revision" },
  { id: "PREPARING_WORKSPACE", label: "Preparing workspace" },
];

const DEFAULT_PROTECTION = "DocRelay did not create or modify anything.";

/**
 * Picker returns the file immediately. The only subsequent observable work is
 * the single register-source request, which reads the Doc, freezes the
 * revision, and persists the workspace baseline together.
 */
export function importStageStatus(
  id: ImportStageId,
  phase: ImportPhase,
): ImportStageStatus {
  if (id === "FILE_SELECTED") return "complete";
  if (phase === "FAILED") return "pending";
  if (id === "READING_SOURCE") return "active";
  return "pending";
}

export function importStatusLabel(phase: ImportPhase, documentName: string): string {
  if (phase === "FAILED") return `Could not import ${documentName}`;
  return `Reading ${documentName}`;
}

export function extractSelectedFile(data: {
  action: string;
  docs?: Array<{ id?: string; name?: string; mimeType?: string }>;
}): SelectedDriveFile | null {
  if (data.action === "cancel" || data.action !== "picked") return null;
  const doc = data.docs?.[0];
  if (!doc?.id) return null;
  return {
    fileId: doc.id,
    name: doc.name?.trim() || "Untitled document",
    mimeType: doc.mimeType ?? "",
  };
}

export function buildRegistrationPayload(file: SelectedDriveFile): { file_id: string } {
  return { file_id: file.fileId };
}

/** Versioned Google copies created before write-back. Keep them in history; hide from Recents. */
export const DOCRELAY_BACKUP_NAME_MARKER = " — DocRelay backup — ";

export function isDocRelayBackupName(name: string): boolean {
  return name.includes(DOCRELAY_BACKUP_NAME_MARKER);
}

export function recentDocumentsFromRuns(
  runs: RunSummary[],
  limit = 8,
): RecentDocument[] {
  const latestByFile = new Map<string, RecentDocument>();

  for (const run of runs) {
    const providerFileId = run.provider_file_id?.trim();
    const name = run.document_name?.trim();
    if (!providerFileId || !name) continue;
    if (isDocRelayBackupName(name)) continue;

    const existing = latestByFile.get(providerFileId);
    if (!existing || Date.parse(run.updated_at) > Date.parse(existing.updatedAt)) {
      latestByFile.set(providerFileId, {
        providerFileId,
        name,
        updatedAt: run.updated_at,
      });
    }
  }

  return [...latestByFile.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";

  const deltaSeconds = Math.round((now - then) / 1000);
  if (deltaSeconds < 45) return "Just now";
  if (deltaSeconds < 90) return "1 minute ago";

  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 90) return "1 hour ago";

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  if (hours < 42) return "Yesterday";

  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days ago`;

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(then));
}

export function mapImportFailure(error: unknown): ImportFailure {
  const code = error instanceof ApiError ? error.code : "";

  switch (code) {
    case "UNSUPPORTED_SOURCE_TYPE":
      return {
        title: "Only Google Docs are supported",
        protection: DEFAULT_PROTECTION,
        retryable: false,
      };
    case "GOOGLE_FILE_NOT_FOUND":
      return {
        title: "This Google Doc could not be found",
        protection: DEFAULT_PROTECTION,
        retryable: false,
      };
    case "GOOGLE_PERMISSION_DENIED":
      return {
        title: "DocRelay cannot read this Google Doc",
        protection: DEFAULT_PROTECTION,
        retryable: true,
      };
    case "SOURCE_TRASHED":
      return {
        title: "This Google Doc is in the trash",
        protection: DEFAULT_PROTECTION,
        retryable: false,
      };
    case "SOURCE_CHANGED_DURING_CAPTURE":
      return {
        title: "This Google Doc changed while DocRelay was reading it",
        protection: DEFAULT_PROTECTION,
        retryable: true,
      };
    case "GOOGLE_REAUTH_REQUIRED":
      return {
        title: "Google Drive needs to be reconnected",
        protection: DEFAULT_PROTECTION,
        retryable: false,
      };
    case "GOOGLE_RATE_LIMITED":
    case "GOOGLE_UNAVAILABLE":
      return {
        title: "Google Drive is temporarily unavailable",
        protection: DEFAULT_PROTECTION,
        retryable: true,
      };
    default:
      return {
        title: "Could not read this Google Doc",
        protection: DEFAULT_PROTECTION,
        retryable: true,
      };
  }
}

export function mapPickerFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (
    normalized.includes("popup_closed") ||
    normalized.includes("popup was closed") ||
    normalized.includes("access_denied")
  ) {
    return null;
  }
  if (normalized.includes("failed to load") || normalized.includes("picker library")) {
    return "Google Drive could not be opened. Check your connection and try again.";
  }
  if (message.includes("Frontend Google configuration")) {
    return "Google Drive is not fully configured in this environment.";
  }
  return "Google Drive could not be opened. Try again.";
}
