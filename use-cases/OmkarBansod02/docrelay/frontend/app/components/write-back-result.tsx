import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import type { ConflictChoice, SourceRegistration, WriteBackView } from "../lib/api";
import { conflictActions, isVerifiedWriteSuccess } from "../lib/write-back-state";
import { SourceSummary } from "./source-summary";

export function WriteBackResult({
  source,
  result,
  deciding,
  onDecision,
}: {
  source: SourceRegistration;
  result: WriteBackView;
  deciding: boolean;
  onDecision: (choice: ConflictChoice) => void;
}) {
  if (isVerifiedWriteSuccess(result.status, result.structurally_verified)) {
    return <VerifiedSuccess source={source} result={result} />;
  }
  if (result.status === "CONFLICT" && result.conflict) {
    return (
      <ConflictState
        source={source}
        deciding={deciding}
        onDecision={onDecision}
      />
    );
  }
  return <AttentionState source={source} result={result} />;
}

function VerifiedSuccess({
  source,
  result,
}: {
  source: SourceRegistration;
  result: WriteBackView;
}) {
  const checks = [
    "Backup created",
    "Source revision verified",
    "Exact planned change applied",
    "Result structurally verified",
  ];
  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />
      <div className="max-w-xl mx-auto rounded-lg border border-success/25 bg-success-soft p-7">
        <ShieldCheck className="h-9 w-9 text-success mb-4" />
        <h2 className="text-lg font-semibold text-ink">Written back safely</h2>
        <div className="mt-5 space-y-2">
          {checks.map((label) => (
            <p key={label} className="flex items-center gap-2 text-sm text-ink/80">
              <Check className="h-4 w-4 text-success" /> {label}
            </p>
          ))}
        </div>
        {result.resulting_revision_id && (
          <p className="mt-5 text-xs text-muted font-mono">
            Resulting revision {truncate(result.resulting_revision_id, 16)}
          </p>
        )}
      </div>
    </div>
  );
}

function ConflictState({
  source,
  deciding,
  onDecision,
}: {
  source: SourceRegistration;
  deciding: boolean;
  onDecision: (choice: ConflictChoice) => void;
}) {
  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />
      <div className="max-w-2xl mx-auto rounded-lg border border-warning/30 bg-warning-soft p-7">
        <AlertTriangle className="h-9 w-9 text-warning mb-4" />
        <h2 className="text-xl font-semibold text-ink">Document changed in Google Drive</h2>
        <p className="mt-3 text-sm text-ink/75">
          Someone changed this document after DocRelay prepared the write.
        </p>
        <p className="mt-1 text-sm font-medium text-ink">DocRelay did not overwrite it.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {conflictActions.map((action) => (
            <button
              key={action.choice}
              disabled={deciding}
              onClick={() => onDecision(action.choice)}
              className="rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AttentionState({
  source,
  result,
}: {
  source: SourceRegistration;
  result: WriteBackView;
}) {
  const inProgress = result.status === "IN_PROGRESS";
  const message = inProgress
    ? "The server has already claimed this workflow. No second write was started."
    : result.status === "CANCELLED"
    ? "Write-back cancelled. No DocRelay change was applied."
    : result.status === "REVIEW_LATEST"
      ? "The old plan is stale. Refresh the source before preparing a new review."
      : "Write-back needs attention. DocRelay will not retry an uncertain provider effect automatically.";
  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />
      <div className="max-w-xl mx-auto rounded-lg border border-warning/30 bg-warning-soft p-7">
        <AlertTriangle className="h-8 w-8 text-warning mb-3" />
        <h2 className="text-lg font-semibold text-ink">
          {inProgress ? "Write-back in progress" : "Safe write-back stopped"}
        </h2>
        <p className="mt-2 text-sm text-ink/75">{message}</p>
      </div>
    </div>
  );
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, 8)}…${value.slice(-7)}`;
}
