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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <PrimitiveButton
      {...props}
      variant={variantMap[variant]}
      disabled={disabled || busy}
      className={cn(className)}
    >
      {busy ? <Spinner className="size-4" /> : null}
      {children}
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
    idle: "border-muted/40 bg-surface text-transparent",
    current: "border-primary bg-primary text-primary-foreground",
    complete: "border-success bg-surface text-success",
    warning: "border-warning bg-surface text-warning",
    info: "border-info bg-surface text-info",
  };
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center rounded-sm border", styles[state])} aria-label={label}>
      {state === "complete" ? <Check className="size-3.5" strokeWidth={2.25} /> : null}
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
    return <div className="border-l-2 border-border px-4 py-3 text-[14px] leading-6 text-ink">{children}</div>;
  }
  return <StatusBanner tone={tone}>{children}</StatusBanner>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <PrimitiveSkeleton className={className} />;
}
