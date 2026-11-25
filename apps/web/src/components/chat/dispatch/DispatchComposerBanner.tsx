/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  GitForkIcon,
  LayersIcon,
  Loader2Icon,
  LockIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useVelaDispatchState, type DispatchStepStatus } from "~/state/velaDispatch";
import { ComposerBanner } from "../ComposerBanner";
import {
  isActiveProgressStatus,
  isBusyStatus,
  isStepAwaitingDecision,
  STATUS_LABEL,
} from "./dispatchModel";
import { postDispatchAction } from "./useDispatchActions";

function BannerStatusGlyph({ status }: { readonly status: DispatchStepStatus }) {
  if (isBusyStatus(status)) {
    return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground" />;
  }
  switch (status) {
    case "done":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground/70" />;
    case "ready_to_accept":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground" />;
    case "locked":
      return <LockIcon className="size-3 shrink-0 text-muted-foreground/50" />;
    case "boundary_violation":
    case "hard_gate_failed":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
    case "premise_failed":
    case "waiting_orchestrator":
    case "needs_human_decision":
    case "awaiting_decision":
      return <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" />;
    case "awaiting_product_acceptance":
      return <CircleDotIcon className="size-3.5 shrink-0 text-foreground/85" />;
    default:
      return <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

/**
 * Native Composer attachment tucked into Vela's ComposerBanner.Dock.
 * Invisible during normal chat and when the Dispatch panel is already open on screen.
 */
export function DispatchComposerBanner({
  workspaceRoot,
  threadRef,
  isMainAgentWorking = false,
}: {
  readonly workspaceRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly isMainAgentWorking?: boolean | undefined;
}) {
  const { state } = useVelaDispatchState(workspaceRoot, threadRef.threadId);
  const activePanel = useRightPanelStore((s) => selectActiveRightPanel(s.byThreadKey, threadRef));
  const [busy, setBusy] = useState(false);
  const [customReply, setCustomReply] = useState("");

  if (
    activePanel === "dispatch" ||
    !workspaceRoot ||
    !state ||
    (state.steps.length === 0 && !state.blindCheck)
  ) {
    return null;
  }

  const openDispatchTab = () => {
    useRightPanelStore.getState().open(threadRef, "dispatch");
  };

  if (isMainAgentWorking) {
    const doneCount = state.steps.filter((s) => s.status === "done").length;
    const hasPendingUserAction =
      state.escalations.some((e) => e.status === "open_human") ||
      state.steps.some((s) => isStepAwaitingDecision(s) || s.status === "ready_to_accept");
    const activeStep = state.steps.find((s) => isActiveProgressStatus(s.status));
    const stepPrefix = state.steps.length > 0 ? `${doneCount}/${state.steps.length} · ` : "";
    const statusText = hasPendingUserAction
      ? `${stepPrefix}主代理正在介入整理，回复完成后展示操作卡片…`
      : activeStep
        ? `${stepPrefix}${activeStep.title} · 主代理正在同步状态…`
        : state.blindCheck?.status === "running"
          ? "只读盲审 · 正在核查代码…"
          : "主代理正在回复，完成后展示执行计划…";
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="default">
          <ComposerBanner.Row>
            <span className="flex items-center justify-center text-foreground">
              <Loader2Icon className="size-3.5 animate-spin text-foreground" />
            </span>
            <button
              type="button"
              onClick={openDispatchTab}
              className="min-w-0 truncate text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {statusText}
            </button>
            <div data-slot="composer-banner-actions" className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="ghost" onClick={openDispatchTab}>
                面板
              </Button>
            </div>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  const openDiffTab = () => {
    useRightPanelStore.getState().open(threadRef, "diff");
  };

  const runBannerAction = async (
    pathname: string,
    body: Record<string, unknown>,
    successTitle?: string,
  ) => {
    setBusy(true);
    try {
      await postDispatchAction({
        workspaceRoot,
        threadId: threadRef.threadId,
        pathname,
        body,
        successTitle,
      });
    } finally {
      setBusy(false);
    }
  };

  // Priority 1: open_human escalation
  const humanEsc = state.escalations.find((e) => e.status === "open_human");
  if (humanEsc) {
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="warning" density="comfortable">
          <div className="space-y-2 px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" />
                <span className="truncate">
                  {humanEsc.stepId} 需要你拍板：{humanEsc.title}
                </span>
              </div>
              <Button size="xs" variant="ghost" onClick={openDispatchTab}>
                面板
              </Button>
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {humanEsc.humanPrompt || humanEsc.question}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {humanEsc.options.map((opt) => (
                <Button
                  key={opt.id}
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void runBannerAction(
                      "/api/vela/dispatch/escalation/reply",
                      {
                        escalationId: humanEsc.id,
                        selectedOptionId: opt.id,
                        decision: opt.description
                          ? `${opt.label}（${opt.description}）`
                          : opt.label,
                        resolvedBy: "human",
                      },
                      "已拍板并恢复执行",
                    )
                  }
                >
                  {opt.label}
                </Button>
              ))}
              <div className="flex min-w-40 flex-1 items-center gap-1">
                <Input
                  size="compact"
                  placeholder="或输入你的决定..."
                  value={customReply}
                  onChange={(e) => setCustomReply(e.target.value)}
                />
                <Button
                  size="xs"
                  disabled={busy || !customReply.trim()}
                  onClick={() => {
                    const decision = customReply.trim();
                    setCustomReply("");
                    void runBannerAction(
                      "/api/vela/dispatch/escalation/reply",
                      { escalationId: humanEsc.id, decision, resolvedBy: "human" },
                      "已发送并恢复执行",
                    );
                  }}
                >
                  发送
                </Button>
              </div>
            </div>
          </div>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  // Priority 2: pending decision step
  const pendingDecision = state.steps.find((s) => isStepAwaitingDecision(s));
  if (pendingDecision) {
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="warning">
          <ComposerBanner.Row>
            <span className="flex items-center justify-center text-warning">
              <GitForkIcon className="size-3.5" />
            </span>
            <button
              type="button"
              onClick={openDispatchTab}
              className="min-w-0 truncate text-left text-xs text-foreground hover:underline"
            >
              <span className="font-mono text-muted-foreground">{pendingDecision.id}</span>{" "}
              <span>等你拍板：</span>
              <span className="font-medium">{pendingDecision.title}</span>
            </button>
            <div data-slot="composer-banner-actions" className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="ghost" onClick={openDispatchTab}>
                面板
              </Button>
            </div>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  // Priority 3: ready_to_accept
  const readyToAccept = state.steps.find((s) => s.status === "ready_to_accept");
  if (readyToAccept) {
    const run = state.runs[readyToAccept.id];
    const fileCount = run?.diffSummary?.changedFiles.length ?? 0;
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="default">
          <ComposerBanner.Row>
            <span className="flex items-center justify-center text-foreground">
              <CheckCircle2Icon className="size-3.5" />
            </span>
            <button
              type="button"
              onClick={openDispatchTab}
              className="min-w-0 truncate text-left text-xs text-foreground hover:underline"
            >
              <span className="font-mono text-muted-foreground">{readyToAccept.id}</span>{" "}
              <span className="font-medium">{readyToAccept.title}</span>
              <span className="text-muted-foreground">
                {" "}
                · 通过检查{fileCount > 0 ? `（${fileCount} 个文件）` : ""}
              </span>
            </button>
            <div data-slot="composer-banner-actions" className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="ghost" onClick={openDiffTab}>
                Diff
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void runBannerAction(
                    "/api/vela/dispatch/step/revert",
                    { stepId: readyToAccept.id },
                    `已撤回 ${readyToAccept.id}`,
                  )
                }
              >
                撤回
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                onClick={() =>
                  void runBannerAction(
                    "/api/vela/dispatch/step/accept",
                    { stepId: readyToAccept.id },
                    `已确认验收 ${readyToAccept.id}`,
                  )
                }
              >
                确认验收
              </Button>
            </div>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  const doneCount = state.steps.filter((s) => s.status === "done").length;
  const allDone = state.steps.length > 0 && doneCount === state.steps.length;
  if (allDone && !state.blindCheck) return null;

  // Priority 4: active / running / failed / blindCheck running
  // (Idle/ready plans live inline in the chat timeline via DispatchInlinePlanCard, so avoid duplicating them here.)
  const activeStep =
    state.steps.find((s) => isActiveProgressStatus(s.status)) ??
    state.steps.find(
      (s) =>
        s.status === "premise_failed" ||
        s.status === "boundary_violation" ||
        s.status === "hard_gate_failed",
    );
  const blindCheckRunning = state.blindCheck?.status === "running";
  if (!activeStep && !blindCheckRunning) {
    return null;
  }
  const activeRun = activeStep ? state.runs[activeStep.id] : undefined;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="default">
        <ComposerBanner.Row>
          <span className="flex items-center justify-center text-muted-foreground">
            {activeStep ? (
              <BannerStatusGlyph status={activeStep.status} />
            ) : state.blindCheck?.status === "running" ? (
              <Loader2Icon className="size-3.5 animate-spin text-foreground" />
            ) : (
              <LayersIcon className="size-3.5" />
            )}
          </span>
          <button
            type="button"
            onClick={openDispatchTab}
            className="min-w-0 truncate text-left text-xs text-muted-foreground hover:text-foreground"
          >
            {activeStep ? (
              <>
                <span className="font-mono text-foreground/90">
                  {doneCount}/{state.steps.length}
                </span>
                {" · "}
                <span className="font-medium text-foreground">{activeStep.title}</span>
                {" · "}
                <span>{activeRun?.headline || STATUS_LABEL[activeStep.status]}</span>
              </>
            ) : (
              <span>
                只读盲审 ·{" "}
                {state.blindCheck?.status === "running" ? "正在核查代码..." : "已完成，点击查看"}
              </span>
            )}
          </button>
          <div data-slot="composer-banner-actions" className="flex shrink-0 items-center gap-1">
            {activeRun?.childThreadId && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  useRightPanelStore
                    .getState()
                    .openThread(threadRef, ThreadId.make(activeRun.childThreadId!))
                }
              >
                子线程
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={openDispatchTab}>
              面板
            </Button>
          </div>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
