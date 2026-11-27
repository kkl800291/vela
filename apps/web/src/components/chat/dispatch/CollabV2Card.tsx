/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import type { ScopedThreadRef, VelaCollabProjection } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  MinusIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useCollabProjectPrefsStore, useCollabUiStore } from "~/state/collabUiStore";
import {
  subscribeFocusDispatchStep,
  useVelaDispatchProviders,
  type DispatchAgentTarget,
  type DispatchProviderSummary,
} from "~/state/velaDispatch";
import { AgentTargetPicker } from "./AgentTargetPicker";
import {
  computeTopCompletedRunCount,
  findCollabStepDependents,
  formatCollabDependsOn,
  formatCollabStepModelShort,
  formatCollabStepStatusText,
  isActiveCollabPlan,
  isCollabStepDone,
  providerLabelOf,
  type CollabStep,
} from "./dispatchModel";
import { useDispatchActions } from "./useDispatchActions";

type RunCollabAction = ReturnType<typeof useDispatchActions>["runCollabAction"];

function CollabProgressRing({
  completed,
  total,
  status,
  reverted,
}: {
  readonly completed: number;
  readonly total: number;
  readonly status: VelaCollabProjection["status"];
  readonly reverted: boolean;
}) {
  if (status === "draft") {
    return (
      <CircleDashedIcon
        aria-hidden
        strokeWidth={1.25}
        className="size-3.5 shrink-0 text-muted-foreground/70"
      />
    );
  }
  if (reverted || status === "cancelled") {
    return (
      <MinusIcon
        aria-hidden
        strokeWidth={1.5}
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
    );
  }
  if (status === "delivered" || status === "ready_to_deliver" || (total > 0 && completed >= total)) {
    return (
      <CheckIcon
        aria-hidden
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-foreground/75 motion-safe:animate-check-draw"
      />
    );
  }
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const progress = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  const dashOffset = circumference * (1 - progress);
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden
      className="-rotate-90 shrink-0"
    >
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-foreground/12"
      />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className="text-foreground/75 transition-[stroke-dashoffset] duration-400 ease-out-expo motion-reduce:transition-none"
      />
    </svg>
  );
}

function StepStatusIcon({
  step,
  isReviewing,
}: {
  readonly step: CollabStep;
  readonly isReviewing: boolean;
}) {
  if (isReviewing || step.status === "reviewing") {
    return <Spinner aria-hidden size="xs" />;
  }
  switch (step.status) {
    case "locked":
      return (
        <CircleDashedIcon
          aria-hidden
          strokeWidth={1.25}
          className="size-3.5 shrink-0 text-muted-foreground/50"
        />
      );
    case "ready":
      return (
        <CircleIcon
          aria-hidden
          strokeWidth={1.25}
          className="size-3.5 shrink-0 text-muted-foreground/65"
        />
      );
    case "developing":
    case "verifying_gates":
    case "integrating":
      return <Spinner aria-hidden size="xs" />;
    case "queued_for_review":
      return (
        <ClockIcon
          aria-hidden
          strokeWidth={1.5}
          className="size-3.5 shrink-0 text-muted-foreground/75"
        />
      );
    case "integrated":
    case "done":
      return (
        <CheckIcon
          aria-hidden
          strokeWidth={1.5}
          className="size-3.5 shrink-0 text-foreground/50 motion-safe:animate-check-draw"
        />
      );
    case "needs_attention":
      return (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-warning"
        />
      );
    case "cancelled":
      return (
        <MinusIcon
          aria-hidden
          strokeWidth={1.5}
          className="size-3.5 shrink-0 text-muted-foreground/50"
        />
      );
  }
}

function ModelSubmenuItems({
  providers,
  onPick,
  includeFollowDefault = false,
}: {
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly onPick: (target: DispatchAgentTarget | null) => void;
  readonly includeFollowDefault?: boolean;
}) {
  return (
    <>
      {includeFollowDefault && (
        <>
          <MenuItem onClick={() => onPick(null)}>跟随默认</MenuItem>
          <MenuSeparator />
        </>
      )}
      {providers.map((provider) => {
        const label = providerLabelOf(provider);
        if (provider.models.length <= 1) {
          return (
            <MenuItem
              key={provider.instanceId}
              onClick={() =>
                onPick({
                  providerInstanceId: provider.instanceId,
                  ...(provider.models[0]?.slug ? { model: provider.models[0].slug } : {}),
                })
              }
            >
              {label}
              {provider.models[0]?.name ? ` · ${provider.models[0].name}` : ""}
            </MenuItem>
          );
        }
        return (
          <MenuSub key={provider.instanceId}>
            <MenuSubTrigger>{label}</MenuSubTrigger>
            <MenuSubPopup>
              {provider.models.map((model) => (
                <MenuItem
                  key={model.slug}
                  onClick={() =>
                    onPick({
                      providerInstanceId: provider.instanceId,
                      model: model.slug,
                    })
                  }
                >
                  {model.name || model.slug}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        );
      })}
    </>
  );
}

function SecondOpinionPopover({
  providers,
  busy,
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly busy: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (brief: string, target?: DispatchAgentTarget) => Promise<boolean>;
}) {
  const [target, setTarget] = useState<DispatchAgentTarget | undefined>();
  const [brief, setBrief] = useState("");
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<span className="sr-only" />} />
      <PopoverPopup align="end" side="bottom" className="w-72">
        <form
          className="space-y-2.5"
          onSubmit={async (event) => {
            event.preventDefault();
            const ok = await onSubmit(
              brief.trim() || "在独立上下文中审查此步骤改动中的高风险逻辑与阻塞问题。",
              target,
            );
            if (ok) {
              setBrief("");
              onOpenChange(false);
            }
          }}
        >
          <div className="text-xs font-medium text-foreground">请求独立审查</div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>审查模型</span>
            <AgentTargetPicker
              value={target ?? null}
              allowNull
              nullLabel="默认模型"
              providers={providers}
              disabled={busy}
              variant="chip"
              onSelect={(next) =>
                setTarget(next && next !== "inherit" && next !== "self" ? next : undefined)
              }
            />
          </div>
          <Input
            size="sm"
            aria-label="补充关注点"
            placeholder="补充关注点（可选）"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="xs" type="submit" disabled={busy}>
              发送请求
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function DraftStepRow({
  step,
  index,
  collab,
  providers,
  busy,
  runAction,
}: {
  readonly step: CollabStep;
  readonly index: number;
  readonly collab: VelaCollabProjection;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly busy: boolean;
  readonly runAction: RunCollabAction;
}) {
  const dependsText = formatCollabDependsOn(collab, step.dependsOn, "draft");
  const overrideModel = formatCollabStepModelShort(step.executor, providers);
  const dependents = findCollabStepDependents(collab, step.stepId);
  const secondaryParts = [overrideModel, dependsText].filter(Boolean);

  return (
    <li data-collab-step={step.stepId} className="group/row">
      <div className="grid h-8 -mx-2 grid-cols-[20px_minmax(0,1fr)_auto_24px] items-center gap-x-2 rounded-lg px-2 transition-colors hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]">
        <span className="flex items-center justify-center text-xs tabular-nums text-muted-foreground">
          {index + 1}
        </span>
        <span className="min-w-0 truncate text-sm/5 text-foreground">{step.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs/4 text-muted-foreground">
          {secondaryParts.map((part, idx) => (
            <span
              key={part}
              className={cn(
                "truncate",
                idx === 0 && overrideModel ? "text-foreground/75 @max-[520px]/collab-card:hidden" : "text-muted-foreground/75",
              )}
            >
              {idx > 0 && (
                <span aria-hidden className="me-1.5 text-muted-foreground/40">
                  ·
                </span>
              )}
              {part}
            </span>
          ))}
        </span>
        <div className="flex size-6 items-center justify-center opacity-0 transition-opacity duration-120 group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`第 ${index + 1} 步操作`}
                  disabled={busy}
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup align="end">
              {providers.length > 0 && (
                <MenuSub>
                  <MenuSubTrigger>执行模型</MenuSubTrigger>
                  <MenuSubPopup>
                    <ModelSubmenuItems
                      providers={providers}
                      includeFollowDefault
                      onPick={(target) =>
                        void runAction({
                          endpoint: "step/executor",
                          planId: collab.planId,
                          stepId: step.stepId,
                          expectedPlanVersion: collab.planVersion,
                          executor: target,
                        })
                      }
                    />
                  </MenuSubPopup>
                </MenuSub>
              )}
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={busy || dependents.length > 0}
                onClick={() =>
                  void runAction({
                    endpoint: "step/cancel",
                    planId: collab.planId,
                    stepId: step.stepId,
                    expectedPlanVersion: collab.planVersion,
                  })
                }
              >
                <div className="flex flex-col">
                  <span>移除步骤</span>
                  {dependents.length > 0 && (
                    <span className="text-2xs text-muted-foreground">
                      第 {dependents.map((d) => d.number).join("、")} 步依赖此步
                    </span>
                  )}
                </div>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </li>
  );
}

function LiveStepRow({
  step,
  index,
  collab,
  providers,
  busy,
  expanded,
  onToggleExpand,
  runAction,
  openChildThread,
  openEvidence,
}: {
  readonly step: CollabStep;
  readonly index: number;
  readonly collab: VelaCollabProjection;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly runAction: RunCollabAction;
  readonly openChildThread: (id: string) => void;
  readonly openEvidence: (target: { readonly reviewId: string }, label: string) => void;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [opinionPopoverOpen, setOpinionPopoverOpen] = useState(false);

  // Auto-reset 2-stage stop confirmation after 3 seconds
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 3-second arming timer for inline two-stage stop confirmation
  useEffect(() => {
    if (!confirmStop) return;
    const timer = window.setTimeout(() => setConfirmStop(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmStop]);

  const { planId, planVersion, activeInbox } = collab;
  const { stepId, status, title, childThreadId, reviewId, latestVerdict, secondOpinion } = step;
  const isReviewing =
    status === "reviewing" ||
    (activeInbox?.kind === "review" &&
      activeInbox.stepId === stepId &&
      activeInbox.status === "dispatched" &&
      activeInbox.reviewId === reviewId);

  const displayReviewId = reviewId ?? latestVerdict?.reviewId;
  const statusText = formatCollabStepStatusText(step, collab, providers, isReviewing);
  const isDone = isCollabStepDone(status);
  const isRunningStep = status === "developing" || status === "verifying_gates";
  const canCancel =
    isActiveCollabPlan(collab.status) &&
    (status === "developing" ||
      status === "verifying_gates" ||
      status === "ready" ||
      status === "locked");
  const canRequestOpinion =
    Boolean(reviewId) &&
    !secondOpinion &&
    step.kind === "change" &&
    (collab.status === "running" || collab.status === "batch_verifying");

  const directAction =
    isRunningStep && childThreadId
      ? {
          kind: "thread" as const,
          label: "打开子会话",
          onClick: () => openChildThread(childThreadId),
        }
      : displayReviewId
        ? {
            kind: "diff" as const,
            label: "查看改动",
            onClick: () =>
              openEvidence(
                { reviewId: displayReviewId },
                `第 ${index + 1} 步 · ${title}`,
              ),
          }
        : childThreadId
          ? {
              kind: "thread" as const,
              label: "打开子会话",
              onClick: () => openChildThread(childThreadId),
            }
          : null;

  const hasDetailContent = Boolean(
    latestVerdict ||
      step.reviewSummary ||
      step.attentionDetail ||
      secondOpinion ||
      childThreadId ||
      displayReviewId ||
      canCancel ||
      canRequestOpinion,
  );

  const handleStopClick = () => {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    void runAction({
      endpoint: "step/cancel",
      planId,
      stepId,
      expectedPlanVersion: planVersion,
    });
  };

  return (
    <li data-collab-step={stepId} className="group/row relative">
      {/* Row header: unified 20px icon | 1fr title | auto status | 24px slot */}
      <div
        className={cn(
          "grid h-8 -mx-2 grid-cols-[20px_minmax(0,1fr)_auto_24px] items-center gap-x-2 rounded-lg px-2 transition-colors",
          isReviewing
            ? "bg-foreground/[0.028] dark:bg-white/[0.03]"
            : "hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]",
        )}
      >
        <button
          type="button"
          onClick={hasDetailContent ? onToggleExpand : undefined}
          aria-expanded={hasDetailContent ? expanded : undefined}
          className={cn(
            "col-span-3 grid min-w-0 grid-cols-[20px_minmax(55%,1fr)_auto] items-center gap-x-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            hasDetailContent ? "cursor-pointer" : "cursor-default",
          )}
        >
          <span className="flex size-5 items-center justify-center">
            <StepStatusIcon step={step} isReviewing={isReviewing} />
          </span>

          <span
            className={cn(
              "min-w-0 truncate text-sm/5",
              isReviewing
                ? "font-medium text-foreground"
                : status === "cancelled"
                  ? "text-muted-foreground/50 line-through"
                  : isDone || status === "locked"
                    ? "text-foreground/60"
                    : "text-foreground",
            )}
          >
            {title}
          </span>

          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-xs/4 tabular-nums transition-opacity duration-150 motion-reduce:transition-none",
              status === "needs_attention"
                ? "text-warning-foreground"
                : "text-muted-foreground",
            )}
          >
            <span className="truncate">{statusText.primary}</span>
            {statusText.modelSuffix && (
              <span className="inline-flex items-center gap-1 @max-[520px]/collab-card:hidden">
                <span aria-hidden className="text-muted-foreground/40">
                  ·
                </span>
                <span className="max-w-28 truncate">{statusText.modelSuffix}</span>
              </span>
            )}
          </span>
        </button>

        {/* Fixed 24px trailing slot: static = shield or empty; hover/focus = 1 direct icon (or menu when expanded) */}
        <div className="relative flex size-6 items-center justify-center">
          {secondOpinion && !expanded && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "flex items-center justify-center transition-opacity duration-120 motion-reduce:transition-none",
                      directAction &&
                        "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
                    )}
                  >
                    {secondOpinion.blockingFindings > 0 ? (
                      <ShieldAlertIcon className="size-3 text-foreground" />
                    ) : (
                      <ShieldCheckIcon className="size-3 text-muted-foreground/70" />
                    )}
                  </span>
                }
              />
              <TooltipPopup side="left">
                {secondOpinion.blockingFindings > 0
                  ? `独立审查发现 ${secondOpinion.blockingFindings} 项问题`
                  : "已通过独立审查"}
              </TooltipPopup>
            </Tooltip>
          )}

          {directAction && !expanded && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={directAction.label}
                    onClick={(event) => {
                      event.stopPropagation();
                      directAction.onClick();
                    }}
                    className="absolute inset-0 flex items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-120 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none"
                  >
                    {directAction.kind === "thread" ? (
                      <ExternalLinkIcon className="size-3.5" />
                    ) : (
                      <FileDiffIcon className="size-3.5" />
                    )}
                  </button>
                }
              />
              <TooltipPopup side="left">{directAction.label}</TooltipPopup>
            </Tooltip>
          )}

          {expanded && (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`第 ${index + 1} 步更多操作`}
                    disabled={busy}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </Button>
                }
              />
              <MenuPopup align="end">
                {canRequestOpinion && (
                  <MenuItem onClick={() => setOpinionPopoverOpen(true)}>
                    请求独立审查
                  </MenuItem>
                )}
                {status === "needs_attention" &&
                  step.attentionReason === "review_incomplete" &&
                  reviewId && (
                    <MenuItem
                      onClick={() =>
                        void runAction({
                          endpoint: "step/retry-review",
                          planId,
                          stepId,
                          reviewId,
                        })
                      }
                    >
                      <RotateCcwIcon className="size-3.5" />
                      重新审查
                    </MenuItem>
                  )}
                <MenuItem
                  onClick={() => {
                    void navigator.clipboard?.writeText(stepId);
                    toastManager.add({ type: "success", title: "已复制步骤 ID" });
                  }}
                >
                  <CopyIcon className="size-3.5" />
                  复制步骤 ID
                </MenuItem>
                {canCancel && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      variant="destructive"
                      onClick={() =>
                        void runAction({
                          endpoint: "step/cancel",
                          planId,
                          stepId,
                          expectedPlanVersion: planVersion,
                        })
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                      取消此步
                    </MenuItem>
                  </>
                )}
              </MenuPopup>
            </Menu>
          )}

          {canRequestOpinion && reviewId && (
            <SecondOpinionPopover
              providers={providers}
              busy={busy}
              open={opinionPopoverOpen}
              onOpenChange={setOpinionPopoverOpen}
              onSubmit={(brief, target) =>
                runAction({
                  endpoint: "step/second-opinion",
                  planId,
                  stepId,
                  reviewId,
                  brief,
                  ...(target ? { target } : {}),
                })
              }
            />
          )}
        </div>
      </div>

      {/* Expandable detail with 1px vertical rail aligned to icon center (x = 10px) */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-drawer motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="relative pb-2.5 ps-7 pt-0.5 text-xs/5 text-muted-foreground">
              <span
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-2 left-[9.5px] w-px bg-border/60"
              />
              <div className="space-y-1.5">
                {latestVerdict && (
                  <p className="line-clamp-2 wrap-anywhere">
                    <span className="text-foreground/75">
                      {latestVerdict.verdict === "approve" ? "审查结论：" : "修改意见："}
                    </span>
                    {latestVerdict.summary}
                  </p>
                )}

                {step.attentionDetail && status === "needs_attention" && (
                  <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-warning-foreground/90">
                    {step.attentionDetail}
                  </p>
                )}

                {step.reviewSummary && (
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    {step.reviewSummary.gateResults.map((gate) => (
                      <span
                        key={gate.command}
                        className="inline-flex items-center gap-1 rounded-sm bg-foreground/[0.045] px-1.5 py-px font-mono text-2xs text-foreground/75"
                      >
                        <span className="max-w-44 truncate">{gate.command}</span>
                        <span aria-hidden>{gate.passed ? "✓" : "✕"}</span>
                      </span>
                    ))}
                    {step.reviewSummary.gateResults.length > 0 && step.reviewSummary.fileCount > 0 && (
                      <span aria-hidden className="text-muted-foreground/40">
                        ·
                      </span>
                    )}
                    {step.reviewSummary.fileCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <span>{step.reviewSummary.fileCount} 个文件</span>
                        <DiffStatLabel
                          additions={step.reviewSummary.additions}
                          deletions={step.reviewSummary.deletions}
                          layout="inline"
                          className="text-2xs"
                        />
                      </span>
                    )}
                  </div>
                )}

                {secondOpinion && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>
                      {secondOpinion.blockingFindings > 0
                        ? `独立审查发现 ${secondOpinion.blockingFindings} 项问题 · 处理中`
                        : "已通过独立审查"}
                    </span>
                    <button
                      type="button"
                      onClick={() => openChildThread(secondOpinion.childThreadId)}
                      className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                    >
                      打开审查会话
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                  {childThreadId && (
                    <button
                      type="button"
                      onClick={() => openChildThread(childThreadId)}
                      className="text-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    >
                      打开子会话
                    </button>
                  )}
                  {displayReviewId && (
                    <button
                      type="button"
                      onClick={() =>
                        openEvidence({ reviewId: displayReviewId }, `第 ${index + 1} 步 · ${title}`)
                      }
                      className="text-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    >
                      查看改动
                    </button>
                  )}
                  {isRunningStep && canCancel && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleStopClick}
                      className={cn(
                        "underline-offset-2 transition-colors hover:underline",
                        confirmStop
                          ? "font-medium text-destructive"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {confirmStop ? "确认停止" : "停止此步"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function CollabV2Card({
  collab,
  threadRef,
  workspaceRoot,
  onFocusComposer,
}: {
  readonly collab: VelaCollabProjection;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly inspector?: boolean;
  readonly onFocusComposer?: (() => void) | undefined;
}) {
  const providers = useVelaDispatchProviders(threadRef.environmentId);
  const { busyKey, runCollabAction, openChildThread, openCollabEvidenceInDiff } =
    useDispatchActions(workspaceRoot, threadRef);
  const rootRef = useRef<HTMLDivElement>(null);
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<string>>(() => new Set());
  const [topCompletedExpanded, setTopCompletedExpanded] = useState(false);
  const [draftCriteriaOpen, setDraftCriteriaOpen] = useState(false);
  const [highlightRing, setHighlightRing] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);

  const collapsedApplied = useCollabUiStore(
    (s) => s.collapsedAppliedPlanIds[collab.planId] ?? false,
  );
  const justAppliedPulse = useCollabUiStore((s) => s.justAppliedPlanId === collab.planId);
  const projectPrefAgent = useCollabProjectPrefsStore(
    (s) => s.devAgentByProjectRoot[workspaceRoot],
  );
  const setProjectDevAgent = useCollabProjectPrefsStore((s) => s.setProjectDevAgent);

  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const { planId, planVersion, status, delivery, appliedDelivery, batchAudit, config } = collab;
  const active = isActiveCollabPlan(status);
  const isDraft = status === "draft";
  const isReverted = Boolean(appliedDelivery?.revertedAt);
  const isDelivered = status === "delivered" && Boolean(appliedDelivery);
  const busy = busyKey !== null;

  const visibleDraftSteps = isDraft
    ? collab.steps.filter((s) => s.status !== "cancelled")
    : collab.steps;
  const completedCount = collab.steps.filter((s) => isCollabStepDone(s.status)).length;
  const attentionCount = collab.steps.filter((s) => s.status === "needs_attention").length;
  const totalCount = visibleDraftSteps.length;
  const topCompletedRun = isDraft ? 0 : computeTopCompletedRunCount(collab.steps);
  const totalCriteriaCount = visibleDraftSteps.reduce(
    (sum, s) => sum + (s.criteria?.length ?? 0),
    0,
  );
  const uniqueGateCommands = [
    ...new Set([
      ...visibleDraftSteps.flatMap((s) => s.hardGates ?? []),
      ...(collab.batchGates ?? []),
    ]),
  ];

  // Focus & pulse ring listener from ThreadNow / Thread Details / Sidebar
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to cross-component focus events to scroll card and reveal target step
  useEffect(() => {
    return subscribeFocusDispatchStep(threadRef.threadId, (stepId) => {
      setArchivedExpanded(true);
      if (stepId && stepId !== "__plan__" && stepId !== "delivery") {
        setExpandedSteps((prev) => {
          if (prev.has(stepId)) return prev;
          const next = new Set(prev);
          next.add(stepId);
          return next;
        });
      }
      setHighlightRing(true);
      const timer = window.setTimeout(() => setHighlightRing(false), 1000);
      requestAnimationFrame(() => {
        const el =
          stepId && stepId !== "__plan__"
            ? rootRef.current?.querySelector(`[data-collab-step="${CSS.escape(stepId)}"]`) ??
              rootRef.current
            : rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const far = Math.abs(rect.top) > window.innerHeight * 2;
        el.scrollIntoView({ behavior: far ? "auto" : "smooth", block: "center" });
      });
      return () => window.clearTimeout(timer);
    });
  }, [threadRef.threadId]);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const handleOpenDeliveryDiff = () => {
    if (!delivery) return;
    openCollabEvidenceInDiff(planId, { deliveryId: delivery.deliveryId }, "全部待应用改动");
  };

  // Archived 44px single-line bar (after user sends next message post-apply, or when reverted)
  const showArchivedBar =
    (isDelivered && (isReverted || collapsedApplied) && !archivedExpanded) ||
    (status === "cancelled" && !archivedExpanded);

  if (showArchivedBar) {
    return (
      <div
        ref={rootRef}
        data-collab-card={planId}
        className={cn(
          "min-w-0 rounded-2xl border border-border/45 bg-card/35 px-4 py-2.5 transition-shadow",
          highlightRing && "ring-2 ring-foreground/15",
        )}
      >
        <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2">
          <span className="flex items-center justify-center">
            <CollabProgressRing
              completed={completedCount}
              total={totalCount}
              status={status}
              reverted={isReverted}
            />
          </span>
          <button
            type="button"
            onClick={() => setArchivedExpanded(true)}
            className="flex min-w-0 items-center gap-2 text-left text-sm/5"
          >
            <span className="truncate font-medium tracking-tight text-foreground/80">
              {collab.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {isReverted ? "已撤回" : status === "cancelled" ? "已取消" : "已应用"}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            {isDelivered && !isReverted && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setRevertDialogOpen(true)}
                className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                撤回改动
              </button>
            )}
            <button
              type="button"
              onClick={() => setArchivedExpanded(true)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              展开
            </button>
          </div>
        </div>
        <RevertConfirmDialog
          open={revertDialogOpen}
          busy={busy}
          onOpenChange={setRevertDialogOpen}
          onConfirm={() => {
            if (!appliedDelivery) return;
            void runCollabAction({
              endpoint: "revert-delivery",
              planId,
              deliveryId: appliedDelivery.deliveryId,
            }).then((ok) => {
              if (ok) setRevertDialogOpen(false);
            });
          }}
        />
      </div>
    );
  }

  const effectiveDefaultAgent = config.defaultDevAgent ?? projectPrefAgent ?? null;
  const headerMeta = isDraft
    ? `共 ${totalCount} 步 · 待开始`
    : isReverted
      ? "已撤回"
      : isDelivered
        ? "已应用"
        : status === "cancelled"
          ? "已取消"
          : attentionCount > 0
            ? `已完成 ${completedCount}/${totalCount} · ${attentionCount} 项待处理`
            : `已完成 ${completedCount}/${totalCount}`;

  const topSteps = topCompletedRun > 0 ? collab.steps.slice(0, topCompletedRun) : [];
  const mainSteps = topCompletedRun > 0 ? collab.steps.slice(topCompletedRun) : visibleDraftSteps;

  return (
    <div
      ref={rootRef}
      data-collab-card={planId}
      className={cn(
        "@container/collab-card min-w-0 rounded-2xl border p-4 transition-shadow sm:p-5",
        "border-foreground/[0.07] bg-card shadow-(--shadow-composer)",
        "dark:border-white/[0.07] dark:bg-(--surface-raised) dark:shadow-(--shadow-collab-card-dark)",
        highlightRing && "ring-2 ring-foreground/15",
      )}
    >
      {/* Header: aligned to exact 20px icon column + title + meta + 24px menu */}
      <div className="grid h-6 grid-cols-[20px_minmax(0,1fr)_auto_24px] items-center gap-x-2">
        <span className="flex size-5 items-center justify-center">
          <CollabProgressRing
            completed={completedCount}
            total={totalCount}
            status={status}
            reverted={isReverted}
          />
        </span>

        <h2 className="min-w-0 truncate text-sm/5 font-medium tracking-tight text-foreground">
          {collab.title}
        </h2>

        <span
          className={cn(
            "shrink-0 text-xs tabular-nums text-muted-foreground",
            justAppliedPulse && "motion-safe:animate-stash-pulse-row",
          )}
        >
          {headerMeta}
        </span>

        <div className="flex size-6 items-center justify-center">
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="并行任务选项">
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup align="end">
              {active && providers.length > 0 && (
                <MenuSub>
                  <MenuSubTrigger>执行模型</MenuSubTrigger>
                  <MenuSubPopup>
                    <ModelSubmenuItems
                      providers={providers}
                      includeFollowDefault
                      onPick={(target) => {
                        setProjectDevAgent(workspaceRoot, target);
                        void runCollabAction({
                          endpoint: "config",
                          planId,
                          defaultDevAgent: target,
                        });
                      }}
                    />
                  </MenuSubPopup>
                </MenuSub>
              )}
              {active && (
                <MenuItem
                  disabled={busy}
                  onClick={() =>
                    void runCollabAction({
                      endpoint: "config",
                      planId,
                      enableBatchAudit: !config.enableBatchAudit,
                    })
                  }
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span>应用前独立审查</span>
                    {config.enableBatchAudit && <CheckIcon className="size-3.5" />}
                  </span>
                </MenuItem>
              )}
              {delivery && (
                <MenuItem onClick={handleOpenDeliveryDiff}>
                  <FileDiffIcon className="size-3.5" />
                  查看全部改动
                </MenuItem>
              )}
              {(isDelivered || status === "cancelled") && archivedExpanded && (
                <MenuItem onClick={() => setArchivedExpanded(false)}>收起为摘要行</MenuItem>
              )}
              {active && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void runCollabAction({ endpoint: "plan", action: "cancel", planId })
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                    取消并行任务
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {/* Step list: zero divide-y, stable topological order */}
      <ul className="mt-3 space-y-0.5">
        {topSteps.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setTopCompletedExpanded((v) => !v)}
              aria-expanded={topCompletedExpanded}
              className="grid h-8 -mx-2 w-[calc(100%+1rem)] cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 text-left transition-colors hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]"
            >
              <span className="flex size-5 items-center justify-center">
                <CheckIcon strokeWidth={1.5} className="size-3.5 text-foreground/50" />
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                已完成 {topSteps.length} 个步骤
              </span>
              <span className="text-2xs text-muted-foreground/70">
                {topCompletedExpanded ? "收起" : "展开"}
              </span>
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-drawer motion-reduce:transition-none",
                topCompletedExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <ul className="overflow-hidden space-y-0.5">
                {topCompletedExpanded &&
                  topSteps.map((step, idx) => (
                    <LiveStepRow
                      key={step.stepId}
                      step={step}
                      index={idx}
                      collab={collab}
                      providers={providers}
                      busy={busy}
                      expanded={expandedSteps.has(step.stepId)}
                      onToggleExpand={() => toggleStep(step.stepId)}
                      runAction={runCollabAction}
                      openChildThread={openChildThread}
                      openEvidence={(target, label) =>
                        openCollabEvidenceInDiff(planId, target, label)
                      }
                    />
                  ))}
              </ul>
            </div>
          </li>
        )}

        {isDraft
          ? visibleDraftSteps.map((step, idx) => (
              <DraftStepRow
                key={step.stepId}
                step={step}
                index={idx}
                collab={collab}
                providers={providers}
                busy={busy}
                runAction={runCollabAction}
              />
            ))
          : mainSteps.map((step) => {
              const stepIdx = collab.steps.findIndex((s) => s.stepId === step.stepId);
              return (
                <LiveStepRow
                  key={step.stepId}
                  step={step}
                  index={stepIdx >= 0 ? stepIdx : 0}
                  collab={collab}
                  providers={providers}
                  busy={busy}
                  expanded={expandedSteps.has(step.stepId)}
                  onToggleExpand={() => toggleStep(step.stepId)}
                  runAction={runCollabAction}
                  openChildThread={openChildThread}
                  openEvidence={(target, label) =>
                    openCollabEvidenceInDiff(planId, target, label)
                  }
                />
              );
            })}
      </ul>

      {/* Draft-only collapsible criteria & hard gates summary */}
      {isDraft && (totalCriteriaCount > 0 || uniqueGateCommands.length > 0) && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setDraftCriteriaOpen((v) => !v)}
            aria-expanded={draftCriteriaOpen}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {draftCriteriaOpen ? "▾ " : "▸ "}
            {[
              totalCriteriaCount > 0 ? `${totalCriteriaCount} 项验收标准` : null,
              uniqueGateCommands.length > 0 ? `${uniqueGateCommands.length} 条检查命令` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </button>
          <div
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-200 ease-drawer motion-reduce:transition-none",
              draftCriteriaOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="overflow-hidden">
              {draftCriteriaOpen && (
                <div className="mt-2 space-y-2 ps-3 text-xs text-muted-foreground">
                  {uniqueGateCommands.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-foreground/70">检查命令</span>
                      {uniqueGateCommands.map((cmd) => (
                        <span
                          key={cmd}
                          className="rounded-sm bg-foreground/[0.045] px-1.5 py-px font-mono text-2xs text-foreground/75"
                        >
                          {cmd}
                        </span>
                      ))}
                    </div>
                  )}
                  {totalCriteriaCount > 0 && (
                    <ul className="space-y-1">
                      {visibleDraftSteps.flatMap((step, stepIdx) =>
                        (step.criteria ?? []).map((item) => (
                          <li key={`${step.stepId}:${item.id}`} className="truncate">
                            <span className="tabular-nums text-muted-foreground/65">
                              {stepIdx + 1}.{" "}
                            </span>
                            {item.text}
                          </li>
                        )),
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Draft Footer */}
      {isDraft && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>执行模型</span>
            <AgentTargetPicker
              value={effectiveDefaultAgent ?? "inherit"}
              providers={providers}
              allowInherit
              disabled={busy}
              align="start"
              variant="chip"
              onSelect={(target) => {
                if (target === "self") return;
                const resolved = target === "inherit" ? null : target;
                setProjectDevAgent(workspaceRoot, resolved);
                void runCollabAction({
                  endpoint: "config",
                  planId,
                  defaultDevAgent: resolved,
                });
              }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                useCollabUiStore.getState().setComposerBinding(threadRef, {
                  kind: "adjust_plan",
                  planId,
                });
                onFocusComposer?.();
              }}
            >
              调整步骤
            </Button>
            <Button
              size="sm"
              disabled={busy || visibleDraftSteps.length === 0}
              onClick={() =>
                void runCollabAction({
                  endpoint: "plan",
                  action: "start",
                  planId,
                  expectedPlanVersion: planVersion,
                })
              }
            >
              {busyKey === "plan" ? "正在启动…" : "开始执行"}
            </Button>
          </div>
        </div>
      )}

      {/* Batch Verifying / Ready to Deliver / Delivered status footer (Running has NO footer!) */}
      {!isDraft &&
        (status === "batch_verifying" ||
          status === "ready_to_deliver" ||
          isDelivered ||
          collab.canRetryBatch ||
          Boolean(batchAudit)) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3 text-xs text-muted-foreground">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {status === "batch_verifying" && (
                <span role="status" className="inline-flex items-center gap-1.5">
                  <Spinner size="xs" />
                  <span>
                    {collab.batchGateSummary?.passed && config.enableBatchAudit
                      ? "整体验证已通过 · 应用前独立审查中…"
                      : "整体验证中…"}
                  </span>
                </span>
              )}

              {status === "ready_to_deliver" && (
                <span>
                  {batchAudit && batchAudit.blockingFindings === 0
                    ? "整体验证与独立审查已通过 · 待应用"
                    : "整体验证已通过 · 待应用"}
                </span>
              )}

              {batchAudit && batchAudit.blockingFindings > 0 && (
                <span className="inline-flex items-center gap-2 text-foreground/85">
                  <span>应用前独立审查发现 {batchAudit.blockingFindings} 项问题 · 正在处理</span>
                  {batchAudit.childThreadId && (
                    <button
                      type="button"
                      onClick={() => openChildThread(batchAudit.childThreadId!)}
                      className="underline-offset-2 hover:underline"
                    >
                      打开审查会话
                    </button>
                  )}
                </span>
              )}

              {collab.canRetryBatch && status === "running" && (
                <span className="text-warning-foreground">
                  整体验证未通过
                  {collab.attentionDetail ? `：${collab.attentionDetail}` : ""}
                </span>
              )}

              {isDelivered && (
                <span className={cn(justAppliedPulse && "motion-safe:animate-stash-pulse-row")}>
                  {isReverted ? "已撤回本次改动" : "已应用到工作区"}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {collab.canRetryBatch && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runCollabAction({
                      endpoint: "batch/retry",
                      planId,
                      expectedPlanVersion: planVersion,
                      ...(collab.integrationOid ? { integrationOid: collab.integrationOid } : {}),
                    })
                  }
                  className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                >
                  重试验证
                </button>
              )}
              {delivery && status === "ready_to_deliver" && (
                <button
                  type="button"
                  onClick={handleOpenDeliveryDiff}
                  className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                >
                  查看全部改动
                </button>
              )}
              {isDelivered && !isReverted && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRevertDialogOpen(true)}
                  className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                >
                  撤回改动
                </button>
              )}
            </div>
          </div>
        )}

      <RevertConfirmDialog
        open={revertDialogOpen}
        busy={busy}
        onOpenChange={setRevertDialogOpen}
        onConfirm={() => {
          if (!appliedDelivery) return;
          void runCollabAction({
            endpoint: "revert-delivery",
            planId,
            deliveryId: appliedDelivery.deliveryId,
          }).then((ok) => {
            if (ok) setRevertDialogOpen(false);
          });
        }}
      />
    </div>
  );
}

function RevertConfirmDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>撤回本次应用的改动？</DialogTitle>
          <DialogDescription>
            将从当前工作区移除本次应用的改动。应用之后你手动编辑的内容会予以保留；若同一位置存在重叠修改，将提示冲突且不会覆盖文件。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? "正在撤回…" : "确认撤回"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
