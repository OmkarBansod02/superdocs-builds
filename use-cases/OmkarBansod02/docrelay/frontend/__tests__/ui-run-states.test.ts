import { describe, expect, it } from "vitest";
import type { RunSummary } from "../app/lib/api";
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
