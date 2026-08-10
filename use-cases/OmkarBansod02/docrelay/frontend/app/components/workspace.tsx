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
  resumeRun,
  startRun,
  submitDecisions,
  decideWriteConflict,
  writeBackSafely,
} from "../lib/api";
import {
  buildReviewDecisionSubmission,
  routeRun,
  runNeedsPolling,
} from "../lib/workspace-state";
import { canWriteBack } from "../lib/write-back-state";
import type { WorkspaceState } from "../lib/workspace-state";

import { TopBar } from "./top-bar";
import { WorkflowRail } from "./workflow-rail";
import { SourceChooser } from "./source-chooser";
import { InstructionComposer } from "./instruction-composer";
import { ProcessingState } from "./processing-state";
import { ReviewPanel } from "./review-panel";
import { DryRunSummary } from "./dry-run-summary";
import { UnsupportedState } from "./unsupported-state";
import { ErrorState } from "./error-state";
import { WriteBackResult } from "./write-back-result";

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

  useEffect(() => () => stopPolling(), [stopPolling]);

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

      if (result.stage === "processing" && runNeedsPolling(run.state)) {
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
    setWorkspaceState((s) => ({ ...s, connection: conn, loading: false }) as WorkspaceState);
  }, [setWorkspaceState]);

  const handleSourceSelected = useCallback(
    (conn: GoogleConnection, source: SourceRegistration) => {
      setWorkspaceState({ stage: "source-selected", connection: conn, source });
    },
    [setWorkspaceState],
  );

  const handleStartEdit = useCallback(() => {
    setWorkspaceState((s) => {
      if (s.stage !== "source-selected") return s;
      return { stage: "edit", connection: s.connection, source: s.source, submitting: false };
    });
  }, [setWorkspaceState]);

  const handleSubmitInstruction = useCallback(
    async (instruction: string) => {
      let conn: GoogleConnection;
      let source: SourceRegistration;

      setWorkspaceState((s) => {
        if (s.stage !== "edit") return s;
        conn = s.connection;
        source = s.source;
        return { ...s, submitting: true };
      });

      try {
        const run = await startRun({
          source_id: source!.source.source_id,
          baseline_capture_id: source!.baseline.capture_id,
          instruction,
        });
        await processRun(conn!, source!, run);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to start edit";
        setWorkspaceState((s) => {
          const c = s.stage !== "source" ? (s as { connection: GoogleConnection }).connection : null;
          const sr = "source" in s ? (s as { source: SourceRegistration }).source : null;
          return { stage: "error", connection: c, source: sr, run: null, message: msg, recoverable: true };
        });
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
    setWorkspaceState({ stage: "source", connection: null, loading: true });
  }, [setWorkspaceState, stopPolling]);

  const handleChangeSource = useCallback(() => {
    stopPolling();
    setWorkspaceState((s) => {
      const conn = "connection" in s ? (s as { connection: GoogleConnection | null }).connection : null;
      return { stage: "source", connection: conn, loading: false };
    });
  }, [setWorkspaceState, stopPolling]);

  const handleReturnFromUnsupported = useCallback(() => {
    setWorkspaceState((s) => {
      if (s.stage !== "unsupported") return s;
      return { stage: "source-selected", connection: s.connection, source: s.source };
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
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, result, deciding: false });
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
    setWorkspaceState((current) => current.stage === "write-result"
      ? { ...current, deciding: true }
      : current);
    try {
      const result = await decideWriteConflict(run.run_id, choice);
      setWorkspaceState({ stage: "write-result", connection: conn, source, run, result, deciding: false });
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

  const currentStage = state.stage === "source-selected" ? "source" : state.stage;

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        connection={"connection" in state ? (state as { connection: GoogleConnection | null }).connection : null}
        onChangeSource={state.stage !== "source" ? handleChangeSource : undefined}
      />

      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:block w-52 border-r border-border bg-surface flex-shrink-0 overflow-y-auto">
          <WorkflowRail currentStage={currentStage} />
          {currentStage !== "source" && currentStage !== "error" && "source" in state && (
            <div className="px-3 pb-4 border-t border-border mt-2 pt-3">
              <p className="text-[11px] text-muted font-medium uppercase tracking-wider mb-1">
                Source
              </p>
              <p className="text-[12px] text-ink truncate">
                {(state as { source: SourceRegistration }).source?.source.name ?? "—"}
              </p>
            </div>
          )}
        </aside>

        <main className="flex-1 overflow-y-auto p-5 sm:p-8">
          {state.stage === "source" && (
            <SourceChooser
              onSourceSelected={handleSourceSelected}
              onConnectionChange={handleConnectionChange}
            />
          )}

          {state.stage === "source-selected" && (
            <div className="max-w-md mx-auto py-12 text-center">
              <h2 className="text-lg font-semibold text-ink mb-2">Document selected</h2>
              <div className="mb-6">
                <div className="bg-surface border border-border rounded-md p-4 text-left">
                  <p className="text-sm font-medium text-ink">{state.source.source.name}</p>
                  <p className="text-xs text-muted mt-1">Google Docs</p>
                  <p className="text-xs text-muted font-mono mt-1">
                    Revision {state.source.baseline.revision_id.slice(0, 8)}…
                  </p>
                </div>
              </div>
              <button
                onClick={handleStartEdit}
                className="px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors"
              >
                Continue to edit
              </button>
            </div>
          )}

          {state.stage === "edit" && (
            <InstructionComposer
              source={state.source}
              submitting={state.submitting}
              onSubmit={handleSubmitInstruction}
              onChangeSource={handleChangeSource}
            />
          )}

          {state.stage === "processing" && (
            <ProcessingState source={state.source} run={state.run} />
          )}

          {state.stage === "review" && (
            <ReviewPanel
              source={state.source}
              proposals={state.proposals}
              decisions={state.decisions}
              submitting={state.submitting}
              onDecide={handleDecide}
              onSubmitAll={handleSubmitDecisions}
            />
          )}

          {state.stage === "dry-run" && (
            <DryRunSummary
              source={state.source}
              dryRun={state.dryRun}
              writing={state.writing}
              onWrite={() => handleWriteBack(
                state.connection,
                state.source,
                state.run,
                state.dryRun,
              )}
            />
          )}

          {state.stage === "write-result" && (
            <WriteBackResult
              source={state.source}
              result={state.result}
              deciding={state.deciding}
              onDecision={(choice) => handleConflictDecision(
                state.connection,
                state.source,
                state.run,
                choice,
              )}
            />
          )}

          {state.stage === "unsupported" && (
            <UnsupportedState
              source={state.source}
              dryRun={state.dryRun}
              onReturn={handleReturnFromUnsupported}
            />
          )}

          {state.stage === "error" && (
            <ErrorState
              message={state.message}
              recoverable={state.recoverable}
              onRetry={handleReset}
            />
          )}
        </main>
      </div>
    </div>
  );
}
