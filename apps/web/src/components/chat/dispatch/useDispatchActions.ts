/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  fetchDispatchApi,
  setCachedDispatchState,
  type DispatchAgentTarget,
  type VelaDispatchState,
} from "~/state/velaDispatch";

export async function postDispatchAction(params: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly pathname: string;
  readonly body: Record<string, unknown>;
  readonly successTitle?: string | undefined;
}): Promise<boolean> {
  try {
    const next = await fetchDispatchApi<VelaDispatchState>(params.pathname, {
      method: "POST",
      body: JSON.stringify({
        projectRoot: params.workspaceRoot,
        threadId: params.threadId,
        ...params.body,
      }),
    });
    setCachedDispatchState(params.workspaceRoot, next, params.threadId);
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
            ...(deliverClient ? { deliver: "client" } : {}),
          }),
        },
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

  return {
    busyKey,
    runAction,
    runKickoff,
    openChildThread,
    openFileInPanel,
    openDiffInPanel,
  };
}
