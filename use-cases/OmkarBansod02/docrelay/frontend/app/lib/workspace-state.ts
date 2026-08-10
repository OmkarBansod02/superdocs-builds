import type { DryRunView, GoogleConnection, ProposalView, RunView, SourceRegistration, WriteBackView } from "./api";

export type WorkflowStage = "source" | "edit" | "review" | "dry-run" | "complete";

export type WorkspaceState =
  | { stage: "source"; connection: GoogleConnection | null; loading: boolean }
  | {
      stage: "source-selected";
      connection: GoogleConnection;
      source: SourceRegistration;
    }
  | {
      stage: "edit";
      connection: GoogleConnection;
      source: SourceRegistration;
      submitting: boolean;
    }
  | {
      stage: "processing";
      connection: GoogleConnection;
      source: SourceRegistration;
      run: RunView;
    }
  | {
      stage: "review";
      connection: GoogleConnection;
      source: SourceRegistration;
      run: RunView;
      proposals: ProposalView[];
      decisions: Map<string, { approve: boolean; feedback?: string }>;
      submitting: boolean;
    }
  | {
      stage: "dry-run";
      connection: GoogleConnection;
      source: SourceRegistration;
      run: RunView;
      dryRun: DryRunView;
      writing: boolean;
    }
  | {
      stage: "unsupported";
      connection: GoogleConnection;
      source: SourceRegistration;
      run: RunView;
      dryRun: DryRunView;
    }
  | {
      stage: "write-result";
      connection: GoogleConnection;
      source: SourceRegistration;
      run: RunView;
      result: WriteBackView;
      deciding: boolean;
    }
  | {
      stage: "error";
      connection: GoogleConnection | null;
      source: SourceRegistration | null;
      run: RunView | null;
      message: string;
      recoverable: boolean;
    };

export function runNeedsPolling(state: string | undefined): boolean {
  if (!state) return false;
  return ["QUEUED", "BASELINING", "EDITING"].includes(state);
}

export function humanRunState(state: string): string {
  switch (state) {
    case "QUEUED": return "Queued";
    case "BASELINING": return "Capturing baseline";
    case "EDITING": return "SuperDocs is editing";
    case "AWAITING_REVIEW": return "Awaiting review";
    case "REVIEWED_EXPORT_READY": return "Export ready";
    case "FAILED": return "Failed";
    case "CANCELLED": return "Cancelled";
    default: return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
  }
}

export function attentionMessage(code: string | null): string | null {
  if (!code) return null;
  const messages: Record<string, string> = {
    SUPERDOCS_UPLOAD_OUTCOME_UNKNOWN: "SuperDocs upload status is uncertain. Retrying may help.",
    SUPERDOCS_UPLOAD_REJECTED: "SuperDocs rejected the document upload.",
    SUPERDOCS_JOB_START_OUTCOME_UNKNOWN: "SuperDocs edit job status is uncertain.",
    SUPERDOCS_JOB_START_REJECTED: "SuperDocs rejected the edit request.",
    SUPERDOCS_REVIEW_SUBMISSION_OUTCOME_UNKNOWN: "Review submission status is uncertain.",
    SUPERDOCS_REVIEW_SUBMISSION_REJECTED: "SuperDocs rejected the review decisions.",
    SUPERDOCS_JOB_FAILED: "The SuperDocs edit job failed.",
    SUPERDOCS_JOB_CANCELLED: "The SuperDocs edit job was cancelled.",
    SUPERDOCS_REVIEW_PAYLOAD_INVALID: "SuperDocs returned an invalid review payload.",
  };
  return messages[code] ?? `Attention required: ${code.replace(/_/g, " ").toLowerCase()}`;
}

export function humanDryRunFailure(reasonCode: string | null, reason: string | null): string {
  if (!reasonCode) return reason ?? "Unknown failure";
  const messages: Record<string, string> = {
    AMBIGUOUS_PREIMAGE: "The matching text appears more than once in the document.",
    STALE_LINEAGE: "The review lineage is no longer current.",
    STALE_SNAPSHOT: "The baseline snapshot does not match the current capture.",
    WRONG_REVISION: "The document revision has changed since the baseline.",
    NOT_APPROVED: "This proposal has not been approved.",
    UNDECIDED: "No review decision has been made for this proposal.",
    UNSUPPORTED_FORMATTING: "The document contains unsupported formatting.",
    UNSUPPORTED_STRUCTURE: "The document structure is not supported for safe write-back.",
    MULTIPLE_RUNS: "Multiple text runs found where exactly one was expected.",
    NO_BODY_MATCH: "No matching paragraph found in the document body.",
    EXISTING_PLAN_LINEAGE_MISMATCH: "An existing write plan has different inputs.",
  };
  return messages[reasonCode] ?? reason ?? reasonCode.replace(/_/g, " ").toLowerCase();
}
