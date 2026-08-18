"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { UserInstructionTurn } from "../lib/conversation";
import { UserAvatar } from "./brand";
import { ConversationComposer } from "./conversation-composer";
import {
  DocRelayEvent,
  PersistedRunEvent,
  TurnFrame,
  VerifiedWriteEvent,
} from "./conversation-events";

export function ConversationPanel({
  title,
  stateLabel,
  turns,
  draft,
  busy,
  composerEnabled,
  onDraftChange,
  onSubmit,
  onRetry,
  children,
}: {
  title: string;
  stateLabel?: string;
  turns: UserInstructionTurn[];
  draft: string;
  busy: boolean;
  composerEnabled: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (instruction: string) => void;
  onRetry: (turn: UserInstructionTurn) => void;
  children?: ReactNode;
}) {
  const empty = turns.length === 0 && !children;

  return (
    // The surrounding pane owns the separation, so this panel never draws its
    // own outer divider.
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden bg-conversation"
      aria-label="Document conversation"
    >
      {/* Same band as the document header: one strip of chrome runs across the
          whole workbench. The thread's state lives here and nowhere else. */}
      <header className="chrome-band gap-3 px-5">
        <h2 className="type-conversation-title min-w-0 flex-1 truncate">{title}</h2>
        {stateLabel ? <StateHint label={stateLabel} /> : null}
      </header>

      <ScrollArea className="scrollbar-inset min-h-0 min-w-0 flex-1">
        {/* Widening the pane adds breathing room around the thread rather than
            stretching every line to the edges. */}
        <div className="mx-auto flex min-h-full w-full max-w-[576px] min-w-0 flex-col px-5 pt-7 pb-6">
          {empty ? (
            <EmptyConversation />
          ) : (
            // Looser between exchanges than inside one, so an instruction and
            // the answer to it read as a single unit.
            <ol className="flex min-w-0 flex-col gap-9" aria-label="Conversation">
              {turns.map((turn) => {
                // Reconstructed turns carry a persisted event; the active run does not.
                const historical = turn.persistedEvent !== undefined;
                return (
                  <li key={turn.id} className="min-w-0 space-y-5">
                    <UserTurn
                      turn={turn}
                      historical={historical}
                      onRetry={onRetry}
                      busy={busy}
                    />
                    {turn.persistedEvent ? (
                      <PersistedRunEvent event={turn.persistedEvent} />
                    ) : null}
                    {turn.verifiedWrite ? (
                      <VerifiedWriteEvent evidence={turn.verifiedWrite} />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {children ? <div className={cn("min-w-0", empty ? "" : "mt-9")}>{children}</div> : null}
        </div>
      </ScrollArea>

      <ConversationComposer
        value={draft}
        busy={busy}
        enabled={composerEnabled}
        onChange={onDraftChange}
        onSubmit={onSubmit}
      />
    </section>
  );
}

/** The one state chip in the conversation header, in the shared pill geometry. */
function StateHint({ label }: { label: string }) {
  const attention = label === "Needs attention" || label === "Conflict";
  const positive = label === "Active" || label === "Verified" || label === "Ready";
  const working = label === "Loading" || label === "Writing";
  return (
    <span
      className={cn(
        "pill shrink-0",
        attention ? "pill-warning" : positive ? "pill-accent" : "pill-neutral",
      )}
    >
      <span
        className={cn(
          "size-[6px] rounded-full",
          attention ? "bg-warning" : positive ? "bg-primary" : "bg-muted-soft",
          working ? "live-dot" : "",
        )}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function EmptyConversation() {
  return (
    <DocRelayEvent title="Ready when you are.">
      <p className="type-message text-muted">
        Describe the change you want in this document. DocRelay prepares it, shows you exactly what
        would change, and writes nothing until you approve.
      </p>
    </DocRelayEvent>
  );
}

function UserTurn({
  turn,
  historical,
  onRetry,
  busy,
}: {
  turn: UserInstructionTurn;
  historical: boolean;
  onRetry: (turn: UserInstructionTurn) => void;
  busy: boolean;
}) {
  return (
    <TurnFrame
      label="You"
      speaker="You"
      avatar={<UserAvatar className="size-7" tone={historical ? "soft" : "solid"} />}
      meta={
        turn.status === "pending" ? (
          <span className="pill pill-neutral shrink-0">Sending…</span>
        ) : undefined
      }
    >
      {/* Tone and identity carry the instruction, not a border: it rests on a
          quiet plate at the same reading size as DocRelay's reply, and a
          border appears only where there is a real state to report. */}
      <div
        className={cn(
          "type-message min-w-0 rounded-[var(--radius-card)] px-3.5 py-2.5",
          turn.status === "failed"
            ? "border border-destructive/25 bg-error-soft py-3"
            : "bg-surface-sunken",
        )}
      >
        <p className="break-words whitespace-pre-wrap">{turn.text}</p>
        {turn.status === "failed" ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-destructive/15 pt-3">
            <p className="text-[13px] leading-5 text-destructive">
              {turn.error ?? "The instruction was not sent."}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRetry(turn)}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </TurnFrame>
  );
}
