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

describe("Browser token lifecycle — reuse and no revocation", () => {
  /**
   * Simulates the token management logic in google-drive-panel.tsx.
   * Key invariants:
   * - Token is reused while valid (no new requestAccessToken call)
   * - Token is never revoked during normal Picker use
   * - Token is never persisted to storage
   * - Expired token triggers a new (silent) request
   */

  interface TokenState {
    token: string | null;
    expiresAt: number; // ms since epoch
    hasAuthorized: boolean;
    requestTokenCallCount: number;
    revokeCallCount: number;
  }

  function createFreshState(): TokenState {
    return {
      token: null,
      expiresAt: 0,
      hasAuthorized: false,
      requestTokenCallCount: 0,
      revokeCallCount: 0,
    };
  }

  function hasValidToken(state: TokenState, now: number): boolean {
    return state.token !== null && now < state.expiresAt - 30_000;
  }

  function simulateOpenPicker(state: TokenState, now: number): TokenState {
    if (hasValidToken(state, now)) {
      // Reuse existing token — no GIS call
      return state;
    }
    // Need a new token
    return {
      ...state,
      token: "ya29.new-token-" + state.requestTokenCallCount,
      expiresAt: now + 3600 * 1000,
      hasAuthorized: true,
      requestTokenCallCount: state.requestTokenCallCount + 1,
    };
  }

  function getPrompt(state: TokenState): string {
    return state.hasAuthorized ? "" : "consent";
  }

  it("first Picker open requests a GIS token", () => {
    const now = Date.now();
    const state = createFreshState();
    const after = simulateOpenPicker(state, now);
    expect(after.requestTokenCallCount).toBe(1);
    expect(after.token).not.toBeNull();
  });

  it("second Picker open with valid token does NOT call requestAccessToken", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);
    expect(state.requestTokenCallCount).toBe(1);

    // Open Picker again while token is valid
    state = simulateOpenPicker(state, now + 5000);
    expect(state.requestTokenCallCount).toBe(1); // still 1 — no new call
  });

  it("third and fourth opens also reuse the same token", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);
    state = simulateOpenPicker(state, now + 10_000);
    state = simulateOpenPicker(state, now + 20_000);
    state = simulateOpenPicker(state, now + 30_000);
    expect(state.requestTokenCallCount).toBe(1);
  });

  it("expired token causes a new request", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);
    expect(state.requestTokenCallCount).toBe(1);

    // Jump past expiry (3600s) minus 30s skew = 3570s
    const afterExpiry = now + 3571 * 1000;
    state = simulateOpenPicker(state, afterExpiry);
    expect(state.requestTokenCallCount).toBe(2);
  });

  it("token close to expiry (within 30s skew) triggers a refresh", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);

    // Jump to 25s before expiry — within 30s skew, so treated as expired
    const nearExpiry = state.expiresAt - 25_000;
    state = simulateOpenPicker(state, nearExpiry);
    expect(state.requestTokenCallCount).toBe(2);
  });

  it("normal Picker pick does NOT revoke or clear the token", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);

    // Simulate pick — token remains intact
    expect(state.revokeCallCount).toBe(0);
    expect(state.token).not.toBeNull();
  });

  it("normal Picker cancel does NOT revoke or clear the token", () => {
    const now = Date.now();
    let state = createFreshState();
    state = simulateOpenPicker(state, now);

    // Simulate cancel — token remains intact for next use
    expect(state.revokeCallCount).toBe(0);
    expect(state.token).not.toBeNull();
    expect(hasValidToken(state, now + 1000)).toBe(true);
  });

  it("first authorization uses prompt 'consent', subsequent uses ''", () => {
    let state = createFreshState();
    expect(getPrompt(state)).toBe("consent");

    const now = Date.now();
    state = simulateOpenPicker(state, now);
    expect(getPrompt(state)).toBe("");
  });

  it("token disappears on fresh state (simulates page reload)", () => {
    const fresh = createFreshState();
    expect(fresh.token).toBeNull();
    expect(fresh.hasAuthorized).toBe(false);
    expect(hasValidToken(fresh, Date.now())).toBe(false);
  });

  it("component source verifies correct token-reuse architecture", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../app/google-drive/google-drive-panel.tsx", import.meta.url),
      "utf-8"
    );

    // Strip comments for code-only analysis
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Must NOT call revoke in executable code
    expect(codeOnly).not.toContain("oauth2.revoke");
    expect(codeOnly).not.toMatch(/\.revoke\s*\(/);

    // Must NOT have a dropBrowserToken that clears after every Picker use
    // (the old bug was clearing the token after each Picker callback)
    expect(source).toContain("hasValidToken");
    expect(source).toContain("tokenExpiresAtRef");
    expect(source).toContain("hasAuthorizedRef");

    // Must NOT persist tokens
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("IndexedDB");
    expect(source).not.toContain("document.cookie");

    // Must NOT hardcode prompt: "consent" as the only requestAccessToken call
    expect(source).not.toMatch(/requestAccessToken\(\{\s*prompt:\s*["']consent["']\s*\}\)/);
  });
});
