"use client";

import { useEffect, useRef, useState } from "react";
import {
  POLICY_DOCUMENT_TYPES,
  type PolicyDocumentType,
  type ValidationResult,
} from "@/domain";
import { DocumentPreview } from "./DocumentPreview";
import type { PolicyWorkspaceState } from "./generate-workspace";
import { PolicyFactsPanel } from "./PolicyFactsPanel";
import {
  getSuperDocsJob,
  initializeSuperDocsSession,
  refreshSuperDocsDocuments,
  startSuperDocsEdit,
  submitSuperDocsReview,
} from "./superdocs-api";
import type {
  SuperDocsJobView,
  SuperDocsWorkspaceSession,
} from "./superdocs-contract";
import { applyPolicyEditOutcome } from "./workspace-edit";

const TAB_LABELS: Record<PolicyDocumentType, string> = {
  terms: "Terms",
  privacy: "Privacy",
  warranty: "Warranty",
  returns: "Returns",
};

export function WorkspaceView({
  workspace,
  onWorkspaceChange,
  onEditIntake,
}: {
  workspace: PolicyWorkspaceState;
  onWorkspaceChange: (workspace: PolicyWorkspaceState) => void;
  onEditIntake: () => void;
}) {
  const [activeTab, setActiveTab] = useState<PolicyDocumentType>("terms");
  const [session, setSession] = useState<SuperDocsWorkspaceSession | null>(null);
  const [connectionState, setConnectionState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [editState, setEditState] = useState<EditState>({ stage: "idle" });
  const [superDocsDocuments, setSuperDocsDocuments] = useState<
    ReadonlySet<PolicyDocumentType>
  >(() => new Set());
  const operationControllersRef = useRef(new Set<AbortController>());
  const { profile, documents, validation } = workspace;
  const editBusy = isEditBusy(editState.stage);

  useEffect(() => {
    const controllers = operationControllersRef.current;
    return () => controllers.forEach((controller) => controller.abort());
  }, []);

  async function handleInitialize() {
    if (session || connectionState === "connecting") {
      return;
    }
    const controller = beginOperation(operationControllersRef.current);
    setConnectionState("connecting");
    setConnectionError(null);
    try {
      const initialized = await initializeSuperDocsSession(
        profile,
        controller.signal,
      );
      setSession(initialized);
      setConnectionState("connected");
    } catch (error) {
      if (!controller.signal.aborted) {
        setConnectionState("error");
        setConnectionError(errorMessage(error));
      }
    }
  }

  async function handleProposeEdit() {
    if (!session || !instruction.trim() || editBusy) {
      return;
    }
    const controller = beginOperation(operationControllersRef.current);
    const target: EditTarget = {
      documentType: activeTab,
      documentId: session.documentIds[activeTab],
    };
    setEditState({ stage: "submitting", target });

    try {
      const started = await startSuperDocsEdit(
        {
          sessionId: session.sessionId,
          documentId: target.documentId,
          instruction: instruction.trim(),
        },
        controller.signal,
      );
      setEditState({ stage: "processing", target, job: started });
      const reviewJob = await pollUntilReview(
        started,
        session,
        target,
        controller.signal,
        (job) => setEditState({ stage: "processing", target, job }),
      );

      if (reviewJob.status === "completed") {
        setEditState({
          stage: "completed",
          message: "SuperDocs completed without proposing changes.",
        });
        return;
      }
      setEditState({ stage: "awaiting_review", target, job: reviewJob });
    } catch (error) {
      if (!controller.signal.aborted) {
        setEditState({ stage: "error", message: errorMessage(error) });
      }
    }
  }

  async function handleReview(approved: boolean) {
    if (
      !session ||
      editState.stage !== "awaiting_review" ||
      editState.job.proposals.length === 0
    ) {
      return;
    }
    const { job, target } = editState;
    const controller = beginOperation(operationControllersRef.current);
    setEditState({
      stage: "applying",
      target,
      job,
      message: approved ? "Applying approved changes…" : "Rejecting changes…",
    });

    try {
      await submitSuperDocsReview(
        {
          sessionId: session.sessionId,
          jobId: job.jobId,
          documentId: target.documentId,
          approved,
        },
        controller.signal,
      );

      if (!approved) {
        onWorkspaceChange(
          applyPolicyEditOutcome(workspace, { kind: "rejected" }),
        );
        setEditState({ stage: "completed", message: "Changes rejected" });
        return;
      }

      await pollUntilCompleted(
        job,
        session,
        target,
        controller.signal,
        (nextJob) =>
          setEditState({
            stage: "applying",
            target,
            job: nextJob,
            message: "Applying approved changes…",
          }),
      );
      const authoritative = await refreshSuperDocsDocuments(
        session.sessionId,
        controller.signal,
      );
      const selectedDocument = authoritative.find(
        (document) => document.documentId === target.documentId,
      );
      if (!selectedDocument?.html) {
        throw new Error(
          "SuperDocs completed the edit but did not return HTML for the selected document.",
        );
      }

      onWorkspaceChange(
        applyPolicyEditOutcome(workspace, {
          kind: "approved",
          documentType: target.documentType,
          html: selectedDocument.html,
        }),
      );
      setSuperDocsDocuments(
        (current) => new Set([...current, target.documentType]),
      );
      setInstruction("");
      setEditState({
        stage: "completed",
        message: `${TAB_LABELS[target.documentType]} updated from SuperDocs`,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setEditState({ stage: "error", message: errorMessage(error) });
      }
    }
  }

  return (
    <div className="app-frame workspace">
      <header className="chrome workspace-chrome">
        <div className="chrome-identity">
          <p className="brand">Policy Set</p>
          <p className="chrome-subtitle">{profile.company.legalName}</p>
        </div>
        <div className="workspace-chrome-actions">
          <ConsistencyStatus validation={validation} />
          <button className="text-button" type="button" onClick={onEditIntake}>
            Edit intake
          </button>
        </div>
      </header>

      <div className="workspace-body">
        <section className="workspace-main" aria-label="Policy documents">
          <div className="document-tabs" role="tablist" aria-label="Documents">
            {POLICY_DOCUMENT_TYPES.map((documentType) => (
              <button
                key={documentType}
                type="button"
                role="tab"
                aria-selected={activeTab === documentType}
                className={
                  activeTab === documentType
                    ? "document-tab is-active"
                    : "document-tab"
                }
                disabled={editBusy}
                onClick={() => setActiveTab(documentType)}
              >
                {TAB_LABELS[documentType]}
              </button>
            ))}
          </div>

          <section className="ai-edit" aria-labelledby="ai-edit-heading">
            <div className="ai-edit-heading-row">
              <div>
                <h2 id="ai-edit-heading">AI Edit</h2>
                <p>
                  Language-only edits apply to the selected {TAB_LABELS[activeTab]} document.
                  Shared policy facts stay canonical and unchanged in Phase 4.
                </p>
              </div>
              <ConnectionStatus
                state={connectionState}
                error={connectionError}
              />
            </div>

            {session ? (
              <div className="ai-edit-controls">
                <label htmlFor="superdocs-instruction">
                  Tell SuperDocs what to change…
                </label>
                <textarea
                  id="superdocs-instruction"
                  rows={2}
                  value={instruction}
                  disabled={editBusy}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Make the warranty claim instructions clearer and more concise."
                />
                <button
                  className="primary-button"
                  type="button"
                  disabled={!instruction.trim() || editBusy}
                  onClick={handleProposeEdit}
                >
                  Propose edit
                </button>
              </div>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={connectionState === "connecting"}
                onClick={handleInitialize}
              >
                {connectionState === "connecting"
                  ? "Connecting…"
                  : "Start SuperDocs editing"}
              </button>
            )}

            <EditStatus
              state={editState}
              onApprove={() => handleReview(true)}
              onReject={() => handleReview(false)}
            />
          </section>

          <div className="document-stage" role="tabpanel">
            <DocumentPreview
              documentType={activeTab}
              html={documents[activeTab]}
              profile={profile}
              source={
                superDocsDocuments.has(activeTab)
                  ? "superdocs"
                  : "deterministic"
              }
            />
          </div>
        </section>

        <PolicyFactsPanel profile={profile} />
      </div>
    </div>
  );
}

type EditTarget = {
  documentType: PolicyDocumentType;
  documentId: string;
};

type EditState =
  | { stage: "idle" }
  | { stage: "submitting"; target: EditTarget }
  | { stage: "processing"; target: EditTarget; job: SuperDocsJobView }
  | { stage: "awaiting_review"; target: EditTarget; job: SuperDocsJobView }
  | {
      stage: "applying";
      target: EditTarget;
      job: SuperDocsJobView;
      message: string;
    }
  | { stage: "completed"; message: string }
  | { stage: "error"; message: string };

function ConnectionStatus({
  state,
  error,
}: {
  state: "idle" | "connecting" | "connected" | "error";
  error: string | null;
}) {
  if (state === "idle") {
    return <p className="connection-status">Not connected</p>;
  }
  if (state === "connecting") {
    return <p className="connection-status">Uploading four documents…</p>;
  }
  if (state === "connected") {
    return <p className="connection-status is-connected">● Connected</p>;
  }
  return <p className="connection-status is-error">{error}</p>;
}

function EditStatus({
  state,
  onApprove,
  onReject,
}: {
  state: EditState;
  onApprove: () => void;
  onReject: () => void;
}) {
  if (state.stage === "idle") {
    return null;
  }
  if (state.stage === "submitting") {
    return <p className="edit-message" role="status">Submitting edit…</p>;
  }
  if (state.stage === "processing") {
    return (
      <p className="edit-message" role="status">
        SuperDocs is preparing proposals
        {state.job.progress === null ? "…" : ` — ${state.job.progress}%`}
      </p>
    );
  }
  if (state.stage === "applying") {
    return <p className="edit-message" role="status">{state.message}</p>;
  }
  if (state.stage === "completed") {
    return <p className="edit-message is-success" role="status">{state.message}</p>;
  }
  if (state.stage === "error") {
    return <p className="edit-message is-error" role="alert">{state.message}</p>;
  }

  return (
    <div className="review-panel" aria-label="SuperDocs proposed changes">
      <div className="review-panel-heading">
        <div>
          <p className="review-eyebrow">Review required</p>
          <h3>{TAB_LABELS[state.target.documentType]} proposals</h3>
        </div>
        <span>{state.job.proposals.length} change{state.job.proposals.length === 1 ? "" : "s"}</span>
      </div>
      <div className="proposal-list">
        {state.job.proposals.map((proposal, index) => (
          <article className="proposal" key={proposal.changeId}>
            <p className="proposal-document">
              {TAB_LABELS[state.target.documentType]} · Change {index + 1}
            </p>
            <p className="proposal-explanation">
              {proposal.explanation || "SuperDocs proposed a language edit."}
            </p>
            <div className="proposal-comparison">
              <div>
                <h4>Before</h4>
                <p>{readableHtml(proposal.beforeHtml, "No previous text")}</p>
              </div>
              <div>
                <h4>After</h4>
                <p>{readableHtml(proposal.afterHtml, "Text removed")}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="review-actions">
        <button className="primary-button" type="button" onClick={onApprove}>
          Approve changes
        </button>
        <button className="secondary-button" type="button" onClick={onReject}>
          Reject changes
        </button>
      </div>
    </div>
  );
}

async function pollUntilReview(
  initialJob: SuperDocsJobView,
  session: SuperDocsWorkspaceSession,
  target: EditTarget,
  signal: AbortSignal,
  onProgress: (job: SuperDocsJobView) => void,
): Promise<SuperDocsJobView> {
  let job = initialJob;
  while (true) {
    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(jobFailureMessage(job));
    }
    if (job.status === "awaiting_approval" && job.proposals.length > 0) {
      return job;
    }
    await pollDelay(signal);
    job = await getSuperDocsJob(
      {
        jobId: job.jobId,
        sessionId: session.sessionId,
        documentId: target.documentId,
      },
      signal,
    );
    onProgress(job);
  }
}

async function pollUntilCompleted(
  initialJob: SuperDocsJobView,
  session: SuperDocsWorkspaceSession,
  target: EditTarget,
  signal: AbortSignal,
  onProgress: (job: SuperDocsJobView) => void,
): Promise<void> {
  let job = initialJob;
  while (job.status !== "completed") {
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(jobFailureMessage(job));
    }
    await pollDelay(signal);
    job = await getSuperDocsJob(
      {
        jobId: job.jobId,
        sessionId: session.sessionId,
        documentId: target.documentId,
      },
      signal,
    );
    onProgress(job);
  }
}

function beginOperation(controllers: Set<AbortController>): AbortController {
  controllers.forEach((controller) => controller.abort());
  controllers.clear();
  const controller = new AbortController();
  controllers.add(controller);
  return controller;
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, 1_500);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function isEditBusy(stage: EditState["stage"]): boolean {
  return (
    stage === "submitting" ||
    stage === "processing" ||
    stage === "awaiting_review" ||
    stage === "applying"
  );
}

function readableHtml(value: string | null, fallback: string): string {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function jobFailureMessage(job: SuperDocsJobView): string {
  return job.errorCode
    ? `SuperDocs could not complete the edit (${job.errorCode}).`
    : "SuperDocs could not complete the edit.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The SuperDocs operation could not be completed.";
}

function ConsistencyStatus({ validation }: { validation: ValidationResult }) {
  if (validation.ok) {
    return (
      <p className="status status-ok" role="status">
        ✓ Policy set consistent
      </p>
    );
  }

  return (
    <div className="status status-attention" role="status">
      <p>Policy set needs attention</p>
      <ul>
        {validation.issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
