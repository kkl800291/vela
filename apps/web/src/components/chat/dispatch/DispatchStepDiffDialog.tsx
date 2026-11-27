/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ExternalLinkIcon, FileDiffIcon, GitBranchIcon, WrapTextIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import type { DispatchStepRun, DispatchTaskCard } from "~/state/velaDispatch";
import { parseUnifiedDiffLines } from "./dispatchModel";

export function DispatchStepDiffDialog({
  step,
  run,
  onClose,
  onOpenFile,
  onOpenWorkspaceDiff,
  onOpenChildThread,
}: {
  readonly step: DispatchTaskCard | null;
  readonly run: DispatchStepRun | undefined;
  readonly onClose: () => void;
  readonly onOpenFile?: ((relativePath: string) => void) | undefined;
  readonly onOpenWorkspaceDiff?: (() => void) | undefined;
  readonly onOpenChildThread?: ((childThreadId: string) => void) | undefined;
}) {
  const open = step !== null;
  const changedFiles = run?.diffSummary?.changedFiles ?? [];
  const patch = run?.diffSummary?.patch ?? "";
  const isWorktree = (run?.isolation ?? step?.isolation) === "worktree";
  const isUnmergedWorktree = isWorktree && step?.status !== "done";
  const parsedLines = parseUnifiedDiffLines(patch);
  const patchFiles = new Set(
    parsedLines.flatMap((line) => (line.filePath ? [line.filePath] : [])),
  );
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? defaultWordWrap;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const patchContainerRef = useRef<HTMLDivElement>(null);

  const scrollToFilePatch = (filePath: string) => {
    setSelectedFile(filePath);
    const container = patchContainerRef.current;
    if (!container) return;
    const candidates = container.querySelectorAll<HTMLElement>("[data-diff-file]");
    for (const element of candidates) {
      if (element.dataset.diffFile === filePath) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedFile(null);
          setWordWrapOverride(null);
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2 pr-6">
            <Badge variant="secondary">
              <span className="font-mono">{step?.id}</span>
            </Badge>
            <DialogTitle>{step ? `「${step.title}」本步改动` : "本步改动"}</DialogTitle>
            {step && (
              <Badge variant="outline" size="sm">
                <GitBranchIcon className="size-3" />
                <span className="font-mono">
                  {isWorktree
                    ? `Worktree${run?.branchName ? ` · ${run.branchName}` : ""}`
                    : "当前分支"}
                </span>
              </Badge>
            )}
          </div>
          <DialogDescription>
            {changedFiles.length > 0
              ? `本步共改动 ${changedFiles.length} 个文件${run?.diffSummary?.truncated ? "（补丁过长已截断，可打开完整工作区 Diff 查看全部）" : ""}`
              : "本步未记录到文件差异。"}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-3">
            {changedFiles.length > 0 && (
              <div className="space-y-1.5">
                {isUnmergedWorktree && (
                  <p className="text-2xs text-muted-foreground">
                    改动位于独立 Worktree（尚未合入主分支），点击文件名定位下方对应补丁
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {changedFiles.map((filePath) => {
                    if (isUnmergedWorktree) {
                      const hasPatchAnchor = patchFiles.has(filePath);
                      if (hasPatchAnchor) {
                        const isActive = selectedFile === filePath;
                        return (
                          <button
                            key={filePath}
                            type="button"
                            onClick={() => scrollToFilePatch(filePath)}
                            className={cn(
                              "rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
                              isActive
                                ? "border-foreground/50 bg-accent text-foreground"
                                : "border-border/65 bg-muted/40 text-foreground/85 hover:border-border hover:bg-accent/60",
                            )}
                          >
                            {filePath}
                          </button>
                        );
                      }
                      return (
                        <Tooltip key={filePath}>
                          <TooltipTrigger
                            render={
                              <span className="rounded border border-border/50 bg-muted/25 px-2 py-0.5 font-mono text-2xs text-muted-foreground">
                                {filePath}
                              </span>
                            }
                          />
                          <TooltipPopup>该文件补丁已被截断，可查看子代理线程</TooltipPopup>
                        </Tooltip>
                      );
                    }
                    return onOpenFile ? (
                      <button
                        key={filePath}
                        type="button"
                        onClick={() => {
                          onOpenFile(filePath);
                          onClose();
                        }}
                        className="rounded border border-border/65 bg-muted/40 px-2 py-0.5 font-mono text-2xs text-foreground/85 transition-colors hover:border-border hover:bg-accent/60"
                      >
                        {filePath}
                      </button>
                    ) : (
                      <span
                        key={filePath}
                        className="rounded border border-border/65 bg-muted/40 px-2 py-0.5 font-mono text-2xs text-foreground/85"
                      >
                        {filePath}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {patch.trim() ? (
              <div className="overflow-hidden rounded-xl border border-border/65 bg-background/80">
                <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-3 py-1.5 text-2xs text-muted-foreground">
                  <span>补丁预览</span>
                  <Button
                    size="xs"
                    variant={wordWrap ? "secondary" : "ghost"}
                    onClick={() => setWordWrapOverride(!wordWrap)}
                  >
                    <WrapTextIcon className="size-3" />
                    {wordWrap ? "自动换行：开" : "自动换行：关"}
                  </Button>
                </div>
                <div
                  ref={patchContainerRef}
                  className="max-h-[55vh] overflow-auto font-mono text-xs leading-relaxed"
                >
                  {parsedLines.map((entry) => (
                    <div
                      key={entry.id}
                      data-diff-file={entry.filePath}
                      className={cn(
                        wordWrap ? "whitespace-pre-wrap wrap-break-word px-3 py-0.5" : "whitespace-pre px-3 py-0.5",
                        entry.kind === "meta" &&
                          "border-t border-border/40 bg-muted/35 font-medium text-muted-foreground first:border-t-0",
                        entry.kind === "hunk" && "bg-muted/20 text-foreground/75",
                        entry.kind === "add" && "bg-diff-addition/12 text-diff-addition-foreground",
                        entry.kind === "del" && "bg-diff-deletion/12 text-diff-deletion-foreground",
                        entry.kind === "context" && "text-foreground/80",
                      )}
                    >
                      {entry.text || " "}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
                暂无可展示的补丁内容。{onOpenWorkspaceDiff ? "你可以打开完整工作区 Diff 查看当前变化。" : ""}
              </div>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          {isUnmergedWorktree && run?.childThreadId && onOpenChildThread && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const targetThreadId = run.childThreadId!;
                onClose();
                onOpenChildThread(targetThreadId);
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
              查看子代理线程
            </Button>
          )}
          {onOpenWorkspaceDiff && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onClose();
                onOpenWorkspaceDiff();
              }}
            >
              <FileDiffIcon className="size-3.5" />
              {isUnmergedWorktree ? "打开主工作区 Diff" : "打开完整工作区 Diff"}
            </Button>
          )}
          <Button size="sm" variant="default" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
