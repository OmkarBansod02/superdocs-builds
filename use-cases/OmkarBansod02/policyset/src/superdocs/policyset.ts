import type { PolicyDocumentType, PolicyProfile } from "@/domain";
import { generatePolicyDocuments } from "@/documents";
import type {
  SuperDocsJobView,
  SuperDocsProposal,
  SuperDocsReviewView,
  SuperDocsSessionDocumentView,
  SuperDocsWorkspaceSession,
} from "@/app/policyset/superdocs-contract";

import { SuperDocsClient, createSessionId } from "./client";
import { getSuperDocsApiKey } from "./config";
import type { JobSnapshot, PendingChange } from "./types";

type PolicySetSuperDocsClient = Pick<
  SuperDocsClient,
  | "uploadDocx"
  | "startChat"
  | "getJob"
  | "submitReview"
  | "listSessionDocuments"
>;

export class PolicySetSuperDocsSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicySetSuperDocsSafetyError";
  }
}

export function createPolicySetSuperDocsClient(): SuperDocsClient {
  return new SuperDocsClient({ apiKey: getSuperDocsApiKey() });
}

export async function initializePolicySetSession(
  profile: PolicyProfile,
  client: PolicySetSuperDocsClient = createPolicySetSuperDocsClient(),
  sessionId = createSessionId(),
): Promise<SuperDocsWorkspaceSession> {
  const generated = await generatePolicyDocuments(profile);
  const documentIds = {} as Record<PolicyDocumentType, string>;

  for (const document of generated.documents) {
    const uploaded = await client.uploadDocx({
      sessionId,
      filename: document.filename,
      bytes: document.bytes,
      openMode: document.documentType === "terms" ? "replace" : "background",
    });
    documentIds[document.documentType] = uploaded.identity.documentId;
  }

  return { sessionId, documentIds };
}

export async function startPolicyDocumentEdit(
  input: {
    sessionId: string;
    documentId: string;
    instruction: string;
  },
  client: PolicySetSuperDocsClient = createPolicySetSuperDocsClient(),
): Promise<SuperDocsJobView> {
  const reference = await client.startChat({
    sessionId: input.sessionId,
    message: input.instruction,
    documentId: input.documentId,
  });
  if (reference.sessionId !== input.sessionId) {
    throw new PolicySetSuperDocsSafetyError(
      "SuperDocs returned an edit job for a different session.",
    );
  }

  return {
    jobId: reference.jobId,
    sessionId: reference.sessionId,
    status: reference.status,
    progress: null,
    proposals: [],
    errorCode: null,
  };
}

export async function getPolicyDocumentEditJob(
  input: { jobId: string; sessionId: string; selectedDocumentId: string },
  client: PolicySetSuperDocsClient = createPolicySetSuperDocsClient(),
): Promise<SuperDocsJobView> {
  const snapshot = await client.getJob(input.jobId);
  assertJobSession(snapshot, input.sessionId);
  assertPendingChangesTargetDocument(
    snapshot.pendingChanges,
    input.selectedDocumentId,
  );
  return jobView(snapshot);
}

export async function submitPolicyDocumentReview(
  input: {
    jobId: string;
    sessionId: string;
    selectedDocumentId: string;
    approved: boolean;
  },
  client: PolicySetSuperDocsClient = createPolicySetSuperDocsClient(),
): Promise<SuperDocsReviewView> {
  const snapshot = await client.getJob(input.jobId);
  assertJobSession(snapshot, input.sessionId);
  if (snapshot.reference.status !== "awaiting_approval") {
    throw new PolicySetSuperDocsSafetyError(
      "This SuperDocs job is not awaiting a review decision.",
    );
  }
  if (snapshot.pendingChanges.length === 0) {
    throw new PolicySetSuperDocsSafetyError(
      "SuperDocs has not provided a reviewable change batch yet.",
    );
  }
  assertPendingChangesTargetDocument(
    snapshot.pendingChanges,
    input.selectedDocumentId,
  );

  const decisions = snapshot.pendingChanges.map((change) => ({
    changeId: change.changeId,
    approved: input.approved,
  }));
  const receipt = await client.submitReview({
    sessionId: input.sessionId,
    jobId: input.jobId,
    decisions,
  });

  return { ...receipt, decisionCount: decisions.length };
}

export async function getPolicySetSessionDocuments(
  sessionId: string,
  client: PolicySetSuperDocsClient = createPolicySetSuperDocsClient(),
): Promise<readonly SuperDocsSessionDocumentView[]> {
  const documents = await client.listSessionDocuments(sessionId, {
    includeHtml: true,
  });
  return documents.map((document) => ({
    documentId: document.identity.documentId,
    title: document.title,
    html: document.html,
  }));
}

export function assertPendingChangesTargetDocument(
  pendingChanges: readonly Pick<PendingChange, "documentId">[],
  selectedDocumentId: string,
): void {
  if (!selectedDocumentId) {
    throw new PolicySetSuperDocsSafetyError(
      "The selected PolicySet document is missing its SuperDocs identity.",
    );
  }
  const foreign = pendingChanges.find(
    (change) => change.documentId !== selectedDocumentId,
  );
  if (foreign) {
    throw new PolicySetSuperDocsSafetyError(
      "SuperDocs proposed a change to another PolicySet document. Nothing was approved; select the intended document and try again.",
    );
  }
}

function assertJobSession(snapshot: JobSnapshot, sessionId: string): void {
  if (snapshot.reference.sessionId !== sessionId) {
    throw new PolicySetSuperDocsSafetyError(
      "SuperDocs returned a job for a different PolicySet session.",
    );
  }
}

function jobView(snapshot: JobSnapshot): SuperDocsJobView {
  return {
    jobId: snapshot.reference.jobId,
    sessionId: snapshot.reference.sessionId,
    status: snapshot.reference.status,
    progress: snapshot.progress,
    proposals: snapshot.pendingChanges.map(proposalView),
    errorCode: snapshot.errorCode,
  };
}

function proposalView(change: PendingChange): SuperDocsProposal {
  return {
    changeId: change.changeId,
    operation: change.operation,
    documentId: change.documentId,
    beforeHtml: change.oldHtml,
    afterHtml: change.newHtml,
    explanation: change.aiExplanation,
  };
}
