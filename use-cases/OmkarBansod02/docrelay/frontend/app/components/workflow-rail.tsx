import { CheckCircle2, Circle, FileText, Pencil, Search, Shield } from "lucide-react";
import type { WorkflowStage } from "../lib/workspace-state";

const steps: { key: WorkflowStage; label: string; icon: typeof FileText }[] = [
  { key: "source", label: "Source", icon: FileText },
  { key: "edit", label: "SuperDocs edit", icon: Pencil },
  { key: "review", label: "Review", icon: Search },
  { key: "dry-run", label: "Dry run", icon: Shield },
];

function stageIndex(stage: string): number {
  const map: Record<string, number> = {
    source: 0,
    "source-selected": 0,
    edit: 1,
    processing: 1,
    review: 2,
    "dry-run": 3,
    unsupported: 3,
    complete: 4,
    error: -1,
  };
  return map[stage] ?? -1;
}

export function WorkflowRail({ currentStage }: { currentStage: string }) {
  const current = stageIndex(currentStage);

  return (
    <nav className="flex flex-col gap-0.5 py-4 px-3" aria-label="Workflow progress">
      {steps.map((step, i) => {
        const completed = i < current;
        const active = i === current;
        const Icon = step.icon;
        const StatusIcon = completed ? CheckCircle2 : active ? Circle : Circle;

        return (
          <div
            key={step.key}
            className={`
              flex items-center gap-2.5 px-2.5 py-2 rounded text-[13px]
              ${active ? "bg-surface-muted font-medium text-ink" : ""}
              ${completed ? "text-success" : ""}
              ${!active && !completed ? "text-muted" : ""}
            `}
          >
            <StatusIcon
              className={`w-3.5 h-3.5 flex-shrink-0 ${
                completed ? "text-success fill-success" : active ? "text-accent" : "text-border"
              }`}
            />
            <Icon className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
            <span>{step.label}</span>
          </div>
        );
      })}
    </nav>
  );
}
