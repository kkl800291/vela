/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import type {
  DispatchIsolationMode,
  DispatchStepKind,
  DispatchTaskCard,
  DispatchTaskSpecPatch,
} from "~/state/velaDispatch";
import {
  formatDecisionOptionsText,
  KIND_META,
  parseDecisionOptionsText,
  resolveStepKind,
} from "./dispatchModel";

function StepEditorForm({
  initialStep,
  existingSteps,
  busy,
  onCancel,
  onPublishNew,
  onUpdateExisting,
}: {
  readonly initialStep: DispatchTaskCard | null;
  readonly existingSteps: ReadonlyArray<DispatchTaskCard>;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onPublishNew: (stepInput: Record<string, unknown>, planTitle: string) => Promise<boolean>;
  readonly onUpdateExisting: (stepId: string, patch: DispatchTaskSpecPatch) => Promise<boolean>;
}) {
  const isEditing = initialStep !== null;

  const [title, setTitle] = useState(() => initialStep?.title ?? "");
  const [kind, setKind] = useState<DispatchStepKind>(() =>
    initialStep ? resolveStepKind(initialStep) : "change",
  );
  const [goal, setGoal] = useState(() => initialStep?.goal ?? "");
  const [acceptanceText, setAcceptanceText] = useState(
    () => initialStep?.acceptanceCriteria.join("\n") ?? "",
  );
  const [allowedGlobsText, setAllowedGlobsText] = useState(
    () => initialStep?.allowedGlobs.join("\n") ?? "",
  );
  const [hardGatesText, setHardGatesText] = useState(
    () => initialStep?.hardGates.join("\n") ?? "",
  );
  const [isolation, setIsolation] = useState<DispatchIsolationMode>(
    () => initialStep?.isolation ?? "direct",
  );
  const [optionsText, setOptionsText] = useState(() =>
    formatDecisionOptionsText(initialStep?.decisionOptions),
  );
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<string>>(
    () => initialStep?.dependsOn ?? [],
  );

  const candidateDeps = existingSteps.filter((s) => s.id !== initialStep?.id);
  const acceptanceCriteria = acceptanceText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const allowedGlobs = allowedGlobsText
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hardGates = hardGatesText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const decisionOptions = parseDecisionOptionsText(optionsText);

  const isChangeValid = kind !== "change" || acceptanceCriteria.length > 0;
  const canSubmit = !busy && Boolean(title.trim()) && Boolean(goal.trim()) && isChangeValid;

  const toggleDependency = (stepId: string) => {
    setDependsOn((prev) =>
      prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId],
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    if (isEditing && initialStep) {
      const patch: DispatchTaskSpecPatch = {
        title: title.trim(),
        kind,
        goal: goal.trim(),
        dependsOn,
        ...(kind === "change"
          ? {
              acceptanceCriteria,
              allowedGlobs,
              hardGates,
              isolation,
            }
          : {}),
        ...(kind === "decision"
          ? {
              decisionOptions,
            }
          : {}),
      };
      const ok = await onUpdateExisting(initialStep.id, patch);
      if (ok) onCancel();
      return;
    }

    const stepInput: Record<string, unknown> = {
      title: title.trim(),
      kind,
      goal: goal.trim(),
      dependsOn,
      ...(kind === "change"
        ? {
            isolation,
            acceptanceCriteria,
            allowedGlobs,
            hardGates,
          }
        : {
            isolation: "direct",
          }),
      ...(kind === "decision"
        ? {
            decisionOptions,
          }
        : {}),
    };

    const ok = await onPublishNew(stepInput, title.trim());
    if (ok) onCancel();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEditing ? `编辑任务卡 ${initialStep.id}` : "手动新建任务卡"}
        </DialogTitle>
        <DialogDescription>
          {isEditing
            ? "调整任务类型、目标、约束条件或前置依赖。"
            : "适合直接指定单步调研、决策或改动任务卡，提交时会自动校验必填字段。"}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">标题</label>
            <Input
              size="compact"
              placeholder="例如：修复登录页闪烁"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">任务类型</label>
            <ToggleGroup
              value={[kind]}
              onValueChange={(next) => {
                const first = next[0];
                if (first === "research" || first === "decision" || first === "change") {
                  setKind(first);
                }
              }}
              className="w-full"
            >
              {(["research", "decision", "change"] as const).map((item) => (
                <Toggle key={item} value={item} className="flex-1">
                  {KIND_META[item].label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">
              {kind === "decision" ? "需要拍板的问题与背景" : "目标与要求"}
            </label>
            <Textarea
              rows={3}
              placeholder={
                kind === "research"
                  ? "写明要调研的范围与需要回答的问题..."
                  : kind === "decision"
                    ? "写明决策背景与取舍维度..."
                    : "写明本步要实现的内容和边界..."
              }
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>

          {kind === "change" && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  验收标准（每行一条，必填）
                </label>
                <Textarea
                  rows={2}
                  placeholder="例如：点击保存后状态立即同步且刷新不丢失"
                  value={acceptanceText}
                  onChange={(e) => setAcceptanceText(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">允许改动路径（可选）</label>
                <Input
                  size="compact"
                  font="mono"
                  placeholder="apps/web/src/**"
                  value={allowedGlobsText}
                  onChange={(e) => setAllowedGlobsText(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  检查命令（可选，每行一条）
                </label>
                <Textarea
                  rows={2}
                  placeholder="vp run --filter @t3tools/web typecheck"
                  value={hardGatesText}
                  onChange={(e) => setHardGatesText(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">工作区隔离策略</label>
                <ToggleGroup
                  value={[isolation]}
                  onValueChange={(next) => {
                    const first = next[0];
                    if (first === "direct" || first === "worktree") setIsolation(first);
                  }}
                  className="w-full"
                >
                  <Toggle value="direct" className="flex-1">
                    当前分支直写 + 快照
                  </Toggle>
                  <Toggle value="worktree" className="flex-1">
                    Worktree 并行
                  </Toggle>
                </ToggleGroup>
              </div>
            </>
          )}

          {kind === "decision" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">
                决策选项（每行格式：<code className="font-mono">A: 标签 - 说明</code>）
              </label>
              <Textarea
                rows={3}
                placeholder={"A: 方案一 - 改动小、风险低\nB: 方案二 - 长期扩展性更好"}
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
              />
            </div>
          )}

          {candidateDeps.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">前置依赖步骤（可选）</label>
              <div className="flex flex-wrap gap-1.5">
                {candidateDeps.map((dep) => {
                  const selected = dependsOn.includes(dep.id);
                  return (
                    <button
                      key={dep.id}
                      type="button"
                      onClick={() => toggleDependency(dep.id)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                        selected
                          ? "border-foreground/60 bg-accent text-foreground"
                          : "border-border/70 bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span>{dep.id}</span>
                      <span className="max-w-28 truncate font-sans">{dep.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {isEditing ? "保存修改" : "发布任务卡"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function DispatchStepEditor({
  open,
  onOpenChange,
  initialStep,
  existingSteps,
  busy,
  onPublishNew,
  onUpdateExisting,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialStep: DispatchTaskCard | null;
  readonly existingSteps: ReadonlyArray<DispatchTaskCard>;
  readonly busy: boolean;
  readonly onPublishNew: (stepInput: Record<string, unknown>, planTitle: string) => Promise<boolean>;
  readonly onUpdateExisting: (stepId: string, patch: DispatchTaskSpecPatch) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {open && (
          <StepEditorForm
            key={initialStep?.id ?? "__new__"}
            initialStep={initialStep}
            existingSteps={existingSteps}
            busy={busy}
            onCancel={() => onOpenChange(false)}
            onPublishNew={onPublishNew}
            onUpdateExisting={onUpdateExisting}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
