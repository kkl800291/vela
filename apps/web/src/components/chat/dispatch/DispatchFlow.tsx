/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ChevronRightIcon, ExternalLinkIcon, GitBranchIcon, SearchCheckIcon, UnlockIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type {
  DispatchBlindCheckRecord,
  DispatchProviderSummary,
  DispatchStepRun,
  DispatchTaskCard,
  DispatchTaskSpecPatch,
} from "~/state/velaDispatch";
import {
  computeBatches,
  formatAgentTarget,
  isBusyStatus,
  isCanRunStatus,
} from "./dispatchModel";
import { DispatchStepNode } from "./DispatchStepNode";

export function DispatchFlow({
  workspaceRoot,
  threadId,
  steps,
  runs,
  blindCheck,
  providers,
  expandedSteps,
  busyKey,
  onToggleExpand,
  onOpenThread,
  onOpenFile,
  onOpenDiff,
  onEditStep,
  onRunAction,
}: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly expandedSteps: ReadonlySet<string>;
  readonly busyKey: string | null;
  readonly onToggleExpand: (stepId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenDiff: () => void;
  readonly onEditStep: (step: DispatchTaskCard) => void;
  readonly onRunAction: (
    key: string,
    pathname: string,
    body: Record<string, unknown>,
    successTitle?: string,
  ) => Promise<boolean>;
}) {
  const [blindFactsOpen, setBlindFactsOpen] = useState(false);

  const batches = computeBatches(steps);
  const lockedSteps = steps.filter((s) => s.status === "locked");
  const runningSteps = steps.filter(
    (s) => isBusyStatus(s.status) || s.status === "awaiting_product_acceptance",
  );

  return (
    <div className="space-y-3.5 px-3.5 py-3.5">
      {blindCheck?.checkerFacts && (
        <div className="rounded-xl border border-border/60 bg-card/40">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
            <button
              type="button"
              onClick={() => setBlindFactsOpen((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  blindFactsOpen && "rotate-90",
                )}
              />
              <SearchCheckIcon className="size-4 shrink-0 opacity-75" />
              <span className="truncate">
                只读盲审事实摘要（{formatAgentTarget(blindCheck.checker, providers)}）
              </span>
            </button>
            {blindCheck.checkerThreadId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenThread(blindCheck.checkerThreadId!)}
              >
                <ExternalLinkIcon className="size-3.5" />
                查看盲审页
              </Button>
            )}
          </div>
          {blindFactsOpen && (
            <div className="max-h-64 overflow-y-auto border-t border-border/45 px-3.5 py-3">
              <ChatMarkdown cwd={workspaceRoot} text={blindCheck.checkerFacts} />
            </div>
          )}
        </div>
      )}

      {lockedSteps.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>尚有 {lockedSteps.length} 项待前序完成解锁</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busyKey !== null}
            onClick={() =>
              void onRunAction(
                "unlock-all",
                "/api/vela/dispatch/steps/unlock-all",
                {},
                "已解锁全部步骤，可自由并行派发",
              )
            }
          >
            <UnlockIcon className="size-3.5" />
            全部解锁
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {batches.map((batch, batchIdx) => {
          const batchRunnableSteps = batch.steps.filter((step) => isCanRunStatus(step.status));
          return (
            <section key={batch.batchNumber} className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span className="text-sm font-semibold text-foreground/90">
                    第 {batch.batchNumber} 批
                  </span>
                  {batch.steps.length > 1 && (
                    <span>· 可并行 {batch.steps.length} 项</span>
                  )}
                </div>

                {batchRunnableSteps.length >= 2 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void onRunAction(
                        `parallel-run:${batch.batchNumber}`,
                        "/api/vela/dispatch/steps/run-parallel",
                        {
                          stepIds: batchRunnableSteps.map((s) => s.id),
                          parentThreadId: threadId,
                        },
                        `已并行启动第 ${batch.batchNumber} 批 ${batchRunnableSteps.length} 个步骤`,
                      )
                    }
                  >
                    <GitBranchIcon className="size-3.5" />
                    并行开跑
                  </Button>
                )}
              </div>

              <div>
                {batch.steps.map((step, idx) => (
                  <DispatchStepNode
                    key={step.id}
                    workspaceRoot={workspaceRoot}
                    step={step}
                    run={runs[step.id]}
                    providers={providers}
                    expanded={expandedSteps.has(step.id)}
                    hasNextStep={!(batchIdx === batches.length - 1 && idx === batch.steps.length - 1)}
                    busy={busyKey !== null}
                    onToggleExpand={() => onToggleExpand(step.id)}
                    onOpenThread={onOpenThread}
                    onOpenFile={onOpenFile}
                    onOpenDiff={onOpenDiff}
                    onRun={() =>
                      void onRunAction(`run:${step.id}`, "/api/vela/dispatch/step/run", {
                        stepId: step.id,
                        parentThreadId: threadId,
                      })
                    }
                    onForceRun={
                      step.status === "locked"
                        ? () =>
                            void onRunAction(
                              `run:${step.id}`,
                              "/api/vela/dispatch/step/run",
                              {
                                stepId: step.id,
                                parentThreadId: threadId,
                                forceUnlock: true,
                                forceWorktree: runningSteps.length > 0,
                              },
                              `已解锁并启动 ${step.id}`,
                            )
                        : undefined
                    }
                    onCancel={() =>
                      void onRunAction(
                        `cancel:${step.id}`,
                        "/api/vela/dispatch/step/cancel",
                        { stepId: step.id },
                        `已中止 ${step.id}`,
                      )
                    }
                    onSkipAcceptance={() =>
                      void onRunAction(
                        `skip:${step.id}`,
                        "/api/vela/dispatch/step/skip-acceptance",
                        { stepId: step.id },
                      )
                    }
                    onRevert={() =>
                      void onRunAction(
                        `revert:${step.id}`,
                        "/api/vela/dispatch/step/revert",
                        { stepId: step.id },
                        `已撤回 ${step.id}`,
                      )
                    }
                    onDecide={(payload) =>
                      onRunAction(
                        `decide:${step.id}`,
                        "/api/vela/dispatch/step/decide",
                        { stepId: step.id, ...payload },
                        `已确认 ${step.id} 决策`,
                      )
                    }
                    onUpdate={(patch: DispatchTaskSpecPatch) =>
                      void onRunAction(`update:${step.id}`, "/api/vela/dispatch/step/update", {
                        stepId: step.id,
                        patch,
                      })
                    }
                    onEdit={() => onEditStep(step)}
                    onDelete={() =>
                      void onRunAction(
                        `delete:${step.id}`,
                        "/api/vela/dispatch/step/delete",
                        { stepId: step.id },
                        `已删除 ${step.id}`,
                      )
                    }
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
