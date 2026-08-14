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
  registerSource,
  resumeRun,
  startRun,
  submitDecisions,
  decideWriteConflict,
  writeBackSafely,
} from "../lib/api";
import {
  NEW_DOCUMENT_EVENT,
  acceptInstruction,
  appendPendingInstruction,
  failInstruction,
  startRunRequest,
  workbenchSource,
  workbenchStateLabel,
  type UserInstructionTurn,
} from "../lib/conversation";
import { mapImportFailure, type SelectedDriveFile } from "../lib/import-state";
import {
  buildReviewDecisionSubmission,
  routeRun,
  runNeedsPolling,
} from "../lib/workspace-state";
import { canWriteBack } from "../lib/write-back-state";
import type { WorkspaceState } from "../lib/workspace-state";

import { SourceChooser } from "./source-chooser";
import { ImportingDocument } from "./importing-document";
import { DocumentWorkbench } from "./document-workbench";
import { MotionPanel } from "./motion-panel";
import { ErrorState } from "./error-state";
import {
  ConversationErrorEvent,
  DryRunEvent,
  ProcessingEvent,
  ReviewEvent,
  UnsupportedEvent,
  WriteResultEvent,
} from "./conversation-events";

const POLL_INTERVAL_MS = 4000;
type WorkspaceStateUpdate = WorkspaceState | ((current: WorkspaceState) => WorkspaceState);

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
  const submitInFlightRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [conversation, setConversation] = useState<UserInstructionTurn[]>([]);

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

  const handleConnectionChange = useCallback((conn: GoogleConnection | null) => {
    setWorkspaceState((s) => (
      s.stage === "source"
        ? { ...s, connection: conn, loading: false }
        : s
    ));
  }, [setWorkspaceState]);

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

  const handleSubmitInstruction = useCallback(
    async (instruction: string, turnId?: string) => {
      const current = stateRef.current;
      if (current.stage !== "edit" || submitInFlightRef.current) return;
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
      setWorkspaceState((s) => (s.stage === "edit" ? { ...s, submitting: true } : s));

      try {
        const run = await startRun(startRunRequest(source, text));
        setConversation((turns) => acceptInstruction(turns, id));
        setDraft("");
        await processRun(conn, source, run);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "The instruction was not sent.";
        setConversation((turns) => failInstruction(turns, id, msg));
        setWorkspaceState((s) => (s.stage === "edit" ? { ...s, submitting: false } : s));
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
    setWorkspaceState({ stage: "source", connection: null, loading: true });
  }, [setWorkspaceState, stopPolling]);

  const handleChangeSource = useCallback(() => {
    stopPolling();
    importAbortRef.current?.abort();
    submitInFlightRef.current = false;
    setDraft("");
    setConversation([]);
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
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, dryRun, result, deciding: false });
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
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, dryRun: current.dryRun, result, deciding: false });
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

  const entryKey =
    state.stage === "importing"
      ? state.error
        ? "import-error"
        : "importing"
      : state.stage;

  const sourced = workbenchSource(state);
  const submitting = state.stage === "edit" && state.submitting;

  return (
    <div className={sourced ? "h-full min-h-0" : undefined}>
          {(state.stage === "source" || state.stage === "importing") ? (
            <MotionPanel key={entryKey}>
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
              busy={submitting}
              composerEnabled={state.stage === "edit"}
              stateLabel={workbenchStateLabel(state)}
              onDraftChange={setDraft}
              onSubmit={(instruction) => void handleSubmitInstruction(instruction)}
              onRetry={(turn) => void handleSubmitInstruction(turn.text, turn.id)}
              onChangeSource={handleChangeSource}
            >
              {state.stage === "processing" ? (
                <ProcessingEvent
                  run={state.run}
                  onCheckStatus={handleCheckProviderStatus}
                />
              ) : null}
              {state.stage === "review" ? (
                <ReviewEvent
                  proposals={state.proposals}
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
              {state.stage === "write-result" ? (
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
                  onStartAnother={handleReset}
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
