/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { type ScopedThreadRef, type VelaCollabProjection } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { useCollabUiStore } from "~/state/collabUiStore";
import { requestFocusDispatchStep, useVelaDispatchState } from "~/state/velaDispatch";
import { ComposerBanner, type ComposerBannerVariant } from "../ComposerBanner";
import { type CollabStep } from "./dispatchModel";
import { useDispatchActions } from "./useDispatchActions";

interface BannerEntry {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}

function buildCollabFailureLabel(step: CollabStep, stepNumber: number): string {
  const shortTitle = step.title.length > 16 ? `${step.title.slice(0, 16)}…` : step.title;
  switch (step.attentionReason) {
    case "gate_failed":
      return `第 ${stepNumber} 步「${shortTitle}」检查未通过`;
    case "repair_limit":
      return `第 ${stepNumber} 步「${shortTitle}」经 ${Math.max(2, step.attempt)} 轮修改仍未通过`;
    case "conflict_limit":
      return `第 ${stepNumber} 步「${shortTitle}」代码冲突未解决`;
    case "review_incomplete":
      return `第 ${stepNumber} 步「${shortTitle}」审查未完成`;
    case "evidence_error":
      return `第 ${stepNumber} 步「${shortTitle}」改动读取异常`;
    default:
      return `第 ${stepNumber} 步「${shortTitle}」需要处理`;
  }
}

function CollabV2Banner({
  collab,
  workspaceRoot,
  threadRef,
  onFocusComposer,
}: {
  readonly collab: VelaCollabProjection;
  readonly workspaceRoot: string;
  readonly threadRef: ScopedThreadRef;
  readonly onFocusComposer?: (() => void) | undefined;
}) {
  const { busyKey, runCollabAction, openCollabEvidenceInDiff } = useDispatchActions(
    workspaceRoot,
    threadRef,
  );
  const conflict = useCollabUiStore((s) => s.deliveryConflictByPlan[collab.planId]);
  const [pageIndex, setPageIndex] = useState(0);
  const [manualExpandedId, setManualExpandedId] = useState<string | null>(null);
  const [checkedByStep, setCheckedByStep] = useState<Record<string, ReadonlySet<string>>>({});
  const busy = busyKey !== null;

  const entries: BannerEntry[] = [];

  // Priority 0: Delivery conflict (error variant with 查看冲突 + 重试应用)
  if (conflict && collab.status === "ready_to_deliver" && collab.delivery) {
    entries.push({
      id: `conflict:${collab.planId}`,
      variant: "error",
      icon: <XCircleIcon className="size-3.5 text-destructive" />,
      title: (
        <span className="truncate text-foreground">
          与当前工作区的 {conflict.conflictFiles.length} 个文件存在冲突，未写入任何改动
        </span>
      ),
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              openCollabEvidenceInDiff(
                collab.planId,
                { deliveryId: collab.delivery!.deliveryId },
                "全部待应用改动",
              )
            }
          >
            查看冲突
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void runCollabAction({
                endpoint: "deliver",
                planId: collab.planId,
                deliveryId: collab.delivery!.deliveryId,
                expectedTargetState: collab.delivery!.expectedTargetState,
              })
            }
          >
            重试应用
          </Button>
        </>
      ),
    });
  }

  // Priority 1: Decisions / Escalations / Manual Checks
  collab.steps.forEach((step, idx) => {
    if (step.status !== "needs_attention") return;
    const stepNumber = idx + 1;

    if (step.attentionReason === "decision" || step.attentionReason === "escalation") {
      const options = [...new Set(step.decisionOptions ?? [])].slice(0, 2);
      const isDecision = step.attentionReason === "decision";
      entries.push({
        id: `decide:${step.stepId}`,
        variant: "warning",
        icon: <CircleAlertIcon className="size-3.5 text-warning" />,
        title: (
          <button
            type="button"
            onClick={() => requestFocusDispatchStep(threadRef.threadId, step.stepId)}
            className="flex min-w-0 items-center gap-1 text-left text-foreground hover:underline"
          >
            <span className="shrink-0 font-medium">
              第 {stepNumber} 步「
              <span className="inline-block max-w-[14em] truncate align-bottom">{step.title}</span>
              」{isDecision ? "待决定" : "待回复"}
            </span>
            {step.attentionDetail && (
              <span className="min-w-0 truncate text-muted-foreground">
                ：{step.attentionDetail}
              </span>
            )}
          </button>
        ),
        actions: (
          <>
            {options.map((opt) => (
              <Button
                key={opt}
                size="xs"
                variant="outline"
                disabled={busy}
                className="max-w-32"
                onClick={() =>
                  void runCollabAction({
                    endpoint: "step/resolve",
                    planId: collab.planId,
                    stepId: step.stepId,
                    resolution: "human_decision",
                    response: opt,
                  })
                }
              >
                <span className="truncate">{opt}</span>
              </Button>
            ))}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                useCollabUiStore.getState().setComposerBinding(threadRef, {
                  kind: "reply_step",
                  planId: collab.planId,
                  stepId: step.stepId,
                  stepNumber,
                  stepTitle: step.title,
                });
                onFocusComposer?.();
              }}
            >
              自定义回复
            </Button>
          </>
        ),
      });
      return;
    }

    if (step.attentionReason === "manual_check_required") {
      const checks = step.manualChecks ?? [];
      const expanded = manualExpandedId === step.stepId;
      const checkedSet = checkedByStep[step.stepId] ?? new Set<string>();
      const allChecked = checks.length > 0 && checks.every(({ id }) => checkedSet.has(id));
      entries.push({
        id: `manual:${step.stepId}`,
        variant: "warning",
        icon: <CircleAlertIcon className="size-3.5 text-warning" />,
        title: (
          <span className="truncate text-foreground">
            第 {stepNumber} 步「
            <span className="inline-block max-w-[14em] truncate align-bottom">{step.title}</span>
            」有 {checks.length} 项需人工确认
          </span>
        ),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setManualExpandedId(expanded ? null : step.stepId)}
          >
            {expanded ? "收起" : "展开确认"}
          </Button>
        ),
        ...(expanded && checks.length > 0
          ? {
              children: (
                <div className="space-y-2 px-7 pt-1 pb-2 text-xs">
                  {checks.map((check) => (
                    <label
                      key={check.id}
                      className="flex cursor-pointer items-start gap-2 text-foreground/90"
                    >
                      <Checkbox
                        checked={checkedSet.has(check.id)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setCheckedByStep((prev) => {
                            const next = new Set(prev[step.stepId] ?? []);
                            if (checked) next.add(check.id);
                            else next.delete(check.id);
                            return { ...prev, [step.stepId]: next };
                          })
                        }
                      />
                      <span className="wrap-anywhere">{check.text}</span>
                    </label>
                  ))}
                  {step.reviewId && (
                    <div className="flex justify-end pt-1">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || !allChecked}
                        onClick={() =>
                          void runCollabAction({
                            endpoint: "step/resolve",
                            planId: collab.planId,
                            stepId: step.stepId,
                            reviewId: step.reviewId!,
                            resolution: "human_manual_check",
                            response: checks
                              .map(({ id, text }) => `已确认 ${id} · ${text}`)
                              .join("\n"),
                          }).then((ok) => {
                            if (ok) setManualExpandedId(null);
                          })
                        }
                      >
                        确认通过
                      </Button>
                    </div>
                  )}
                </div>
              ),
            }
          : {}),
      });
    }
  });

  // Priority 2: Step failures & batch verification failure
  collab.steps.forEach((step, idx) => {
    if (step.status !== "needs_attention") return;
    if (
      step.attentionReason === "decision" ||
      step.attentionReason === "escalation" ||
      step.attentionReason === "manual_check_required"
    ) {
      return;
    }
    const stepNumber = idx + 1;
    entries.push({
      id: `fail:${step.stepId}`,
      variant: "warning",
      icon: <CircleAlertIcon className="size-3.5 text-warning" />,
      title: (
        <span className="truncate text-foreground">{buildCollabFailureLabel(step, stepNumber)}</span>
      ),
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => requestFocusDispatchStep(threadRef.threadId, step.stepId)}
          >
            查看原因
          </Button>
          {step.attentionReason === "review_incomplete" && step.reviewId && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void runCollabAction({
                  endpoint: "step/retry-review",
                  planId: collab.planId,
                  stepId: step.stepId,
                  reviewId: step.reviewId!,
                })
              }
            >
              重新审查
            </Button>
          )}
        </>
      ),
    });
  });

  if (collab.canRetryBatch && collab.status === "running") {
    entries.push({
      id: `batch-fail:${collab.planId}`,
      variant: "warning",
      icon: <CircleAlertIcon className="size-3.5 text-warning" />,
      title: (
        <span className="truncate text-foreground">
          整体验证未通过
          {collab.attentionDetail ? `：${collab.attentionDetail}` : ""}
        </span>
      ),
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => requestFocusDispatchStep(threadRef.threadId, "__plan__")}
          >
            查看原因
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void runCollabAction({
                endpoint: "batch/retry",
                planId: collab.planId,
                expectedPlanVersion: collab.planVersion,
                ...(collab.integrationOid ? { integrationOid: collab.integrationOid } : {}),
              })
            }
          >
            重试验证
          </Button>
        </>
      ),
    });
  }

  // Priority 3: Ready to deliver (sole primary button across entire lifecycle)
  if (collab.status === "ready_to_deliver" && collab.delivery && !conflict) {
    const auditPassed = Boolean(collab.batchAudit && collab.batchAudit.blockingFindings === 0);
    entries.push({
      id: `deliver:${collab.delivery.deliveryId}`,
      variant: "default",
      icon: <CheckCircle2Icon className="size-3.5 text-foreground/80" />,
      title: (
        <span className="truncate text-foreground">
          {auditPassed
            ? "全部步骤已完成 · 整体验证与独立审查均已通过"
            : "全部步骤已完成 · 整体验证已通过"}
        </span>
      ),
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              openCollabEvidenceInDiff(
                collab.planId,
                { deliveryId: collab.delivery!.deliveryId },
                "全部待应用改动",
              )
            }
          >
            查看全部改动
          </Button>
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void runCollabAction({
                endpoint: "deliver",
                planId: collab.planId,
                deliveryId: collab.delivery!.deliveryId,
                expectedTargetState: collab.delivery!.expectedTargetState,
              })
            }
          >
            {busyKey === "deliver" ? "正在应用…" : "应用到工作区"}
          </Button>
        </>
      ),
    });
  }

  if (entries.length === 0) return null;

  const safeIndex = Math.min(pageIndex, entries.length - 1);
  const current = entries[safeIndex]!;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant={current.variant} density="comfortable">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>{current.icon}</ComposerBanner.Icon>
          <ComposerBanner.Content>{current.title}</ComposerBanner.Content>
          <ComposerBanner.Actions>
            {current.actions}
            {entries.length > 1 && (
              <span className="ms-1 inline-flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground tabular-nums">
                <span>
                  {safeIndex + 1}/{entries.length}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="上一项待处理"
                  onClick={() =>
                    setPageIndex((prev) => (prev - 1 + entries.length) % entries.length)
                  }
                >
                  <ChevronLeftIcon className="size-3" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="下一项待处理"
                  onClick={() => setPageIndex((prev) => (prev + 1) % entries.length)}
                >
                  <ChevronRightIcon className="size-3" />
                </Button>
              </span>
            )}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {current.children ? <ComposerBanner.Children>{current.children}</ComposerBanner.Children> : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

/**
 * Native Composer attachment tucked into Vela's ComposerBanner.Dock.
 * Renders only actionable human-attention or ready-to-apply items (never passive progress noise).
 */
export function DispatchComposerBanner({
  workspaceRoot,
  threadRef,
  onFocusComposer,
}: {
  readonly workspaceRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly isMainAgentWorking?: boolean | undefined;
  readonly onFocusComposer?: (() => void) | undefined;
}) {
  const { state } = useVelaDispatchState(
    workspaceRoot,
    threadRef.threadId,
    threadRef.environmentId,
  );

  if (!workspaceRoot || !state?.collab) {
    return null;
  }

  return (
    <CollabV2Banner
      collab={state.collab}
      workspaceRoot={workspaceRoot}
      threadRef={threadRef}
      onFocusComposer={onFocusComposer}
    />
  );
}
