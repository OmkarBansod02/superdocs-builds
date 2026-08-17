"use client";

import { useEffect, useRef, useState } from "react";
import {
  POLICY_DOCUMENT_TYPES,
  type ChangeSet,
  type PolicyDocumentType,
  type ValidationResult,
} from "@/domain";
import { DocumentPreview } from "./DocumentPreview";
import type { PolicyWorkspaceState } from "./generate-workspace";
import { PolicyFactsPanel } from "./PolicyFactsPanel";
import {
  getSuperDocsJob,
  getSuperDocsSynchronizedJob,
  initializeSuperDocsSession,
  refreshSuperDocsDocuments,
  startSuperDocsEdit,
  startSuperDocsSynchronizedChange,
  submitSuperDocsReview,
  submitSuperDocsSynchronizedReview,
} from "./superdocs-api";
import type {
  SuperDocsJobView,
  PolicyDocumentContentStateMap,
  SuperDocsTargetedJob,
  SuperDocsWorkspaceSession,
} from "./superdocs-contract";
import { applyPolicyEditOutcome } from "./workspace-edit";
import {
  approveSynchronizedChangeSet,
  commitValidatedSynchronizedChange,
  failSynchronizedChangeSet,
  proposeReturnWindowChangeSet,
  rejectSynchronizedChangeSet,
} from "./changeset-workflow";

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
  const [returnWindowInput, setReturnWindowInput] = useState(() =>
    String(workspace.profile.returns.windowDays),
  );
  const [synchronizedState, setSynchronizedState] =
    useState<SynchronizedState>({ stage: "idle" });
  const [superDocsDocuments, setSuperDocsDocuments] = useState<
    ReadonlySet<PolicyDocumentType>
  >(() => new Set());
  const operationControllersRef = useRef(new Set<AbortController>());
  const { profile, documents, validation } = workspace;
  const editBusy = isEditBusy(editState.stage);
  const synchronizedBusy = isSynchronizedBusy(synchronizedState.stage);
  const operationBusy = editBusy || synchronizedBusy;

  useEffect(() => {
    const controllers = operationControllersRef.current;
    return () => controllers.forEach((controller) => controller.abort());
  }, []);

  async function ensureSession(
    signal: AbortSignal,
  ): Promise<SuperDocsWorkspaceSession> {
    if (session) {
      return session;
    }
    setConnectionState("connecting");
    setConnectionError(null);
    try {
      const initialized = await initializeSuperDocsSession(profile, signal);
      setSession(initialized);
      setConnectionState("connected");
      return initialized;
    } catch (error) {
      if (!signal.aborted) {
        setConnectionState("error");
        setConnectionError(errorMessage(error));
      }
      throw error;
    }
  }

  async function handleInitialize() {
    if (session || connectionState === "connecting") {
      return;
    }
    const controller = beginOperation(operationControllersRef.current);
    try {
      await ensureSession(controller.signal);
    } catch {}
  }

  async function handleProposeEdit() {
    if (!session || !instruction.trim() || operationBusy) {
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

  async function handleProposeSynchronizedUpdate() {
    if (operationBusy) {
      return;
    }
    const nextValue = Number(returnWindowInput);
    const proposed = proposeReturnWindowChangeSet(workspace, nextValue);
    if (!proposed.ok) {
      setSynchronizedState({
        stage: "error",
        message: proposed.error.message,
      });
      return;
    }

    const changeSet = proposed.value;
    const controller = beginOperation(operationControllersRef.current);
    setSynchronizedState({ stage: "preparing", changeSet });

    try {
      const currentSession = await ensureSession(controller.signal);
      const started = await startSuperDocsSynchronizedChange(
        {
          sessionId: currentSession.sessionId,
          documentIds: currentSession.documentIds,
          changeSet,
        },
        controller.signal,
      );
      setSynchronizedState({
        stage: "processing",
        changeSet,
        preEditState: started.preEditState,
        jobs: started.jobs,
      });

      // Poll every targeted job independently. Each job's own gate
      // (targeting safety + managed-fact coverage) runs server-side the
      // moment that job reaches awaiting_approval, so a rejection here means
      // that one document's batch was already denied.
      const settled = await Promise.allSettled(
        started.jobs.map((targeted) =>
          pollUntilTargetedSynchronizedReview(
            targeted.job,
            currentSession,
            targeted.documentType,
            changeSet,
            controller.signal,
            (nextJob) =>
              setSynchronizedState((current) =>
                withUpdatedJob(current, targeted.documentType, nextJob),
              ),
          ).then((job): SuperDocsTargetedJob => ({
            documentType: targeted.documentType,
            job,
          })),
        ),
      );

      const fulfilled = settled
        .filter(
          (result): result is PromiseFulfilledResult<SuperDocsTargetedJob> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);
      const rejectedIndex = settled.findIndex(
        (result) => result.status === "rejected",
      );

      if (rejectedIndex !== -1) {
        // At least one document's batch failed its own gate (or the job
        // itself failed). Deny every OTHER job that reached awaiting_review
        // with a passing gate — the synchronized ChangeSet is unsafe as a
        // whole even though that job's own batch was individually fine.
        await denyAwaitingJobs(
          fulfilled,
          currentSession,
          changeSet,
          controller.signal,
        );
        const failedDocumentType = started.jobs[rejectedIndex]?.documentType;
        const reason = (settled[rejectedIndex] as PromiseRejectedResult)
          .reason;
        markSynchronizedFailed(
          changeSet,
          `${failedDocumentType ? `${TAB_LABELS[failedDocumentType]}: ` : ""}${errorMessage(reason)}`,
        );
        return;
      }

      const emptyBatch = fulfilled.find(
        (targeted) => targeted.job.status === "completed",
      );
      if (emptyBatch) {
        await denyAwaitingJobs(
          fulfilled.filter((targeted) => targeted !== emptyBatch),
          currentSession,
          changeSet,
          controller.signal,
        );
        markSynchronizedFailed(
          changeSet,
          `SuperDocs completed the ${TAB_LABELS[emptyBatch.documentType]} job without a reviewable proposal. The canonical return window remains unchanged.`,
        );
        return;
      }

      setSynchronizedState({
        stage: "awaiting_review",
        changeSet,
        preEditState: started.preEditState,
        jobs: fulfilled,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        markSynchronizedFailed(changeSet, errorMessage(error));
      }
    }
  }

  async function handleSynchronizedReview(approved: boolean) {
    if (
      !session ||
      synchronizedState.stage !== "awaiting_review" ||
      synchronizedState.jobs.some((targeted) => targeted.job.proposals.length === 0)
    ) {
      return;
    }
    const { changeSet, jobs, preEditState } = synchronizedState;
    const controller = beginOperation(operationControllersRef.current);
    setSynchronizedState({
      stage: "applying",
      changeSet,
      preEditState,
      jobs,
      message: approved
        ? "Applying the approved synchronized update…"
        : "Rejecting every proposed change across both jobs…",
    });

    try {
      // Submit the same decision for every targeted job's own pending
      // changes. These are two independent SuperDocs jobs, not one atomic
      // transaction, so track each submission's outcome separately.
      const decisions = await Promise.allSettled(
        jobs.map((targeted) =>
          submitSuperDocsSynchronizedReview(
            {
              sessionId: session.sessionId,
              jobId: targeted.job.jobId,
              documentType: targeted.documentType,
              documentIds: session.documentIds,
              changeSet,
              approved,
            },
            controller.signal,
          ),
        ),
      );

      if (!approved) {
        const rejected = rejectSynchronizedChangeSet(workspace, changeSet);
        if (!rejected.ok) {
          throw new Error(rejected.error.message);
        }
        setSynchronizedState({
          stage: "rejected",
          changeSet: rejected.value.changeSet,
          message:
            "Update rejected. Every proposal was denied across both jobs and the canonical return window remains unchanged.",
        });
        return;
      }

      const decisionFailure = decisions.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (decisionFailure) {
        throw new Error(
          `Approval could not be submitted for one document's SuperDocs job (${errorMessage(decisionFailure.reason)}). This is a partial-apply condition: nothing was committed, but the other document's job may already have applied its edit and could require manual recovery.`,
        );
      }

      const approvedChangeSet = approveSynchronizedChangeSet(changeSet);
      if (!approvedChangeSet.ok) {
        throw new Error(approvedChangeSet.error.message);
      }
      const approvedValue = approvedChangeSet.value;

      const completions = await Promise.allSettled(
        jobs.map((targeted) =>
          pollUntilTargetedSynchronizedCompleted(
            targeted.job,
            session,
            targeted.documentType,
            approvedValue,
            controller.signal,
          ),
        ),
      );
      const completionFailureIndex = completions.findIndex(
        (result) => result.status === "rejected",
      );
      if (completionFailureIndex !== -1) {
        const failedDocumentType = jobs[completionFailureIndex]?.documentType;
        const reason = (
          completions[completionFailureIndex] as PromiseRejectedResult
        ).reason;
        throw new Error(
          `SuperDocs did not finish applying the approved update${failedDocumentType ? ` for ${TAB_LABELS[failedDocumentType]}` : ""} (${errorMessage(reason)}). This is a partial-apply condition: two SuperDocs jobs are not one atomic transaction, so the other document's edit may already be applied. Nothing was committed to the canonical PolicyProfile; document state may require manual recovery.`,
        );
      }

      const authoritative = await refreshSuperDocsDocuments(
        session.sessionId,
        controller.signal,
      );
      const completed = commitValidatedSynchronizedChange(
        workspace,
        approvedValue,
        preEditState,
        authoritative,
        session.documentIds,
      );
      if (!completed.ok) {
        markSynchronizedFailed(approvedValue, completed.error.message);
        return;
      }

      onWorkspaceChange(completed.value.workspace);
      setSuperDocsDocuments(
        (current) =>
          new Set([
            ...current,
            ...completed.value.changeSet.affectedDocuments,
          ]),
      );
      setReturnWindowInput(
        String(completed.value.workspace.profile.returns.windowDays),
      );
      setSynchronizedState({
        stage: "synchronized",
        changeSet: completed.value.changeSet,
        unchangedDocuments: completed.value.unchangedDocuments,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        markSynchronizedFailed(changeSet, errorMessage(error));
      }
    }
  }

  function markSynchronizedFailed(
    changeSet: ChangeSet,
    message: string,
  ) {
    const failed = failSynchronizedChangeSet(workspace, changeSet);
    setSynchronizedState({
      stage: "failed",
      changeSet: failed.ok ? failed.value.changeSet : changeSet,
      message,
    });
  }

  async function denyAwaitingJobs(
    jobs: readonly SuperDocsTargetedJob[],
    currentSession: SuperDocsWorkspaceSession,
    changeSet: ChangeSet,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled(
      jobs
        .filter(
          (targeted) =>
            targeted.job.status === "awaiting_approval" &&
            targeted.job.proposals.length > 0,
        )
        .map((targeted) =>
          submitSuperDocsSynchronizedReview(
            {
              sessionId: currentSession.sessionId,
              jobId: targeted.job.jobId,
              documentType: targeted.documentType,
              documentIds: currentSession.documentIds,
              changeSet,
              approved: false,
            },
            signal,
          ),
        ),
    );
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
                disabled={operationBusy}
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
                  Use Policy Facts for synchronized managed-fact changes.
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
                  disabled={operationBusy}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Make the warranty claim instructions clearer and more concise."
                />
                <button
                  className="primary-button"
                  type="button"
                  disabled={!instruction.trim() || operationBusy}
                  onClick={handleProposeEdit}
                >
                  Propose edit
                </button>
              </div>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={connectionState === "connecting" || operationBusy}
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
            <SynchronizedChangeStatus
              state={synchronizedState}
              session={session}
              onApprove={() => handleSynchronizedReview(true)}
              onReject={() => handleSynchronizedReview(false)}
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

        <PolicyFactsPanel
          profile={profile}
          returnWindowInput={returnWindowInput}
          activeChangeSet={activeSynchronizedChangeSet(synchronizedState)}
          disabled={operationBusy}
          onReturnWindowInputChange={setReturnWindowInput}
          onProposeReturnWindow={handleProposeSynchronizedUpdate}
        />
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

type SynchronizedState =
  | { stage: "idle" }
  | { stage: "error"; message: string }
  | { stage: "preparing"; changeSet: ChangeSet }
  | {
      stage: "processing";
      changeSet: ChangeSet;
      preEditState: PolicyDocumentContentStateMap;
      jobs: readonly SuperDocsTargetedJob[];
    }
  | {
      stage: "awaiting_review";
      changeSet: ChangeSet;
      preEditState: PolicyDocumentContentStateMap;
      jobs: readonly SuperDocsTargetedJob[];
    }
  | {
      stage: "applying";
      changeSet: ChangeSet;
      preEditState: PolicyDocumentContentStateMap;
      jobs: readonly SuperDocsTargetedJob[];
      message: string;
    }
  | { stage: "rejected"; changeSet: ChangeSet; message: string }
  | { stage: "failed"; changeSet: ChangeSet; message: string }
  | {
      stage: "synchronized";
      changeSet: ChangeSet;
      unchangedDocuments: readonly PolicyDocumentType[];
    };

/** Replaces one job's entry within a "processing"-stage jobs array. No-op for any other stage. */
function withUpdatedJob(
  state: SynchronizedState,
  documentType: PolicyDocumentType,
  nextJob: SuperDocsJobView,
): SynchronizedState {
  if (state.stage !== "processing") {
    return state;
  }
  return {
    ...state,
    jobs: state.jobs.map((targeted) =>
      targeted.documentType === documentType
        ? { documentType, job: nextJob }
        : targeted,
    ),
  };
}

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

function SynchronizedChangeStatus({
  state,
  session,
  onApprove,
  onReject,
}: {
  state: SynchronizedState;
  session: SuperDocsWorkspaceSession | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  if (state.stage === "idle") {
    return null;
  }
  if (state.stage === "error") {
    return <p className="edit-message is-error" role="alert">{state.message}</p>;
  }
  if (state.stage === "preparing") {
    return (
      <p className="edit-message" role="status">
        Capturing the authoritative four-document state…
      </p>
    );
  }
  if (state.stage === "processing") {
    return (
      <p className="edit-message" role="status">
        SuperDocs is preparing synchronized proposals for{" "}
        {state.jobs
          .map(
            (targeted) =>
              `${TAB_LABELS[targeted.documentType]}${targeted.job.progress === null ? "" : ` (${targeted.job.progress}%)`}`,
          )
          .join(", ")}
        …
      </p>
    );
  }
  if (state.stage === "applying") {
    return <p className="edit-message" role="status">{state.message}</p>;
  }
  if (state.stage === "failed") {
    return (
      <div className="edit-message is-error" role="alert">
        <strong>Synchronized update blocked.</strong> {state.message}
        <p>Nothing was committed. Review the proposal scope and document consistency before trying again.</p>
      </div>
    );
  }
  if (state.stage === "rejected") {
    return <p className="edit-message" role="status">{state.message}</p>;
  }
  if (state.stage === "synchronized") {
    return (
      <div className="sync-success" role="status">
        <strong>Synchronized</strong>
        {state.changeSet.affectedDocuments.map((documentType) => (
          <span key={documentType}>{TAB_LABELS[documentType]} updated</span>
        ))}
        {state.unchangedDocuments.map((documentType) => (
          <span key={documentType}>{TAB_LABELS[documentType]} unchanged</span>
        ))}
        <span>Return window: {String(state.changeSet.nextValue)} days</span>
      </div>
    );
  }

  if (!session) {
    return (
      <p className="edit-message is-error" role="alert">
        The SuperDocs session is no longer available. Nothing was approved.
      </p>
    );
  }

  const totalProposals = state.jobs.reduce(
    (sum, targeted) => sum + targeted.job.proposals.length,
    0,
  );

  return (
    <div className="review-panel synchronized-review" aria-label="Synchronized proposed changes">
      <div className="review-panel-heading">
        <div>
          <p className="review-eyebrow">Review required</p>
          <h3>Canonical fact: Return window</h3>
          <p className="canonical-change">
            {String(state.changeSet.previousValue)} → {String(state.changeSet.nextValue)} days
          </p>
        </div>
        <span>{totalProposals} change{totalProposals === 1 ? "" : "s"}</span>
      </div>
      <div className="proposal-groups">
        {state.changeSet.affectedDocuments.map((documentType) => {
          const proposals =
            state.jobs.find((targeted) => targeted.documentType === documentType)
              ?.job.proposals ?? [];
          return (
            <section className="proposal-group" key={documentType}>
              <h4>{TAB_LABELS[documentType]}</h4>
              <div className="proposal-list">
                {proposals.map((proposal, index) => (
                  <article className="proposal" key={proposal.changeId}>
                    <p className="proposal-document">
                      {TAB_LABELS[documentType]} · Change {index + 1}
                    </p>
                    <p className="proposal-explanation">
                      {proposal.explanation || "SuperDocs proposed the managed return-window update."}
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
            </section>
          );
        })}
      </div>
      <div className="review-actions">
        <button className="primary-button" type="button" onClick={onApprove}>
          Approve synchronized update
        </button>
        <button className="secondary-button" type="button" onClick={onReject}>
          Reject update
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

/**
 * Polls one targeted (pinned) synchronized job for that document. When the
 * server response reports `awaiting_approval` with proposals, PolicySet's
 * server-side gate for that document has already run (and passed) inside
 * `getPolicyTargetedSynchronizedJob` — a gate failure surfaces here as a
 * rejected fetch, which this function lets propagate to the caller.
 */
async function pollUntilTargetedSynchronizedReview(
  initialJob: SuperDocsJobView,
  session: SuperDocsWorkspaceSession,
  documentType: PolicyDocumentType,
  changeSet: ChangeSet,
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
    job = await getSuperDocsSynchronizedJob(
      {
        jobId: job.jobId,
        sessionId: session.sessionId,
        documentType,
        documentIds: session.documentIds,
        changeSet,
      },
      signal,
    );
    onProgress(job);
  }
}

async function pollUntilTargetedSynchronizedCompleted(
  initialJob: SuperDocsJobView,
  session: SuperDocsWorkspaceSession,
  documentType: PolicyDocumentType,
  changeSet: ChangeSet,
  signal: AbortSignal,
): Promise<void> {
  let job = initialJob;
  while (job.status !== "completed") {
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(jobFailureMessage(job));
    }
    await pollDelay(signal);
    job = await getSuperDocsSynchronizedJob(
      {
        jobId: job.jobId,
        sessionId: session.sessionId,
        documentType,
        documentIds: session.documentIds,
        changeSet,
      },
      signal,
    );
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

function isSynchronizedBusy(stage: SynchronizedState["stage"]): boolean {
  return (
    stage === "preparing" ||
    stage === "processing" ||
    stage === "awaiting_review" ||
    stage === "applying"
  );
}

function activeSynchronizedChangeSet(
  state: SynchronizedState,
): ChangeSet | null {
  return "changeSet" in state ? state.changeSet : null;
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
