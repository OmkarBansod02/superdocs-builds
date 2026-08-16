import type { PolicyDocumentType } from "@/domain";

export type SuperDocsWorkspaceSession = {
  sessionId: string;
  documentIds: Record<PolicyDocumentType, string>;
};

export type SuperDocsProposal = {
  changeId: string;
  operation: "edit" | "create" | "delete";
  documentId: string;
  beforeHtml: string | null;
  afterHtml: string | null;
  explanation: string | null;
};

export type SuperDocsJobView = {
  jobId: string;
  sessionId: string;
  status:
    | "pending"
    | "in_progress"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number | null;
  proposals: readonly SuperDocsProposal[];
  errorCode: string | null;
};

export type SuperDocsSessionDocumentView = {
  documentId: string;
  title: string | null;
  html: string | null;
};

export type SuperDocsReviewView = {
  status: string;
  batchComplete: boolean;
  decisionCount: number;
};
