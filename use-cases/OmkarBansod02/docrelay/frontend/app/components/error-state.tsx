import { AlertTriangle } from "lucide-react";

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
    <div className="max-w-md mx-auto py-16 text-center">
      <div className="w-12 h-12 rounded-lg bg-warning-soft flex items-center justify-center mx-auto mb-4">
        <AlertTriangle className="w-6 h-6 text-warning" />
      </div>
      <h2 className="text-base font-semibold text-ink mb-2">Something needs attention</h2>
      <p className="text-sm text-muted mb-6">{message}</p>
      {recoverable && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-ink text-white text-sm font-medium rounded hover:bg-ink/90 transition-colors"
        >
          Try again
        </button>
      )}
      <button
        onClick={onRetry}
        className={`${recoverable ? "ml-3" : ""} px-4 py-2 bg-surface-muted text-ink text-sm font-medium rounded border border-border hover:bg-border/30 transition-colors`}
      >
        Start over
      </button>
    </div>
  );
}
