"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConflictChoice,
  DryRunView,
  GoogleConnection,
  RunView,
  SourceRegistration,
} from "../lib/api";
import {
  createDryRun,
  getRun,
  listRuns,
  registerSource,
  resumeRun,
  startRun,
  submitDecisions,
  decideWriteConflict,
  writeBackSafely,
} from "../lib/api";
import {
  NEW_DOCUMENT_EVENT,
  OPEN_RECENT_DOCUMENT_EVENT,
  acceptInstruction,
  appendPendingInstruction,
  documentReviewMarks,
  documentConversationFromRuns,
  failInstruction,
  frozenPreviewBlocks,
  peekQueuedRecentDocument,
  recordVerifiedWrite,
  setActiveDocumentId,
  startRunRequest,
  takeQueuedRecentDocument,
  workbenchSource,
  workbenchStateLabel,
  type RecentDocumentSelection,
  type UserInstructionTurn,
} from "../lib/conversation";
import { mapImportFailure, type SelectedDriveFile } from "../lib/import-state";
import {
  buildReviewDecisionSubmission,
  routeRun,
  runNeedsPolling,
} from "../lib/workspace-state";
import { canWriteBack, isVerifiedWriteSuccess } from "../lib/write-back-state";
import type { WorkspaceState } from "../lib/workspace-state";

import { SourceChooser } from "./source-chooser";
import { ImportingDocument } from "./importing-document";
import { DocumentWorkbench } from "./document-workbench";
import { ConversationPanel } from "./conversation-panel";
import { extractText } from "./diff-view";
import { MotionPanel } from "./motion-panel";
import { ErrorState } from "./error-state";
import {
  ConversationErrorEvent,
  DocRelayEvent,
  DryRunEvent,
  ProcessingEvent,
  ReviewEvent,
  UnsupportedEvent,
  WriteResultEvent,
} from "./conversation-events";

const POLL_INTERVAL_MS = 4000;
type WorkspaceStateUpdate = WorkspaceState | ((current: WorkspaceState) => WorkspaceState);

type ReopenThreadState = {
  file: RecentDocumentSelection;
  historyLoading: boolean;
  activeRunLoading: boolean;
  historyError: string | null;
  sourceError: ReturnType<typeof mapImportFailure> | null;
  canContinue: boolean;
};

export function Workspace() {
  const stateRef = useRef<WorkspaceState>({
    stage: "source",
    connection: null,
    loading: true,
  });
  const [state, setState] = useState<WorkspaceState>(stateRef.current);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const writeInFlightRef = useRef(false);
  const importAbortRef = useRef<AbortController | null>(null);
  const reopenRequestRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [conversation, setConversation] = useState<UserInstructionTurn[]>([]);
  const [reopenThread, setReopenThread] = useState<ReopenThreadState | null>(null);

  const setWorkspaceState = useCallback((update: WorkspaceStateUpdate): WorkspaceState => {
    const next = typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopPolling();
    importAbortRef.current?.abort();
  }, [stopPolling]);

  const processRun = useCallback(
    async (conn: GoogleConnection, source: SourceRegistration, run: RunView) => {
      stopPolling();
      const result = routeRun(conn, source, run);

      if (result === "dry-run-needed") {
        try {
          const dryRunResult = await createDryRun(run.run_id);
          if (dryRunResult.status === "READY") {
            setWorkspaceState({ stage: "dry-run", connection: conn, source, run, dryRun: dryRunResult, writing: false });
          } else {
            setWorkspaceState({ stage: "unsupported", connection: conn, source, run, dryRun: dryRunResult });
          }
        } catch (err) {
          setWorkspaceState({
            stage: "error",
            connection: conn,
            source,
            run,
            message: err instanceof Error ? err.message : "Dry run failed",
            recoverable: true,
          });
        }
        return;
      }

      setWorkspaceState(result);

      if (result.stage === "processing" && runNeedsPolling(run.state) && !run.provider_read_error) {
        const poll = setInterval(async () => {
          try {
            const updated = await resumeRun(run.run_id);
            const nextResult = routeRun(conn, source, updated);

            if (nextResult === "dry-run-needed") {
              clearInterval(poll);
              pollRef.current = null;
              try {
                const dryRunResult = await createDryRun(updated.run_id);
                if (dryRunResult.status === "READY") {
                  setWorkspaceState({ stage: "dry-run", connection: conn, source, run: updated, dryRun: dryRunResult, writing: false });
                } else {
                  setWorkspaceState({ stage: "unsupported", connection: conn, source, run: updated, dryRun: dryRunResult });
                }
              } catch (err) {
                setWorkspaceState({
                  stage: "error",
                  connection: conn,
                  source,
                  run: updated,
                  message: err instanceof Error ? err.message : "Dry run failed",
                  recoverable: true,
                });
              }
              return;
            }

            if (nextResult.stage !== "processing") {
              clearInterval(poll);
              pollRef.current = null;
            }
            setWorkspaceState(nextResult);
          } catch {
            // silently retry on next interval
          }
        }, POLL_INTERVAL_MS);
        pollRef.current = poll;
      }
    },
    [setWorkspaceState, stopPolling],
  );

  const handleCheckProviderStatus = useCallback(async () => {
    const current = stateRef.current;
    if (current.stage !== "processing") return;
    const updated = await resumeRun(current.run.run_id);
    await processRun(current.connection, current.source, updated);
  }, [processRun]);

  const beginImport = useCallback(
    (conn: GoogleConnection, file: SelectedDriveFile) => {
      importAbortRef.current?.abort();
      const controller = new AbortController();
      importAbortRef.current = controller;
      setReopenThread(null);
      setWorkspaceState({
        stage: "importing",
        connection: conn,
        selectedFile: file,
        error: null,
      });

      void (async () => {
        try {
          const source = await registerSource(conn.connection_id, file.fileId, controller.signal);
          if (controller.signal.aborted) return;
          setWorkspaceState({ stage: "edit", connection: conn, source, submitting: false });
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          setWorkspaceState({
            stage: "importing",
            connection: conn,
            selectedFile: file,
            error: mapImportFailure(err),
          });
        }
      })();
    },
    [setWorkspaceState],
  );

  const reopenRecent = useCallback((conn: GoogleConnection, file: RecentDocumentSelection) => {
    stopPolling();
    importAbortRef.current?.abort();
    const controller = new AbortController();
    importAbortRef.current = controller;
    const requestId = reopenRequestRef.current + 1;
    reopenRequestRef.current = requestId;
    const selectedFile = {
      fileId: file.fileId,
      name: file.name,
      mimeType: file.mimeType || "application/vnd.google-apps.document",
    };

    setDraft("");
    setConversation([]);
    setReopenThread({
      file,
      historyLoading: true,
      activeRunLoading: false,
      historyError: null,
      sourceError: null,
      canContinue: false,
    });
    setWorkspaceState({ stage: "importing", connection: conn, selectedFile, error: null });

    let currentSource: SourceRegistration | null = null;
    let history: ReturnType<typeof documentConversationFromRuns> | null = null;
    let activeRunPromise: Promise<RunView> | null = null;

    const isCurrentRequest = () => (
      !controller.signal.aborted && reopenRequestRef.current === requestId
    );
    const activatePersistedRun = async () => {
      if (!currentSource || !history || !isCurrentRequest()) return;
      if (!history.activeRunId) {
        setWorkspaceState({ stage: "edit", connection: conn, source: currentSource, submitting: false });
        return;
      }
      activeRunPromise ??= getRun(history.activeRunId, controller.signal);
      setReopenThread((thread) => thread?.file.fileId === file.fileId
        ? { ...thread, activeRunLoading: true }
        : thread);
      try {
        const activeRun = await activeRunPromise;
        if (!isCurrentRequest()) return;
        setReopenThread((thread) => thread?.file.fileId === file.fileId
          ? { ...thread, activeRunLoading: false }
          : thread);
        await processRun(conn, currentSource, activeRun);
      } catch {
        if (!isCurrentRequest()) return;
        setReopenThread((thread) => thread?.file.fileId === file.fileId
          ? {
              ...thread,
              activeRunLoading: false,
              historyError: "Could not load the active workflow status.",
            }
          : thread);
      }
    };

    // History and the current Google capture are deliberately independent.
    void listRuns(controller.signal).then((response) => {
      if (!isCurrentRequest()) return;
      const projection = documentConversationFromRuns(response.runs, file.fileId);
      history = projection;
      setConversation(projection.turns);
      setReopenThread((thread) => thread?.file.fileId === file.fileId
        ? {
            ...thread,
            historyLoading: false,
            activeRunLoading: Boolean(projection.activeRunId),
            canContinue: projection.canContinue,
          }
        : thread);
      void activatePersistedRun();
    }).catch(() => {
      if (!isCurrentRequest()) return;
      setReopenThread((thread) => thread?.file.fileId === file.fileId
        ? {
            ...thread,
            historyLoading: false,
            historyError: "Could not load this document's saved workflow history.",
          }
        : thread);
    });

    void registerSource(conn.connection_id, file.fileId, controller.signal).then((source) => {
      if (!isCurrentRequest()) return;
      currentSource = source;
      setWorkspaceState({ stage: "edit", connection: conn, source, submitting: false });
      void activatePersistedRun();
    }).catch((error) => {
      if (!isCurrentRequest()) return;
      setReopenThread((thread) => thread?.file.fileId === file.fileId
        ? { ...thread, sourceError: mapImportFailure(error), canContinue: false }
        : thread);
    });
  }, [processRun, setWorkspaceState, stopPolling]);

  const openRecentFile = useCallback((file: RecentDocumentSelection | null, conn: GoogleConnection | null) => {
    if (!file || !conn || conn.status !== "CONNECTED") return false;
    const current = stateRef.current;
    const openId = workbenchSource(current)?.source.provider_file_id
      ?? (current.stage === "importing" ? current.selectedFile.fileId : null);
    takeQueuedRecentDocument();
    if (openId === file.fileId) return true;
    reopenRecent(conn, file);
    return true;
  }, [reopenRecent]);

  const handleConnectionChange = useCallback((conn: GoogleConnection | null) => {
    setWorkspaceState((s) => (
      s.stage === "source"
        ? { ...s, connection: conn, loading: false }
        : s
    ));
    openRecentFile(peekQueuedRecentDocument(), conn);
  }, [openRecentFile, setWorkspaceState]);

  const handleSubmitInstruction = useCallback(
    async (instruction: string, turnId?: string) => {
      const current = stateRef.current;
      const verifiedResult = current.stage === "write-result"
        && isVerifiedWriteSuccess(
          current.result.status,
          current.result.structurally_verified,
        );
      if ((current.stage !== "edit" && !verifiedResult) || submitInFlightRef.current) return;
      const conn = current.connection;
      const source = current.source;
      const text = instruction.trim();
      if (!text) return;

      submitInFlightRef.current = true;
      const id = turnId ?? `local-${Date.now()}`;
      setConversation((turns) => {
        if (turnId) {
          return turns.map((turn) => (
            turn.id === turnId
              ? { ...turn, text, status: "pending", error: undefined }
              : turn
          ));
        }
        return appendPendingInstruction(turns, text, id);
      });
      setWorkspaceState((s) => {
        if (s.stage === "edit") return { ...s, submitting: true };
        if (
          s.stage === "write-result"
          && isVerifiedWriteSuccess(s.result.status, s.result.structurally_verified)
        ) {
          return { ...s, startingNext: true };
        }
        return s;
      });

      try {
        // Every instruction receives a new provider capture. start_run then
        // recaptures once more and rejects if Google changed in between.
        const runSource = await registerSource(
          conn.connection_id,
          source.source.provider_file_id,
        );
        setWorkspaceState({
          stage: "edit",
          connection: conn,
          source: runSource,
          submitting: true,
        });
        const run = await startRun(startRunRequest(runSource, text));
        setConversation((turns) => acceptInstruction(turns, id, run.run_id));
        setDraft("");
        await processRun(conn, runSource, run);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "The instruction was not sent.";
        setConversation((turns) => failInstruction(turns, id, msg));
        setWorkspaceState((s) => {
          if (s.stage === "edit") return { ...s, submitting: false };
          if (s.stage === "write-result") return { ...s, startingNext: false };
          return s;
        });
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [processRun, setWorkspaceState],
  );

  const handleDecide = useCallback((proposalId: string, approve: boolean) => {
    setWorkspaceState((s) => {
      if (s.stage !== "review") return s;
      const next = new Map(s.decisions);
      next.set(proposalId, { approve });
      return { ...s, decisions: next };
    });
  }, [setWorkspaceState]);

  const handleSubmitDecisions = useCallback(async () => {
    const current = stateRef.current;
    const submission = buildReviewDecisionSubmission(current);
    if (!submission || current.stage !== "review") return;

    const { connection, source } = current;
    setWorkspaceState({ ...current, submitting: true });

    try {
      const updated = await submitDecisions(submission.runId, submission.decisions);
      await processRun(connection, source, updated);
    } catch (err) {
      setWorkspaceState((s) => {
        const c = "connection" in s ? (s as { connection: GoogleConnection }).connection : null;
        const sr = "source" in s ? (s as { source: SourceRegistration }).source : null;
        const r = "run" in s ? (s as { run: RunView | null }).run : null;
        return {
          stage: "error",
          connection: c,
          source: sr,
          run: r,
          message: err instanceof Error ? err.message : "Failed to submit decisions",
          recoverable: true,
        };
      });
    }
  }, [processRun, setWorkspaceState]);

  const handleReset = useCallback(() => {
    stopPolling();
    importAbortRef.current?.abort();
    submitInFlightRef.current = false;
    setDraft("");
    setConversation([]);
    setReopenThread(null);
    setWorkspaceState({ stage: "source", connection: null, loading: true });
  }, [setWorkspaceState, stopPolling]);

  const handleChangeSource = useCallback(() => {
    stopPolling();
    importAbortRef.current?.abort();
    submitInFlightRef.current = false;
    setDraft("");
    setConversation([]);
    setReopenThread(null);
    setWorkspaceState((s) => {
      const conn = "connection" in s ? (s as { connection: GoogleConnection | null }).connection : null;
      return { stage: "source", connection: conn, loading: false };
    });
  }, [setWorkspaceState, stopPolling]);

  const handleReturnFromUnsupported = useCallback(() => {
    setWorkspaceState((s) => {
      if (s.stage !== "unsupported") return s;
      return { stage: "edit", connection: s.connection, source: s.source, submitting: false };
    });
  }, [setWorkspaceState]);

  const handleWriteBack = useCallback(async (
    conn: GoogleConnection,
    source: SourceRegistration,
    run: RunView,
    dryRun: DryRunView,
  ) => {
    if (writeInFlightRef.current || !canWriteBack(dryRun.status, false)) return;
    writeInFlightRef.current = true;
    setWorkspaceState({ stage: "dry-run", connection: conn, source, run, dryRun, writing: true });
    try {
      const result = await writeBackSafely(run.run_id);
      if (isVerifiedWriteSuccess(result.status, result.structurally_verified)) {
        setConversation((turns) => recordVerifiedWrite(turns, {
          runId: run.run_id,
          fileId: source.source.provider_file_id,
          backupCreated: result.backup_created,
          backupVerified: result.backup_verified,
          writeApplied: result.write_applied,
          structurallyVerified: true,
        }));
        setReopenThread((thread) => thread
          ? { ...thread, canContinue: true, activeRunLoading: false }
          : thread);
      }
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, dryRun, result, deciding: false, startingNext: false });
    } catch (err) {
      setWorkspaceState({
        stage: "error",
        connection: conn,
        source,
        run,
        message: err instanceof Error ? err.message : "Safe write-back failed",
        recoverable: false,
      });
    } finally {
      writeInFlightRef.current = false;
    }
  }, [setWorkspaceState]);

  const handleConflictDecision = useCallback(async (
    conn: GoogleConnection,
    source: SourceRegistration,
    run: RunView,
    choice: ConflictChoice,
  ) => {
    const current = stateRef.current;
    if (current.stage !== "write-result") return;
    setWorkspaceState((current) => current.stage === "write-result"
      ? { ...current, deciding: true }
      : current);
    try {
      const result = await decideWriteConflict(run.run_id, choice);
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, dryRun: current.dryRun, result, deciding: false, startingNext: false });
    } catch (err) {
      setWorkspaceState({
        stage: "error",
        connection: conn,
        source,
        run,
        message: err instanceof Error ? err.message : "Conflict decision failed",
        recoverable: false,
      });
    }
  }, [setWorkspaceState]);

  useEffect(() => {
    const onNewDocument = () => handleChangeSource();
    window.addEventListener(NEW_DOCUMENT_EVENT, onNewDocument);
    return () => window.removeEventListener(NEW_DOCUMENT_EVENT, onNewDocument);
  }, [handleChangeSource]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const file = (event as CustomEvent<RecentDocumentSelection>).detail
        ?? peekQueuedRecentDocument();
      const conn = "connection" in stateRef.current ? stateRef.current.connection : null;
      openRecentFile(file, conn);
    };
    window.addEventListener(OPEN_RECENT_DOCUMENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RECENT_DOCUMENT_EVENT, onOpen);
  }, [openRecentFile]);

  const sourced = workbenchSource(state);
  const reopeningFileId = reopenThread?.file.fileId ?? null;

  useEffect(() => {
    setActiveDocumentId(sourced?.source.provider_file_id ?? reopeningFileId);
    return () => setActiveDocumentId(null);
  }, [reopeningFileId, sourced?.source.provider_file_id]);

  const entryKey =
    state.stage === "importing"
      ? state.error
        ? "import-error"
        : "importing"
      : state.stage;

  const verifiedWrite = state.stage === "write-result"
    && isVerifiedWriteSuccess(state.result.status, state.result.structurally_verified);
  const submitting = (state.stage === "edit" && state.submitting)
    || (state.stage === "write-result" && state.startingNext);
  const matchingThread = reopenThread?.file.fileId === sourced?.source.provider_file_id
    ? reopenThread
    : null;
  const threadBusy = Boolean(matchingThread?.historyLoading || matchingThread?.activeRunLoading);
  const threadBlocked = Boolean(
    matchingThread
    && (threadBusy || matchingThread.historyError || !matchingThread.canContinue),
  );
  const retryReopen = () => {
    if (!reopenThread) return;
    const connection = "connection" in state ? state.connection : null;
    if (connection) reopenRecent(connection, reopenThread.file);
  };

  const previewBlocks = frozenPreviewBlocks(sourced?.preview);
  const reviewMarks = state.stage === "review"
    ? documentReviewMarks(
        previewBlocks,
        state.proposals.map((proposal) => ({
          oldText: extractText(proposal.old_html),
          newText: extractText(proposal.new_html),
        })),
      )
    : [];

  return (
    <div className="h-full min-h-0">
          {reopenThread?.sourceError && !sourced ? (
            <ReopenSourceFailure
              thread={reopenThread}
              turns={conversation}
              onRetry={retryReopen}
            />
          ) : null}

          {!reopenThread?.sourceError && (state.stage === "source" || state.stage === "importing") ? (
            <MotionPanel key={entryKey} className="h-full">
              {state.stage === "source" ? (
                <SourceChooser
                  initialConnection={state.connection}
                  onDocumentPicked={beginImport}
                  onConnectionChange={handleConnectionChange}
                />
              ) : null}
              {state.stage === "importing" ? (
                <ImportingDocument
                  documentName={state.selectedFile.name}
                  phase={state.error ? "FAILED" : "READING_SOURCE"}
                  error={state.error}
                  onRetry={() => beginImport(state.connection, state.selectedFile)}
                  onChooseAnother={handleChangeSource}
                />
              ) : null}
            </MotionPanel>
          ) : null}

          {sourced ? (
            <DocumentWorkbench
              source={sourced}
              turns={conversation}
              draft={draft}
              busy={submitting || threadBusy}
              composerEnabled={(state.stage === "edit" || verifiedWrite) && !threadBlocked}
              stateLabel={matchingThread?.historyError
                ? "Needs attention"
                : threadBusy
                  ? "Loading"
                  : workbenchStateLabel(state)}
              onDraftChange={setDraft}
              onSubmit={(instruction) => void handleSubmitInstruction(instruction)}
              onRetry={(turn) => void handleSubmitInstruction(turn.text, turn.id)}
              onChangeSource={handleChangeSource}
              reviewMarks={reviewMarks}
              documentPreview={verifiedWrite
                ? state.result.verified_preview ?? undefined
                : undefined}
              documentRevision={verifiedWrite
                ? state.result.verified_preview?.revision_id
                  ?? state.result.resulting_revision_id
                  ?? undefined
                : undefined}
            >
              {matchingThread?.historyLoading ? (
                <DocRelayEvent title="Loading saved document history…" />
              ) : null}
              {matchingThread?.activeRunLoading ? (
                <DocRelayEvent title="Loading the active workflow…" />
              ) : null}
              {matchingThread?.historyError ? (
                <ConversationErrorEvent
                  message={matchingThread.historyError}
                  recoverable
                  onRetry={retryReopen}
                />
              ) : null}
              {state.stage === "processing" ? (
                <ProcessingEvent
                  run={state.run}
                  onCheckStatus={handleCheckProviderStatus}
                />
              ) : null}
              {state.stage === "review" ? (
                <ReviewEvent
                  proposals={state.proposals}
                  blocks={previewBlocks}
                  decisions={state.decisions}
                  submitting={state.submitting}
                  onDecide={handleDecide}
                  onSubmitAll={handleSubmitDecisions}
                />
              ) : null}
              {state.stage === "dry-run" ? (
                <DryRunEvent
                  dryRun={state.dryRun}
                  writing={state.writing}
                  onWrite={() => handleWriteBack(
                    state.connection,
                    state.source,
                    state.run,
                    state.dryRun,
                  )}
                />
              ) : null}
              {state.stage === "write-result" && !verifiedWrite ? (
                <WriteResultEvent
                  fileId={state.source.source.provider_file_id}
                  result={state.result}
                  deciding={state.deciding}
                  onDecision={(choice) => handleConflictDecision(
                    state.connection,
                    state.source,
                    state.run,
                    choice,
                  )}
                />
              ) : null}
              {state.stage === "unsupported" ? (
                <UnsupportedEvent
                  dryRun={state.dryRun}
                  onReturn={state.dryRun.reason_code === "MALFORMED_SNAPSHOT"
                    ? handleChangeSource
                    : handleReturnFromUnsupported}
                />
              ) : null}
              {state.stage === "error" ? (
                <ConversationErrorEvent
                  message={state.message}
                  recoverable={state.recoverable}
                  onRetry={handleReset}
                />
              ) : null}
            </DocumentWorkbench>
          ) : null}

          {state.stage === "error" && !sourced ? (
            <ErrorState
              message={state.message}
              recoverable={state.recoverable}
              onRetry={handleReset}
            />
          ) : null}
    </div>
  );
}

function ReopenSourceFailure({
  thread,
  turns,
  onRetry,
}: {
  thread: ReopenThreadState;
  turns: UserInstructionTurn[];
  onRetry: () => void;
}) {
  return (
    <MotionPanel className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden lg:w-[420px] lg:min-w-[360px] lg:max-w-[470px] lg:shrink-0">
          <ConversationPanel
            title={thread.file.name}
            stateLabel="Needs attention"
            turns={turns}
            draft=""
            busy={thread.historyLoading}
            composerEnabled={false}
            onDraftChange={() => undefined}
            onSubmit={() => undefined}
            onRetry={() => undefined}
          >
            {thread.historyLoading ? (
              <DocRelayEvent title="Loading saved document history…" />
            ) : null}
            {thread.historyError ? (
              <DocRelayEvent title="Saved workflow history could not be loaded." />
            ) : null}
            <ConversationErrorEvent
              message={thread.sourceError?.title ?? "The current Google document could not be loaded."}
              recoverable
              onRetry={onRetry}
            />
          </ConversationPanel>
        </div>
        <section
          aria-label="Current Google document"
          className="hidden min-h-0 min-w-0 flex-1 place-items-center bg-document-canvas px-8 lg:grid"
        >
          <div className="max-w-sm rounded-lg border border-border bg-surface p-5">
            <h2 className="text-[14px] font-medium text-foreground">Current document unavailable</h2>
            <p className="mt-1.5 text-[13px] leading-5 text-muted">
              DocRelay could not refresh the Google source, so no current document content is shown and new edits are disabled.
            </p>
          </div>
        </section>
      </div>
    </MotionPanel>
  );
}
