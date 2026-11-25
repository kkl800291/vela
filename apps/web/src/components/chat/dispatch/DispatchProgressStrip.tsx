/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import type { DispatchStepRun, DispatchTaskCard } from "~/state/velaDispatch";
import { DispatchElapsedTimer } from "./DispatchElapsedTimer";
import {
  isActiveProgressStatus,
  progressSegmentTone,
  STATUS_LABEL,
} from "./dispatchModel";

export function DispatchProgressStrip({
  steps,
  runs,
  onSelectStep,
  onOpenThread,
}: {
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs?: Readonly<Record<string, DispatchStepRun>> | undefined;
  readonly onSelectStep?: ((stepId: string) => void) | undefined;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  if (steps.length === 0) return null;

  const activeStep = steps.find((s) => isActiveProgressStatus(s.status));
  const activeRun = activeStep ? runs?.[activeStep.id] : undefined;

  return (
    <div className="space-y-1.5">
      <div
        className="flex h-1.5 w-full shrink-0 gap-0.5 px-3 py-0"
        role="progressbar"
        aria-label="分步派发进度"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={steps.filter((s) => s.status === "done").length}
      >
        {steps.map((step) => {
          const tone = progressSegmentTone(step.status);
          const run = runs?.[step.id];
          return (
            <Tooltip key={step.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onSelectStep?.(step.id)}
                    aria-label={`${step.id} ${step.title}：${STATUS_LABEL[step.status]}`}
                    className={cn(
                      "relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full transition-colors duration-500 focus-visible:outline-1 focus-visible:outline-ring",
                      tone.className,
                    )}
                  >
                    {tone.sweep && (
                      <span
                        ref={observeVisibleAnimation}
                        aria-hidden="true"
                        className="visible-animate-dispatch-sweep pointer-events-none absolute inset-y-0 left-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-foreground/45 to-transparent"
                      />
                    )}
                  </button>
                }
              />
              <TooltipPopup side="bottom">
                <div>
                  <span className="font-mono">{step.id}</span> {step.title} ·{" "}
                  {STATUS_LABEL[step.status]}
                </div>
                {run?.headline && (
                  <div className="mt-0.5 text-muted-foreground">{run.headline}</div>
                )}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>

      {activeStep && (
        <div className="flex items-center gap-2 px-3 text-xs">
          <span className="relative flex size-2 shrink-0 items-center justify-center">
            <span
              ref={observeVisibleAnimation}
              aria-hidden="true"
              className="visible-animate-dispatch-ping absolute inset-0 rounded-full bg-foreground/50"
            />
            <span className="relative size-1.5 rounded-full bg-foreground" />
          </span>
          <span className="shrink-0 font-mono font-medium text-foreground">{activeStep.id}</span>
          <DispatchElapsedTimer
            startedAt={activeRun?.startedAt}
            className="shrink-0 font-mono text-muted-foreground tabular-nums"
          />
          <span
            ref={observeVisibleAnimation}
            className="visible-animate-dispatch-shine min-w-0 flex-1 truncate font-medium"
          >
            {activeRun?.headline || STATUS_LABEL[activeStep.status]}
          </span>
          {activeRun?.childThreadId && onOpenThread && (
            <button
              type="button"
              onClick={() => onOpenThread(activeRun.childThreadId!)}
              className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              查看代理
            </button>
          )}
        </div>
      )}
    </div>
  );
}
