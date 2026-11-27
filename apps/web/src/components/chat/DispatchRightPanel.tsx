/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BotIcon,
  FileDiffIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  UnlockIcon,
} from "lucide-react";
import { useState } from "react";

import {
  useVelaDispatchProviders,
  useVelaDispatchState,
  type DispatchAgentTarget,
  type DispatchTaskCard,
  type DispatchTaskSpecPatch,
} from "~/state/velaDispatch";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DispatchActivity } from "./dispatch/DispatchActivity";
import { AgentTargetPicker } from "./dispatch/AgentTargetPicker";
import { CollabV2Card } from "./dispatch/CollabV2Card";
import { DispatchComposerBanner } from "./dispatch/DispatchComposerBanner";
import { DispatchHistory } from "./dispatch/DispatchHistory";
import { DispatchKickoff } from "./dispatch/DispatchKickoff";
import { DispatchOutline } from "./dispatch/DispatchOutline";
import { DispatchProgressStrip } from "./dispatch/DispatchProgressStrip";
import { DispatchStepDiffDialog } from "./dispatch/DispatchStepDiffDialog";
import { DispatchStepEditor } from "./dispatch/DispatchStepEditor";
import { isActiveCollabPlan, providerLabelOf } from "./dispatch/dispatchModel";
import { useDispatchActions } from "./dispatch/useDispatchActions";

export { DispatchComposerBanner };

interface DispatchRightPanelProps {
  readonly workspaceRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly isServerThread?: boolean | undefined;
  readonly hasConversationMessages?: boolean | undefined;
  readonly currentBranch?: string | null | undefined;
  readonly sendPrompt?: ((prompt: string) => Promise<boolean>) | undefined;
}

export function DispatchRightPanel({
  workspaceRoot,
  threadRef,
  isServerThread,
  hasConversationMessages,
  currentBranch: _currentBranch,
  sendPrompt,
}: DispatchRightPanelProps) {
  const { state, refresh } = useVelaDispatchState(
    workspaceRoot,
    threadRef.threadId,
    threadRef.environmentId,
  );
  const providers = useVelaDispatchProviders(threadRef.environmentId);
  const {
    busyKey,
    runAction,
    runCollabAction,
    runKickoff,
    openChildThread,
    openFileInPanel,
    openDiffInPanel,
  } = useDispatchActions(workspaceRoot, threadRef, { isServerThread, sendPrompt });

  const [pendingDefaultAgent, setPendingDefaultAgent] = useState<
    DispatchAgentTarget | null | undefined
  >(undefined);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<DispatchTaskCard | null>(null);
  const [diffStepId, setDiffStepId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [newPlanAfter, setNewPlanAfter] = useState<string | null>(null);
  const [devPickerPlanId, setDevPickerPlanId] = useState<string | null>(null);
  const collab = state?.collab;
  const preparingNewPlan = collab?.planId === newPlanAfter;

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const startedAt = Date.now();
    try {
      await refresh();
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "刷新状态失败",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const remaining = 520 - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      setIsRefreshing(false);
    }
  };

  if (!workspaceRoot) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon className="size-4" />
            </EmptyMedia>
            <EmptyTitle>未打开项目工作区</EmptyTitle>
            <EmptyDescription>进入具体项目线程后即可使用分步派发与门禁验收。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (collab && !preparingNewPlan) {
    const { planId, config } = collab;
    const active = isActiveCollabPlan(collab.status);
    return (
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div
          data-surface-subheader
          className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-3"
        >
          <span className="text-sm font-medium">协作检查器</span>
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="协作选项">
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup align="end">
              {active && (
                <>
                  <MenuItem disabled={busyKey !== null} onClick={() => setDevPickerPlanId(planId)}>
                    <BotIcon className="size-3.5" /> 切换默认开发代理
                  </MenuItem>
                  <MenuItem
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runCollabAction({
                        endpoint: "config",
                        planId,
                        enableBatchAudit: !config.enableBatchAudit,
                      })
                    }
                  >
                    {config.enableBatchAudit ? "关闭交付前冷眼终审" : "开启交付前冷眼终审"}
                  </MenuItem>
                </>
              )}
              <MenuItem onClick={openDiffInPanel}>
                <FileDiffIcon className="size-3.5" /> 查看工作区 Diff
              </MenuItem>
              <MenuSeparator />
              {active ? (
                <MenuItem
                  variant="destructive"
                  disabled={busyKey !== null}
                  onClick={async () => {
                    if (await runCollabAction({ endpoint: "plan", action: "cancel", planId }))
                      setNewPlanAfter(planId);
                  }}
                >
                  <Trash2Icon className="size-3.5" /> 取消计划
                </MenuItem>
              ) : (
                <MenuItem onClick={() => setNewPlanAfter(planId)}>
                  <PlusIcon className="size-3.5" /> 开启新计划
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <CollabV2Card
            key={planId}
            collab={collab}
            threadRef={threadRef}
            workspaceRoot={workspaceRoot}
            inspector
          />
        </ScrollArea>
        <Dialog
          open={active && devPickerPlanId === planId}
          onOpenChange={(open) => setDevPickerPlanId(open ? planId : null)}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>切换默认开发代理</DialogTitle>
              <DialogDescription>适用于接下来启动的开发步骤。</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <AgentTargetPicker
                value={config.defaultDevAgent ?? "inherit"}
                providers={providers}
                allowInherit
                disabled={busyKey !== null}
                align="start"
                onSelect={(target) => {
                  if (target === "self") return;
                  void runCollabAction({
                    endpoint: "config",
                    planId,
                    defaultDevAgent: target === "inherit" ? null : target,
                  });
                }}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </div>
    );
  }

  const steps = preparingNewPlan ? [] : (state?.steps ?? []);
  const blindCheck = preparingNewPlan ? null : (state?.blindCheck ?? null);
  const hasPlanOrBlind = steps.length > 0 || Boolean(blindCheck);
  const doneCount = steps.filter((s) => s.status === "done").length;
  const lockedSteps = steps.filter((s) => s.status === "locked");

  const selectedDefaultAgent =
    pendingDefaultAgent !== undefined
      ? pendingDefaultAgent
      : preparingNewPlan
        ? (collab?.config.defaultDevAgent ?? null)
        : (state?.config?.defaultAgent ?? null);

  const focusStep = (stepId: string) => {
    if (typeof document !== "undefined") {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-step-id="${CSS.escape(stepId)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  };

  const openCreateEditor = () => {
    setEditingStep(null);
    setEditorOpen(true);
  };

  const openEditEditor = (step: DispatchTaskCard) => {
    setEditingStep(step);
    setEditorOpen(true);
  };

  const handlePublishNewStep = async (
    stepInput: Record<string, unknown>,
    planTitle: string,
  ): Promise<boolean> => {
    return runAction(
      "publish",
      "/api/vela/dispatch/publish",
      {
        parentThreadId: threadRef.threadId,
        append: steps.length > 0,
        ...(steps.length === 0 ? { planTitle } : {}),
        steps: [stepInput],
      },
      steps.length > 0 ? "已追加单步任务卡" : "已手动添加任务卡",
    );
  };

  const handleUpdateStep = async (
    stepId: string,
    patch: DispatchTaskSpecPatch,
  ): Promise<boolean> => {
    return runAction(
      `update:${stepId}`,
      "/api/vela/dispatch/step/update",
      { stepId, patch },
      `已更新 ${stepId}`,
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* Subheader */}
      <div
        data-surface-subheader
        className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 in-data-[preview-panel-mode=inline]:h-8 in-data-[preview-panel-mode=inline]:min-h-8"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {state?.planTitle || "分步派发"}
          </span>
          {steps.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {doneCount}/{steps.length}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={isRefreshing ? "正在刷新状态" : "刷新状态"}
                  aria-busy={isRefreshing}
                  onClick={() => void handleRefresh()}
                >
                  <RefreshIcon size="sm" refreshing={isRefreshing} />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {isRefreshing ? "刷新中..." : "刷新状态"}
            </TooltipPopup>
          </Tooltip>

          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="更多选项">
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup align="end">
              {hasPlanOrBlind && providers.length > 0 && (
                <MenuSub>
                  <MenuSubTrigger>
                    <BotIcon className="size-3.5" />
                    切换默认派发 AI
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuItem
                      onClick={() => {
                        setPendingDefaultAgent(null);
                        void runAction(
                          "config:default",
                          "/api/vela/dispatch/config",
                          { defaultAgent: null, applyToPendingSteps: true },
                          "已将待执行步骤切换为跟随当前对话 AI",
                        );
                      }}
                    >
                      跟随当前对话模型
                    </MenuItem>
                    <MenuSeparator />
                    {providers.map((p) => {
                      const pLabel = providerLabelOf(p);
                      if (p.models.length <= 1) {
                        return (
                          <MenuItem
                            key={p.instanceId}
                            onClick={() => {
                              const target: DispatchAgentTarget = {
                                providerInstanceId: p.instanceId,
                                ...(p.models[0]?.slug ? { model: p.models[0].slug } : {}),
                              };
                              setPendingDefaultAgent(target);
                              void runAction(
                                `config:${p.instanceId}`,
                                "/api/vela/dispatch/config",
                                { defaultAgent: target, applyToPendingSteps: true },
                                `已将待执行步骤切换为 ${pLabel}`,
                              );
                            }}
                          >
                            {pLabel}
                            {p.models[0]?.name ? ` · ${p.models[0].name}` : ""}
                          </MenuItem>
                        );
                      }
                      return (
                        <MenuSub key={p.instanceId}>
                          <MenuSubTrigger>{pLabel}</MenuSubTrigger>
                          <MenuSubPopup>
                            {p.models.map((m) => (
                              <MenuItem
                                key={m.slug}
                                onClick={() => {
                                  const target: DispatchAgentTarget = {
                                    providerInstanceId: p.instanceId,
                                    model: m.slug,
                                  };
                                  setPendingDefaultAgent(target);
                                  void runAction(
                                    `config:${p.instanceId}:${m.slug}`,
                                    "/api/vela/dispatch/config",
                                    { defaultAgent: target, applyToPendingSteps: true },
                                    `已将待执行步骤切换为 ${pLabel} · ${m.name || m.slug}`,
                                  );
                                }}
                              >
                                {m.name || m.slug}
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      );
                    })}
                  </MenuSubPopup>
                </MenuSub>
              )}

              {hasPlanOrBlind && (
                <MenuItem onClick={openCreateEditor}>
                  <PlusIcon className="size-3.5" />
                  手动新建单步任务卡
                </MenuItem>
              )}

              {lockedSteps.length > 0 && (
                <MenuItem
                  onClick={() =>
                    void runAction(
                      "unlock-all",
                      "/api/vela/dispatch/steps/unlock-all",
                      {},
                      "已解锁全部步骤，可自由并行派发",
                    )
                  }
                >
                  <UnlockIcon className="size-3.5" />
                  全部解锁
                </MenuItem>
              )}

              <MenuItem onClick={openDiffInPanel}>
                <FileDiffIcon className="size-3.5" />
                查看工作区 Diff
              </MenuItem>

              {hasPlanOrBlind && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    variant="destructive"
                    onClick={() =>
                      void runAction(
                        "clear",
                        "/api/vela/dispatch/clear",
                        {},
                        steps.length > 0
                          ? "已归档上一轮计划，可开始新拆单"
                          : "已重置派发面板",
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                    {steps.length > 0 ? "归档并开启新计划" : "重置面板"}
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {steps.length > 0 && (
        <div className="border-b border-border/40 py-1.5">
          <DispatchProgressStrip
            steps={steps}
            runs={state?.runs}
            onSelectStep={focusStep}
            onOpenThread={openChildThread}
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1" scrollFade>
        {steps.length === 0 ? (
          <div className="pb-4">
            <DispatchKickoff
              workspaceRoot={workspaceRoot}
              threadId={threadRef.threadId}
              providers={providers}
              blindCheck={blindCheck}
              selectedDefaultAgent={selectedDefaultAgent}
              defaultEnableBatchAudit={
                (preparingNewPlan ? collab?.config.enableBatchAudit : state?.config?.enableBatchAudit) ?? false
              }
              hasConversationMessages={hasConversationMessages}
              busyKey={busyKey}
              onSelectDefaultAgent={(target) => {
                setPendingDefaultAgent(target);
              }}
              onKickoff={(req, mode, enableBatchAudit) =>
                runKickoff(req, mode, selectedDefaultAgent, enableBatchAudit)
              }
              onCancelBlindCheck={() =>
                void runAction(
                  "cancel:blind",
                  "/api/vela/dispatch/step/cancel",
                  { stepId: "__blind_check__" },
                  "已中止只读盲审",
                )
              }
              onClear={() =>
                void runAction("clear", "/api/vela/dispatch/clear", {}, "已重置派发面板")
              }
              onOpenCheckerThread={openChildThread}
              onOpenManualCreate={openCreateEditor}
            />
            <DispatchHistory
              workspaceRoot={workspaceRoot}
              history={state?.history ?? []}
              busyKey={busyKey}
              onOpenThread={openChildThread}
              onDeleteArchive={(archiveId) =>
                void runAction(
                  `delete-history:${archiveId}`,
                  "/api/vela/dispatch/history/delete",
                  { archiveId },
                  "已删除历史计划",
                )
              }
            />
          </div>
        ) : (
          <div className="pb-4">
            <DispatchOutline
              steps={steps}
              runs={state?.runs ?? {}}
              blindCheck={blindCheck}
              providers={providers}
              onOpenThread={openChildThread}
              onOpenDiff={openDiffInPanel}
              onOpenStepDiff={(stepId) => setDiffStepId(stepId)}
              onEditStep={openEditEditor}
            />
            <DispatchActivity events={state?.events ?? []} />
            <DispatchHistory
              workspaceRoot={workspaceRoot}
              history={state?.history ?? []}
              busyKey={busyKey}
              onOpenThread={openChildThread}
              onDeleteArchive={(archiveId) =>
                void runAction(
                  `delete-history:${archiveId}`,
                  "/api/vela/dispatch/history/delete",
                  { archiveId },
                  "已删除历史计划",
                )
              }
            />
          </div>
        )}
      </ScrollArea>

      <DispatchStepDiffDialog
        step={diffStepId ? (steps.find((s) => s.id === diffStepId) ?? null) : null}
        run={diffStepId && state ? state.runs[diffStepId] : undefined}
        onClose={() => setDiffStepId(null)}
        onOpenFile={openFileInPanel}
        onOpenWorkspaceDiff={openDiffInPanel}
        onOpenChildThread={openChildThread}
      />

      <DispatchStepEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initialStep={editingStep}
        existingSteps={steps}
        busy={busyKey !== null}
        onPublishNew={handlePublishNewStep}
        onUpdateExisting={handleUpdateStep}
      />
    </div>
  );
}
