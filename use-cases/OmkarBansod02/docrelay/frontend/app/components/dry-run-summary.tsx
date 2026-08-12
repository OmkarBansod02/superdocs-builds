"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { DryRunView, SourceRegistration } from "../lib/api";
import { canWriteBack } from "../lib/write-back-state";
import { DiffView } from "./diff-view";
import { DocumentIdentity, type DocumentIdentityData, shortId } from "./document-identity";
import { WorkflowProgress } from "./workflow-progress";
import { Button, StateMark } from "./ui";

export function DryRunSummary({
  source,
  document,
  dryRun,
  writing,
  onWrite,
}: {
  source?: SourceRegistration;
  document?: DocumentIdentityData;
  dryRun: DryRunView;
  writing: boolean;
  onWrite: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const identity = document ?? (source ? { name: source.source.name, revision: source.baseline.revision_id } : { name: "Google document", revision: dryRun.source?.baseline_revision_id ?? null });
  const safetyChecks = normalizedSafetyChecks(dryRun.why_safe);

  return (
    <div>
      <DocumentIdentity document={identity} />
      <WorkflowProgress current="Safety check" />
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
        <section className="px-5 py-9 sm:px-8 lg:px-10 lg:py-10">
          <h2 className="text-[31px] font-semibold tracking-[-0.04em] text-ink sm:text-[36px]">Ready for safe write-back</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-6 text-muted">The approved change is mapped to {operationPhrase(dryRun.operation_count)} guarded Google Docs {dryRun.operation_count === 1 ? "operation" : "operations"}.</p>

          <div className="mt-8">
            <h3 className="text-[18px] font-semibold text-ink">Change to write</h3>
            <div className="mt-6">
              <DiffView oldText={dryRun.old_text} newText={dryRun.new_text} compact />
            </div>
          </div>

          <dl className="mt-7 divide-y divide-border border-y border-border text-[14px]">
            {dryRun.structural_location ? <DetailRow label="Location" value={locationSummary(dryRun.structural_location)} /> : null}
            <DetailRow label="Operations" value={String(dryRun.operation_count)} />
            <DetailRow label="Source revision" value={dryRun.source?.baseline_revision_id ? shortId(dryRun.source.baseline_revision_id) : "—"} mono />
          </dl>

          <div className="mt-6 flex items-center gap-3 text-[16px] font-medium text-success">
            <span className="grid size-5 place-items-center rounded-full border border-success text-[12px]" aria-hidden="true">✓</span>
            No cloud write has happened yet
          </div>

          <Button disabled={!canWriteBack(dryRun.status, writing)} busy={writing} onClick={onWrite} className="mt-6 w-full text-[15px]">
            {writing ? "Creating and verifying backup…" : "Write back safely"}
          </Button>

          <button type="button" onClick={() => setShowDetails((value) => !value)} aria-expanded={showDetails} className="mx-auto mt-3 flex min-h-11 items-center gap-2 px-3 text-[13px] font-medium text-accent hover:underline">
            View technical evidence
            <ChevronDown className={`size-4 transition-transform ${showDetails ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
          {showDetails ? <TechnicalDetails dryRun={dryRun} /> : null}

          <p className="mt-5 border-t border-border pt-5 text-[13px] text-muted">DocRelay stops if Google Drive has a newer revision.</p>
        </section>

        <aside className="border-t border-border px-5 py-8 sm:px-8 lg:border-l lg:border-t-0 lg:px-8 lg:py-10">
          <h2 className="text-[19px] font-semibold text-ink">Safety checks</h2>
          <div className="mt-8">
            {safetyChecks.map((label, index) => (
              <div key={label} className="relative flex gap-3 pb-9 last:pb-0">
                {index < safetyChecks.length - 1 ? <span className="absolute left-[9px] top-5 h-[calc(100%-20px)] border-l border-border" aria-hidden="true" /> : null}
                <StateMark state="complete" />
                <span className="text-[14px] leading-5 text-ink">{label}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function TechnicalDetails({ dryRun }: { dryRun: DryRunView }) {
  return (
    <dl className="mt-2 space-y-3 rounded-md border border-border bg-surface-muted p-4 font-mono text-[11px] leading-5 text-muted">
      {dryRun.mapping_proof_id ? <TechnicalRow label="MappingProof" value={dryRun.mapping_proof_id} /> : null}
      {dryRun.mapping_proof_sha256 ? <TechnicalRow label="Proof SHA-256" value={dryRun.mapping_proof_sha256} /> : null}
      {dryRun.write_plan_id ? <TechnicalRow label="WritePlan" value={dryRun.write_plan_id} /> : null}
      {dryRun.write_plan_sha256 ? <TechnicalRow label="Plan SHA-256" value={dryRun.write_plan_sha256} /> : null}
      <TechnicalRow label="cloud_mutation_performed" value="false" />
      {dryRun.provider_operation ? <TechnicalRow label="Provider operation" value={JSON.stringify(dryRun.provider_operation)} /> : null}
    </dl>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid grid-cols-[150px_1fr] gap-4 py-3"><dt className="text-muted">{label}</dt><dd className={mono ? "font-mono text-[12px] text-ink" : "text-ink"}>{value}</dd></div>;
}

function TechnicalRow({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 sm:grid-cols-[150px_1fr]"><dt>{label}</dt><dd className="break-all text-ink/75">{value}</dd></div>;
}

function locationSummary(location: Record<string, unknown>): string {
  return typeof location.paragraph_index === "number" ? `Paragraph ${location.paragraph_index + 1}` : "Document body";
}

function operationPhrase(count: number): string {
  if (count === 1) return "one";
  if (count === 2) return "two";
  return String(count);
}

function normalizedSafetyChecks(checks: string[]): string[] {
  const mapping: Record<string, string> = {
    "approved immutable review decision": "Review decision recorded",
    "exact persisted baseline revision and native snapshot hash": "Exact source revision matched",
    "one unique ordinary body paragraph and one plain text run": "Unique location found",
    "exact internal ASCII preimage with equal UTF-16 length": "Source text exactly matched",
    "minimum delete-and-insert range guarded by requiredRevisionId": "Revision guard prepared",
  };
  const result = checks.map((check) => mapping[check] ?? check);
  if (!result.some((check) => check.toLowerCase().includes("backup"))) result.push("Backup will be created first");
  return result;
}
