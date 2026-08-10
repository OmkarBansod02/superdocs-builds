"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ProposalView, SourceRegistration } from "../lib/api";
import { SourceSummary } from "./source-summary";
import { ProposalDiff } from "./document-canvas";
import { StatusBadge } from "./status-badge";

export function ReviewPanel({
  source,
  proposals,
  decisions,
  submitting,
  onDecide,
  onSubmitAll,
}: {
  source: SourceRegistration;
  proposals: ProposalView[];
  decisions: Map<string, { approve: boolean; feedback?: string }>;
  submitting: boolean;
  onDecide: (proposalId: string, approve: boolean) => void;
  onSubmitAll: () => void;
}) {
  const allDecided = proposals.every((p) => decisions.has(p.proposal_id) || p.decision !== null);
  const hasAnyNew = proposals.some((p) => decisions.has(p.proposal_id));

  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />

      <div className="bg-surface-muted rounded-lg p-6 sm:p-8">
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="mb-6">
            <h2 className="text-base font-semibold text-ink mb-1">Review proposals</h2>
            <p className="text-sm text-muted">
              Approve or reject each proposed change. All decisions must be explicit.
            </p>
          </div>

          {proposals.map((proposal) => {
            const existing = proposal.decision;
            const pending = decisions.get(proposal.proposal_id);
            const decided = existing !== null || pending !== undefined;
            const approved = pending?.approve ?? (existing === "APPROVE");

            return (
              <div
                key={proposal.proposal_id}
                className="bg-surface border border-border rounded-md overflow-hidden"
              >
                <div className="px-5 py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted uppercase tracking-wide">
                      Proposed change
                    </span>
                    {decided && (
                      <StatusBadge variant={approved ? "success" : "error"}>
                        {approved ? "Approved" : "Rejected"}
                      </StatusBadge>
                    )}
                    {!decided && <StatusBadge variant="warning">Pending</StatusBadge>}
                  </div>

                  <ProposalDiff proposal={proposal} />

                  {proposal.ai_explanation && (
                    <div className="text-xs text-muted leading-relaxed pt-1">
                      <span className="font-medium">SuperDocs:</span> {proposal.ai_explanation}
                    </div>
                  )}

                  {existing === null && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => onDecide(proposal.proposal_id, false)}
                        disabled={submitting}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                          pending && !pending.approve
                            ? "bg-error-soft text-error border border-error/30"
                            : "bg-surface-muted text-muted hover:text-error hover:bg-error-soft border border-border"
                        } disabled:opacity-50`}
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Reject
                      </button>
                      <button
                        onClick={() => onDecide(proposal.proposal_id, true)}
                        disabled={submitting}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                          pending?.approve
                            ? "bg-success-soft text-success border border-success/30"
                            : "bg-surface-muted text-muted hover:text-success hover:bg-success-soft border border-border"
                        } disabled:opacity-50`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Approve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {allDecided && hasAnyNew && (
            <div className="flex justify-end pt-2">
              <button
                onClick={onSubmitAll}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  "Submit decisions"
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
