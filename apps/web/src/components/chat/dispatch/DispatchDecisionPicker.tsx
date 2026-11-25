/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { CheckCircle2Icon, CheckIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import type { DispatchStepRun, DispatchTaskCard } from "~/state/velaDispatch";

export function DispatchDecisionPicker({
  workspaceRoot,
  step,
  run,
  busy,
  onDecide,
}: {
  readonly workspaceRoot: string;
  readonly step: DispatchTaskCard;
  readonly run: DispatchStepRun | undefined;
  readonly busy: boolean;
  readonly onDecide: (payload: {
    readonly selectedOptionId?: string | undefined;
    readonly decision: string;
  }) => Promise<boolean>;
}) {
  const options = step.decisionOptions ?? [];
  const decidedOptionId = run?.deliverable?.selectedOptionId;
  const isDone = step.status === "done";

  const [selectedOptionId, setSelectedOptionId] = useState<string | undefined>(
    () => decidedOptionId ?? run?.recommendedOptionId ?? options[0]?.id,
  );
  const [note, setNote] = useState("");

  const activeOptionId = isDone ? decidedOptionId : selectedOptionId;
  const selectedOpt = options.find((opt) => opt.id === activeOptionId);

  const canSubmit =
    !busy &&
    !isDone &&
    ((options.length > 0 && Boolean(selectedOpt)) || Boolean(note.trim()));

  const handleConfirm = async () => {
    if (!canSubmit) return;
    const trimmedNote = note.trim();
    const baseDecision = selectedOpt
      ? selectedOpt.description
        ? `${selectedOpt.label}（${selectedOpt.description}）`
        : selectedOpt.label
      : trimmedNote;
    const fullDecision =
      selectedOpt && trimmedNote ? `${baseDecision}；补充说明：${trimmedNote}` : baseDecision;

    const ok = await onDecide({
      ...(selectedOpt ? { selectedOptionId: selectedOpt.id } : {}),
      decision: fullDecision,
    });
    if (ok) {
      setNote("");
    }
  };

  return (
    <div className="space-y-3">
      {run?.decisionAnalysis && (
        <div className="rounded-lg border border-border/55 bg-muted/20 p-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">方案分析</div>
          <ChatMarkdown cwd={workspaceRoot} text={run.decisionAnalysis} />
        </div>
      )}

      {options.length > 0 && (
        <div className="space-y-2" role="radiogroup" aria-label={`${step.id} 决策选项`}>
          {options.map((opt) => {
            const isSelected = activeOptionId === opt.id;
            const isRecommended = run?.recommendedOptionId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={isDone || busy}
                onClick={() => setSelectedOptionId(opt.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                  isSelected
                    ? "border-foreground/50 bg-accent/50"
                    : "border-border/60 bg-background hover:bg-accent/30",
                  isDone && !isSelected && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    isSelected
                      ? "border-foreground bg-foreground text-background"
                      : "border-muted-foreground/45 bg-background",
                  )}
                >
                  {isSelected && <CheckIcon className="size-2.5" strokeWidth={2.5} />}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{opt.id}</span>
                    <span className="text-sm font-medium text-foreground">{opt.label}</span>
                    {isRecommended && (
                      <Badge variant="secondary">
                        推荐
                      </Badge>
                    )}
                  </div>
                  {opt.description && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {opt.description}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!isDone ? (
        <div className="space-y-2.5">
          <Input
            size="compact"
            placeholder={options.length > 0 ? "补充说明（可选）..." : "输入你的决定..."}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <Button
            size="sm"
            variant="default"
            disabled={!canSubmit}
            onClick={() => void handleConfirm()}
          >
            <CheckIcon className="size-3.5" />
            确认决定
          </Button>
        </div>
      ) : (
        run?.deliverable && (
          <div className="space-y-1.5 rounded-lg border border-border/55 bg-muted/20 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <CheckCircle2Icon className="size-3.5 text-foreground/80" />
              <span>已确认决策</span>
              {run.deliverable.selectedOptionId && (
                <span className="font-mono text-muted-foreground">
                  ({run.deliverable.selectedOptionId})
                </span>
              )}
            </div>
            {run.deliverable.text && (
              <div className="max-h-56 overflow-y-auto">
                <ChatMarkdown cwd={workspaceRoot} text={run.deliverable.text} />
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
