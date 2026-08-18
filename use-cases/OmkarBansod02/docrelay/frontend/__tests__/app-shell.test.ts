// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & Record<string, unknown>) => createElement("a", { href, ...props }, children),
}));

vi.mock("../app/lib/api", () => ({
  getAuthorizeUrl: () => "http://localhost:8000/api/v1/google/oauth/authorize",
  getConnections: vi.fn(async () => ({
    oauth_configured: true,
    selected_scopes: [],
    connections: [],
  })),
  listRuns: vi.fn(async () => ({ runs: [] })),
}));

import { getConnections, listRuns, type RunSummary } from "../app/lib/api";
import { AppShell } from "../app/components/app-shell";
import { TooltipProvider } from "../components/ui/tooltip";
import { ACTIVE_DOCUMENT_EVENT, NEW_DOCUMENT_EVENT } from "../app/lib/conversation";
import {
  hideRecentDocument,
  readHiddenRecents,
  restoreRecentDocument,
} from "../app/lib/recent-preferences";

function runSummary(overrides: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-1",
    watch_id: null,
    originating_scan_id: null,
    source_id: "source-1",
    provider_file_id: "file-1",
    document_name: "Vendor Agreement",
    instruction: "Change payment terms.",
    proposal_count: 1,
    provider_version: "5",
    source_revision_id: "rev-5",
    matched_rule_id: null,
    matched_rule_version: null,
    workflow_state: "SUCCEEDED",
    review_status: "REVIEWED",
    write_authorization_status: null,
    dry_run_status: "READY",
    write_back_status: "WRITE_VERIFIED",
    verification_status: "PASSED",
    last_error_code: null,
    conflict: null,
    ready_for_dry_run: false,
    ready_for_write_back: false,
    export: null,
    started_at: null,
    created_at: "2026-08-14T11:59:00Z",
    updated_at: "2026-08-14T12:00:00Z",
    finished_at: null,
    duration_ms: null,
    external_effect_count: 0,
    external_effect_attempt_count: 0,
    external_effects_unknown: 0,
    superdocs_usage: {},
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("application shell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    restoreRecentDocument("file-vendor");
    vi.mocked(getConnections).mockReset();
    vi.mocked(listRuns).mockReset();
    vi.mocked(getConnections).mockResolvedValue({
      oauth_configured: true,
      selected_scopes: [],
      connections: [],
    });
    vi.mocked(listRuns).mockResolvedValue({ runs: [] });
  });

  it("renders primary navigation and brand without changing routes", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AppShell, null, createElement("div", { id: "workspace-slot" }, "Workspace content")),
        ),
      );
    });
    await flushEffects();

    expect(container.textContent).toContain("DocRelay");
    expect(container.textContent).toContain("New document");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Watch");
    expect(container.textContent).not.toMatch(/\bRuns\b/);
    expect(container.textContent).toContain("View all documents");
    expect(container.textContent).toContain("Workspace content");
    expect(container.querySelector('a[href="/"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('a[href="/watch"]')?.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector('a[href="/runs"]')).not.toBeNull();
    expect(container.querySelector("aside")?.className).toContain("bg-sidebar");

    root.unmount();
  });

  it("renders recent documents from real runs and hides backup artifacts", async () => {
    vi.mocked(getConnections).mockResolvedValue({
      oauth_configured: true,
      selected_scopes: [],
      connections: [{
        connection_id: "conn-1",
        provider: "GOOGLE",
        status: "CONNECTED",
        granted_scopes: [],
        last_validated_at: null,
        disconnected_at: null,
      }],
    });
    vi.mocked(listRuns).mockResolvedValue({
      runs: [
        runSummary({
          run_id: "run-1",
          provider_file_id: "file-vendor",
          document_name: "Vendor Agreement",
          updated_at: "2026-08-14T12:00:00Z",
        }),
        runSummary({
          run_id: "run-2",
          provider_file_id: "file-backup",
          document_name: "Vendor Agreement — DocRelay backup — 2026-08-14T12-00-00Z — A1roV34H9ERMvb0",
          updated_at: "2026-08-14T12:01:00Z",
        }),
      ],
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AppShell, null, createElement("div", null, "Workspace content")),
        ),
      );
    });
    await flushEffects();

    expect(listRuns).toHaveBeenCalled();
    expect(container.textContent).toContain("Vendor Agreement");
    expect(container.textContent).not.toContain("DocRelay backup");
    expect(container.querySelector('[aria-label="Recent documents"]')).not.toBeNull();
    expect(container.querySelector('a[href="/runs"]')?.getAttribute("aria-label")).toContain("Activity");

    root.unmount();
  });

  it("keeps New document as a reset action on the workspace route", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const received: Event[] = [];
    const onNew = (event: Event) => received.push(event);
    window.addEventListener(NEW_DOCUMENT_EVENT, onNew);

    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AppShell, null, createElement("div", null, "Workspace content")),
        ),
      );
    });
    await flushEffects();

    const button = Array.from(container.querySelectorAll("button")).find((item) => (
      item.textContent?.includes("New document")
    ));
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(received).toHaveLength(1);

    window.removeEventListener(NEW_DOCUMENT_EVENT, onNew);
    root.unmount();
  });
  it("removes a document from Recents without touching run history", async () => {
    vi.mocked(getConnections).mockResolvedValue({
      oauth_configured: true,
      selected_scopes: [],
      connections: [{
        connection_id: "conn-1",
        provider: "GOOGLE",
        status: "CONNECTED",
        granted_scopes: [],
        last_validated_at: null,
        disconnected_at: null,
      }],
    });
    vi.mocked(listRuns).mockResolvedValue({
      runs: [
        runSummary({
          run_id: "run-1",
          provider_file_id: "file-vendor",
          document_name: "Vendor Agreement",
          updated_at: "2026-08-14T12:00:00Z",
        }),
      ],
    });

    hideRecentDocument("file-vendor");
    expect(readHiddenRecents().has("file-vendor")).toBe(true);

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AppShell, null, createElement("div", null, "Workspace content")),
        ),
      );
    });
    await flushEffects();

    // Hidden from the sidebar list only.
    expect(container.textContent).not.toContain("Vendor Agreement");
    // Durable history is untouched: the run is still returned and Activity stays linked.
    expect(vi.mocked(listRuns).mock.results.length).toBeGreaterThan(0);
    expect(container.querySelector('a[href="/runs"]')).not.toBeNull();

    // Re-opening the document makes it eligible for Recents again.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(ACTIVE_DOCUMENT_EVENT, { detail: { providerFileId: "file-vendor" } }),
      );
    });
    await flushEffects();

    expect(readHiddenRecents().has("file-vendor")).toBe(false);
    expect(container.textContent).toContain("Vendor Agreement");

    root.unmount();
  });
});
