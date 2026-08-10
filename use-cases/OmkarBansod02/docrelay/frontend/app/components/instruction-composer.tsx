"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import type { SourceRegistration } from "../lib/api";
import { SourceSummary } from "./source-summary";
import { DocumentCanvas } from "./document-canvas";

export function InstructionComposer({
  source,
  submitting,
  onSubmit,
  onChangeSource,
}: {
  source: SourceRegistration;
  submitting: boolean;
  onSubmit: (instruction: string) => void;
  onChangeSource: () => void;
}) {
  const [instruction, setInstruction] = useState("");

  const canSubmit = instruction.trim().length > 0 && !submitting;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SourceSummary source={source} compact />
        <button
          onClick={onChangeSource}
          className="text-xs text-muted hover:text-ink transition-colors"
        >
          Change source
        </button>
      </div>

      <DocumentCanvas title={source.source.name}>
        <div className="space-y-4">
          <p className="text-sm text-muted leading-relaxed">
            This document is loaded from Google Docs. Describe the change you want SuperDocs to make.
          </p>

          <div>
            <label htmlFor="instruction" className="block text-xs font-medium text-muted mb-1.5">
              What should DocRelay change?
            </label>
            <textarea
              id="instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={'e.g. Change "45 days" to "30 days" and nothing else.'}
              rows={3}
              disabled={submitting}
              className="w-full px-3 py-2.5 bg-surface-muted border border-border rounded text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 resize-none disabled:opacity-50"
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={() => canSubmit && onSubmit(instruction.trim())}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  Ask SuperDocs
                </>
              )}
            </button>
          </div>
        </div>
      </DocumentCanvas>
    </div>
  );
}
