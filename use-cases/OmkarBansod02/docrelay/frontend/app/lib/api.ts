const API_BASE = process.env.NEXT_PUBLIC_DOCRELAY_API_URL ?? "http://localhost:8000";

export type ConnectionStatus = "PENDING" | "CONNECTED" | "DISCONNECTED" | "REAUTH_REQUIRED" | "INVALID";

export interface GoogleConnection {
  connection_id: string;
  provider: "GOOGLE";
  status: ConnectionStatus;
  granted_scopes: string[];
  last_validated_at: string | null;
  disconnected_at: string | null;
}

export interface ConnectionsResponse {
  oauth_configured: boolean;
  selected_scopes: string[];
  connections: GoogleConnection[];
}

export interface SourceRegistration {
  source: {
    source_id: string;
    provider_file_id: string;
    name: string;
    mime_type: string;
    parent_ids: string[];
  };
  baseline: {
    capture_id: string;
    revision_id: string;
    native_canonical_sha256: string;
    docx_sha256: string;
    docx_size_bytes: number;
  };
}

export type SyncRunState =
  | "QUEUED"
  | "BASELINING"
  | "EDITING"
  | "AWAITING_REVIEW"
  | "REVIEWED_EXPORT_READY"
  | "READY_TO_COMMIT"
  | "PREVIEW_READY"
  | "COMMITTING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "SKIPPED"
  | "EXPIRED"
  | "COMMIT_OUTCOME_UNKNOWN"
  | "VERIFICATION_FAILED"
  | "FAILED"
  | "CANCELLED";

export interface ProposalView {
  proposal_id: string;
  review_round: number;
  change_id: string;
  operation: string;
  chunk_id: string | null;
  document_id: string;
  old_html: string | null;
  new_html: string | null;
  ai_explanation: string | null;
  replaces_proposal_id: string | null;
  decision: "APPROVE" | "REJECT" | null;
  feedback: string | null;
}

export interface ExportView {
  export_id: string;
  artifact_reference: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  content_disposition: string | null;
  warnings: Record<string, unknown>[];
  final_version_id: string | null;
  exported_at: string;
}

export interface RunView {
  run_id: string;
  source_id: string;
  provider_revision_id: string;
  state: SyncRunState;
  attention_code: string | null;
  session_id: string | null;
  session_document_id: string | null;
  durable_document_id: string | null;
  upload_version_id: string | null;
  final_version_id: string | null;
  provider_job_id: string | null;
  provider_job_status: string | null;
  awaiting_kind: string | null;
  pending_proposals: ProposalView[];
  export: ExportView | null;
  write_back: WriteBackRunSummary | null;
}

export interface WriteBackRunSummary {
  status: WriteBackStatus;
  backup_created: boolean;
  backup_verified: boolean;
  write_applied: boolean;
  structurally_verified: boolean;
  resulting_revision_id: string | null;
  conflict_detection_stage: string | null;
  conflict_decision: ConflictChoice | null;
}

export type DryRunStatus = "READY" | "UNSUPPORTED" | "AMBIGUOUS" | "STALE" | "NOT_APPROVED";

export interface DryRunSource {
  provider: "GOOGLE";
  file_id: string;
  baseline_revision_id: string;
  native_snapshot_sha256: string;
}

export interface DryRunView {
  run_id: string;
  proposal_id: string | null;
  status: DryRunStatus;
  source: DryRunSource | null;
  old_text: string | null;
  new_text: string | null;
  structural_location: Record<string, unknown> | null;
  operation_count: number;
  operation_types: string[];
  provider_operation: Record<string, unknown> | null;
  why_safe: string[];
  mapping_proof_id: string | null;
  mapping_proof_sha256: string | null;
  write_plan_id: string | null;
  write_plan_sha256: string | null;
  reason_code: string | null;
  reason: string | null;
  candidate_count: number | null;
  cloud_mutation_performed: false;
}

export type WriteBackStatus =
  | "READY"
  | "IN_PROGRESS"
  | "WRITE_VERIFIED"
  | "CONFLICT"
  | "ATTENTION"
  | "VERIFICATION_FAILED"
  | "FAILED"
  | "CANCELLED"
  | "REVIEW_LATEST";

export type ConflictChoice = "CANCEL" | "REVIEW_LATEST";

export interface WriteConflictView {
  baseline_revision_id: string;
  latest_revision_id: string | null;
  detection_stage: string;
  detected_at: string;
  backup_created: boolean;
  decision: ConflictChoice | null;
}

export interface WriteBackView {
  run_id: string;
  status: WriteBackStatus;
  write_plan_id: string;
  write_plan_sha256: string;
  backup_created: boolean;
  backup_verified: boolean;
  source_revision_verified: boolean;
  write_applied: boolean;
  structurally_verified: boolean;
  baseline_revision_id: string;
  resulting_revision_id: string | null;
  attention_code: string | null;
  conflict: WriteConflictView | null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ValidationIssue = {
  loc?: unknown;
  msg?: unknown;
  message?: unknown;
};

function formatValidationIssue(issue: ValidationIssue): string | null {
  const message = typeof issue.msg === "string"
    ? issue.msg
    : typeof issue.message === "string"
      ? issue.message
      : null;
  if (!message) return null;

  const location = Array.isArray(issue.loc)
    ? issue.loc.filter((part): part is string | number => typeof part === "string" || typeof part === "number").join(" → ")
    : "";
  return location ? `${location}: ${message}` : message;
}

export function formatApiError(body: unknown, status: number): string {
  if (typeof body === "string" && body.trim()) return body;
  if (!body || typeof body !== "object") return `Request failed (${status})`;

  const payload = body as {
    error?: { message?: unknown };
    detail?: unknown;
  };
  const configuredMessage = payload.error?.message;
  if (typeof configuredMessage === "string" && configuredMessage.trim()) return configuredMessage;
  if (typeof payload.detail === "string" && payload.detail.trim()) return payload.detail;
  if (Array.isArray(payload.detail)) {
    const issues = payload.detail
      .filter((item): item is ValidationIssue => Boolean(item) && typeof item === "object")
      .map(formatValidationIssue)
      .filter((message): message is string => message !== null);
    if (issues.length > 0) return issues.join("; ");
  }
  if (payload.detail && typeof payload.detail === "object") {
    const issue = formatValidationIssue(payload.detail as ValidationIssue);
    if (issue) return issue;
  }
  return `Request failed (${status})`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    throw new ApiError(
      res.status,
      typeof code === "string" ? code : "UNKNOWN",
      formatApiError(body, res.status),
    );
  }
  return res.json() as Promise<T>;
}

export function getConnections(signal?: AbortSignal): Promise<ConnectionsResponse> {
  return request<ConnectionsResponse>("/api/v1/google/connections", { signal, cache: "no-store" });
}

export function getAuthorizeUrl(): string {
  return `${API_BASE}/api/v1/google/oauth/authorize`;
}

export function registerSource(
  connectionId: string,
  fileId: string,
): Promise<SourceRegistration> {
  return request<SourceRegistration>(
    `/api/v1/google/connections/${connectionId}/sources`,
    { method: "POST", body: JSON.stringify({ file_id: fileId }) },
  );
}

export function startRun(payload: {
  source_id: string;
  baseline_capture_id: string;
  instruction: string;
}): Promise<RunView> {
  return request<RunView>("/api/v1/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunView> {
  return request<RunView>(`/api/v1/runs/${runId}`, { signal, cache: "no-store" });
}

export function resumeRun(runId: string): Promise<RunView> {
  return request<RunView>(`/api/v1/runs/${runId}/resume`, { method: "POST" });
}

export function submitDecisions(
  runId: string,
  decisions: { proposal_id: string; approve: boolean; feedback?: string | null }[],
): Promise<RunView> {
  if (typeof runId !== "string" || runId.trim() === "" || runId === "undefined") {
    throw new Error("The current run ID is unavailable; decisions were not submitted.");
  }
  return request<RunView>(`/api/v1/runs/${runId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
}

export function submitContinue(runId: string, shouldContinue: boolean): Promise<RunView> {
  return request<RunView>(`/api/v1/runs/${runId}/continue`, {
    method: "POST",
    body: JSON.stringify({ should_continue: shouldContinue }),
  });
}

export function createDryRun(runId: string, proposalId?: string): Promise<DryRunView> {
  return request<DryRunView>(`/api/v1/runs/${runId}/dry-run`, {
    method: "POST",
    body: proposalId ? JSON.stringify({ proposal_id: proposalId }) : "{}",
  });
}

export function writeBackSafely(runId: string): Promise<WriteBackView> {
  return request<WriteBackView>(`/api/v1/runs/${runId}/write-back`, {
    method: "POST",
  });
}

export function decideWriteConflict(
  runId: string,
  choice: ConflictChoice,
): Promise<WriteBackView> {
  return request<WriteBackView>(`/api/v1/runs/${runId}/conflict-decision`, {
    method: "POST",
    body: JSON.stringify({ choice }),
  });
}

export { ApiError };
