import { Loader2 } from "lucide-react";
import type { RunView, SourceRegistration } from "../lib/api";
import { humanRunState, attentionMessage } from "../lib/workspace-state";
import { DocumentIdentity } from "./document-identity";
import { WorkflowProgress } from "./workflow-progress";
import { InlineNotice, StateMark } from "./ui";
import type { DocumentIdentityData } from "./document-identity";

export function ProcessingState({
  source,
  document,
  run,
}: {
  source?: SourceRegistration;
  document?: DocumentIdentityData;
  run: RunView;
}) {
  const attention = attentionMessage(run.attention_code);
  const identity = document ?? (source
    ? { name: source.source.name, revision: source.baseline.revision_id }
    : { name: "Google document", revision: run.provider_revision_id });

  return (
    <div>
      <DocumentIdentity document={identity} />
      <WorkflowProgress current="Instruction" />
      <section className="mx-auto max-w-[760px] px-5 py-14 sm:px-8 lg:py-20">
        <div className="flex items-center gap-4">
          <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
          <div>
            <h2 className="text-[25px] font-semibold tracking-[-0.03em] text-ink">Preparing your change</h2>
            <p className="mt-1 text-[14px] text-muted">{humanRunState(run.state)}</p>
          </div>
        </div>
        <ol className="mt-10 border-l border-border pl-7">
          {processingSteps(run.state).map((step) => (
            <li key={step.label} className="relative flex min-h-16 items-start gap-3">
              <span className="absolute -left-[37px] bg-background"><StateMark state={step.state} /></span>
              <div>
                <p className={`text-[14px] ${step.state === "current" ? "font-semibold text-ink" : "text-muted"}`}>{step.label}</p>
                {step.detail ? <p className="mt-1 text-[12px] text-muted">{step.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
        {attention ? <div className="mt-5"><InlineNotice tone="warning">{attention}</InlineNotice></div> : null}
      </section>
    </div>
  );
}

function processingSteps(state: RunView["state"]): { label: string; detail?: string; state: "idle" | "current" | "complete" }[] {
  const active = state === "QUEUED" ? 0 : state === "BASELINING" ? 1 : 2;
  return [
    { label: "Reading source", detail: "Using the selected immutable Google revision." },
    { label: "Preparing SuperDocs session" },
    { label: "Analyzing instruction" },
    { label: "Preparing proposed change" },
    { label: "Waiting for review" },
  ].map((item, index) => ({ ...item, state: index < active ? "complete" as const : index === active ? "current" as const : "idle" as const }));
}
