/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitForkIcon,
  LockIcon,
  PanelRightIcon,
  PlayIcon,
  RotateCcwIcon,
  SearchCheckIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  UnlockIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  subscribeFocusDispatchStep,
  useVelaDispatchProviders,
  type DispatchEscalationRecord,
  type DispatchProviderSummary,
  type DispatchStepRun,
  type DispatchStepStatus,
  type DispatchTaskCard,
  type DispatchTaskSpecPatch,
  type VelaDispatchState,
} from "~/state/velaDispatch";
import { AgentTargetPicker } from "./AgentTargetPicker";
import { CollabV2Card } from "./CollabV2Card";
import { DispatchDecisionPicker } from "./DispatchDecisionPicker";
import { DispatchElapsedTimer } from "./DispatchElapsedTimer";
import { DispatchStepDiffDialog } from "./DispatchStepDiffDialog";
import {
  computeBatches,
  isActiveProgressStatus,
  isBusyStatus,
  isCanRunStatus,
  isStepAwaitingDecision,
  KIND_META,
  progressSegmentTone,
  resolveAgentTargetDisplay,
  resolveStepKind,
  STATUS_LABEL,
  stripMarkdownPreview,
  summarizeStepVerification,
} from "./dispatchModel";
import { useDispatchActions } from "./useDispatchActions";

function InlineStepGlyph({ status }: { readonly status: DispatchStepStatus }) {
  if (isActiveProgressStatus(status)) {
    return (
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span className="absolute size-3 rounded-full bg-foreground/25 visible-animate-dispatch-ping" />
        <span className="relative size-1.5 rounded-full bg-foreground" />
      </span>
    );
  }
  switch (status) {
    case "done":
      return <CheckCircle2Icon className="size-4 shrink-0 text-foreground/75" />;
    case "ready_to_accept":
      return <CheckCircle2Icon className="size-4 shrink-0 text-foreground" />;
    case "awaiting_decision":
      return <GitForkIcon className="size-4 shrink-0 text-warning" />;
    case "needs_human_decision":
    case "premise_failed":
      return <ShieldAlertIcon className="size-4 shrink-0 text-warning" />;
    case "boundary_violation":
    case "hard_gate_failed":
      return <XCircleIcon className="size-4 shrink-0 text-destructive" />;
    case "locked":
      return <LockIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
    default:
      return <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground/75" />;
  }
}

function InlinePlanStepRow({
  workspaceRoot,
  currentBranch,
  step,
  run,
  escalation,
  providers,
  expanded,
  busy,
  onToggleExpand,
  onOpenThread,
  onOpenFile,
  onOpenStepDiff,
  onRun,
  onCancel,
  onAccept,
  onRevert,
  onDecide,
  onReplyEscalation,
  onUpdate,
}: {
  readonly workspaceRoot: string;
  readonly currentBranch?: string | null | undefined;
  readonly step: DispatchTaskCard;
  readonly run: DispatchStepRun | undefined;
  readonly escalation: DispatchEscalationRecord | undefined;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly expanded: boolean;
  readonly busy: boolean;
  readonly onToggleExpand: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenStepDiff: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onAccept: () => void;
  readonly onRevert: () => void;
  readonly onDecide: (payload: {
    readonly selectedOptionId?: string | undefined;
    readonly decision: string;
  }) => Promise<boolean>;
  readonly onReplyEscalation: (payload: {
    readonly escalationId: string;
    readonly selectedOptionId?: string | undefined;
    readonly decision: string;
  }) => Promise<boolean>;
  readonly onUpdate: (patch: DispatchTaskSpecPatch) => void;
}) {
  const [customEscalationReply, setCustomEscalationReply] = useState("");

  const kind = resolveStepKind(step);
  const kindMeta = KIND_META[kind];
  const isActive = isActiveProgressStatus(step.status);
  const isBusy = isBusyStatus(step.status);
  const canRun = isCanRunStatus(step.status);
  const awaitingDecision = isStepAwaitingDecision(step);
  const canEdit = step.status !== "done" && !isActive;
  const changedFiles = run?.diffSummary?.changedFiles ?? [];
  const hasBoundaryIssues = run?.boundaryAudit?.ok === false;
  const hasFailedGate = run?.hardGate?.ok === false;
  const hasDiagnostics = Boolean(run?.lastError || hasBoundaryIssues || hasFailedGate);
  const verification =
    step.status === "ready_to_accept" && kind !== "research"
      ? summarizeStepVerification(step, run, currentBranch)
      : null;
  const hasSpecDetails =
    Boolean(step.goal?.trim()) ||
    Boolean(step.contractNote?.trim()) ||
    step.allowedGlobs.length > 0 ||
    step.hardGates.length > 0 ||
    step.acceptanceCriteria.length > 0;
  const hasDetailContent =
    hasSpecDetails ||
    hasDiagnostics ||
    changedFiles.length > 0 ||
    Boolean(run?.deliverable?.text) ||
    Boolean(run?.reviews.length) ||
    awaitingDecision ||
    Boolean(escalation);

  const showDetails = expanded || Boolean(escalation);
  const isRetry =
    step.status === "cancelled" ||
    step.status === "premise_failed" ||
    step.status === "boundary_violation" ||
    step.status === "hard_gate_failed";

  const gateSummaryParts: string[] = [];
  if (step.allowedGlobs.length > 0) gateSummaryParts.push(`范围 ${step.allowedGlobs.length}`);
  if (step.hardGates.length > 0) gateSummaryParts.push(`门禁 ${step.hardGates.length}`);
  if (step.acceptanceCriteria.length > 0) {
    gateSummaryParts.push(`验收 ${step.acceptanceCriteria.length}`);
  }

  return (
    <div
      data-inline-step-id={step.id}
      className={cn(
        "px-4 py-2.5 transition-colors",
        isActive && "bg-foreground/[0.025]",
        escalation && "bg-warning-surface/35",
      )}
    >
      {/* Row 1: Status + Title + Contextual Action */}
      <div className="flex items-start justify-between gap-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          disabled={!hasDetailContent}
          className="group flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
        >
          <span className="mt-0.5 flex shrink-0 items-center">
            <InlineStepGlyph status={step.status} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs text-muted-foreground">{step.id}</span>
              <span
                className={cn(
                  "text-sm font-medium text-foreground",
                  step.status === "done" && "text-foreground/80",
                  step.status === "locked" && "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
              <span className="rounded border border-border/55 px-1.5 py-px text-2xs text-muted-foreground">
                {kindMeta.label}
              </span>
              {(isActive ||
                step.status === "ready_to_accept" ||
                step.status === "awaiting_decision" ||
                step.status === "needs_human_decision" ||
                isRetry) && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs",
                    step.status === "boundary_violation" || step.status === "hard_gate_failed"
                      ? "text-destructive"
                      : awaitingDecision ||
                          step.status === "needs_human_decision" ||
                          step.status === "premise_failed"
                        ? "text-warning"
                        : "text-muted-foreground",
                  )}
                >
                  <span>{run?.headline || STATUS_LABEL[step.status]}</span>
                  {isActive && run?.startedAt && (
                    <DispatchElapsedTimer
                      startedAt={run.startedAt}
                      className="font-mono text-2xs tabular-nums opacity-80"
                    />
                  )}
                </span>
              )}
            </div>
          </div>
        </button>

        {/* Per-step single-click contextual action */}
        <div className="flex shrink-0 items-center gap-1">
          {awaitingDecision && (
            <Button size="xs" variant="default" disabled={busy} onClick={onToggleExpand}>
              <GitForkIcon className="size-3" />
              {showDetails ? "收起拍板" : "去拍板"}
            </Button>
          )}

          {step.status === "ready_to_accept" && (
            <>
              {(changedFiles.length > 0 || Boolean(run?.diffSummary?.patch.trim())) && (
                <Button size="xs" variant="ghost" onClick={onOpenStepDiff}>
                  本步改动
                </Button>
              )}
              <Button size="xs" variant="ghost" disabled={busy} onClick={onRevert}>
                撤回
              </Button>
              <Button size="xs" variant="default" disabled={busy} onClick={onAccept}>
                <CheckIcon className="size-3" />
                确认验收
              </Button>
            </>
          )}

          {canRun && !awaitingDecision && (
            <Button size="xs" variant="outline" disabled={busy} onClick={onRun}>
              {isRetry ? (
                <RotateCcwIcon className="size-3" />
              ) : (
                <PlayIcon className="size-3" />
              )}
              {isRetry ? "重试" : "执行"}
            </Button>
          )}

          {isActive && (
            <>
              {run?.childThreadId && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenThread(run.childThreadId!)}
                >
                  <ExternalLinkIcon className="size-3" />
                  查看代理
                </Button>
              )}
              {isBusy && (
                <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
                  <SquareIcon className="size-3" />
                  中止
                </Button>
              )}
            </>
          )}

          {step.status === "done" && run?.childThreadId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onOpenThread(run.childThreadId!)}
            >
              <ExternalLinkIcon className="size-3" />
              记录
            </Button>
          )}
        </div>
      </div>

      {/* Row 2: Transparent & directly editable Harness / Model / Effort / Isolation chips */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-6 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="text-2xs text-muted-foreground/80">执行</span>
          <AgentTargetPicker
            value={step.executor}
            providers={providers}
            allowSelf
            align="start"
            variant="chip"
            disabled={!canEdit || busy}
            onSelect={(next) => {
              if (next === "inherit" || next === null) return;
              onUpdate({ executor: next });
            }}
          />
        </span>

        {kind !== "decision" && (
          <span className="inline-flex items-center gap-1">
            <span className="text-2xs text-muted-foreground/80">复查</span>
            <AgentTargetPicker
              value={step.reviewer ?? null}
              providers={providers}
              allowNull
              nullLabel="不复查"
              align="start"
              variant="chip"
              disabled={!canEdit || busy}
              onSelect={(next) => {
                if (next === "inherit" || next === "self") return;
                onUpdate({ reviewer: next });
              }}
            />
          </span>
        )}

        {kind === "change" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled={!canEdit || busy}
                  onClick={() =>
                    onUpdate({
                      isolation: step.isolation === "worktree" ? "direct" : "worktree",
                    })
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border border-border/55 px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors",
                    canEdit && !busy
                      ? "hover:border-border hover:bg-accent/50 hover:text-foreground"
                      : "cursor-default opacity-70",
                  )}
                >
                  <GitBranchIcon className="size-3 opacity-75" />
                  <span>{step.isolation === "worktree" ? "Worktree" : "当前分支"}</span>
                </button>
              }
            />
            <TooltipPopup side="top">
              切换隔离策略：当前分支直写 / Worktree 隔离
            </TooltipPopup>
          </Tooltip>
        )}

        {hasDetailContent && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground/85 transition-colors hover:bg-accent/45 hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn(
                "size-3 transition-transform duration-200 ease-drawer",
                showDetails && "rotate-90",
              )}
            />
            <span>
              {gateSummaryParts.length > 0 ? gateSummaryParts.join(" · ") : "详情"}
            </span>
          </button>
        )}
      </div>

      {/* 4-Fact Step Acceptance Card shown directly when step awaits confirmation */}
      {verification && (
        <div className="mt-2.5 ml-6 space-y-2 rounded-xl border border-border/65 bg-muted/25 p-3 text-xs">
          {verification.summaryText && (
            <div className="space-y-0.5">
              <div className="text-2xs font-medium text-muted-foreground">本步实现了什么</div>
              <p className="leading-relaxed text-foreground/90">{verification.summaryText}</p>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs font-medium text-muted-foreground">
                改动文件（{verification.changedFiles.length}）
              </span>
              {(verification.changedFiles.length > 0 || verification.hasPatch) && (
                <button
                  type="button"
                  onClick={onOpenStepDiff}
                  className="inline-flex items-center gap-1 text-2xs font-medium text-foreground underline underline-offset-2 hover:opacity-80"
                >
                  <FileDiffIcon className="size-3" />
                  查看本步改动
                </button>
              )}
            </div>
            {verification.changedFiles.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {verification.changedFiles.slice(0, 6).map((filePath) => (
                  <button
                    key={filePath}
                    type="button"
                    onClick={() => onOpenFile(filePath)}
                    className="rounded border border-border/60 bg-background/70 px-1.5 py-0.5 font-mono text-2xs text-foreground/85 hover:border-border hover:bg-accent/50"
                  >
                    {filePath}
                  </button>
                ))}
                {verification.changedFiles.length > 6 && (
                  <span className="px-1 py-0.5 text-2xs text-muted-foreground">
                    +{verification.changedFiles.length - 6} 个文件
                  </span>
                )}
              </div>
            ) : (
              <div className="text-2xs text-muted-foreground">无文件改动记录</div>
            )}
          </div>

          <div className="space-y-1">
            <div className="text-2xs font-medium text-muted-foreground">实际运行检查</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-foreground/85">
              <span>{verification.checkLabel}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{verification.reviewLabel}</span>
            </div>
            {run?.hardGate && run.hardGate.results.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {run.hardGate.results.map((item) => (
                  <code
                    key={item.command}
                    className={cn(
                      "rounded border px-1.5 py-0.5 font-mono text-2xs",
                      item.ok
                        ? "border-border/60 bg-background/70 text-foreground/85"
                        : "border-destructive/40 bg-destructive/10 text-destructive",
                    )}
                  >
                    {item.ok ? "✓" : "✗"} {item.command}
                  </code>
                ))}
              </div>
            )}
          </div>

          <div className="text-2xs text-muted-foreground">
            确认后影响：<span className="text-foreground/85">{verification.targetBranchLabel}</span>
          </div>
        </div>
      )}

      {/* Expandable Detail Drawer: Spec, Gates, Decision Picker, Escalation, Diagnostics */}
      <Collapsible open={showDetails}>
        <CollapsiblePanel>
          <div className="mt-2.5 ml-6 space-y-2.5 rounded-xl border border-border/55 bg-background/60 p-3 text-xs">
          {escalation && (
            <div className="space-y-2 rounded-lg border border-warning/35 bg-warning-surface/55 p-2.5">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" />
                <span>需要你拍板：{escalation.title}</span>
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {escalation.humanPrompt || escalation.question}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {escalation.options.map((opt) => (
                  <Button
                    key={opt.id}
                    size="xs"
                    variant="default"
                    disabled={busy}
                    onClick={() =>
                      void onReplyEscalation({
                        escalationId: escalation.id,
                        selectedOptionId: opt.id,
                        decision: opt.description
                          ? `${opt.label}（${opt.description}）`
                          : opt.label,
                      })
                    }
                  >
                    {opt.label}
                  </Button>
                ))}
                <div className="flex min-w-44 flex-1 items-center gap-1">
                  <Input
                    size="compact"
                    placeholder="或输入你的决定..."
                    value={customEscalationReply}
                    onChange={(e) => setCustomEscalationReply(e.target.value)}
                  />
                  <Button
                    size="xs"
                    disabled={busy || !customEscalationReply.trim()}
                    onClick={() => {
                      const decision = customEscalationReply.trim();
                      void onReplyEscalation({
                        escalationId: escalation.id,
                        decision,
                      }).then((ok) => {
                        if (ok) setCustomEscalationReply("");
                      });
                    }}
                  >
                    发送
                  </Button>
                </div>
              </div>
            </div>
          )}

          {step.goal && (
            <p className="whitespace-pre-wrap leading-relaxed text-foreground/85">{step.goal}</p>
          )}

          {step.contractNote && (
            <div className="space-y-0.5">
              <div className="font-medium text-muted-foreground">约束与契约</div>
              <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {step.contractNote}
              </p>
            </div>
          )}

          {step.allowedGlobs.length > 0 && (
            <div className="space-y-0.5">
              <div className="font-medium text-muted-foreground">允许改动范围</div>
              <div className="font-mono text-2xs leading-relaxed text-muted-foreground">
                {step.allowedGlobs.join(" · ")}
              </div>
            </div>
          )}

          {step.hardGates.length > 0 && (
            <div className="space-y-1">
              <div className="font-medium text-muted-foreground">自动门禁命令</div>
              <div className="flex flex-wrap gap-1.5">
                {step.hardGates.map((cmd) => (
                  <code
                    key={cmd}
                    className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-foreground/85"
                  >
                    {cmd}
                  </code>
                ))}
              </div>
            </div>
          )}

          {step.acceptanceCriteria.length > 0 && (
            <div className="space-y-0.5">
              <div className="font-medium text-muted-foreground">验收标准</div>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {step.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </div>
          )}

          {kind === "decision" && (awaitingDecision || step.status === "done") && (
            <DispatchDecisionPicker
              workspaceRoot={workspaceRoot}
              step={step}
              run={run}
              busy={busy}
              onDecide={onDecide}
            />
          )}

          {run?.lastError && (
            <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-2.5 py-2 text-destructive">
              {run.lastError}
            </div>
          )}

          {hasBoundaryIssues && run?.boundaryAudit && (
            <div className="space-y-1 rounded-lg border border-destructive/35 bg-destructive/5 px-2.5 py-2">
              <div className="font-medium text-destructive">范围越界拦截</div>
              {run.boundaryAudit.outOfScopeFiles.length > 0 && (
                <div className="font-mono text-2xs text-muted-foreground">
                  超出范围：{run.boundaryAudit.outOfScopeFiles.join(", ")}
                </div>
              )}
              {run.boundaryAudit.forbiddenFiles.length > 0 && (
                <div className="font-mono text-2xs text-destructive">
                  命中禁止路径：{run.boundaryAudit.forbiddenFiles.join(", ")}
                </div>
              )}
            </div>
          )}

          {hasFailedGate && run?.hardGate && (
            <div className="space-y-1 rounded-lg border border-destructive/35 bg-destructive/5 px-2.5 py-2">
              <div className="font-medium text-destructive">门禁命令未通过</div>
              {run.hardGate.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <div key={r.command} className="font-mono text-2xs text-muted-foreground">
                    {r.command} (exit {r.exitCode})
                  </div>
                ))}
            </div>
          )}

          {changedFiles.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-muted-foreground">
                  改动文件（{changedFiles.length}）
                </span>
                <button
                  type="button"
                  onClick={onOpenStepDiff}
                  className="text-foreground/80 underline underline-offset-2 hover:text-foreground"
                >
                  查看本步改动
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {changedFiles.slice(0, 8).map((filePath) => (
                  <button
                    key={filePath}
                    type="button"
                    onClick={() => onOpenFile(filePath)}
                    className="rounded border border-border/55 bg-muted/35 px-1.5 py-0.5 font-mono text-2xs text-foreground/85 hover:border-border hover:bg-accent/50"
                  >
                    {filePath}
                  </button>
                ))}
                {changedFiles.length > 8 && (
                  <span className="px-1 py-0.5 text-2xs text-muted-foreground">
                    +{changedFiles.length - 8} 个文件
                  </span>
                )}
              </div>
            </div>
          )}

          {run?.deliverable?.text && kind !== "decision" && (
            <div className="space-y-1 border-t border-border/45 pt-2">
              <div className="font-medium text-muted-foreground">阶段产出</div>
              <p className="line-clamp-4 leading-relaxed text-muted-foreground">
                {stripMarkdownPreview(run.deliverable.text, 320)}
              </p>
            </div>
          )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * Conversation-native Dispatch Plan & Execution Card rendered inline at the end of the main chat
 * timeline (aligned with ProposedPlanCard). Makes every step's harness, model, thinking effort,
 * reviewer, isolation, and gate rules transparent and editable before/during execution without
 * auto-opening right-panel subagent tabs.
 */
export function DispatchInlinePlanCard(
  props: Parameters<typeof LegacyDispatchInlinePlanCard>[0] & {
    readonly onFocusComposer?: (() => void) | undefined;
  },
) {
  const { state, threadRef, workspaceRoot, onFocusComposer } = props;
  return state.collab ? (
    <CollabV2Card
      key={state.collab.planId}
      collab={state.collab}
      threadRef={threadRef}
      workspaceRoot={workspaceRoot}
      onFocusComposer={onFocusComposer}
    />
  ) : (
    <LegacyDispatchInlinePlanCard {...props} />
  );
}

function LegacyDispatchInlinePlanCard({
  workspaceRoot,
  threadRef,
  state,
  currentBranch,
}: {
  readonly workspaceRoot: string;
  readonly threadRef: ScopedThreadRef;
  readonly state: VelaDispatchState;
  readonly currentBranch?: string | null | undefined;
}) {
  const providers = useVelaDispatchProviders(threadRef.environmentId);
  const { busyKey, runAction, openChildThread, openFileInPanel, openDiffInPanel } =
    useDispatchActions(workspaceRoot, threadRef);

  const [collapsed, setCollapsed] = useState(false);
  const [blindFactsOpen, setBlindFactsOpen] = useState(false);
  const [expandedStepIds, setExpandedStepIds] = useState<ReadonlySet<string>>(() => new Set());
  const [diffStepId, setDiffStepId] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands and scrolls to the target dispatch step requested by sidebar attention navigation
  useEffect(() => {
    return subscribeFocusDispatchStep(threadRef.threadId, (stepId) => {
      setCollapsed(false);
      setExpandedStepIds((prev) => {
        if (prev.has(stepId)) return prev;
        const next = new Set(prev);
        next.add(stepId);
        return next;
      });
      if (typeof document !== "undefined") {
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-inline-step-id="${CSS.escape(stepId)}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    });
  }, [threadRef.threadId]);

  const focusInlineStep = (stepId: string) => {
    setCollapsed(false);
    setExpandedStepIds((prev) => {
      if (prev.has(stepId)) return prev;
      const next = new Set(prev);
      next.add(stepId);
      return next;
    });
    if (typeof document !== "undefined") {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-inline-step-id="${CSS.escape(stepId)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  };

  const toggleStepExpand = (stepId: string) => {
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const openDispatchPanel = () => {
    useRightPanelStore.getState().open(threadRef, "dispatch");
  };

  const steps = state.steps;
  const blindCheck = state.blindCheck;

  // Mode A: Blind check in progress or completed, before steps are published
  if (steps.length === 0) {
    if (!blindCheck) return null;
    const checkerDisplay = resolveAgentTargetDisplay(blindCheck.checker, providers);
    const isRunning = blindCheck.status === "running";
    const isFailed = blindCheck.status === "failed";

    return (
      <div className="rounded-2xl border border-border/75 bg-card/65">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {isRunning ? (
              <span className="relative flex size-4 shrink-0 items-center justify-center">
                <span className="absolute size-3 rounded-full bg-foreground/25 visible-animate-dispatch-ping" />
                <span className="relative size-1.5 rounded-full bg-foreground" />
              </span>
            ) : isFailed ? (
              <XCircleIcon className="size-4 shrink-0 text-destructive" />
            ) : (
              <SearchCheckIcon className="size-4 shrink-0 text-foreground/80" />
            )}
            <Badge variant="secondary">只读核查</Badge>
            <span className="truncate text-sm font-medium text-foreground">
              {isRunning
                ? "正在只读核查代码事实..."
                : isFailed
                  ? "只读核查未完成"
                  : "代码事实核查已完成"}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border/55 bg-background/70 px-2 py-0.5 text-xs text-muted-foreground">
                    {checkerDisplay.driverKind && (
                      <ProviderInstanceIcon
                        driverKind={checkerDisplay.driverKind}
                        displayName={checkerDisplay.providerLabel}
                        size="compact"
                        iconClassName="size-3.5"
                      />
                    )}
                    <span className="max-w-36 truncate text-foreground/85">
                      {checkerDisplay.modelName || checkerDisplay.providerLabel}
                    </span>
                    {checkerDisplay.effortLabel && (
                      <span className="shrink-0">{checkerDisplay.effortLabel}</span>
                    )}
                  </span>
                }
              />
              <TooltipPopup side="top">{checkerDisplay.fullLabel}</TooltipPopup>
            </Tooltip>

            {blindCheck.checkerThreadId && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => openChildThread(blindCheck.checkerThreadId!)}
              >
                <ExternalLinkIcon className="size-3" />
                查看代理
              </Button>
            )}

            {isRunning ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busyKey !== null}
                onClick={() =>
                  void runAction(
                    "cancel:blind",
                    "/api/vela/dispatch/step/cancel",
                    { stepId: "__blind_check__" },
                    "已中止只读核查",
                  )
                }
              >
                中止
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busyKey !== null}
                onClick={() =>
                  void runAction("clear", "/api/vela/dispatch/clear", {}, "已重置核查记录")
                }
              >
                重置
              </Button>
            )}
          </div>
        </div>

        {blindCheck.error && (
          <div className="border-t border-border/50 px-4 py-2 text-xs text-destructive">
            {blindCheck.error}
          </div>
        )}

        {blindCheck.checkerFacts && (
          <div className="border-t border-border/50">
            <button
              type="button"
              onClick={() => setBlindFactsOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform duration-200 ease-drawer",
                  blindFactsOpen && "rotate-90",
                )}
              />
              <span>{blindFactsOpen ? "收起核查事实摘要" : "展开核查事实摘要"}</span>
            </button>
            <Collapsible open={blindFactsOpen}>
              <CollapsiblePanel>
                <div className="max-h-60 overflow-y-auto border-t border-border/40 px-4 py-3 text-xs">
                  <ChatMarkdown cwd={workspaceRoot} text={blindCheck.checkerFacts} />
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        )}
      </div>
    );
  }

  // Mode B: Plan & Execution Card
  const orderedSteps = [...steps].toSorted((a, b) => a.order - b.order);
  const batches = computeBatches(orderedSteps);
  const usesBatches = batches.some((batch) => batch.steps.length > 1);
  const doneCount = orderedSteps.filter((s) => s.status === "done").length;
  const activeSteps = orderedSteps.filter((s) => isActiveProgressStatus(s.status));
  const lockedSteps = orderedSteps.filter((s) => s.status === "locked");
  const allDone = doneCount === orderedSteps.length;
  const openHumanEscalations = state.escalations.filter((e) => e.status === "open_human");
  const pendingDecisionCount = orderedSteps.filter((s) => isStepAwaitingDecision(s)).length;
  const readyToAcceptCount = orderedSteps.filter((s) => s.status === "ready_to_accept").length;
  const hasAnyChangedFiles = orderedSteps.some(
    (s) => (state.runs[s.id]?.diffSummary?.changedFiles.length ?? 0) > 0,
  );

  const firstRunnableBatch = batches.find((batch) =>
    batch.steps.some((step) => isCanRunStatus(step.status) && !isStepAwaitingDecision(step)),
  );
  const primaryRunnableSteps = firstRunnableBatch
    ? firstRunnableBatch.steps.filter(
        (step) => isCanRunStatus(step.status) && !isStepAwaitingDecision(step),
      )
    : [];

  const headerBadgeText = allDone
    ? "已完成"
    : openHumanEscalations.length > 0 || pendingDecisionCount > 0
      ? "待拍板"
      : readyToAcceptCount > 0
        ? "待验收"
        : activeSteps.length > 0
          ? "执行中"
          : "执行计划";

  const footerHint = allDone
    ? `全部 ${orderedSteps.length} 步已验收完成`
    : activeSteps.length > 0
      ? `${activeSteps.length} 步正在后台执行 · 子代理不自动弹窗，可随时点「查看代理」`
      : openHumanEscalations.length > 0 || pendingDecisionCount > 0
        ? "有步骤等待你拍板确认后继续"
        : readyToAcceptCount > 0
          ? `${readyToAcceptCount} 步已通过检查，等待你确认验收`
          : "可直接修改每步 Harness / 模型 / 思考等级后再开始执行";

  return (
    <div className="overflow-hidden rounded-2xl border border-border/75 bg-card/65">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-drawer",
              collapsed && "-rotate-90",
            )}
          />
          <Badge variant="secondary">{headerBadgeText}</Badge>
          <h3 className="truncate text-sm font-medium text-foreground">
            {state.planTitle || "分步执行计划"}
          </h3>
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {doneCount}/{orderedSteps.length}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {hasAnyChangedFiles && (
            <Button size="xs" variant="ghost" onClick={openDiffInPanel}>
              <FileDiffIcon className="size-3.5" />
              Diff
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={openDispatchPanel}>
            <PanelRightIcon className="size-3.5" />
            侧栏
          </Button>
        </div>
      </div>

      {/* Interactive hairline progress segments */}
      <div
        className="flex w-full gap-0.5 bg-border/20 px-4 py-1"
        role="progressbar"
        aria-label="分步执行进度"
        aria-valuemin={0}
        aria-valuemax={orderedSteps.length}
        aria-valuenow={doneCount}
      >
        {orderedSteps.map((step) => {
          const seg = progressSegmentTone(step.status);
          const run = state.runs[step.id];
          return (
            <Tooltip key={step.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => focusInlineStep(step.id)}
                    aria-label={`${step.id} ${step.title}：${STATUS_LABEL[step.status]}`}
                    className="group/seg relative flex min-w-0 flex-1 cursor-pointer items-center py-1.5 -my-1 focus-visible:outline-1 focus-visible:outline-ring"
                  >
                    <span
                      className={cn(
                        "relative block h-1 w-full overflow-hidden rounded-full transition-all group-hover/seg:h-1.5",
                        seg.className,
                      )}
                    >
                      {seg.sweep && (
                        <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-foreground/45 to-transparent visible-animate-dispatch-sweep" />
                      )}
                    </span>
                  </button>
                }
              />
              <TooltipPopup side="top">
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

      <Collapsible open={!collapsed}>
        <CollapsiblePanel>
          {/* Optional blind check facts disclosure */}
          {blindCheck?.checkerFacts && (
            <div className="border-b border-border/45 bg-muted/15">
              <div className="flex items-center justify-between gap-2 px-4 py-2">
                <button
                  type="button"
                  onClick={() => setBlindFactsOpen((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 transition-transform duration-200 ease-drawer",
                      blindFactsOpen && "rotate-90",
                    )}
                  />
                  <SearchCheckIcon className="size-3.5 shrink-0 opacity-75" />
                  <span className="truncate">只读代码核查摘要</span>
                </button>
                {blindCheck.checkerThreadId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => openChildThread(blindCheck.checkerThreadId!)}
                  >
                    <ExternalLinkIcon className="size-3" />
                    核查记录
                  </Button>
                )}
              </div>
              <Collapsible open={blindFactsOpen}>
                <CollapsiblePanel>
                  <div className="max-h-52 overflow-y-auto border-t border-border/40 px-4 py-2.5 text-xs">
                    <ChatMarkdown cwd={workspaceRoot} text={blindCheck.checkerFacts} />
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </div>
          )}

          {/* Steps list */}
          <div className="divide-y divide-border/45">
            {batches.map((batch) => {
              const batchRunnable = batch.steps.filter(
                (s) => isCanRunStatus(s.status) && !isStepAwaitingDecision(s),
              );
              return (
                <div key={batch.batchNumber} className="divide-y divide-border/40">
                  {usesBatches && (
                    <div className="flex items-center justify-between gap-2 bg-muted/20 px-4 py-1.5 text-2xs text-muted-foreground">
                      <span>
                        第 {batch.batchNumber} 批
                        {batch.steps.length > 1 ? ` · 可并行 ${batch.steps.length} 项` : ""}
                      </span>
                      {batchRunnable.length >= 2 && (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(
                              `parallel:${batch.batchNumber}`,
                              "/api/vela/dispatch/steps/run-parallel",
                              {
                                stepIds: batchRunnable.map((s) => s.id),
                                parentThreadId: threadRef.threadId,
                              },
                              `已并行启动第 ${batch.batchNumber} 批 ${batchRunnable.length} 个步骤`,
                            )
                          }
                          className="inline-flex items-center gap-1 font-medium text-foreground/85 hover:text-foreground disabled:opacity-50"
                        >
                          <GitBranchIcon className="size-3" />
                          并行开跑
                        </button>
                      )}
                    </div>
                  )}
                  {batch.steps.map((step) => {
                    const stepEscalation = openHumanEscalations.find(
                      (esc) => esc.stepId === step.id,
                    );
                    return (
                      <InlinePlanStepRow
                        key={step.id}
                        workspaceRoot={workspaceRoot}
                        currentBranch={currentBranch}
                        step={step}
                        run={state.runs[step.id]}
                        escalation={stepEscalation}
                        providers={providers}
                        expanded={expandedStepIds.has(step.id)}
                        busy={busyKey !== null}
                        onToggleExpand={() => toggleStepExpand(step.id)}
                        onOpenThread={openChildThread}
                        onOpenFile={openFileInPanel}
                        onOpenStepDiff={() => setDiffStepId(step.id)}
                        onRun={() =>
                          void runAction(`run:${step.id}`, "/api/vela/dispatch/step/run", {
                            stepId: step.id,
                            parentThreadId: threadRef.threadId,
                          })
                        }
                        onCancel={() =>
                          void runAction(
                            `cancel:${step.id}`,
                            "/api/vela/dispatch/step/cancel",
                            { stepId: step.id },
                            `已中止 ${step.id}`,
                          )
                        }
                        onAccept={() =>
                          void runAction(
                            `accept:${step.id}`,
                            "/api/vela/dispatch/step/accept",
                            { stepId: step.id },
                            `已确认验收 ${step.id}`,
                          )
                        }
                        onRevert={() =>
                          void runAction(
                            `revert:${step.id}`,
                            "/api/vela/dispatch/step/revert",
                            { stepId: step.id },
                            `已撤回 ${step.id}`,
                          )
                        }
                        onDecide={(payload) =>
                          runAction(
                            `decide:${step.id}`,
                            "/api/vela/dispatch/step/decide",
                            { stepId: step.id, ...payload },
                            `已确认 ${step.id} 决策`,
                          )
                        }
                        onReplyEscalation={(payload) =>
                          runAction(
                            `esc:${payload.escalationId}`,
                            "/api/vela/dispatch/escalation/reply",
                            { ...payload, resolvedBy: "human" },
                            "已提交决定并恢复执行",
                          )
                        }
                        onUpdate={(patch) =>
                          void runAction(`update:${step.id}`, "/api/vela/dispatch/step/update", {
                            stepId: step.id,
                            patch,
                          })
                        }
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Footer Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/55 bg-muted/20 px-4 py-2.5">
            <span className="text-xs text-muted-foreground">{footerHint}</span>

            <div className="flex shrink-0 items-center gap-1.5">
              {lockedSteps.length > 0 && !allDone && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(
                      "unlock-all",
                      "/api/vela/dispatch/steps/unlock-all",
                      {},
                      "已解锁全部步骤，可自由派发",
                    )
                  }
                >
                  <UnlockIcon className="size-3" />
                  全部解锁
                </Button>
              )}

              {primaryRunnableSteps.length >= 2 && firstRunnableBatch && (
                <Button
                  size="sm"
                  variant="default"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(
                      `parallel-primary:${firstRunnableBatch.batchNumber}`,
                      "/api/vela/dispatch/steps/run-parallel",
                      {
                        stepIds: primaryRunnableSteps.map((s) => s.id),
                        parentThreadId: threadRef.threadId,
                      },
                      `已并行启动 ${primaryRunnableSteps.length} 个步骤`,
                    )
                  }
                >
                  <PlayIcon className="size-3.5" />
                  并行开始（{primaryRunnableSteps.length} 步）
                </Button>
              )}

              {primaryRunnableSteps.length === 1 && (
                <Button
                  size="sm"
                  variant="default"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(
                      `run:${primaryRunnableSteps[0]!.id}`,
                      "/api/vela/dispatch/step/run",
                      {
                        stepId: primaryRunnableSteps[0]!.id,
                        parentThreadId: threadRef.threadId,
                      },
                    )
                  }
                >
                  <PlayIcon className="size-3.5" />
                  开始执行 {primaryRunnableSteps[0]!.id}
                </Button>
              )}

              {allDone && (
                <>
                  {hasAnyChangedFiles && (
                    <Button size="xs" variant="outline" onClick={openDiffInPanel}>
                      <FileDiffIcon className="size-3.5" />
                      查看 Diff
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runAction(
                        "clear",
                        "/api/vela/dispatch/clear",
                        {},
                        "已归档本轮执行计划",
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                    归档计划
                  </Button>
                </>
              )}
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <DispatchStepDiffDialog
        step={diffStepId ? (steps.find((s) => s.id === diffStepId) ?? null) : null}
        run={diffStepId ? state.runs[diffStepId] : undefined}
        onClose={() => setDiffStepId(null)}
        onOpenFile={openFileInPanel}
        onOpenWorkspaceDiff={openDiffInPanel}
        onOpenChildThread={openChildThread}
      />
    </div>
  );
}
