/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  FileDiffIcon,
  GitBranchIcon,
  GitForkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import type {
  DispatchProviderSummary,
  DispatchStepKind,
  DispatchStepRun,
  DispatchTaskCard,
  DispatchTaskSpecPatch,
} from "~/state/velaDispatch";
import { AgentTargetPicker } from "./AgentTargetPicker";
import { DispatchDecisionPicker } from "./DispatchDecisionPicker";
import { DispatchElapsedTimer } from "./DispatchElapsedTimer";
import { DispatchGatePipeline } from "./DispatchGatePipeline";
import {
  isActiveProgressStatus,
  isBusyStatus,
  isCanRunStatus,
  isStepAwaitingDecision,
  KIND_META,
  progressSegmentTone,
  resolveExecutorName,
  resolveStepKind,
  STATUS_LABEL,
} from "./dispatchModel";

function KindIcon({ kind, className }: { readonly kind: DispatchStepKind; readonly className?: string }) {
  switch (kind) {
    case "research":
      return <SearchIcon className={className} />;
    case "decision":
      return <GitForkIcon className={className} />;
    case "change":
      return <FileCode2Icon className={className} />;
  }
}

export function DispatchStepNode({
  workspaceRoot,
  step,
  run,
  providers,
  expanded,
  hasNextStep,
  busy,
  onToggleExpand,
  onOpenThread,
  onOpenFile,
  onOpenDiff,
  onRun,
  onForceRun,
  onCancel,
  onSkipAcceptance,
  onRevert,
  onDecide,
  onUpdate,
  onEdit,
  onDelete,
}: {
  readonly workspaceRoot: string;
  readonly step: DispatchTaskCard;
  readonly run: DispatchStepRun | undefined;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly expanded: boolean;
  readonly hasNextStep: boolean;
  readonly busy: boolean;
  readonly onToggleExpand: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenDiff: () => void;
  readonly onRun: () => void;
  readonly onForceRun?: (() => void) | undefined;
  readonly onCancel: () => void;
  readonly onSkipAcceptance: () => void;
  readonly onRevert: () => void;
  readonly onDecide: (payload: {
    readonly selectedOptionId?: string | undefined;
    readonly decision: string;
  }) => Promise<boolean>;
  readonly onUpdate: (patch: DispatchTaskSpecPatch) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const [openGateOutputs, setOpenGateOutputs] = useState<ReadonlySet<string>>(() => new Set());

  const kind = resolveStepKind(step);
  const running = isBusyStatus(step.status);
  const activeShine = isActiveProgressStatus(step.status);

  const tone = progressSegmentTone(step.status).tone;
  const canEdit = step.status !== "done" && !running;
  const canRun = isCanRunStatus(step.status);
  const executorName = resolveExecutorName(step, providers);
  const latestReview = run?.reviews.at(-1);
  const latestAcceptance = run?.acceptanceReports.at(-1);
  const changedCount = run?.diffSummary?.changedFiles.length ?? 0;
  const showPipeline =
    step.status !== "locked" && (step.status !== "ready" || isStepAwaitingDecision(step));
  const boundaryAudit = run?.boundaryAudit;
  const hasBoundaryIssues =
    Boolean(boundaryAudit && !boundaryAudit.ok) &&
    ((boundaryAudit?.outOfScopeFiles.length ?? 0) > 0 ||
      (boundaryAudit?.forbiddenFiles.length ?? 0) > 0 ||
      (boundaryAudit?.sensitiveFiles.length ?? 0) > 0);

  const hasHeaderActions = canRun || running || Boolean(run?.childThreadId);

  const toggleGateOutput = (command: string) => {
    setOpenGateOutputs((prev) => {
      const next = new Set(prev);
      if (next.has(command)) next.delete(command);
      else next.add(command);
      return next;
    });
  };

  return (
    <div
      data-step-id={step.id}
      className={cn("group flex items-stretch gap-2.5", step.status === "locked" && "opacity-60")}
    >
      {/* Timeline rail & compact status node */}
      <div className="flex w-6 shrink-0 flex-col items-center pt-4">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={`切换 ${step.id} 详情`}
          className="relative flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-1 focus-visible:outline-ring"
        >
          {activeShine && (
            <>
              <span
                ref={observeVisibleAnimation}
                aria-hidden="true"
                className="visible-animate-dispatch-ping pointer-events-none absolute inset-0 rounded-full border border-foreground/55"
              />
              <span
                ref={observeVisibleAnimation}
                aria-hidden="true"
                className="visible-animate-dispatch-orbit pointer-events-none absolute -inset-0.5 rounded-full border border-dashed border-foreground/45"
              />
            </>
          )}
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-full border transition-colors duration-300",
              step.status === "done" && "border-foreground bg-foreground text-background",
              step.status !== "done" &&
                tone === "attention" &&
                "border-warning bg-background text-warning",
              step.status !== "done" &&
                tone === "ready_to_accept" &&
                "border-foreground bg-background text-foreground",
              step.status !== "done" &&
                tone === "failed" &&
                "border-destructive bg-background text-destructive",
              step.status !== "done" &&
                tone === "busy" &&
                "border-foreground/75 bg-background text-foreground",
              step.status === "locked" &&
                "border-dashed border-muted-foreground/45 bg-background text-muted-foreground/70",
              step.status !== "done" &&
                step.status !== "locked" &&
                tone === "muted" &&
                "border-border bg-background text-muted-foreground",
            )}
          >
            {step.status === "done" ? (
              <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
                <path
                  d="M4 8.4l2.7 2.6L12 5.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeDasharray="12"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="motion-safe:animate-check-draw"
                />
              </svg>
            ) : (
              <KindIcon kind={kind} className="size-3.5" />
            )}
          </span>
        </button>

        {hasNextStep &&
          (step.status === "locked" ? (
            <div className="mt-1.5 min-h-3 flex-1 border-l border-dashed border-border/75" />
          ) : activeShine ? (
            <div className="relative mt-1.5 min-h-3 w-0.5 flex-1 overflow-hidden rounded-full bg-border/60">
              <span
                ref={observeVisibleAnimation}
                aria-hidden="true"
                className="visible-animate-dispatch-flow-v pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-full bg-gradient-to-b from-transparent via-foreground/75 to-transparent"
              />
            </div>
          ) : (
            <div
              className={cn(
                "mt-1.5 min-h-3 w-px flex-1 transition-colors duration-300",
                step.status === "done" ? "bg-foreground/50" : "bg-border/60",
              )}
            />
          ))}
      </div>

      {/* Full-width rounded card */}
      <div className="min-w-0 flex-1 pb-3">
        <div
          className={cn(
            "relative overflow-hidden rounded-xl border border-border/65 bg-card/40 transition-colors",
            activeShine && "border-foreground/35 bg-card/80 shadow-xs",
            step.status === "ready_to_accept" && "border-foreground/30",
            tone === "attention" && "border-warning/40",
            tone === "failed" && "border-destructive/40",
          )}
        >
          {activeShine && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-foreground/10">
              <span
                ref={observeVisibleAnimation}
                aria-hidden="true"
                className="visible-animate-dispatch-sweep block h-full w-1/2 bg-gradient-to-r from-transparent via-foreground/75 to-transparent"
              />
            </div>
          )}

          {/* Card header */}
          <div className="px-4 py-3.5">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={onToggleExpand}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-start gap-2">
                  <ChevronRightIcon
                    className={cn(
                      "mt-1 size-3.5 shrink-0 text-muted-foreground/75 transition-transform duration-200",
                      expanded && "rotate-90",
                    )}
                  />
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                    {step.id}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground line-clamp-2">
                    {step.title}
                  </span>
                  {activeShine && (
                    <DispatchElapsedTimer
                      startedAt={run?.startedAt}
                      className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/85 tabular-nums"
                    />
                  )}
                  <Badge variant="secondary" className="shrink-0">
                    {KIND_META[kind].label}
                  </Badge>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-xs text-muted-foreground">
                  <span
                    ref={activeShine ? observeVisibleAnimation : undefined}
                    className={cn(
                      activeShine && "visible-animate-dispatch-shine font-medium",
                      tone === "failed" && "text-destructive",
                      tone === "attention" && "text-warning",
                      tone === "ready_to_accept" && "font-medium text-foreground",
                    )}
                  >
                    {run?.headline && activeShine ? run.headline : STATUS_LABEL[step.status]}
                  </span>
                  <span>·</span>
                  <span className="font-mono">{executorName}</span>
                  <span>·</span>
                  <span className="font-mono">{step.isolation}</span>
                  {step.dependsOn && step.dependsOn.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="font-mono">依赖 {step.dependsOn.join(", ")}</span>
                    </>
                  )}
                  {changedCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="font-mono">{changedCount} 文件</span>
                    </>
                  )}
                </div>
              </button>

              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-sm" variant="ghost" aria-label="步骤菜单" className="shrink-0">
                      <MoreHorizontalIcon className="size-4" />
                    </Button>
                  }
                />
                <MenuPopup align="end">
                  {canRun && (
                    <MenuItem onClick={onRun}>
                      <PlayIcon className="size-3.5" />
                      {step.status === "ready" ? "派发执行" : "重新派发"}
                    </MenuItem>
                  )}
                  {step.status === "locked" && onForceRun && (
                    <MenuItem onClick={onForceRun}>
                      <PlayIcon className="size-3.5" />
                      强制解锁并立即运行
                    </MenuItem>
                  )}
                  {run?.childThreadId && (
                    <MenuItem onClick={() => onOpenThread(run.childThreadId!)}>
                      <ExternalLinkIcon className="size-3.5" />
                      查看执行子线程
                    </MenuItem>
                  )}
                  {changedCount > 0 && (
                    <MenuItem onClick={onOpenDiff}>
                      <FileDiffIcon className="size-3.5" />
                      查看 Diff
                    </MenuItem>
                  )}
                  {step.status === "awaiting_product_acceptance" && (
                    <MenuItem onClick={onSkipAcceptance}>
                      <CheckIcon className="size-3.5" />
                      跳过产品验收
                    </MenuItem>
                  )}
                  {canEdit && (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={onEdit}>
                        <PencilIcon className="size-3.5" />
                        编辑任务卡
                      </MenuItem>
                      {kind === "change" && (
                        <MenuItem
                          onClick={() =>
                            onUpdate({
                              isolation: step.isolation === "direct" ? "worktree" : "direct",
                            })
                          }
                        >
                          <GitBranchIcon className="size-3.5" />
                          切换为 {step.isolation === "direct" ? "Worktree 并行" : "当前分支直写"}
                        </MenuItem>
                      )}
                    </>
                  )}
                  {run && step.status !== "done" && (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={onRevert}>
                        <RotateCcwIcon className="size-3.5" />
                        撤回本步改动
                      </MenuItem>
                    </>
                  )}
                  {!running && (
                    <>
                      <MenuSeparator />
                      <MenuItem variant="destructive" onClick={onDelete}>
                        <Trash2Icon className="size-3.5" />
                        删除任务卡
                      </MenuItem>
                    </>
                  )}
                </MenuPopup>
              </Menu>
            </div>

            {/* Exposed compact gate pipeline */}
            {showPipeline && (
              <div className="mt-2.5 pl-5">
                <DispatchGatePipeline compact step={step} run={run} />
              </div>
            )}

            {/* Primary header actions & single native agent tab trigger */}
            {hasHeaderActions && (
              <div className="mt-3 flex flex-wrap items-center gap-2 pl-5">
                {canRun && (
                  <Button size="sm" variant="default" disabled={busy} onClick={onRun}>
                    <PlayIcon className="size-3.5" />
                    {step.status === "ready" ? "执行" : "重试"}
                  </Button>
                )}

                {running && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
                    <SquareIcon className="size-3.5" />
                    中止
                  </Button>
                )}

                {run?.childThreadId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenThread(run.childThreadId!)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    {running ? "实时查看代理" : "代理页"}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Animated collapsible details filling card width */}
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-out",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="space-y-3.5 border-t border-border/50 px-4 py-3.5">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {step.goal}
                </p>

                {step.warnings && step.warnings.length > 0 && (
                  <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning-surface/50 px-3 py-2.5 text-warning-foreground">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />
                      <span>提示</span>
                    </div>
                    <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-muted-foreground">
                      {step.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {run?.lastError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive">
                    {run.lastError}
                  </div>
                )}

                {step.contractNote && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-foreground/80">约束与契约</div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {step.contractNote}
                    </p>
                  </div>
                )}

                {step.allowedGlobs.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-foreground/80">允许范围</div>
                    <div className="font-mono text-xs leading-relaxed text-muted-foreground">
                      {step.allowedGlobs.join(" · ")}
                    </div>
                  </div>
                )}

                {/* Execution / Review agent pickers */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span>执行</span>
                    <AgentTargetPicker
                      value={step.executor}
                      providers={providers}
                      allowSelf
                      disabled={!canEdit || busy}
                      onSelect={(next) => {
                        if (next === "inherit" || next === null) return;
                        onUpdate({ executor: next });
                      }}
                    />
                  </span>
                  {kind !== "decision" && (
                    <span className="inline-flex items-center gap-1">
                      <span>复查</span>
                      <AgentTargetPicker
                        value={step.reviewer ?? null}
                        providers={providers}
                        allowNull
                        nullLabel="不复查"
                        disabled={!canEdit || busy}
                        onSelect={(next) => {
                          if (next === "inherit" || next === "self") return;
                          onUpdate({ reviewer: next });
                        }}
                      />
                    </span>
                  )}
                </div>

                {/* Kind-specific content */}
                {kind === "change" && (
                  <div className="space-y-3.5">

                    {hasBoundaryIssues && boundaryAudit && (
                      <div className="space-y-1.5 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2.5 text-xs">
                        <div className="flex items-center gap-1.5 font-medium text-destructive">
                          <ShieldAlertIcon className="size-4 shrink-0" />
                          <span>越界审计未通过</span>
                        </div>
                        {boundaryAudit.outOfScopeFiles.length > 0 && (
                          <div className="font-mono text-xs leading-relaxed text-muted-foreground">
                            超出允许范围：{boundaryAudit.outOfScopeFiles.join(", ")}
                          </div>
                        )}
                        {boundaryAudit.forbiddenFiles.length > 0 && (
                          <div className="font-mono text-xs leading-relaxed text-destructive">
                            命中禁止路径：{boundaryAudit.forbiddenFiles.join(", ")}
                          </div>
                        )}
                        {boundaryAudit.sensitiveFiles.length > 0 && (
                          <div className="font-mono text-xs leading-relaxed text-warning-foreground">
                            触及敏感文件：{boundaryAudit.sensitiveFiles.join(", ")}
                          </div>
                        )}
                      </div>
                    )}

                    {run?.diffSummary && run.diffSummary.changedFiles.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground/85">
                            改动文件（{run.diffSummary.changedFiles.length}）
                          </span>
                          <button
                            type="button"
                            onClick={onOpenDiff}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                          >
                            查看 Diff
                          </button>
                        </div>
                        <div className="space-y-1 rounded-lg border border-border/50 bg-background/60 p-1.5">
                          {run.diffSummary.changedFiles.map((file) => (
                            <button
                              key={file}
                              type="button"
                              onClick={() => onOpenFile(file)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                            >
                              <FileCode2Icon className="size-3.5 shrink-0 opacity-70" />
                              <span className="truncate">{file}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {run?.hardGate && run.hardGate.results.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-medium text-foreground/85">
                          检查命令（{run.hardGate.ok ? "全部通过" : "未通过"}）
                        </div>
                        <div className="space-y-1.5 font-mono text-xs">
                          {run.hardGate.results.map((item) => {
                            const outputOpen = openGateOutputs.has(item.command) || !item.ok;
                            return (
                              <div
                                key={item.command}
                                className="space-y-1.5 rounded-lg border border-border/50 bg-background/60 p-2.5"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleGateOutput(item.command)}
                                  className="flex w-full items-center justify-between gap-2 text-left hover:text-foreground"
                                >
                                  <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground/90">
                                    {item.output && (
                                      <ChevronRightIcon
                                        className={cn(
                                          "size-3 shrink-0 transition-transform",
                                          outputOpen && "rotate-90",
                                        )}
                                      />
                                    )}
                                    <span className="truncate">{item.command}</span>
                                  </span>
                                  <span
                                    className={cn(
                                      "shrink-0 text-xs",
                                      item.ok ? "text-muted-foreground" : "text-destructive",
                                    )}
                                  >
                                    {item.ok ? `${item.durationMs}ms` : `exit ${item.exitCode}`}
                                  </span>
                                </button>
                                {outputOpen && item.output && (
                                  <pre
                                    className={cn(
                                      "max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 text-xs leading-relaxed",
                                      item.ok ? "text-muted-foreground" : "text-destructive",
                                    )}
                                  >
                                    {item.output}
                                  </pre>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {latestReview && (
                      <div className="space-y-2 rounded-lg border border-border/50 bg-background/60 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-foreground/85">
                            独立复查 · 第 {latestReview.round} 轮（
                            {latestReview.verdict === "pass" ? "通过" : "未通过"}）
                          </span>
                          {latestReview.reviewerThreadId && (
                            <button
                              type="button"
                              onClick={() => onOpenThread(latestReview.reviewerThreadId!)}
                              className="text-muted-foreground hover:text-foreground hover:underline"
                            >
                              复查线程
                            </button>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {latestReview.summary}
                        </p>
                        {latestReview.issues.length > 0 && (
                          <div className="space-y-1.5">
                            {latestReview.issues.map((issue) => (
                              <div
                                key={`${issue.severity}:${issue.file ?? ""}:${issue.summary}`}
                                className="rounded-md bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
                              >
                                <span className="font-mono uppercase text-foreground">
                                  [{issue.severity}]
                                </span>{" "}
                                {issue.file ? <code className="font-mono">{issue.file}</code> : null}{" "}
                                <span className="text-sm leading-relaxed">{issue.summary}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {latestAcceptance && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-foreground/85">
                          需求验收 · 第 {latestAcceptance.round} 轮（
                          {latestAcceptance.passed ? "通过" : "未通过"}）
                        </div>
                        <div className="space-y-2">
                          {latestAcceptance.items.map((item) => (
                            <div
                              key={`${item.criterion}:${item.status}:${item.reason}`}
                              className="space-y-1.5 rounded-lg border border-border/50 bg-background/60 p-3"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-sm font-medium leading-snug text-foreground">
                                  {item.criterion}
                                </span>
                                <Badge
                                  variant={
                                    item.status === "passed"
                                      ? "success"
                                      : item.status === "failed"
                                        ? "error"
                                        : "warning"
                                  }
                                  className="shrink-0"
                                >
                                  {item.status === "passed"
                                    ? "通过"
                                    : item.status === "failed"
                                      ? "未通过"
                                      : "人工点测"}
                                </Badge>
                              </div>
                              <p className="text-sm leading-relaxed text-muted-foreground">
                                {item.reason}
                              </p>
                              {item.fixHint && (
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                  修复建议：{item.fixHint}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {step.status === "awaiting_product_acceptance" && (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={onSkipAcceptance}
                        >
                          跳过需求验收
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {kind === "research" && (
                  <div className="min-w-0 space-y-3">
                    {run?.deliverable?.text ? (
                      <div className="min-w-0 space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-3.5">
                        <div className="text-xs font-medium text-foreground/85">调研结论</div>
                        <div className="max-h-[28rem] min-w-0 overflow-x-hidden overflow-y-auto break-words [&_pre]:overflow-x-auto">
                          <ChatMarkdown cwd={workspaceRoot} text={run.deliverable.text} />
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
                        暂无调研结论报告，派发执行后将在此展示只读调研结果。
                      </div>
                    )}

                    {latestReview && (
                      <div className="space-y-1.5 rounded-lg border border-border/50 bg-background/60 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-foreground/85">
                            独立复查 · 第 {latestReview.round} 轮（
                            {latestReview.verdict === "pass" ? "通过" : "未通过"}）
                          </span>
                          {latestReview.reviewerThreadId && (
                            <button
                              type="button"
                              onClick={() => onOpenThread(latestReview.reviewerThreadId!)}
                              className="text-muted-foreground hover:text-foreground hover:underline"
                            >
                              复查线程
                            </button>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {latestReview.summary}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {kind === "decision" && (
                  <DispatchDecisionPicker
                    workspaceRoot={workspaceRoot}
                    step={step}
                    run={run}
                    busy={busy}
                    onDecide={onDecide}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
