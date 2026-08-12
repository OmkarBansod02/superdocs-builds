import { StateMark } from "./ui";

const steps = ["Source", "Instruction", "Review", "Safety check", "Write-back"] as const;
export type WorkflowStep = (typeof steps)[number];

export function WorkflowProgress({ current, warning = false }: { current: WorkflowStep; warning?: boolean }) {
  const currentIndex = steps.indexOf(current);
  return (
    <nav aria-label="Document workflow" className="border-b border-border px-5 sm:px-8 lg:px-10">
      <div className="py-4 sm:hidden">
        <div className="flex items-center justify-between text-[13px]">
          <span className="flex items-center gap-2.5 font-semibold text-ink"><StateMark state={warning ? "warning" : "current"} />{current}</span>
          <span className="text-muted">Step {currentIndex + 1} of {steps.length}</span>
        </div>
        <div className="mt-3 h-0.5 bg-border" aria-hidden="true"><span className={`block h-full ${warning ? "bg-warning" : "bg-accent"}`} style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }} /></div>
      </div>
      <ol className="hidden items-center py-5 sm:flex">
        {steps.map((step, index) => {
          const complete = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li key={step} className="flex flex-1 items-center last:flex-none">
              <div className={`flex items-center gap-2.5 text-[13px] ${active ? "font-semibold text-ink" : "text-muted"}`}>
                <StateMark state={complete ? "complete" : active ? (warning ? "warning" : "current") : "idle"} />
                <span>{step}</span>
              </div>
              {index < steps.length - 1 ? <span className="mx-4 h-px min-w-8 flex-1 bg-border" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
