"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { getAuthorizeUrl, getConnections, listRuns, type GoogleConnection } from "../lib/api";
import {
  ACTIVE_DOCUMENT_EVENT,
  NEW_DOCUMENT_EVENT,
  requestOpenRecentDocument,
} from "../lib/conversation";
import {
  formatRelativeTime,
  recentDocumentsFromRuns,
  type RecentDocument,
} from "../lib/import-state";
import { ICON_STROKE, icons } from "@/lib/icons";

const SIDEBAR_WIDTH = "232px";

const navigation = [
  { href: "/", label: "Workspace", icon: icons.workspace },
  { href: "/watch", label: "Watch", icon: icons.watch },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getConnections(controller.signal)
      .then((response) => {
        setConnection(response.connections.find((item) => item.status === "CONNECTED") ?? null);
      })
      .catch(() => setConnection(null));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!connection) return;

    const controller = new AbortController();
    void listRuns(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setRecent(recentDocumentsFromRuns(response.runs));
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (!controller.signal.aborted) setRecent([]);
      });

    return () => controller.abort();
  }, [connection, pathname]);

  useEffect(() => {
    const onActive = (event: Event) => {
      const detail = (event as CustomEvent<{ providerFileId: string | null }>).detail;
      setActiveFileId(detail?.providerFileId ?? null);
    };
    window.addEventListener(ACTIVE_DOCUMENT_EVENT, onActive);
    return () => window.removeEventListener(ACTIVE_DOCUMENT_EVENT, onActive);
  }, []);

  const openRecent = (document: RecentDocument) => {
    if (!connection) return;
    if (activeFileId === document.providerFileId && pathname === "/") {
      setMobileOpen(false);
      return;
    }
    requestOpenRecentDocument({
      fileId: document.providerFileId,
      name: document.name,
      mimeType: "application/vnd.google-apps.document",
    });
    setMobileOpen(false);
    if (pathname !== "/") router.push("/");
  };

  return (
    <div
      className="h-dvh overflow-hidden bg-background lg:grid"
      style={{ gridTemplateColumns: `${SIDEBAR_WIDTH} minmax(0, 1fr)` }}
    >
      <aside className="hidden h-dvh min-h-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarChrome
          pathname={pathname}
          connection={connection}
          recent={connection ? recent : []}
          activeFileId={activeFileId}
          onNewDocument={() => router.push("/")}
          onOpenRecent={openRecent}
        />
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-col bg-conversation">
        <header className="flex h-11 items-center gap-3 px-3 lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                className="size-8 text-foreground"
              >
                <icons.menu strokeWidth={ICON_STROKE} />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[232px] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[232px]"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarChrome
                pathname={pathname}
                connection={connection}
                recent={connection ? recent : []}
                activeFileId={activeFileId}
                onNavigate={() => setMobileOpen(false)}
                onOpenRecent={openRecent}
                onNewDocument={() => {
                  setMobileOpen(false);
                  router.push("/");
                }}
              />
            </SheetContent>
          </Sheet>
          <Brand compact />
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function SidebarChrome({
  pathname,
  connection,
  recent,
  activeFileId,
  onNavigate,
  onOpenRecent,
  onNewDocument,
}: {
  pathname: string;
  connection: GoogleConnection | null;
  recent: RecentDocument[];
  activeFileId: string | null;
  onNavigate?: () => void;
  onOpenRecent: (document: RecentDocument) => void;
  onNewDocument?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Brand />
      <NewDocumentButton pathname={pathname} onNavigate={onNavigate} onNewDocument={onNewDocument} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-2 py-3">
          <PrimaryNavigation pathname={pathname} onNavigate={onNavigate} />
          <RecentDocuments
            documents={recent}
            activeFileId={activeFileId}
            connected={Boolean(connection)}
            onOpen={onOpenRecent}
            onNavigate={onNavigate}
          />
        </div>
      </ScrollArea>
      <Separator className="bg-sidebar-border" />
      <AccountArea connection={connection} />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", compact ? "" : "h-12 px-4")}>
      <span
        className="grid size-6 place-items-center text-primary"
        aria-hidden="true"
      >
        <icons.document className="size-4" strokeWidth={2} />
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.03em] text-sidebar-foreground">
        DocRelay
      </span>
    </div>
  );
}

function NewDocumentButton({
  pathname,
  onNavigate,
  onNewDocument,
}: {
  pathname: string;
  onNavigate?: () => void;
  onNewDocument?: () => void;
}) {
  return (
    <div className="px-2 pb-1">
      <Button
        type="button"
        variant="outline"
        className="h-8 w-full justify-start"
        onClick={() => {
          onNavigate?.();
          if (pathname === "/") {
            window.dispatchEvent(new Event(NEW_DOCUMENT_EVENT));
            return;
          }
          onNewDocument?.();
        }}
      >
        <icons.plus data-icon="inline-start" strokeWidth={ICON_STROKE} aria-hidden="true" />
        New document
      </Button>
    </div>
  );
}

function PrimaryNavigation({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {navigation.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "type-nav relative flex h-8 items-center gap-2.5 rounded-md px-2.5 transition-[background-color,color] duration-[180ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-muted hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className="size-4"
              strokeWidth={ICON_STROKE}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function RecentDocuments({
  documents,
  activeFileId,
  connected,
  onOpen,
  onNavigate,
}: {
  documents: RecentDocument[];
  activeFileId: string | null;
  connected: boolean;
  onOpen: (document: RecentDocument) => void;
  onNavigate?: () => void;
}) {
  return (
    <section aria-label="Recent documents" className="flex flex-col gap-1">
      <h2 className="type-section-heading px-2.5">Recent</h2>
      {documents.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {documents.map((document) => {
            const active = activeFileId === document.providerFileId;
            const timestamp = formatRelativeTime(document.updatedAt);
            return (
              <li key={document.providerFileId}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onOpen(document)}
                      disabled={!connected}
                      aria-current={active ? "true" : undefined}
                      aria-label={timestamp ? `${document.name}, ${timestamp}` : document.name}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-[background-color,color] duration-[180ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
                        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-[180ms]",
                        "disabled:pointer-events-none disabled:opacity-50",
                        active
                          ? "bg-primary-soft text-sidebar-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent",
                      )}
                    >
                      <icons.document
                        className="size-4 shrink-0 text-sidebar-muted"
                        strokeWidth={ICON_STROKE}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium tracking-[-0.012em]">
                          {document.name}
                        </span>
                        {timestamp ? (
                          <span className="block truncate text-[12px] text-sidebar-muted">
                            {timestamp}
                          </span>
                        ) : null}
                      </span>
                      {active ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      ) : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[16rem]">
                    {document.name}
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Link
        href="/runs"
        onClick={onNavigate}
        aria-label="View all documents in Activity"
        className="type-caption mt-0.5 inline-flex items-center gap-0.5 px-2.5 py-1 text-sidebar-muted transition-colors duration-[180ms] hover:text-sidebar-foreground"
      >
        View all documents
        <icons.chevronRight className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden="true" />
      </Link>
    </section>
  );
}

function AccountArea({ connection }: { connection: GoogleConnection | null }) {
  const connected = connection?.status === "CONNECTED";

  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <icons.drive className="size-4 shrink-0 text-sidebar-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-sidebar-foreground">Google Drive</span>
          <span className="block text-[12px] text-sidebar-muted">
            {connected ? "Connected" : "Not connected"}
          </span>
        </span>
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connected ? "bg-success" : "bg-sidebar-border",
          )}
          aria-hidden="true"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[180ms] hover:bg-sidebar-accent"
          >
            <icons.account className="size-4 shrink-0 text-sidebar-muted" strokeWidth={ICON_STROKE} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-sidebar-foreground">Account</span>
              <span className="block truncate text-[12px] text-sidebar-muted">
                {connected ? "Google Drive" : "Connect Drive"}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel>Google Drive</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => window.location.assign(getAuthorizeUrl())}>
              {connected ? "Reconnect Drive" : "Connect Google Drive"}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/runs">Activity</Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
