// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { contextRange, DiffView } from "../app/components/diff-view";
import { ProcessingState } from "../app/components/processing-state";
import type { RunSummary, RunView } from "../app/lib/api";
import { runStatusDisplay } from "../app/components/run-status";

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-1",
    watch_id: null,
    originating_scan_id: null,
    source_id: "source-1",
    provider_file_id: "file-1",
    document_name: "Document",
    provider_version: "5",
    source_revision_id: "rev-5",
    matched_rule_id: null,
    matched_rule_version: null,
    workflow_state: "AWAITING_REVIEW",
    review_status: "AWAITING_DECISIONS",
    write_authorization_status: null,
    dry_run_status: "NOT_REQUESTED",
    write_back_status: "AWAITING_REVIEW",
    verification_status: null,
    last_error_code: null,
    conflict: null,
    ready_for_dry_run: false,
    ready_for_write_back: false,
    export: null,
    started_at: null,
    updated_at: "2026-08-12T12:00:00Z",
    finished_at: null,
    duration_ms: null,
    external_effect_count: 0,
    external_effect_attempt_count: 0,
    external_effects_unknown: 0,
    superdocs_usage: {},
    ...overrides,
  };
}

describe("operational run state labels", () => {
  it("keeps authorization, conflict, unknown effect, and verified success distinct", () => {
    expect(runStatusDisplay(run({ write_back_status: "WRITE_AUTHORIZATION_REQUIRED" })).label).toBe("Write authorization required");
    expect(runStatusDisplay(run({ write_back_status: "CONFLICT" })).label).toBe("Conflict");
    expect(runStatusDisplay(run({ write_back_status: "UNKNOWN" })).label).toBe("External outcome unknown");
    expect(runStatusDisplay(run({ write_back_status: "WRITE_VERIFIED", verification_status: "PASSED" })).label).toBe("Verified");
  });
});

describe("contextual write preview", () => {
  it("highlights exact variable-length spans while preserving surrounding context", () => {
    const before = {
      text: "Payment is due within 45 days after receipt.",
      highlight_start: 22,
      highlight_end: 29,
    };
    const after = {
      text: "Payment is due within six business days after receipt.",
      highlight_start: 22,
      highlight_end: 39,
    };

    expect(contextRange(before.text, "45 days", before)).toEqual({ start: 22, end: 29 });
    expect(contextRange(after.text, "six business days", after)).toEqual({ start: 22, end: 39 });
    expect(before.text.slice(0, before.highlight_start)).toBe(
      after.text.slice(0, after.highlight_start),
    );
    expect(before.text.slice(before.highlight_end)).toBe(after.text.slice(after.highlight_end));

    const html = renderToStaticMarkup(
      createElement(DiffView, {
        oldText: "45 days",
        newText: "six business days",
        context: {
          offset_unit: "UNICODE_CODE_POINT",
          before,
          after,
          source_snapshot_id: "snapshot-1",
          native_snapshot_sha256: "a".repeat(64),
        },
      }),
    );
    expect(html).toContain(">45 days</mark>");
    expect(html).toContain(">six business days</mark>");
    expect(html).toContain("Context is read-only");
    expect(html).toContain(" after receipt.");
  });

  it("rejects a context span that does not contain the exact mutation text", () => {
    expect(
      contextRange("Payment is due within 45 days.", "30 days", {
        text: "Payment is due within 45 days.",
        highlight_start: 22,
        highlight_end: 29,
      }),
    ).toBeNull();
    expect(
      contextRange("📄 Payment 45", "45", {
        text: "📄 Payment 45",
        highlight_start: 10,
        highlight_end: 12,
      }),
    ).toEqual({ start: 10, end: 12 });
  });
});

describe("provider status timeout recovery", () => {
  it("shows a truthful read-only retry action and invokes it once", async () => {
    const onCheckStatus = vi.fn(async () => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    const timedOutRun = {
      run_id: "run-1",
      source_id: "source-1",
      provider_revision_id: "revision-1",
      state: "EDITING",
      attention_code: "SUPERDOCS_STATUS_READ_TIMEOUT",
      provider_read_error: {
        code: "SUPERDOCS_STATUS_READ_TIMEOUT",
        operation: "jobs.get",
        retryable: true,
        observed_at: "2026-08-13T16:24:00Z",
        occurrence_count: 1,
      },
      session_id: "session-1",
      session_document_id: "document-1",
      durable_document_id: "durable-1",
      upload_version_id: "upload-1",
      final_version_id: null,
      provider_job_id: "job-1",
      provider_job_status: "in_progress",
      awaiting_kind: null,
      pending_proposals: [],
      export: null,
      write_back: null,
    } satisfies RunView;

    await act(async () => {
      root.render(
        createElement(ProcessingState, {
          document: { name: "Agreement", revision: "revision-1" },
          run: timedOutRun,
          onCheckStatus,
        }),
      );
    });

    expect(container.textContent).toContain("No cloud write was made.");
    expect(container.textContent).toContain("only reads jobs.get");
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Check status again"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(onCheckStatus).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
