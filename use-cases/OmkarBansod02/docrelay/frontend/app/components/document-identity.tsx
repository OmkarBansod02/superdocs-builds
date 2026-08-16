import type { ReactNode } from "react";

import { icons } from "@/lib/icons";

export interface DocumentIdentityData {
  name: string;
  revision: string | null;
  origin?: string | null;
}

export function DocumentIdentity({
  document,
  action,
}: {
  document: DocumentIdentityData;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] items-center gap-3.5 border-b border-border-light bg-background px-6 py-4 sm:px-8 lg:px-10">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <icons.document className="size-[18px]" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-[16px] font-semibold tracking-[-0.022em] text-ink sm:text-[17px]">
          {document.name}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted">
          <span>Google Drive</span>
          {document.revision ? (
            <>
              <span className="h-3 w-px bg-border" aria-hidden="true" />
              <span>
                Revision <span className="type-mono text-[11px]">{shortId(document.revision)}</span>
              </span>
            </>
          ) : null}
          {document.origin ? (
            <>
              <span className="h-3 w-px bg-border" aria-hidden="true" />
              <span className="text-muted-soft">{document.origin}</span>
            </>
          ) : null}
        </div>
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}

export function shortId(value: string, length = 10): string {
  if (value.length <= length) return value;
  return `${value.slice(0, 6)}…${value.slice(-3)}`;
}
