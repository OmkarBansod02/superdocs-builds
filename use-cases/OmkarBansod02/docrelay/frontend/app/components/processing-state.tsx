import { Loader2 } from "lucide-react";
import type { RunView, SourceRegistration } from "../lib/api";
import { humanRunState, attentionMessage } from "../lib/workspace-state";
import { SourceSummary } from "./source-summary";
import { DocumentCanvas } from "./document-canvas";

export function ProcessingState({
  source,
  run,
}: {
  source: SourceRegistration;
  run: RunView;
}) {
  const attention = attentionMessage(run.attention_code);

  return (
    <div className="space-y-5">
      <SourceSummary source={source} compact />
      <DocumentCanvas title={source.source.name}>
        <div className="flex flex-col items-center py-8 text-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
          <p className="text-sm font-medium text-ink mb-1">
            {humanRunState(run.state)}
          </p>
          <p className="text-xs text-muted">
            SuperDocs is processing your edit request.
          </p>
          {attention && (
            <div className="mt-4 px-4 py-2.5 bg-warning-soft border border-warning/20 rounded text-xs text-warning max-w-sm">
              {attention}
            </div>
          )}
        </div>
      </DocumentCanvas>
    </div>
  );
}
