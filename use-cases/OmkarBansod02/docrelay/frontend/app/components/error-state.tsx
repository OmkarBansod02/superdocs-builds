import { ICON_STROKE, icons } from "@/lib/icons";

import { Button } from "./ui";

export function ErrorState({
  message,
  recoverable,
  onRetry,
}: {
  message: string;
  recoverable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-[440px] rounded-[var(--radius-plate)] border border-border-light bg-surface px-7 py-9 text-center shadow-[var(--shadow-raised)]">
        <span className="mx-auto grid size-10 place-items-center rounded-[9px] bg-warning-soft text-warning" aria-hidden="true">
          <icons.warning className="size-5" strokeWidth={ICON_STROKE} />
        </span>
        <h2 className="mt-5 text-[16px] font-semibold tracking-[-0.022em] text-ink">Something needs attention</h2>
        <p className="mx-auto mt-2 max-w-[24rem] text-[13.5px] leading-[1.62] text-muted">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {recoverable ? <Button onClick={onRetry}>Try again</Button> : null}
          <Button variant="secondary" onClick={onRetry}>Start over</Button>
        </div>
      </div>
    </div>
  );
}
