import { FileText } from "lucide-react";
import type { GoogleConnection } from "../lib/api";

export function TopBar({
  connection,
  onChangeSource,
}: {
  connection: GoogleConnection | null;
  onChangeSource?: () => void;
}) {
  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface">
      <div className="flex items-center gap-2.5">
        <FileText className="w-5 h-5 text-accent" />
        <span className="text-[15px] font-semibold tracking-tight text-ink">DocRelay</span>
      </div>
      <div className="flex items-center gap-4">
        <ConnectionIndicator connection={connection} />
        {onChangeSource && (
          <button
            onClick={onChangeSource}
            className="text-xs text-muted hover:text-ink transition-colors"
          >
            Change source
          </button>
        )}
      </div>
    </header>
  );
}

function ConnectionIndicator({ connection }: { connection: GoogleConnection | null }) {
  if (!connection) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-border" />
        Google Drive
      </div>
    );
  }
  const connected = connection.status === "CONNECTED";
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <span
        className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-success" : "bg-warning"}`}
      />
      Google Drive {connected ? "connected" : "needs attention"}
    </div>
  );
}
