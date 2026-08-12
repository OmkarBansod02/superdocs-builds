import { Check, Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "primary",
  busy = false,
  className = "",
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  const variants = {
    primary: "border-accent bg-accent text-white hover:bg-accent-strong",
    secondary: "border-accent bg-surface text-accent hover:bg-accent-soft",
    ghost: "border-transparent bg-transparent text-accent hover:bg-accent-soft",
    danger: "border-error/40 bg-surface text-error hover:bg-error-soft",
  };
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 text-[14px] font-semibold transition-colors disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-muted/60 ${variants[variant]} ${className}`}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function StateMark({ state = "idle", label }: { state?: "idle" | "current" | "complete" | "warning" | "info"; label?: string }) {
  const styles = {
    idle: "border-muted/60 bg-surface text-transparent",
    current: "border-accent bg-accent text-white",
    complete: "border-success bg-surface text-success",
    warning: "border-warning bg-surface text-warning",
    info: "border-info bg-surface text-info",
  };
  return (
    <span className={`grid size-5 shrink-0 place-items-center border ${styles[state]}`} aria-label={label}>
      {state === "complete" ? <Check className="size-3.5" strokeWidth={2.4} /> : null}
    </span>
  );
}

export function InlineNotice({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warning" | "info"; children: ReactNode }) {
  const styles = {
    neutral: "border-border text-ink",
    success: "border-success/30 text-success",
    warning: "border-warning/35 bg-warning-soft/70 text-warning",
    info: "border-info/25 bg-info-soft text-info",
  };
  return <div className={`border-l-2 px-4 py-3 text-[14px] leading-6 ${styles[tone]}`}>{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-muted ${className}`} aria-hidden="true" />;
}
