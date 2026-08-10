import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  canWriteBack,
  conflictActions,
  isVerifiedWriteSuccess,
} from "../app/lib/write-back-state";

describe("Phase 6 write-back state", () => {
  it("enables write only for a READY dry-run", () => {
    expect(canWriteBack("READY", false)).toBe(true);
    expect(canWriteBack("STALE", false)).toBe(false);
    expect(canWriteBack("READY", true)).toBe(false);
  });

  it("shows success only for verified backend success", () => {
    expect(isVerifiedWriteSuccess("WRITE_VERIFIED", true)).toBe(true);
    expect(isVerifiedWriteSuccess("WRITE_VERIFIED", false)).toBe(false);
    expect(isVerifiedWriteSuccess("IN_PROGRESS", true)).toBe(false);
  });

  it("offers only explicit cancel and review-latest conflict choices", () => {
    expect(conflictActions).toEqual([
      { choice: "CANCEL", label: "Cancel write-back" },
      { choice: "REVIEW_LATEST", label: "Review latest version" },
    ]);
    expect(JSON.stringify(conflictActions).toLowerCase()).not.toContain("overwrite");
  });

  it("guards the workspace write call with one in-flight claim", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../app/components/workspace.tsx"),
      "utf-8",
    );
    expect(source).toContain("writeInFlightRef.current");
    expect(source.match(/await writeBackSafely\(/g)).toHaveLength(1);
  });

  it("renders the conflict hero without an overwrite action", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../app/components/write-back-result.tsx"),
      "utf-8",
    );
    expect(source).toContain("Document changed in Google Drive");
    expect(source).toContain("DocRelay did not overwrite it.");
    expect(source.toLowerCase()).not.toContain("overwrite anyway");
  });
});
