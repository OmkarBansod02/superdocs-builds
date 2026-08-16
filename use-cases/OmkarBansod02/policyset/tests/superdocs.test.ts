import { describe, expect, it } from "vitest";

import { SuperDocsClient, SuperDocsInvalidResponse, buildStartChatPayload } from "@/superdocs";
import { DOCX_MIME, PDF_MIME } from "@/superdocs/types";

describe("SuperDocs chat request", () => {
  it("omits document_id when the caller does not pin a document", async () => {
    expect(buildStartChatPayload({ sessionId: "sess-1", message: "Edit both policies" })).not.toHaveProperty(
      "document_id",
    );

    let body: unknown;
    const client = new SuperDocsClient({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          job_id: "job-1",
          session_id: "sess-1",
          status: "pending",
        });
      },
    });

    await client.startChat({ sessionId: "sess-1", message: "Edit both policies" });
    expect(body).toEqual({
      message: "Edit both policies",
      session_id: "sess-1",
      approval_mode: "ask_every_time",
      response_mode: "full",
    });
    expect(body).not.toHaveProperty("document_id");
  });

  it("includes document_id only when an explicit pin is provided", () => {
    expect(
      buildStartChatPayload({
        sessionId: "sess-1",
        message: "Edit this document",
        documentId: "doc_primary",
      }),
    ).toMatchObject({ document_id: "doc_primary" });
  });
});

describe("SuperDocs export helper", () => {
  it("focuses and verifies identity before exporting", async () => {
    const calls: string[] = [];
    const client = new SuperDocsClient({
      apiKey: "test-key",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/focus")) {
          return jsonResponse({ focused_document_id: "doc_primary" });
        }
        if (url.includes("/documents/export")) {
          return binaryResponse(DOCX_MIME, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        }
        throw new Error(`unexpected request ${url}`);
      },
    });

    const artifact = await client.exportFocusedDocument(
      { sessionId: "sess-1", documentId: "doc_primary" },
      { format: "docx", filename: "terms-of-service.docx" },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/sessions/sess-1/documents/doc_primary/focus");
    expect(calls[1]).toContain("/documents/export");
    expect(artifact.contentType).toBe(DOCX_MIME);
  });

  it("does not export when focus returns a different document", async () => {
    const calls: string[] = [];
    const client = new SuperDocsClient({
      apiKey: "test-key",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/focus")) {
          return jsonResponse({ focused_document_id: "doc_other" });
        }
        return binaryResponse(PDF_MIME, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      },
    });

    await expect(
      client.exportFocusedDocument(
        { sessionId: "sess-1", documentId: "doc_primary" },
        { format: "pdf", filename: "terms-of-service.pdf" },
      ),
    ).rejects.toBeInstanceOf(SuperDocsInvalidResponse);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/focus");
    expect(calls.some((call) => call.includes("/export"))).toBe(false);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function binaryResponse(contentType: string, body: Uint8Array): Response {
  return new Response(Buffer.from(body), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}
