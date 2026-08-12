"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Box, Check, FileText, List } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getConnections, type GoogleConnection } from "../lib/api";

const navigation: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Workspace", icon: Box },
  { href: "/watch", label: "Watch", icon: Bell },
  { href: "/runs", label: "Runs", icon: List },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [connection, setConnection] = useState<GoogleConnection | null>(null);

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
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="hidden min-h-dvh border-r border-border bg-surface lg:flex lg:flex-col">
        <Brand />
        <PrimaryNavigation pathname={pathname} />
      </aside>

      <div className="min-w-0 pb-[76px] lg:pb-0">
        <header className="flex h-[72px] items-center justify-between border-b border-border bg-surface px-5 sm:px-8 lg:h-[80px] lg:px-10">
          <div className="lg:hidden"><Brand compact /></div>
          <ConnectionIndicator connection={connection} />
        </header>

        <main className="min-h-[calc(100dvh-80px)]">{children}</main>
      </div>

      <nav aria-label="Primary navigation" className="fixed inset-x-0 bottom-0 z-30 grid h-[76px] grid-cols-3 border-t border-border bg-surface lg:hidden">
        {navigation.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-11 flex-col items-center justify-center gap-1 text-[12px] font-medium transition-colors ${active ? "text-accent" : "text-muted hover:text-ink"}`}
            >
              {active ? <span className="absolute inset-x-5 top-0 h-0.5 bg-accent" /> : null}
              <Icon className="size-5" strokeWidth={1.75} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${compact ? "" : "h-[80px] border-b border-border px-6"}`}>
      <span className="relative grid size-8 place-items-center rounded-[6px] bg-accent text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.2)]" aria-hidden="true">
        <FileText className="size-[18px]" strokeWidth={2.25} />
      </span>
      <span className="text-[19px] font-semibold tracking-[-0.035em] text-ink">DocRelay</span>
    </div>
  );
}

function PrimaryNavigation({ pathname, mobile = false }: { pathname: string; mobile?: boolean }) {
  return (
    <nav aria-label={mobile ? "Menu" : "Primary"} className={mobile ? "space-y-1" : "space-y-1 p-3 pt-8"}>
      {navigation.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-12 items-center gap-3 rounded-lg px-4 text-[15px] font-medium transition-colors ${active ? "bg-surface-muted text-accent" : "text-ink hover:bg-surface-muted"}`}
          >
            <Icon className="size-5" strokeWidth={1.7} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ConnectionIndicator({ connection }: { connection: GoogleConnection | null }) {
  const connected = connection?.status === "CONNECTED";
  return (
    <div className="ml-auto mr-4 flex items-center gap-2 text-[13px] text-muted lg:mr-0 lg:text-[14px]">
      <span className={`grid size-5 place-items-center border ${connected ? "border-success text-success" : "border-border text-muted"}`} aria-hidden="true">
        {connected ? <Check className="size-3.5" strokeWidth={2.25} /> : null}
      </span>
      <span className="hidden sm:inline">Google Drive {connected ? "connected" : "not connected"}</span>
      <span className="sm:hidden">Drive</span>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
