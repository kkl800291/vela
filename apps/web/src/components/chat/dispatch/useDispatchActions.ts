/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import {
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
  type CollabDiffTarget,
} from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useCollabUiStore } from "~/state/collabUiStore";
import {
  fetchDispatchApi,
  refreshDispatchState,
  setCachedDispatchState,
  type DispatchAgentTarget,
  type VelaDispatchState,
} from "~/state/velaDispatch";

type CollabStepAction = { stepId: string };
type CollabReviewAction = CollabStepAction & { reviewId: string };
type CollabVersionedAction = { expectedPlanVersion: number };
type CollabDeliveryAction = { deliveryId: string };

type CollabAction = { planId: string } & (
  | {
      endpoint: "config";
      defaultDevAgent?: DispatchAgentTarget | null;
      enableBatchAudit?: boolean;
      batchAuditAgent?: DispatchAgentTarget | null;
    }
  | ({ endpoint: "plan"; action: "start" } & CollabVersionedAction)
  | { endpoint: "plan"; action: "cancel" }
  | ({ endpoint: "step/cancel" } & CollabStepAction & CollabVersionedAction)
  | ({
      endpoint: "step/executor";
      executor: DispatchAgentTarget | null;
    } & CollabStepAction &
      CollabVersionedAction)
  | ({ endpoint: "step/retry-review" } & CollabReviewAction)
  | ({
      endpoint: "step/second-opinion";
      brief: string;
      target?: DispatchAgentTarget;
    } & CollabReviewAction)
  | ({
      endpoint: "step/resolve";
      response: string;
    } & (
      | ({ resolution: "human_decision" } & CollabStepAction)
      | ({ resolution: "human_manual_check" } & CollabReviewAction)
    ))
  | ({ endpoint: "deliver"; expectedTargetState: string } & CollabDeliveryAction)
  | ({ endpoint: "revert-delivery" } & CollabDeliveryAction)
  | ({ endpoint: "batch/retry"; integrationOid?: string } & CollabVersionedAction)
);

type CollabDeliveryResult =
  | { status: "applied" | "reverted" | "reconciled" | "target_busy" | "pending" }
  | { status: "conflict"; conflictFiles: ReadonlyArray<string> }
  | { status: "drifted_needs_reverify" };

const COLLAB_SUCCESS = {
  config: "已更新任务设置",
  "step/cancel": "已取消此步骤",
  "step/executor": "已更新步骤执行模型",
  "step/retry-review": "已重新提交审查",
  "step/second-opinion": "已发起独立审查",
  "step/resolve": "已提交处理结果",
  "batch/retry": "已重新开始整体验证",
} as const;

async function postCollabAction(
  workspaceRoot: string,
  threadRef: ScopedThreadRef,
  action: CollabAction,
): Promise<boolean> {
  const { endpoint, ...body } = action;
  const { threadId, environmentId } = threadRef;
  const refresh = () => refreshDispatchState(workspaceRoot, threadId, environmentId);
  let result: CollabDeliveryResult | { status?: undefined };
  try {
    result = await fetchDispatchApi(
      `/api/vela/dispatch/v2/${endpoint}`,
      { method: "POST", body: JSON.stringify({ threadId, ...body }) },
      undefined,
      environmentId,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stale = /stale|no longer|current target state|HTTP 409/i.test(detail);
    if (stale) void refresh().catch(() => {});
    toastManager.add({
      type: "error",
      title: stale ? "任务状态已更新，请核对后重试" : "操作失败",
      description: detail,
    });
    return false;
  }

  const delivery = endpoint === "deliver" || endpoint === "revert-delivery";
  const status = delivery ? result.status : undefined;
  const refreshed = await refresh().then(
    () => true,
    () => false,
  );
  if (!refreshed) {
    toastManager.add({
      type: "warning",
      title: "暂时无法刷新任务状态",
      description: "连接恢复后将自动同步最新状态。",
    });
  }
  if (status === "conflict" && result.status === "conflict") {
    if (action.endpoint === "deliver") {
      useCollabUiStore.getState().setDeliveryConflict(action.planId, {
        planId: action.planId,
        deliveryId: action.deliveryId,
        expectedTargetState: action.expectedTargetState,
        conflictFiles: result.conflictFiles,
      });
    }
    toastManager.add({
      type: "error",
      title:
        endpoint === "deliver"
          ? `与当前工作区的 ${result.conflictFiles.length} 个文件存在冲突，未写入任何改动`
          : "部分文件与后续编辑冲突，未执行撤回",
      description: result.conflictFiles.join("、"),
    });
    return false;
  }
  if (status === "target_busy") {
    toastManager.add({ type: "warning", title: "当前工作区正在写入中，请稍后重试" });
    return false;
  }
  if (status === "drifted_needs_reverify") {
    useCollabUiStore.getState().setDeliveryConflict(action.planId, null);
    toastManager.add({
      type: "warning",
      title: "工作区有新改动，正在重新执行整体验证",
      description: "验证通过后可再次应用到工作区。",
    });
    return false;
  }
  if (status === "pending") {
    toastManager.add({ type: "warning", title: "应用操作正在恢复中，请稍候" });
    return false;
  }
  if (endpoint === "deliver") {
    useCollabUiStore.getState().setDeliveryConflict(action.planId, null);
    useCollabUiStore.getState().markAppliedCollapsed(action.planId, false);
    useCollabUiStore.getState().triggerAppliedPulse(action.planId);
    const currentDiff = selectThreadDiffPanelSelection(
      useDiffPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (currentDiff.kind === "collab") {
      useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
    }
  }
  toastManager.add({
    type: "success",
    title:
      endpoint === "deliver"
        ? "已应用到工作区"
        : endpoint === "revert-delivery"
          ? "已撤回本次改动"
          : endpoint === "plan"
            ? "expectedPlanVersion" in body
              ? "已开始并行任务"
              : "已取消并行任务"
            : COLLAB_SUCCESS[endpoint],
    ...(endpoint === "deliver"
      ? { description: "改动已作为未暂存修改写入当前工作区" }
      : {}),
  });
  return true;
}

export async function postDispatchAction(params: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly pathname: string;
  readonly body: Record<string, unknown>;
  readonly successTitle?: string | undefined;
}): Promise<boolean> {
  try {
    const next = await fetchDispatchApi<VelaDispatchState>(
      params.pathname,
      {
        method: "POST",
        body: JSON.stringify({
          projectRoot: params.workspaceRoot,
          threadId: params.threadId,
          ...params.body,
        }),
      },
      undefined,
      params.environmentId,
    );
    setCachedDispatchState(params.workspaceRoot, next, params.threadId, params.environmentId);
    if (params.successTitle) {
      toastManager.add({ type: "success", title: params.successTitle });
    }
    return true;
  } catch (err) {
    toastManager.add({
      type: "error",
      title: "操作失败",
      description: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function useDispatchActions(
  workspaceRoot: string | undefined,
  threadRef: ScopedThreadRef,
  options?: {
    readonly isServerThread?: boolean | undefined;
    readonly sendPrompt?: ((prompt: string) => Promise<boolean>) | undefined;
  },
) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const collabActionInFlight = useRef(false);

  const runCollabAction = async (action: CollabAction): Promise<boolean> => {
    if (!workspaceRoot || collabActionInFlight.current) return false;
    collabActionInFlight.current = true;
    setBusyKey(action.endpoint);
    try {
      return await postCollabAction(workspaceRoot, threadRef, action);
    } finally {
      collabActionInFlight.current = false;
      setBusyKey(null);
    }
  };

  const runAction = async (
    key: string,
    pathname: string,
    body: Record<string, unknown>,
    successTitle?: string,
  ): Promise<boolean> => {
    if (!workspaceRoot) return false;
    setBusyKey(key);
    try {
      return await postDispatchAction({
        workspaceRoot,
        threadId: threadRef.threadId,
        environmentId: threadRef.environmentId,
        pathname,
        body,
        successTitle,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const runKickoff = async (
    requirement: string,
    mode: "fast" | "strict",
    defaultAgent: DispatchAgentTarget | null,
    enableBatchAudit = false,
  ): Promise<boolean> => {
    if (!workspaceRoot) return false;
    setBusyKey("kickoff");
    const deliverClient = options?.isServerThread === false && Boolean(options.sendPrompt);
    try {
      const res = await fetchDispatchApi<{ ok: true; prompt?: string }>(
        "/api/vela/dispatch/kickoff",
        {
          method: "POST",
          body: JSON.stringify({
            projectRoot: workspaceRoot,
            threadId: threadRef.threadId,
            requirement,
            mode,
            defaultAgent,
            ...(mode === "fast" ? { enableBatchAudit } : {}),
            ...(deliverClient ? { deliver: "client" } : {}),
          }),
        },
        undefined,
        threadRef.environmentId,
      );
      if (deliverClient && options?.sendPrompt) {
        if (!res.prompt) {
          throw new Error("未获取到拆单提示词");
        }
        const sent = await options.sendPrompt(res.prompt);
        if (!sent) {
          toastManager.add({
            type: "warning",
            title: "无法自动发送",
            description: "请先发送或清空左侧输入框中的内容，再拆单",
          });
          return false;
        }
      }
      toastManager.add({
        type: "success",
        title: mode === "strict" ? "已让主控先盲审代码再拆单" : "已发送给左侧主控自动拆单",
      });
      return true;
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const openChildThread = (childThreadId: string) => {
    useRightPanelStore.getState().openThread(threadRef, ThreadId.make(childThreadId));
  };

  const openFileInPanel = (relativePath: string) => {
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  };

  const openDiffInPanel = () => {
    useRightPanelStore.getState().open(threadRef, "diff");
  };

  const openCollabEvidenceInDiff = (planId: string, target: CollabDiffTarget, label: string) => {
    useDiffPanelStore.getState().selectCollabEvidence(threadRef, { planId, target, label });
    useRightPanelStore.getState().open(threadRef, "diff");
  };

  return {
    busyKey,
    runAction,
    runCollabAction,
    runKickoff,
    openChildThread,
    openFileInPanel,
    openDiffInPanel,
    openCollabEvidenceInDiff,
  };
}
