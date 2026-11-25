import { CheckIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import type { DispatchStepRun, DispatchTaskCard } from "~/state/velaDispatch";
import { resolveGatePipelinePercent, resolveGateStages } from "./dispatchModel";

export function DispatchGatePipeline({
  step,
  run,
  compact = false,
}: {
  readonly step: DispatchTaskCard;
  readonly run: DispatchStepRun | undefined;
  readonly compact?: boolean | undefined;
}) {
  const stages = resolveGateStages(step, run);
  const fillPercent = resolveGatePipelinePercent(stages);
  const hasFailed = stages.some((stage) => stage.status === "failed");
  const hasActive = stages.some((stage) => stage.status === "active");
  const gridColsClass =
    stages.length <= 2
      ? "grid-cols-2"
      : stages.length === 3
        ? "grid-cols-3"
        : "grid-cols-4";

  return (
    <div
      className={cn(
        "rounded-lg border",
        compact
          ? "space-y-1.5 border-border/45 bg-muted/15 px-2.5 py-2"
          : "space-y-2 border-border/55 bg-muted/20 px-3 py-2.5",
      )}
    >
      <div className={cn("relative flex items-center justify-between", compact ? "px-3" : "px-4")}>
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 h-0.5 -translate-y-1/2 overflow-hidden bg-border/80",
            compact ? "right-3 left-3" : "right-4 left-4",
          )}
        >
          <div
            className={cn(
              "h-full w-full origin-left transition-transform duration-500 ease-out",
              hasFailed ? "bg-destructive/70" : "bg-foreground/75",
            )}
            style={{ transform: `scaleX(${fillPercent / 100})` }}
          />
          {hasActive && (
            <span
              ref={observeVisibleAnimation}
              aria-hidden="true"
              className="visible-animate-dispatch-sweep pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/85 to-transparent"
            />
          )}
        </div>

        {stages.map((stage) => (
          <div
            key={stage.key}
            className={cn(
              "relative z-10 flex items-center justify-center rounded-full bg-background",
              compact ? "size-4.5" : "size-5",
            )}
          >
            {stage.status === "active" && (
              <span
                ref={observeVisibleAnimation}
                aria-hidden="true"
                className="visible-animate-dispatch-ping pointer-events-none absolute inset-0 rounded-full border border-foreground/50"
              />
            )}
            <span
              className={cn(
                "flex items-center justify-center rounded-full border transition-colors duration-300",
                compact ? "size-3.5" : "size-4",
                stage.status === "passed" && "border-foreground bg-foreground text-background",
                stage.status === "active" && "border-foreground bg-background",
                stage.status === "failed" &&
                  "border-destructive bg-destructive text-destructive-foreground",
                stage.status === "skipped" &&
                  "border-dashed border-muted-foreground/35 bg-muted/40",
                stage.status === "pending" && "border-border bg-background",
              )}
            >
              {stage.status === "passed" && (
                <CheckIcon className={compact ? "size-2.5" : "size-3"} strokeWidth={2.5} />
              )}
              {stage.status === "failed" && (
                <XIcon className={compact ? "size-2.5" : "size-3"} strokeWidth={2.5} />
              )}
              {stage.status === "active" && (
                <span className="size-1.5 rounded-full bg-foreground" />
              )}
            </span>
          </div>
        ))}
      </div>

      <div className={cn("grid gap-1.5 text-center", gridColsClass)}>
        {stages.map((stage) => (
          <span
            key={stage.key}
            className={cn(
              "text-xs leading-tight",
              stage.status === "active" && "font-medium text-foreground",
              stage.status === "passed" && "text-foreground/85",
              stage.status === "failed" && "font-medium text-destructive",
              stage.status === "skipped" && "text-muted-foreground/50 line-through",
              stage.status === "pending" && "text-muted-foreground/80",
            )}
          >
            {stage.label}
          </span>
        ))}
      </div>
    </div>
  );
}
