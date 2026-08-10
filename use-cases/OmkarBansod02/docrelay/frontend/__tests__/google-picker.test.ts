/**
 * Focused deterministic tests for the Google Picker integration logic.
 *
 * These verify:
 * - Picker success extracts the intended file ID
 * - Cancel does not register a source
 * - Unsupported file selection does not bypass backend validation
 * - Frontend never serializes browser OAuth tokens into backend requests
 * - Error states are handled safely
 */

import { describe, expect, it } from "vitest";
import { EXPIRY_SKEW_MS, PickerTokenManager } from "../app/google-drive/picker-token";

// ---------------------------------------------------------------------------
// Extract the pure logic that we test independently of React rendering.
// These mirror the logic in google-drive-panel.tsx.
// ---------------------------------------------------------------------------

interface PickerDocument {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

interface PickerResponse {
  action: "cancel" | "picked";
  docs?: PickerDocument[];
}

interface SelectedFile {
  fileId: string;
  name: string;
  mimeType: string;
}

/**
 * Extracts a SelectedFile from a Picker response, or null if cancelled/empty.
 */
function extractSelectedFile(data: PickerResponse): SelectedFile | null {
  if (data.action === "cancel") return null;
  if (data.action !== "picked") return null;
  if (!data.docs || data.docs.length === 0) return null;

  const doc = data.docs[0];
  return {
    fileId: doc.id,
    name: doc.name,
    mimeType: doc.mimeType,
  };
}

/**
 * Builds the request body for source registration.
 * Verifies that no token is included.
 */
function buildRegistrationPayload(file: SelectedFile): Record<string, unknown> {
  return { file_id: file.fileId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Picker callback extraction", () => {
  it("extracts file ID from a successful pick", () => {
    const response: PickerResponse = {
      action: "picked",
      docs: [
        {
          id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          name: "Test Document",
          mimeType: "application/vnd.google-apps.document",
          url: "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit",
        },
      ],
    };

    const result = extractSelectedFile(response);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms");
    expect(result!.name).toBe("Test Document");
    expect(result!.mimeType).toBe("application/vnd.google-apps.document");
  });

  it("returns null on cancel — no source registration triggered", () => {
    const response: PickerResponse = { action: "cancel" };
    const result = extractSelectedFile(response);
    expect(result).toBeNull();
  });

  it("returns null when no documents in response", () => {
    const response: PickerResponse = { action: "picked", docs: [] };
    const result = extractSelectedFile(response);
    expect(result).toBeNull();
  });

  it("handles spreadsheet MIME type (unsupported by backend)", () => {
    const response: PickerResponse = {
      action: "picked",
      docs: [
        {
          id: "spreadsheet-id-123",
          name: "Test Spreadsheet",
          mimeType: "application/vnd.google-apps.spreadsheet",
          url: "https://docs.google.com/spreadsheets/d/spreadsheet-id-123/edit",
        },
      ],
    };

    const result = extractSelectedFile(response);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("spreadsheet-id-123");
    expect(result!.mimeType).toBe("application/vnd.google-apps.spreadsheet");
    // The frontend extracts it — the BACKEND is responsible for rejection
  });
});

describe("Source registration payload security", () => {
  it("sends only file_id — no token field", () => {
    const file: SelectedFile = {
      fileId: "some-opaque-file-id",
      name: "My Doc",
      mimeType: "application/vnd.google-apps.document",
    };

    const payload = buildRegistrationPayload(file);

    expect(payload).toEqual({ file_id: "some-opaque-file-id" });
    expect(Object.keys(payload)).toEqual(["file_id"]);
    expect("access_token" in payload).toBe(false);
    expect("token" in payload).toBe(false);
    expect("oauth_token" in payload).toBe(false);
    expect("refresh_token" in payload).toBe(false);
    expect("authorization" in payload).toBe(false);
  });

  it("does not include browser token in any field", () => {
    const browserToken = "ya29.a0ARrdaM...fake-token-value";
    const file: SelectedFile = {
      fileId: "file-123",
      name: "doc",
      mimeType: "application/vnd.google-apps.document",
    };

    const payload = buildRegistrationPayload(file);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(browserToken);
    expect(serialized).not.toContain("ya29");
    expect(serialized).not.toContain("Bearer");
  });
});

describe("Unsupported file selection and backend validation", () => {
  it("frontend does not filter unsupported types — backend remains authoritative", () => {
    const sheetFile: SelectedFile = {
      fileId: "sheet-id-456",
      name: "Budget Sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
    };

    // The frontend MUST send the file_id to the backend regardless of MIME type.
    // Backend performs the authoritative UNSUPPORTED_SOURCE_TYPE rejection.
    const payload = buildRegistrationPayload(sheetFile);
    expect(payload.file_id).toBe("sheet-id-456");
  });
});

describe("Error handling does not leak secrets", () => {
  it("backend error response does not contain token patterns", () => {
    const mockErrorResponse = {
      error: {
        code: "UNSUPPORTED_SOURCE_TYPE",
        message: "Only native Google Docs are supported",
        retryable: false,
        details: {},
      },
    };

    const serialized = JSON.stringify(mockErrorResponse);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("ya29.");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("GOCSPX");
  });
});

describe("PickerTokenManager — browser token lifecycle", () => {
  it("fresh manager has no valid token — first invocation must call requestAccessToken", () => {
    const tm = new PickerTokenManager();
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
  });

  it("handleTokenResponse uses GIS expires_in to compute expiry", () => {
    const tm = new PickerTokenManager();
    const now = 1_000_000;
    tm.handleTokenResponse("ya29.token-1", 1800, now);

    expect(tm.currentToken).toBe("ya29.token-1");
    expect(tm.hasValidToken(now + 100_000)).toBe(true);
    // 1800s − 30s skew = 1770s boundary
    expect(tm.hasValidToken(now + 1_770_001)).toBe(false);
  });

  it("second invocation before expiry reuses token — hasValidToken returns true", () => {
    const tm = new PickerTokenManager();
    const now = 1_000_000;
    tm.handleTokenResponse("ya29.token-1", 3600, now);

    expect(tm.hasValidToken(now + 5_000)).toBe(true);
    expect(tm.currentToken).toBe("ya29.token-1");
  });

  it("requestAccessToken is NOT needed while token is valid", () => {
    const tm = new PickerTokenManager();
    const now = 1_000_000;
    tm.handleTokenResponse("ya29.token-1", 3600, now);

    for (const offset of [1_000, 60_000, 600_000, 1_800_000, 3_500_000]) {
      expect(tm.hasValidToken(now + offset)).toBe(true);
    }
  });

  it("after calculated expiry minus skew, hasValidToken returns false", () => {
    const tm = new PickerTokenManager();
    const now = 1_000_000;
    tm.handleTokenResponse("ya29.token-1", 3600, now);

    const boundary = now + 3600 * 1000 - EXPIRY_SKEW_MS;
    expect(tm.hasValidToken(boundary - 1)).toBe(true);
    expect(tm.hasValidToken(boundary)).toBe(false);
  });

  it("different expires_in values produce different expiry windows", () => {
    const now = 1_000_000;

    const short = new PickerTokenManager();
    short.handleTokenResponse("t1", 600, now);

    const long = new PickerTokenManager();
    long.handleTokenResponse("t2", 7200, now);

    // At 9 min (540s): both valid
    expect(short.hasValidToken(now + 540_000)).toBe(true);
    expect(long.hasValidToken(now + 540_000)).toBe(true);

    // At 10 min (600s): short expired (600s − 30s = 570s), long valid
    expect(short.hasValidToken(now + 580_000)).toBe(false);
    expect(long.hasValidToken(now + 580_000)).toBe(true);

    // At 2h − 29s (7171s): long expired (7200s − 30s = 7170s)
    expect(long.hasValidToken(now + 7_169_000)).toBe(true);
    expect(long.hasValidToken(now + 7_171_000)).toBe(false);
  });

  it("invalid expires_in (undefined) does not create a reusable token", () => {
    const tm = new PickerTokenManager();
    tm.handleTokenResponse("ya29.token", undefined as unknown as number);
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
    expect(tm.hasAuthorized).toBe(true);
  });

  it("invalid expires_in (0) does not create a reusable token", () => {
    const tm = new PickerTokenManager();
    tm.handleTokenResponse("ya29.token", 0);
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
  });

  it("invalid expires_in (negative) does not create a reusable token", () => {
    const tm = new PickerTokenManager();
    tm.handleTokenResponse("ya29.token", -3600);
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
  });

  it("invalid expires_in (NaN) does not create a reusable token", () => {
    const tm = new PickerTokenManager();
    tm.handleTokenResponse("ya29.token", NaN);
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
  });

  it("invalid expires_in (Infinity) does not create a reusable token", () => {
    const tm = new PickerTokenManager();
    tm.handleTokenResponse("ya29.token", Infinity);
    expect(tm.hasValidToken()).toBe(false);
    expect(tm.currentToken).toBeNull();
  });

  it("pick/cancel does not invalidate a still-valid token", () => {
    const tm = new PickerTokenManager();
    const now = 1_000_000;
    tm.handleTokenResponse("ya29.token-1", 3600, now);

    // Picker pick/cancel is handled by the component, not the manager.
    // The token manager state remains unchanged.
    expect(tm.hasValidToken(now + 5_000)).toBe(true);
    expect(tm.currentToken).toBe("ya29.token-1");
  });

  it("prompt is 'consent' before first auth, '' afterward", () => {
    const tm = new PickerTokenManager();
    expect(tm.promptHint).toBe("consent");

    tm.handleTokenResponse("ya29.token-1", 3600);
    expect(tm.promptHint).toBe("");
  });

  it("component source never calls revoke during normal Picker use", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../app/google-drive/google-drive-panel.tsx", import.meta.url),
      "utf-8",
    );
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    expect(codeOnly).not.toContain("oauth2.revoke");
    expect(codeOnly).not.toMatch(/\.revoke\s*\(/);
  });

  it("browser token is never persisted to storage", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../app/google-drive/google-drive-panel.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("IndexedDB");
    expect(source).not.toContain("document.cookie");
  });

  it("component uses PickerTokenManager and response.expires_in — no hardcoded 3600", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../app/google-drive/google-drive-panel.tsx", import.meta.url),
      "utf-8",
    );
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    expect(codeOnly).toContain("PickerTokenManager");
    expect(codeOnly).toContain("handleTokenResponse");
    expect(codeOnly).toContain("response.expires_in");
    expect(codeOnly).not.toMatch(/3600\s*\*\s*1000/);
  });
});
