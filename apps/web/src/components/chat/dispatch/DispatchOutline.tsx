/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitForkIcon,
  LockIcon,
  MessageSquareIcon,
  PencilIcon,
  SearchCheckIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type {
  DispatchBlindCheckRecord,
  DispatchProviderSummary,
  DispatchStepRun,
  DispatchStepStatus,
  DispatchTaskCard,
} from "~/state/velaDispatch";
import { DispatchElapsedTimer } from "./DispatchElapsedTimer";
import {
  computeBatches,
  isActiveProgressStatus,
  resolveAgentTargetDisplay,
  STATUS_LABEL,
} from "./dispatchModel";

function OutlineStepGlyph({ status }: { readonly status: DispatchStepStatus }) {
  if (isActiveProgressStatus(status)) {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute size-2.5 rounded-full bg-foreground/25 visible-animate-dispatch-ping" />
        <span className="relative size-1.5 rounded-full bg-foreground" />
      </span>
    );
  }
  switch (status) {
    case "done":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground/75" />;
    case "ready_to_accept":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground" />;
    case "awaiting_decision":
      return <GitForkIcon className="size-3.5 shrink-0 text-warning" />;
    case "needs_human_decision":
    case "premise_failed":
      return <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" />;
    case "boundary_violation":
    case "hard_gate_failed":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
    case "locked":
      return <LockIcon className="size-3 shrink-0 text-muted-foreground/50" />;
    default:
      return <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />;
  }
}

export function DispatchOutline({
  steps,
  runs,
  blindCheck,
  providers,
  onOpenThread,
  onOpenDiff,
  onEditStep,
}: {
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenDiff: () => void;
  readonly onEditStep: (step: DispatchTaskCard) => void;
}) {
  const orderedSteps = [...steps].toSorted((a, b) => a.order - b.order);
  const batches = computeBatches(orderedSteps);
  const usesBatches = batches.some((batch) => batch.steps.length > 1);

  const doneCount = orderedSteps.filter((s) => s.status === "done").length;
  const activeCount = orderedSteps.filter((s) => isActiveProgressStatus(s.status)).length;
  const changedFileSet = new Set<string>();
  for (const step of orderedSteps) {
    const files = runs[step.id]?.diffSummary?.changedFiles ?? [];
    for (const file of files) {
      changedFileSet.add(file);
    }
  }
  const totalChangedFiles = changedFileSet.size;

  return (
    <div className="divide-y divide-border/45">
      {/* Top summary bar */}
      <div className="space-y-1 px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-mono font-medium text-foreground tabular-nums">
              {doneCount}/{orderedSteps.length}
            </span>
            <span className="text-muted-foreground">
              {activeCount > 0
                ? `${activeCount} 步执行中`
                : doneCount === orderedSteps.length
                  ? "全部已完成"
                  : "进度大纲"}
            </span>
          </div>
          {totalChangedFiles > 0 && (
            <Button size="xs" variant="outline" onClick={onOpenDiff}>
              <FileDiffIcon className="size-3" />
              查看 Diff ({totalChangedFiles})
            </Button>
          )}
        </div>
        <div className="text-2xs text-muted-foreground">主流程已在左侧对话流内联操作</div>
      </div>

      {/* Optional 1-line blind-check shortcut */}
      {blindCheck?.checkerThreadId && (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <SearchCheckIcon className="size-3.5 shrink-0 opacity-75" />
            <span className="truncate">只读代码核查</span>
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onOpenThread(blindCheck.checkerThreadId!)}
          >
            <ExternalLinkIcon className="size-3" />
            查看代理
          </Button>
        </div>
      )}

      {/* Compact step outline list */}
      <div className="divide-y divide-border/40">
        {batches.map((batch) => (
          <div key={batch.batchNumber} className="divide-y divide-border/35">
            {usesBatches && (
              <div className="bg-muted/20 px-3.5 py-1 text-2xs font-medium text-muted-foreground">
                第 {batch.batchNumber} 批
                {batch.steps.length > 1 ? ` · 可并行 ${batch.steps.length} 项` : ""}
              </div>
            )}

            {batch.steps.map((step) => {
              const run = runs[step.id];
              const isActive = isActiveProgressStatus(step.status);
              const isEditable = step.status !== "done" && !isActive;
              const isNonIdle = step.status !== "ready" && step.status !== "locked";
              const fileCount = run?.diffSummary?.changedFiles.length ?? 0;
              const latestReviewerThreadId = run?.reviewerThreadIds.at(-1);
              const targetDisplay =
                step.executor === "self" ? null : resolveAgentTargetDisplay(step.executor, providers);

              return (
                <div
                  key={step.id}
                  data-step-id={step.id}
                  className={cn(
                    "space-y-1 px-3.5 py-2 transition-colors",
                    isActive && "bg-foreground/[0.025]",
                  )}
                >
                  {/* Line 1 */}
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <OutlineStepGlyph status={step.status} />
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                        {step.id}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs font-medium text-foreground",
                          step.status === "done" && "text-foreground/80",
                          step.status === "locked" && "text-muted-foreground",
                        )}
                      >
                        {step.title}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {isActive && run?.startedAt && (
                        <DispatchElapsedTimer
                          startedAt={run.startedAt}
                          className="font-mono text-2xs text-muted-foreground tabular-nums"
                        />
                      )}
                      {isEditable && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`编辑 ${step.id}`}
                                onClick={() => onEditStep(step)}
                              >
                                <PencilIcon className="size-3" />
                              </Button>
                            }
                          />
                          <TooltipPopup side="left">编辑步骤配置</TooltipPopup>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  {/* Line 2 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pl-5 text-2xs text-muted-foreground">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      {step.executor === "self" ? (
                        <span className="inline-flex items-center gap-1">
                          <MessageSquareIcon className="size-3 shrink-0 opacity-75" />
                          <span className="truncate">主控直接执行</span>
                        </span>
                      ) : targetDisplay ? (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          {targetDisplay.driverKind && (
                            <ProviderInstanceIcon
                              driverKind={targetDisplay.driverKind}
                              displayName={targetDisplay.providerLabel}
                              size="compact"
                              iconClassName="size-3"
                            />
                          )}
                          <span className="truncate text-foreground/85">
                            {targetDisplay.modelName || targetDisplay.providerLabel}
                          </span>
                          {targetDisplay.effortLabel && (
                            <span className="shrink-0">{targetDisplay.effortLabel}</span>
                          )}
                        </span>
                      ) : null}

                      {isNonIdle && (
                        <>
                          <span className="opacity-45">·</span>
                          <span
                            className={cn(
                              "truncate",
                              step.status === "boundary_violation" ||
                                step.status === "hard_gate_failed"
                                ? "text-destructive"
                                : step.status === "awaiting_decision" ||
                                    step.status === "needs_human_decision" ||
                                    step.status === "premise_failed"
                                  ? "text-warning"
                                  : undefined,
                            )}
                          >
                            {run?.headline || STATUS_LABEL[step.status]}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {run?.childThreadId && (
                        <Button
                          size="micro"
                          variant="ghost"
                          onClick={() => onOpenThread(run.childThreadId!)}
                        >
                          查看代理
                        </Button>
                      )}
                      {latestReviewerThreadId && (
                        <Button
                          size="micro"
                          variant="ghost"
                          onClick={() => onOpenThread(latestReviewerThreadId)}
                        >
                          复查
                        </Button>
                      )}
                      {fileCount > 0 && (
                        <Button size="micro" variant="ghost" onClick={onOpenDiff}>
                          {fileCount} 文件
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
