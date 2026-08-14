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
import {
  hideRecentDocument,
  readHiddenRecents,
  restoreRecentDocument,
  subscribeToHiddenRecents,
} from "../lib/recent-preferences";
import { ICON_STROKE, icons } from "@/lib/icons";

const SIDEBAR_WIDTH = "236px";

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
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    const sync = () => setHidden(readHiddenRecents());
    sync();
    return subscribeToHiddenRecents(sync);
  }, []);

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

  // Working on a document again makes it eligible for Recent, even if it was
  // previously removed from the list.
  useEffect(() => {
    if (activeFileId) restoreRecentDocument(activeFileId);
  }, [activeFileId]);

  const visibleRecent = connection ? recent.filter((item) => !hidden.has(item.providerFileId)) : [];

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
      <aside className="hidden h-dvh min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarChrome
          pathname={pathname}
          connection={connection}
          recent={visibleRecent}
          activeFileId={activeFileId}
          onNewDocument={() => router.push("/")}
          onOpenRecent={openRecent}
          onRemoveRecent={hideRecentDocument}
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
              className="w-[236px] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[236px]"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarChrome
                pathname={pathname}
                connection={connection}
                recent={visibleRecent}
                activeFileId={activeFileId}
                onNavigate={() => setMobileOpen(false)}
                onOpenRecent={openRecent}
                onRemoveRecent={hideRecentDocument}
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
  onRemoveRecent,
}: {
  pathname: string;
  connection: GoogleConnection | null;
  recent: RecentDocument[];
  activeFileId: string | null;
  onNavigate?: () => void;
  onOpenRecent: (document: RecentDocument) => void;
  onNewDocument?: () => void;
  onRemoveRecent: (providerFileId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Brand />
      <NewDocumentButton pathname={pathname} onNavigate={onNavigate} onNewDocument={onNewDocument} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 px-3 pt-4 pb-3">
          <PrimaryNavigation pathname={pathname} onNavigate={onNavigate} />
          <RecentDocuments
            documents={recent}
            activeFileId={activeFileId}
            connected={Boolean(connection)}
            onOpen={onOpenRecent}
            onNavigate={onNavigate}
            onRemove={onRemoveRecent}
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
    <div className={cn("flex items-center gap-2", compact ? "" : "h-14 shrink-0 px-4")}>
      <span
        className="grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <icons.document className="size-3.5" strokeWidth={2} />
      </span>
      <span className="text-[14.5px] font-semibold tracking-[-0.028em] text-sidebar-foreground">
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
    <div className="px-3">
      <Button
        type="button"
        variant="outline"
        className="h-9 w-full justify-start gap-2 border-sidebar-border bg-surface px-2.5 text-[13.5px] text-sidebar-foreground shadow-[var(--shadow-subtle)] hover:bg-surface hover:shadow-[var(--shadow-raised)]"
        onClick={() => {
          onNavigate?.();
          if (pathname === "/") {
            window.dispatchEvent(new Event(NEW_DOCUMENT_EVENT));
            return;
          }
          onNewDocument?.();
        }}
      >
        <icons.plus className="size-4 text-sidebar-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
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
              "type-nav relative flex h-8 items-center gap-2.5 rounded-md px-2 transition-[background-color,color] duration-[var(--motion-duration)] ease-[var(--motion-ease)]",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className={cn("size-4 shrink-0", active ? "text-primary" : "text-sidebar-muted")}
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
  onRemove,
}: {
  documents: RecentDocument[];
  activeFileId: string | null;
  connected: boolean;
  onOpen: (document: RecentDocument) => void;
  onNavigate?: () => void;
  onRemove: (providerFileId: string) => void;
}) {
  return (
    <section aria-label="Recent documents" className="flex flex-col gap-1.5">
      <h2 className="type-section-heading px-2">Recent</h2>
      {documents.length > 0 ? (
        <ul className="flex flex-col">
          {documents.map((document) => (
            <RecentDocumentRow
              key={document.providerFileId}
              document={document}
              active={activeFileId === document.providerFileId}
              connected={connected}
              onOpen={onOpen}
              onNavigate={onNavigate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-[12.5px] text-sidebar-muted">
          {connected ? "No documents yet." : "Connect Drive to see documents."}
        </p>
      )}
      <Link
        href="/runs"
        onClick={onNavigate}
        aria-label="View all documents in Activity"
        className="type-caption mt-1 inline-flex items-center gap-0.5 px-2 py-1 text-sidebar-muted transition-colors duration-[var(--motion-duration)] hover:text-sidebar-foreground"
      >
        View all documents
        <icons.chevronRight className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden="true" />
      </Link>
    </section>
  );
}

function RecentDocumentRow({
  document,
  active,
  connected,
  onOpen,
  onNavigate,
  onRemove,
}: {
  document: RecentDocument;
  active: boolean;
  connected: boolean;
  onOpen: (document: RecentDocument) => void;
  onNavigate?: () => void;
  onRemove: (providerFileId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const timestamp = formatRelativeTime(document.updatedAt);

  return (
    <li
      className={cn(
        "group/recent relative rounded-md transition-colors duration-[var(--motion-duration)] ease-[var(--motion-ease)]",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-[var(--motion-duration)]",
        active ? "bg-primary-soft" : "hover:bg-sidebar-accent/60",
        menuOpen && !active ? "bg-sidebar-accent/60" : "",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onOpen(document)}
            disabled={!connected}
            aria-current={active ? "true" : undefined}
            aria-label={timestamp ? `${document.name}, ${timestamp}` : document.name}
            className="flex w-full items-start gap-2 rounded-md px-2 py-[7px] pr-8 text-left outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <icons.document
              className={cn(
                "mt-px size-4 shrink-0",
                active ? "text-primary" : "text-sidebar-muted",
              )}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium tracking-[-0.012em] text-sidebar-foreground">
                {document.name}
              </span>
              <span className="mt-px block truncate text-[11.5px] text-sidebar-muted">
                {active ? (timestamp ? `Open · ${timestamp}` : "Open") : timestamp}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[16rem]">
          {document.name}
        </TooltipContent>
      </Tooltip>

      <div className="absolute top-1.5 right-1.5 grid size-6 place-items-center">
        {active && !menuOpen ? (
          <span
            className="col-start-1 row-start-1 size-1.5 rounded-full bg-primary transition-opacity duration-[var(--motion-duration)] group-hover/recent:opacity-0"
            aria-hidden="true"
          />
        ) : null}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${document.name}`}
              className={cn(
                "col-start-1 row-start-1 grid size-6 place-items-center rounded-[6px] text-sidebar-muted transition-[opacity,background-color,color] duration-[var(--motion-duration)] ease-[var(--motion-ease)]",
                "hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100",
                menuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100",
              )}
            >
              <icons.more className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="right" className="w-48">
            <DropdownMenuItem asChild>
              <Link href="/runs" onClick={onNavigate}>
                <icons.activity strokeWidth={ICON_STROKE} aria-hidden="true" />
                View activity
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onRemove(document.providerFileId)}
            >
              <icons.hide strokeWidth={ICON_STROKE} aria-hidden="true" />
              Remove from Recents
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function AccountArea({ connection }: { connection: GoogleConnection | null }) {
  const connected = connection?.status === "CONNECTED";

  return (
    <div className="flex flex-col gap-0.5 p-3">
      <div className="flex items-center gap-2 px-2 py-1">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connected ? "bg-success" : "bg-sidebar-border",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-sidebar-muted">
          Google Drive · {connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--motion-duration)] hover:bg-sidebar-accent/60 aria-expanded:bg-sidebar-accent/60"
          >
            <icons.account className="size-[18px] shrink-0 text-sidebar-muted" strokeWidth={ICON_STROKE} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
              Account
            </span>
            <icons.chevronDown className="size-3.5 shrink-0 text-sidebar-muted" strokeWidth={ICON_STROKE} aria-hidden="true" />
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
