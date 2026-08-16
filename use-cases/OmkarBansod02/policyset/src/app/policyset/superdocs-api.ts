import type { PolicyProfile } from "@/domain";
import type {
  SuperDocsJobView,
  SuperDocsReviewView,
  SuperDocsSessionDocumentView,
  SuperDocsWorkspaceSession,
} from "./superdocs-contract";

const API_ROOT = "/api/policyset/superdocs";

export async function initializeSuperDocsSession(
  profile: PolicyProfile,
  signal?: AbortSignal,
): Promise<SuperDocsWorkspaceSession> {
  return requestJson(`${API_ROOT}/session`, {
    method: "POST",
    body: JSON.stringify({ profile }),
    signal,
  });
}

export async function startSuperDocsEdit(
  input: {
    sessionId: string;
    documentId: string;
    instruction: string;
  },
  signal?: AbortSignal,
): Promise<SuperDocsJobView> {
  return requestJson(`${API_ROOT}/edit`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export async function getSuperDocsJob(
  input: { jobId: string; sessionId: string; documentId: string },
  signal?: AbortSignal,
): Promise<SuperDocsJobView> {
  const search = new URLSearchParams({
    sessionId: input.sessionId,
    documentId: input.documentId,
  });
  return requestJson(
    `${API_ROOT}/jobs/${encodeURIComponent(input.jobId)}?${search}`,
    { signal, cache: "no-store" },
  );
}

export async function submitSuperDocsReview(
  input: {
    jobId: string;
    sessionId: string;
    documentId: string;
    approved: boolean;
  },
  signal?: AbortSignal,
): Promise<SuperDocsReviewView> {
  return requestJson(`${API_ROOT}/review`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export async function refreshSuperDocsDocuments(
  sessionId: string,
  signal?: AbortSignal,
): Promise<readonly SuperDocsSessionDocumentView[]> {
  const search = new URLSearchParams({ sessionId });
  const response = await requestJson<{
    documents: readonly SuperDocsSessionDocumentView[];
  }>(`${API_ROOT}/session?${search}`, { signal, cache: "no-store" });
  return response.documents;
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "The SuperDocs request failed.";
    throw new Error(message);
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
