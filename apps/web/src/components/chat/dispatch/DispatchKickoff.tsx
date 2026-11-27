/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  BotIcon,
  ExternalLinkIcon,
  LayersIcon,
  Loader2Icon,
  SearchCheckIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";

interface KickoffDraft {
  readonly input: string;
  readonly mode: "fast" | "strict";
}

const kickoffDraftByThread = new Map<string, KickoffDraft>();

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Switch } from "~/components/ui/switch";
import type {
  DispatchAgentTarget,
  DispatchBlindCheckRecord,
  DispatchProviderSummary,
} from "~/state/velaDispatch";
import { AgentTargetPicker } from "./AgentTargetPicker";
import { formatAgentTarget } from "./dispatchModel";

export function DispatchKickoff({
  workspaceRoot,
  threadId,
  providers,
  blindCheck,
  selectedDefaultAgent,
  defaultEnableBatchAudit,
  hasConversationMessages = true,
  busyKey,
  onSelectDefaultAgent,
  onKickoff,
  onCancelBlindCheck,
  onClear,
  onOpenCheckerThread,
  onOpenManualCreate,
}: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly selectedDefaultAgent: DispatchAgentTarget | null;
  readonly defaultEnableBatchAudit: boolean;
  readonly hasConversationMessages?: boolean | undefined;
  readonly busyKey: string | null;
  readonly onSelectDefaultAgent: (next: DispatchAgentTarget | null) => void;
  readonly onKickoff: (
    requirement: string,
    mode: "fast" | "strict",
    enableBatchAudit: boolean,
  ) => Promise<boolean>;
  readonly onCancelBlindCheck: () => void;
  readonly onClear: () => void;
  readonly onOpenCheckerThread: (threadId: string) => void;
  readonly onOpenManualCreate: () => void;
}) {
  const initialDraft = kickoffDraftByThread.get(threadId);
  const [kickoffMode, setKickoffMode] = useState<"fast" | "strict">(initialDraft?.mode ?? "fast");
  const [kickoffInput, setKickoffInput] = useState(initialDraft?.input ?? "");
  const [batchAuditOverride, setBatchAuditOverride] = useState<boolean | null>(null);
  const enableBatchAudit = batchAuditOverride ?? defaultEnableBatchAudit;

  const updateKickoffDraft = (nextInput: string, nextMode: "fast" | "strict") => {
    if (!nextInput && nextMode === "fast") {
      kickoffDraftByThread.delete(threadId);
    } else {
      kickoffDraftByThread.set(threadId, { input: nextInput, mode: nextMode });
    }
  };

  if (blindCheck) {
    return (
      <div className="space-y-4 p-4">
        <div className="space-y-3 rounded-xl border border-border/65 bg-card/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
              {blindCheck.status === "running" ? (
                <Loader2Icon className="size-4 shrink-0 animate-spin" />
              ) : (
                <SearchCheckIcon className="size-4 shrink-0" />
              )}
              <span className="truncate">
                {blindCheck.status === "running"
                  ? `正在只读盲审（${formatAgentTarget(blindCheck.checker, providers)}）`
                  : blindCheck.status === "failed"
                    ? "只读盲审失败"
                    : "只读盲审已完成 · 下一步拆单"}
              </span>
            </span>
            {blindCheck.checkerThreadId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenCheckerThread(blindCheck.checkerThreadId!)}
              >
                <ExternalLinkIcon className="size-3.5" />
                查看盲审页
              </Button>
            )}
          </div>

          {blindCheck.status === "running" ? (
            <div className="space-y-2.5">
              <p className="text-sm leading-relaxed text-muted-foreground">
                正在后台独立子线程核查真实代码，完成后会自动唤醒左侧主控对比并拆单，无需操作。
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busyKey !== null}
                onClick={onCancelBlindCheck}
              >
                <SquareIcon className="size-3.5" />
                中止盲审
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {blindCheck.error && (
                <p className="text-sm leading-relaxed text-destructive">{blindCheck.error}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  disabled={busyKey !== null}
                  onClick={() => void onKickoff("", "fast", false)}
                >
                  结合盲审结论让主控拆单上板
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onClick={onClear}
                >
                  重置
                </Button>
              </div>
            </div>
          )}
        </div>

        {blindCheck.checkerFacts && (
          <div className="space-y-2 rounded-xl border border-border/55 bg-card/30 p-4">
            <div className="text-xs font-medium text-muted-foreground">
              盲审代码事实摘要（{formatAgentTarget(blindCheck.checker, providers)}）
            </div>
            <div className="max-h-80 overflow-y-auto">
              <ChatMarkdown cwd={workspaceRoot} text={blindCheck.checkerFacts} />
            </div>
          </div>
        )}
      </div>
    );
  }

  const trimmedInput = kickoffInput.trim();
  const emptyWithoutConversation = !hasConversationMessages && !trimmedInput;

  const submitKickoff = async () => {
    if (emptyWithoutConversation) return;
    const ok = await onKickoff(trimmedInput, kickoffMode, enableBatchAudit);
    if (ok) {
      setKickoffInput("");
      kickoffDraftByThread.delete(threadId);
    }
  };

  const primaryCtaLabel = emptyWithoutConversation
    ? "输入需求后生成分步计划"
    : trimmedInput
      ? kickoffMode === "strict"
        ? "先核查代码并生成计划"
        : "生成分步计划"
      : kickoffMode === "strict"
        ? "对当前对话先核查再拆单"
        : "从当前对话生成分步计划";

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/35 text-foreground">
          <LayersIcon className="size-4" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">发起协作计划</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            多代理并行开发，主控按完成顺序依次审查，整批验证后一次应用。
          </p>
        </div>
      </div>

      <div className="space-y-3.5">
        <Textarea
          rows={3}
          placeholder={
            hasConversationMessages
              ? "补充或调整需求（留空则按当前对话方案拆成步骤）"
              : "这次要做什么？输入需求后由主控拆成可验收的步骤"
          }
          value={kickoffInput}
          onChange={(e) => {
            const nextVal = e.target.value;
            setKickoffInput(nextVal);
            updateKickoffDraft(nextVal, kickoffMode);
          }}
        />

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>默认开发代理</span>
          <AgentTargetPicker
            value={selectedDefaultAgent ?? "inherit"}
            providers={providers}
            allowInherit
            onSelect={(next) => {
              const target = next === "inherit" || next === "self" ? null : next;
              onSelectDefaultAgent(target);
            }}
          />
        </div>
        {kickoffMode === "fast" && (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>交付前冷眼终审</span>
            <Switch
              size="sm"
              checked={enableBatchAudit}
              onCheckedChange={setBatchAuditOverride}
              aria-label="交付前冷眼终审"
            />
          </div>
        )}

        <details
          className="space-y-2 text-xs text-muted-foreground"
          open={kickoffMode === "strict" || undefined}
        >
          <summary className="w-fit cursor-pointer">高级选项</summary>
          <div className="flex items-center justify-between gap-2">
            <span>先核查代码再拆</span>
            <Switch
              size="sm"
              checked={kickoffMode === "strict"}
              aria-label="先核查代码再拆"
              onCheckedChange={(checked) => {
                const mode = checked ? "strict" : "fast";
                setKickoffMode(mode);
                updateKickoffDraft(kickoffInput, mode);
              }}
            />
          </div>
          <Button size="xs" variant="ghost" onClick={onOpenManualCreate}>
            手动建卡
          </Button>
        </details>

        <Button
          size="sm"
          className="w-full"
          disabled={busyKey !== null || emptyWithoutConversation}
          onClick={() => void submitKickoff()}
        >
          <BotIcon className="size-3.5" />
          {primaryCtaLabel}
        </Button>
      </div>
    </div>
  );
}
