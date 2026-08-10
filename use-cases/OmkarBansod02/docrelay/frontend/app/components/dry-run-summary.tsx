"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Shield, ShieldCheck } from "lucide-react";
import type { DryRunView, SourceRegistration } from "../lib/api";
import { canWriteBack } from "../lib/write-back-state";
import { SourceSummary } from "./source-summary";

export function DryRunSummary({
  source,
  dryRun,
  writing,
  onWrite,
}: {
  source: SourceRegistration;
  dryRun: DryRunView;
  writing: boolean;
  onWrite: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  const shortRev = dryRun.source?.baseline_revision_id
    ? truncate(dryRun.source.baseline_revision_id, 12)
    : "—";

  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />

      <div className="bg-surface-muted rounded-lg p-6 sm:p-8">
        <div className="bg-surface rounded border border-border shadow-sm max-w-2xl mx-auto">
          <div className="px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-lg bg-success-soft flex items-center justify-center flex-shrink-0">
                <ShieldCheck className="w-5 h-5 text-success" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-ink">Ready to write back</h2>
                <p className="text-xs text-muted">
                  All safety checks passed. No cloud changes have been made.
                </p>
              </div>
            </div>

            {dryRun.old_text && dryRun.new_text && (
              <div className="mb-6 px-4 py-3 bg-surface-muted rounded border border-border">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-error line-through">{dryRun.old_text}</span>
                  <span className="text-muted">→</span>
                  <span className="text-success font-medium">{dryRun.new_text}</span>
                </div>
              </div>
            )}

            <dl className="space-y-2.5 text-sm mb-6">
              <Row label="Source revision" value={shortRev} mono />
              {dryRun.structural_location && (
                <Row
                  label="Location"
                  value={locationSummary(dryRun.structural_location)}
                />
              )}
              <Row label="Operations" value={String(dryRun.operation_count)} />
            </dl>

            <SafetyChecklist items={dryRun.why_safe} />

            <div className="mt-6 border-t border-border pt-4">
              <button
                onClick={() => setShowDetails((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-muted hover:text-ink transition-colors"
              >
                {showDetails ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                View technical details
              </button>

              {showDetails && (
                <TechnicalDetails dryRun={dryRun} />
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-border">
              <button
                disabled={!canWriteBack(dryRun.status, writing)}
                onClick={onWrite}
                className="px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors disabled:bg-ink/20 disabled:text-ink/40 disabled:cursor-not-allowed"
              >
                {writing ? "Creating and verifying backup…" : "Write back safely"}
              </button>
              <p className="text-[11px] text-muted mt-2">
                A versioned backup will be created first. DocRelay stops if the source
                revision changed.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SafetyChecklist({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted mb-1">Safety checks</p>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <Shield className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
          <span className="text-ink/80">{humanSafetyCheck(item)}</span>
        </div>
      ))}
      <div className="flex items-start gap-2 text-xs">
        <Shield className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
        <span className="text-ink/80">No cloud write has occurred</span>
      </div>
    </div>
  );
}

function TechnicalDetails({ dryRun }: { dryRun: DryRunView }) {
  return (
    <div className="mt-3 p-3 bg-surface-muted rounded border border-border text-xs font-mono space-y-1.5">
      {dryRun.mapping_proof_id && (
        <p>
          <span className="text-muted">MappingProof:</span>{" "}
          <span className="text-ink/70 break-all">{dryRun.mapping_proof_id}</span>
        </p>
      )}
      {dryRun.mapping_proof_sha256 && (
        <p>
          <span className="text-muted">Proof SHA-256:</span>{" "}
          <span className="text-ink/70 break-all">{truncate(dryRun.mapping_proof_sha256, 16)}</span>
        </p>
      )}
      {dryRun.write_plan_id && (
        <p>
          <span className="text-muted">WritePlan:</span>{" "}
          <span className="text-ink/70 break-all">{dryRun.write_plan_id}</span>
        </p>
      )}
      {dryRun.write_plan_sha256 && (
        <p>
          <span className="text-muted">Plan SHA-256:</span>{" "}
          <span className="text-ink/70 break-all">{truncate(dryRun.write_plan_sha256, 16)}</span>
        </p>
      )}
      {dryRun.source?.baseline_revision_id && (
        <p>
          <span className="text-muted">requiredRevisionId:</span>{" "}
          <span className="text-ink/70 break-all">{dryRun.source.baseline_revision_id}</span>
        </p>
      )}
      {dryRun.provider_operation && (
        <details className="mt-2">
          <summary className="text-muted cursor-pointer hover:text-ink transition-colors">
            Provider operation payload
          </summary>
          <pre className="mt-1 text-[11px] text-ink/60 whitespace-pre-wrap break-all overflow-x-auto">
            {JSON.stringify(dryRun.provider_operation, null, 2)}
          </pre>
        </details>
      )}
      <p className="text-muted pt-1">cloud_mutation_performed: false</p>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-ink text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function locationSummary(loc: Record<string, unknown>): string {
  const paragraphIndex = loc.paragraph_index;
  if (typeof paragraphIndex === "number") {
    return `Paragraph ${paragraphIndex + 1}`;
  }
  return "Document body";
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  const half = Math.floor((len - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-(len - half - 1))}`;
}

function humanSafetyCheck(check: string): string {
  const map: Record<string, string> = {
    "approved immutable review decision": "Explicit review decision recorded",
    "exact persisted baseline revision and native snapshot hash": "Exact source revision matched",
    "one unique ordinary body paragraph and one plain text run": "Unique location found",
    "exact internal ASCII preimage with equal UTF-16 length": "Source text exactly matched",
    "minimum delete-and-insert range guarded by requiredRevisionId": "Revision-guarded operation",
  };
  return map[check] ?? check;
}
