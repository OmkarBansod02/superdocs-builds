"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDryRun,
  decideWriteConflict,
  getRun,
  getRunSummary,
  listProposals,
  listWatchRules,
  resumeRun,
  submitDecisions,
  writeBackSafely,
  type ConflictChoice,
  type DryRunView,
  type ProposalView,
  type RunSummary,
  type RunView,
  type WriteBackView,
} from "../lib/api";
import { safetyFailureRecovery } from "../lib/workspace-state";
import type { DocumentIdentityData } from "./document-identity";
import { DocumentIdentity } from "./document-identity";
import { DryRunSummary } from "./dry-run-summary";
import { extractText } from "./diff-view";
import { ProcessingState } from "./processing-state";
import { ReviewPanel } from "./review-panel";
import { Button, InlineNotice, Skeleton, StateMark } from "./ui";
import { WriteAuthorization } from "./write-authorization";
import { WriteBackResult } from "./write-back-result";
import { WorkflowProgress } from "./workflow-progress";

type LoadedRun = {
  run: RunView;
  summary: RunSummary;
  proposals: ProposalView[];
  matchedFolder: string | null;
};

export function RunDetailWorkspace({ runId }: { runId: string }) {
  const [loaded, setLoaded] = useState<LoadedRun | null>(null);
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);
  const [writeResult, setWriteResult] = useState<WriteBackView | null>(null);
  const [decisions, setDecisions] = useState<Map<string, { approve: boolean }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [writing, setWriting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preparingRef = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const [run, summary, proposalResponse] = await Promise.all([
        getRun(runId, signal),
        getRunSummary(runId, signal),
        listProposals(runId, signal),
      ]);
      let matchedFolder: string | null = null;
      if (summary.watch_id && summary.matched_rule_id) {
        const rules = await listWatchRules(summary.watch_id, signal);
        const matched = rules.rules.find((rule) => rule.rule_id === summary.matched_rule_id);
        matchedFolder = matched ? `${matched.folder_name}/` : null;
      }
      setLoaded({ run, summary, proposals: proposalResponse.proposals, matchedFolder });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "This run could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const shouldPoll = loaded ? !loaded.run.provider_read_error && ["QUEUED", "BASELINING", "EDITING", "COMMITTING", "VERIFYING"].includes(loaded.summary.workflow_state) : false;
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void resumeRun(runId).then(() => load()).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [load, runId, shouldPoll]);

  const prepareDryRun = useCallback(async () => {
    if (preparingRef.current) return;
    preparingRef.current = true;
    setDryRunBusy(true);
    setError(null);
    try {
      const result = await createDryRun(runId);
      setDryRun(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The safety check could not be prepared.");
    } finally {
      preparingRef.current = false;
      setDryRunBusy(false);
    }
  }, [runId]);

  useEffect(() => {
    if (!loaded || dryRun || dryRunBusy || loaded.run.write_back) return;
    if (loaded.summary.ready_for_dry_run || loaded.summary.ready_for_write_back || loaded.summary.dry_run_status === "READY") queueMicrotask(() => void prepareDryRun());
  }, [dryRun, dryRunBusy, loaded, prepareDryRun]);

  const document = useMemo<DocumentIdentityData>(() => {
    if (!loaded) return { name: "Google document", revision: null };
    const origin = loaded.summary.watch_id
      ? `Watch${loaded.matchedFolder ? ` · ${loaded.matchedFolder}` : ""}`
      : "Manual run";
    return { name: loaded.summary.document_name, revision: loaded.summary.source_revision_id, origin };
  }, [loaded]);

  const checkProviderStatus = useCallback(async () => {
    setError(null);
    try {
      await resumeRun(runId);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "SuperDocs status could not be checked.");
    }
  }, [load, runId]);

  async function submitReview() {
    if (!loaded || submitting) return;
    const payload = loaded.proposals.map((proposal) => ({
      proposal_id: proposal.proposal_id,
      approve: decisions.get(proposal.proposal_id)?.approve ?? proposal.decision === "APPROVE",
    }));
    setSubmitting(true);
    setError(null);
    try {
      await submitDecisions(runId, payload);
      setDecisions(new Map());
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review decisions could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function write() {
    if (writing) return;
    setWriting(true);
    setError(null);
    try {
      setWriteResult(await writeBackSafely(runId));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Safe write-back could not be completed.");
    } finally {
      setWriting(false);
    }
  }

  async function decide(choice: ConflictChoice) {
    setDeciding(true);
    setError(null);
    try {
      setWriteResult(await decideWriteConflict(runId, choice));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The conflict decision could not be recorded.");
    } finally {
      setDeciding(false);
    }
  }

  if (loading && !loaded) return <RunDetailSkeleton />;
  if (!loaded) return <RunLoadFailure error={error} onRetry={() => { setLoading(true); void load(); }} />;

  const { run, summary, proposals } = loaded;
  const terminal = writeResult ?? writeBackViewFromPersisted(run, summary);
  const approvedProposal = proposals.find((proposal) => proposal.decision === "APPROVE");
  const approvedChange = approvedProposal ? { oldText: extractText(approvedProposal.old_html), newText: extractText(approvedProposal.new_html) } : undefined;

  let content;
  if (summary.write_authorization_status === "REQUIRED" || summary.write_back_status === "WRITE_AUTHORIZATION_REQUIRED") {
    content = <WriteAuthorization runId={runId} providerFileId={summary.provider_file_id} document={document} onAuthorized={() => void load()} />;
  } else if (terminal) {
    content = <WriteBackResult document={document} fileId={summary.provider_file_id} dryRun={dryRun} change={approvedChange} result={terminal} deciding={deciding} onDecision={(choice) => void decide(choice)} />;
  } else if (summary.review_status === "AWAITING_DECISIONS" || run.state === "AWAITING_REVIEW") {
    content = <ReviewPanel document={document} proposals={proposals.length ? proposals : run.pending_proposals} decisions={decisions} submitting={submitting} onDecide={(proposalId, approve) => setDecisions((current) => new Map(current).set(proposalId, { approve }))} onSubmitAll={() => void submitReview()} />;
  } else if (dryRun?.status === "READY") {
    content = <DryRunSummary document={document} dryRun={dryRun} writing={writing} onWrite={() => void write()} />;
  } else if (dryRunBusy) {
    content = <PreparingSafetyCheck document={document} />;
  } else if (dryRun) {
    content = <SafetyStop document={document} dryRun={dryRun} onRetry={() => void prepareDryRun()} />;
  } else if (shouldPoll || run.provider_read_error) {
    content = <ProcessingState document={document} run={run} onCheckStatus={checkProviderStatus} />;
  } else {
    content = <RunAttention document={document} summary={summary} onRefresh={() => void load()} />;
  }

  return (
    <div>
      <div className="border-b border-border px-5 py-2 sm:px-8 lg:px-10">
        <Link href="/runs" className="inline-flex min-h-10 items-center gap-2 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" />All runs</Link>
      </div>
      {error ? <div className="px-5 pt-5 sm:px-8 lg:px-10"><InlineNotice tone="warning">{error}</InlineNotice></div> : null}
      {content}
    </div>
  );
}

export function writeBackViewFromPersisted(run: RunView, summary: RunSummary): WriteBackView | null {
  const persisted = run.write_back;
  if (!persisted) return null;
  return {
    run_id: run.run_id,
    status: persisted.status,
    write_plan_id: persisted.write_plan_id ?? "",
    write_plan_sha256: persisted.write_plan_sha256 ?? "",
    backup_created: persisted.backup_created,
    backup_verified: persisted.backup_verified,
    source_revision_verified: false,
    write_applied: persisted.write_applied,
    structurally_verified: persisted.structurally_verified,
    baseline_revision_id: summary.conflict?.baseline_revision_id ?? summary.source_revision_id,
    resulting_revision_id: persisted.resulting_revision_id,
    attention_code: run.attention_code,
    preview: persisted.preview,
    conflict: summary.conflict ? {
      baseline_revision_id: summary.conflict.baseline_revision_id,
      latest_revision_id: summary.conflict.latest_revision_id,
      detection_stage: summary.conflict.detection_stage,
      detected_at: summary.updated_at,
      backup_created: persisted.backup_created,
      decision: summary.conflict.decision,
    } : null,
  };
}

function PreparingSafetyCheck({ document }: { document: DocumentIdentityData }) {
  return <div><DocumentIdentity document={document} /><WorkflowProgress current="Safety check" /><section className="mx-auto max-w-[720px] px-5 py-16 sm:px-8"><h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">Proving the write is safe</h1><p className="mt-3 text-[14px] text-muted">Matching the approved old text, source revision, structural location, and guarded write operation.</p><div className="mt-9 space-y-5">{["Approved review located", "Mapping exact source range", "Preparing revision guard"].map((label, index) => <div key={label} className="flex gap-3"><StateMark state={index === 0 ? "complete" : index === 1 ? "current" : "idle"} /><span className="text-[14px] text-ink">{label}</span></div>)}</div></section></div>;
}

function SafetyStop({ document, dryRun, onRetry }: { document: DocumentIdentityData; dryRun: DryRunView; onRetry: () => void }) {
  const recovery = safetyFailureRecovery(dryRun.reason_code);
  return <div><DocumentIdentity document={document} /><WorkflowProgress current="Safety check" warning /><section className="mx-auto max-w-[760px] px-5 py-14 sm:px-8"><h1 className="text-[30px] font-semibold tracking-[-0.04em] text-ink">Safety check stopped</h1><div className="mt-6"><InlineNotice tone="warning">{dryRun.reason ?? "DocRelay could not produce a unique, current write plan."}</InlineNotice></div>{dryRun.reason_code ? <p className="mt-4 font-mono text-[11px] text-muted">{dryRun.reason_code}</p> : null}{recovery.explanation ? <p className="mt-5 max-w-[650px] text-[14px] leading-6 text-muted">{recovery.explanation}</p> : null}{recovery.kind === "refresh-source" ? <Link href="/" className="mt-7 inline-flex min-h-11 items-center justify-center rounded-md border border-accent bg-surface px-4 text-[14px] font-semibold text-accent transition-colors hover:bg-accent-soft">{recovery.label}</Link> : <Button variant="secondary" className="mt-7" onClick={onRetry}>{recovery.label}</Button>}</section></div>;
}

function RunAttention({ document, summary, onRefresh }: { document: DocumentIdentityData; summary: RunSummary; onRefresh: () => void }) {
  const unknown = summary.write_back_status === "UNKNOWN" || summary.external_effects_unknown > 0;
  return <div><DocumentIdentity document={document} /><WorkflowProgress current="Write-back" warning /><section className="mx-auto max-w-[760px] px-5 py-14 sm:px-8"><h1 className="text-[30px] font-semibold tracking-[-0.04em] text-ink">{unknown ? "External effect needs verification" : "This run needs attention"}</h1><div className="mt-6"><InlineNotice tone={unknown ? "info" : "warning"}>{unknown ? "DocRelay cannot prove the external outcome yet. It will not automatically repeat the write." : "The workflow stopped without a verified write-back result."}</InlineNotice></div>{summary.last_error_code ? <p className="mt-4 font-mono text-[11px] text-muted">{summary.last_error_code}</p> : null}<Button variant="secondary" className="mt-7" onClick={onRefresh}><RefreshCw className="size-4" />Refresh run</Button></section></div>;
}

function RunDetailSkeleton() { return <div className="space-y-4 px-5 py-8 sm:px-8 lg:px-10"><Skeleton className="h-10 w-32" /><Skeleton className="h-20 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-[420px] w-full" /></div>; }
function RunLoadFailure({ error, onRetry }: { error: string | null; onRetry: () => void }) { return <section className="mx-auto max-w-[700px] px-5 py-20 sm:px-8"><h1 className="text-[30px] font-semibold text-ink">Run unavailable</h1><div className="mt-6"><InlineNotice tone="warning">{error ?? "The run could not be loaded."}</InlineNotice></div><Button variant="secondary" className="mt-7" onClick={onRetry}>Try again</Button></section>; }
