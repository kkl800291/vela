/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  CheckCircle2Icon,
  CheckIcon,
  FileDiffIcon,
  GitForkIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { DispatchEscalationRecord, DispatchStepRun, DispatchTaskCard } from "~/state/velaDispatch";
import {
  isStepAwaitingDecision,
  KIND_META,
  resolveStepKind,
  stripMarkdownPreview,
  summarizeStepVerification,
} from "./dispatchModel";

export function DispatchInbox({
  steps,
  runs,
  escalations,
  busyKey,
  currentBranch,
  onFocusStep,
  onOpenDiff,
  onOpenStepDiff,
  onRunAction,
}: {
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly escalations: ReadonlyArray<DispatchEscalationRecord>;
  readonly busyKey: string | null;
  readonly currentBranch?: string | null | undefined;
  readonly onFocusStep: (stepId: string) => void;
  readonly onOpenDiff: () => void;
  readonly onOpenStepDiff?: ((stepId: string) => void) | undefined;
  readonly onRunAction: (
    key: string,
    pathname: string,
    body: Record<string, unknown>,
    successTitle?: string,
  ) => Promise<boolean>;
}) {
  const [customDecisions, setCustomDecisions] = useState<Record<string, string>>({});

  const pendingDecisionSteps = steps.filter((step) => isStepAwaitingDecision(step));
  const openHumanEscalations = escalations.filter((esc) => esc.status === "open_human");
  const openOrchestratorEscalation = escalations.find(
    (esc) => esc.status === "open_orchestrator",
  );
  const readyToAcceptSteps = steps.filter((step) => step.status === "ready_to_accept");
  const allStepsDone = steps.length > 0 && steps.every((step) => step.status === "done");

  const hasActionable =
    pendingDecisionSteps.length > 0 ||
    openHumanEscalations.length > 0 ||
    readyToAcceptSteps.length > 0;

  if (!hasActionable && !openOrchestratorEscalation && !allStepsDone) {
    return null;
  }

  return (
    <div className="space-y-3 px-3.5 pt-3.5">
      {hasActionable && (
        <div className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          需要你处理
        </div>
      )}

      {pendingDecisionSteps.map((step) => {
        const run = runs[step.id];
        const optionCount = step.decisionOptions?.length ?? 0;
        return (
          <div
            key={`decision:${step.id}`}
            className="space-y-2.5 rounded-xl border border-warning/35 bg-warning-surface/50 p-3.5 motion-safe:animate-step-in"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <GitForkIcon className="size-4 shrink-0 text-warning" />
                <span>等你拍板（{step.id}）</span>
              </span>
              {optionCount > 0 && (
                <span className="font-mono text-xs text-muted-foreground">
                  {optionCount} 个选项
                </span>
              )}
            </div>
            <div className="text-sm font-medium text-foreground">{step.title}</div>
            <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {run?.decisionAnalysis || step.goal}
            </p>
            <div>
              <Button size="sm" variant="default" onClick={() => onFocusStep(step.id)}>
                去拍板
              </Button>
            </div>
          </div>
        );
      })}

      {openHumanEscalations.map((esc) => (
        <div
          key={`esc:${esc.id}`}
          className="space-y-2.5 rounded-xl border border-warning/35 bg-warning-surface/50 p-3.5 motion-safe:animate-step-in"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
              <span>需要你拍板（{esc.stepId}）</span>
            </span>
            <span className="font-mono text-xs text-muted-foreground">{esc.id}</span>
          </div>
          <p className="text-sm font-medium text-foreground">{esc.title}</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {esc.humanPrompt || esc.question}
          </p>
          {esc.factsFound && (
            <pre className="max-h-28 overflow-auto rounded-lg bg-background/80 p-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
              {esc.factsFound}
            </pre>
          )}
          {esc.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {esc.options.map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  variant="default"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void onRunAction(
                      `esc:${esc.id}:${opt.id}`,
                      "/api/vela/dispatch/escalation/reply",
                      {
                        escalationId: esc.id,
                        selectedOptionId: opt.id,
                        decision: opt.description
                          ? `${opt.label}（${opt.description}）`
                          : opt.label,
                        resolvedBy: "human",
                      },
                      "已提交决定并恢复执行",
                    )
                  }
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              size="compact"
              placeholder="或输入自定义指示..."
              value={customDecisions[esc.id] ?? ""}
              onChange={(e) =>
                setCustomDecisions((prev) => ({
                  ...prev,
                  [esc.id]: e.target.value,
                }))
              }
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busyKey !== null || !(customDecisions[esc.id] ?? "").trim()}
              onClick={() => {
                const text = (customDecisions[esc.id] ?? "").trim();
                void onRunAction(
                  `esc:${esc.id}:custom`,
                  "/api/vela/dispatch/escalation/reply",
                  {
                    escalationId: esc.id,
                    decision: text,
                    resolvedBy: "human",
                  },
                  "已发送决定并恢复执行",
                ).then((ok) => {
                  if (ok) {
                    setCustomDecisions((prev) => ({ ...prev, [esc.id]: "" }));
                  }
                });
              }}
            >
              发送
            </Button>
          </div>
        </div>
      ))}

      {readyToAcceptSteps.map((step) => {
        const run = runs[step.id];
        const kind = resolveStepKind(step);
        const isWorktree = run?.isolation === "worktree";

        if (kind === "research") {
          const reportSummary = run?.deliverable?.text
            ? stripMarkdownPreview(run.deliverable.text)
            : "";
          return (
            <div
              key={`accept:${step.id}`}
              className="space-y-2.5 rounded-xl border border-border/70 bg-muted/25 p-3.5 motion-safe:animate-step-in"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>等待确认验收</span>
                <Badge variant="secondary">
                  {KIND_META.research.label}
                </Badge>
              </div>
              <div className="text-sm font-semibold text-foreground">
                {step.id}「{step.title}」已完成调研
              </div>
              <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                {reportSummary || "调研结论已就绪，确认验收后将解锁后续步骤。"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void onRunAction(
                      `accept:${step.id}`,
                      "/api/vela/dispatch/step/accept",
                      { stepId: step.id },
                      `已确认验收 ${step.id}`,
                    )
                  }
                >
                  <CheckIcon className="size-3.5" />
                  确认验收
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onFocusStep(step.id)}
                >
                  展开报告
                </Button>
              </div>
            </div>
          );
        }

        const verification = summarizeStepVerification(step, run, currentBranch);
        const stepHeaderLabel =
          verification.checksRunCount > 0 && run?.hardGate?.ok
            ? `${step.id}「${step.title}」已通过检查与复查`
            : `${step.id}「${step.title}」已完成执行，待确认验收`;

        return (
          <div
            key={`accept:${step.id}`}
            className="space-y-2.5 rounded-xl border border-border/70 bg-muted/25 p-3.5 motion-safe:animate-step-in"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>等待确认验收</span>
              {isWorktree && <span className="font-mono">Worktree</span>}
            </div>
            <div className="text-sm font-semibold text-foreground">{stepHeaderLabel}</div>
            {verification.summaryText && (
              <p className="line-clamp-2 text-xs leading-relaxed text-foreground/85">
                {verification.summaryText}
              </p>
            )}
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <div>
                改动文件：
                {verification.changedFiles.length > 0
                  ? `${verification.changedFiles.length} 个（${verification.changedFiles.slice(0, 3).join(", ")}${verification.changedFiles.length > 3 ? " 等" : ""}）`
                  : "0 个"}
              </div>
              <div>
                实际检查：{verification.checkLabel} · {verification.reviewLabel}
              </div>
              <div>确认后：{verification.targetBranchLabel}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="default"
                disabled={busyKey !== null}
                onClick={() =>
                  void onRunAction(
                    `accept:${step.id}`,
                    "/api/vela/dispatch/step/accept",
                    { stepId: step.id },
                    isWorktree ? `已合并并验收 ${step.id}` : `已确认验收 ${step.id}`,
                  )
                }
              >
                <CheckIcon className="size-3.5" />
                {isWorktree ? "合并到当前分支并验收" : "确认验收"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => (onOpenStepDiff ? onOpenStepDiff(step.id) : onOpenDiff())}
              >
                <FileDiffIcon className="size-3.5" />
                查看本步改动
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyKey !== null}
                onClick={() =>
                  void onRunAction(
                    `revert:${step.id}`,
                    "/api/vela/dispatch/step/revert",
                    { stepId: step.id },
                    `已撤回 ${step.id}`,
                  )
                }
              >
                撤回本步
              </Button>
            </div>
          </div>
        );
      })}

      {openOrchestratorEscalation && (
        <div className="flex items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            主控正在自动排查 {openOrchestratorEscalation.stepId} 卡点：
            {openOrchestratorEscalation.question}
          </span>
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() =>
              void onRunAction(
                `escalate:${openOrchestratorEscalation.id}`,
                "/api/vela/dispatch/escalation/escalate-human",
                {
                  escalationId: openOrchestratorEscalation.id,
                  humanPrompt: openOrchestratorEscalation.question,
                },
              )
            }
            className="shrink-0 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            直接拍板
          </button>
        </div>
      )}

      {allStepsDone && (
        <div className="space-y-2.5 rounded-xl border border-border/60 bg-muted/20 p-3.5 motion-safe:animate-step-in">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CheckCircle2Icon className="size-4" />
            全部 {steps.length} 步已验收完成
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            所有代码改动均已保留在当前分支未提交列表中，你可以统一检查后手动提交。归档后本轮记录会保留在下方「历史计划」折叠区。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="default" onClick={onOpenDiff}>
              查看全部 Diff
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyKey !== null}
              onClick={() =>
                void onRunAction(
                  "clear",
                  "/api/vela/dispatch/clear",
                  {},
                  "已归档上一轮计划，可开始新拆单",
                )
              }
            >
              归档并开启新计划
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
