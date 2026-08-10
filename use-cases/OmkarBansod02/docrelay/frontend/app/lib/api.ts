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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? "UNKNOWN";
    const message = (body as { error?: { message?: string } } | null)?.error?.message
      ?? (body as { detail?: string } | null)?.detail
      ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, code, message);
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

export { ApiError };
