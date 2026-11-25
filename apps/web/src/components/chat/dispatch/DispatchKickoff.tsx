/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  BotIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitForkIcon,
  LayersIcon,
  Loader2Icon,
  SearchCheckIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import type {
  DispatchAgentTarget,
  DispatchBlindCheckRecord,
  DispatchProviderSummary,
} from "~/state/velaDispatch";
import { AgentTargetPicker } from "./AgentTargetPicker";
import { formatAgentTarget, KIND_META } from "./dispatchModel";

export function DispatchKickoff({
  workspaceRoot,
  providers,
  blindCheck,
  selectedDefaultAgent,
  busyKey,
  onSelectDefaultAgent,
  onKickoff,
  onCancelBlindCheck,
  onClear,
  onOpenCheckerThread,
  onOpenManualCreate,
}: {
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly selectedDefaultAgent: DispatchAgentTarget | null;
  readonly busyKey: string | null;
  readonly onSelectDefaultAgent: (next: DispatchAgentTarget | null) => void;
  readonly onKickoff: (requirement: string, mode: "fast" | "strict") => Promise<boolean>;
  readonly onCancelBlindCheck: () => void;
  readonly onClear: () => void;
  readonly onOpenCheckerThread: (threadId: string) => void;
  readonly onOpenManualCreate: () => void;
}) {
  const [kickoffMode, setKickoffMode] = useState<"fast" | "strict">("fast");
  const [kickoffInput, setKickoffInput] = useState("");

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
                  onClick={() => void onKickoff("", "fast")}
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

  const submitKickoff = async () => {
    const ok = await onKickoff(kickoffInput.trim(), kickoffMode);
    if (ok) {
      setKickoffInput("");
    }
  };

  return (
    <div className="space-y-5 p-4">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/35 text-foreground">
            <LayersIcon className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold text-foreground">
              把需求拆成可验收的任务
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              主控拆成有序步骤卡，独立执行并逐关校验后再合入当前分支。
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
            <SearchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <span className="text-xs font-medium text-foreground">
                {KIND_META.research.label}
              </span>
              <span className="ml-2 text-xs leading-relaxed text-muted-foreground">
                {KIND_META.research.description}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
            <GitForkIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <span className="text-xs font-medium text-foreground">
                {KIND_META.decision.label}
              </span>
              <span className="ml-2 text-xs leading-relaxed text-muted-foreground">
                {KIND_META.decision.description}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
            <FileCode2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <span className="text-xs font-medium text-foreground">
                {KIND_META.change.label}
              </span>
              <span className="ml-2 text-xs leading-relaxed text-muted-foreground">
                {KIND_META.change.description}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3.5 border-t border-border/50 pt-4">
        <Textarea
          rows={3}
          placeholder="这次要做什么？留空则由主控从当前对话提炼最近对齐的需求"
          value={kickoffInput}
          onChange={(e) => setKickoffInput(e.target.value)}
        />

        <div className="space-y-2">
          <ToggleGroup
            value={[kickoffMode]}
            onValueChange={(next) => {
              const first = next[0];
              if (first === "fast" || first === "strict") setKickoffMode(first);
            }}
            className="w-full"
          >
            <Toggle value="fast" className="h-8 flex-1">
              快速拆单
            </Toggle>
            <Toggle value="strict" className="h-8 flex-1">
              先核查代码再拆
            </Toggle>
          </ToggleGroup>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-relaxed text-muted-foreground">
            <span>
              {kickoffMode === "strict"
                ? "先拉起只读子线程核查真实代码，再由主控对比拆单"
                : "直接由左侧主控按当前上下文拆成步骤卡"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground/85">长对话建议先核查</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>默认子代理 AI</span>
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

        <Button
          size="sm"
          className="w-full"
          disabled={busyKey !== null}
          onClick={() => void submitKickoff()}
        >
          <BotIcon className="size-3.5" />
          {kickoffInput.trim()
            ? kickoffMode === "strict"
              ? "先核查代码，再让主控拆单"
              : "发送给主控自动拆单"
            : kickoffMode === "strict"
              ? "对当前对话需求先核查再拆单"
              : "把当前对话方案拆单上板"}
        </Button>

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          聊天框输入 <code className="font-mono text-foreground">/dispatch</code> 也能随时唤起
          {" · "}
          <button
            type="button"
            onClick={onOpenManualCreate}
            className="underline underline-offset-2 hover:text-foreground"
          >
            手动建卡
          </button>
        </p>
      </div>
    </div>
  );
}
