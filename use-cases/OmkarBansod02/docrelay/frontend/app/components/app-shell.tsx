"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
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

import { getAuthorizeUrl, getConnections, type GoogleConnection } from "../lib/api";
import { ICON_STROKE, icons } from "../lib/icons";

const SIDEBAR_WIDTH = "220px";

const navigation = [
  { href: "/", label: "Workspace", icon: icons.workspace },
  { href: "/watch", label: "Watch", icon: icons.watch },
  { href: "/runs", label: "Runs", icon: icons.runs },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getConnections(controller.signal)
      .then((response) => {
        setConnection(response.connections.find((item) => item.status === "CONNECTED") ?? null);
      })
      .catch(() => setConnection(null));
    return () => controller.abort();
  }, []);

  return (
    <div
      className="min-h-dvh overflow-x-hidden bg-background lg:grid"
      style={{ gridTemplateColumns: `${SIDEBAR_WIDTH} minmax(0, 1fr)` }}
    >
      <aside className="hidden min-h-dvh flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarChrome pathname={pathname} connection={connection} />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-border bg-surface px-3 lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                className="size-9 text-foreground"
              >
                <icons.menu className="size-4" strokeWidth={ICON_STROKE} />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[220px] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[220px]"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarChrome
                pathname={pathname}
                connection={connection}
                onNavigate={() => setMobileOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <Brand compact />
          <div className="ml-auto">
            <ConnectionIndicator connection={connection} compact />
          </div>
        </header>

        <header className="hidden h-12 items-center justify-end border-b border-border bg-surface px-6 lg:flex">
          <ConnectionIndicator connection={connection} />
        </header>

        <main className="min-h-0 min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function SidebarChrome({
  pathname,
  connection,
  onNavigate,
}: {
  pathname: string;
  connection: GoogleConnection | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-dvh flex-col">
      <Brand />
      <ScrollArea className="min-h-0 flex-1">
        <PrimaryNavigation pathname={pathname} onNavigate={onNavigate} />
      </ScrollArea>
      <Separator className="bg-sidebar-border" />
      <AccountArea connection={connection} />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", compact ? "" : "h-14 px-4")}>
      <span
        className={cn(
          "grid size-7 place-items-center rounded-[6px]",
          compact ? "bg-primary text-primary-foreground" : "bg-sidebar-primary text-sidebar-primary-foreground",
        )}
        aria-hidden="true"
      >
        <icons.document className="size-3.5" strokeWidth={2} />
      </span>
      <span
        className={cn(
          "text-[15px] font-semibold tracking-[-0.03em]",
          compact ? "text-foreground" : "text-sidebar-foreground",
        )}
      >
        DocRelay
      </span>
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
    <nav aria-label="Primary" className="space-y-0.5 px-2 py-3">
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
                ? "bg-white/[0.06] text-sidebar-foreground"
                : "text-sidebar-muted hover:bg-white/[0.04] hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className={cn("size-4", active ? "text-sidebar-primary" : "text-current")}
              strokeWidth={ICON_STROKE}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountArea({ connection }: { connection: GoogleConnection | null }) {
  const connected = connection?.status === "CONNECTED";

  return (
    <div className="p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-[180ms] hover:bg-white/[0.04]"
          >
            <span className="grid size-7 place-items-center rounded-md bg-white/[0.06] text-sidebar-foreground">
              <icons.account className="size-3.5" strokeWidth={ICON_STROKE} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-sidebar-foreground">Account</span>
              <span className="block truncate text-[11px] text-sidebar-muted">
                {connected ? "Google Drive connected" : "Google Drive"}
              </span>
            </span>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                connected ? "bg-sidebar-primary" : "bg-sidebar-muted/60",
              )}
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel>Google Drive</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => window.location.assign(getAuthorizeUrl())}>
            {connected ? "Reconnect Drive" : "Connect Google Drive"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ConnectionIndicator({
  connection,
  compact = false,
}: {
  connection: GoogleConnection | null;
  compact?: boolean;
}) {
  const connected = connection?.status === "CONNECTED";
  const label = connected ? "Drive connected" : "Drive not connected";
  const Icon = icons.drive;

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[12px] text-muted",
        compact ? "" : "px-1",
      )}
    >
      <Icon className="size-3.5" strokeWidth={ICON_STROKE} />
      {compact ? null : <span>{label}</span>}
      <span
        className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-border")}
        aria-hidden="true"
      />
    </span>
  );

  if (!compact) {
    return (
      <div className="flex items-center" aria-label={label}>
        {content}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label}>{content}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
