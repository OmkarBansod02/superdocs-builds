import { Check } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Button as PrimitiveButton } from "@/components/ui/button";
import { Skeleton as PrimitiveSkeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { StatusBanner } from "./feedback";

const variantMap = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const;

export function Button({
  variant = "primary",
  busy = false,
  className = "",
  children,
  disabled,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
  /** Render a link (or other element) with button geometry, so no screen
      needs to hand-roll a button-shaped anchor. */
  asChild?: boolean;
}) {
  return (
    <PrimitiveButton
      {...props}
      asChild={asChild}
      variant={variantMap[variant]}
      disabled={asChild ? undefined : disabled || busy}
      className={cn(className)}
    >
      {asChild ? (
        children
      ) : (
        <>
          {busy ? <Spinner className="size-4" /> : null}
          {children}
        </>
      )}
    </PrimitiveButton>
  );
}

export function StateMark({
  state = "idle",
  label,
}: {
  state?: "idle" | "current" | "complete" | "warning" | "info";
  label?: string;
}) {
  const styles = {
    idle: "border-border bg-surface text-transparent",
    current: "border-primary bg-primary text-primary-foreground",
    complete: "border-primary-line bg-success-soft text-success",
    warning: "border-warning/40 bg-warning-soft text-warning",
    info: "border-info/40 bg-info-soft text-info",
  };
  return (
    <span className={cn("grid size-[18px] shrink-0 place-items-center rounded-[5px] border", styles[state])} aria-label={label}>
      {state === "complete" ? <Check className="size-3" strokeWidth={2.5} /> : null}
    </span>
  );
}

export function InlineNotice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "info";
  children: ReactNode;
}) {
  if (tone === "neutral") {
    return <div className="rounded-[10px] border border-border-light bg-surface px-3.5 py-3 text-[14px] leading-[1.6] text-ink">{children}</div>;
  }
  return <StatusBanner tone={tone}>{children}</StatusBanner>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <PrimitiveSkeleton className={className} />;
}
