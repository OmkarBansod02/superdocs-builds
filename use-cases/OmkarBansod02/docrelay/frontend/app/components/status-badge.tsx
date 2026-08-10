export function StatusBadge({
  variant,
  children,
}: {
  variant: "success" | "warning" | "error" | "neutral" | "accent";
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    error: "bg-error-soft text-error",
    neutral: "bg-surface-muted text-muted",
    accent: "bg-accent-soft text-accent",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${styles[variant]}`}
    >
      {children}
    </span>
  );
}
