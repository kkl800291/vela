/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { LegendList } from "@legendapp/list/react";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, WrapTextIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { HighlightedTokens } from "~/components/chat/HighlightedTokens";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type CollabDiffTarget, useDiffPanelStore } from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import {
  fetchCollabEvidence,
  useVelaDispatchState,
  type CollabEvidenceFile,
  type CollabEvidenceResults,
} from "~/state/velaDispatch";
import { parseUnifiedDiffLines } from "./dispatchModel";
import { useDispatchActions } from "./useDispatchActions";

interface EvidenceScope {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadId: string;
  readonly planId: string;
  readonly target: CollabDiffTarget;
}

const PAGE_BYTES = 64 * 1024;

function useEvidencePages<Page>(load: (offset: number, signal: AbortSignal) => Promise<Page>) {
  const [request, setRequest] = useState({ offset: 0 });
  const [result, setResult] = useState<{
    readonly request: { readonly offset: number };
    readonly pages: ReadonlyArray<Page>;
    readonly error: string | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches one frozen evidence page and aborts when scope changes
  useEffect(() => {
    const abort = new AbortController();
    void load(request.offset, abort.signal).then(
      (page) => {
        if (abort.signal.aborted) return;
        setResult((previous) => ({
          request,
          pages: request.offset === 0 ? [page] : [...(previous?.pages ?? []), page],
          error: null,
        }));
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setResult((previous) => ({
          request,
          pages: previous?.pages ?? [],
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    );
    return () => abort.abort();
  }, [load, request]);

  return {
    pages: result?.pages ?? [],
    loading: result?.request !== request,
    error: result?.request === request ? result.error : null,
    loadMore: (offset: number) => setRequest({ offset }),
    retry: () => setRequest({ offset: request.offset }),
  };
}

function decodePatch(pages: ReadonlyArray<CollabEvidenceResults["diff"]>) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const encoder = new TextEncoder();
  return pages
    .map((page) => {
      if (page.kind !== "patch") return "";
      const bytes =
        page.encoding === "utf8"
          ? encoder.encode(page.text)
          : Uint8Array.from(atob(page.dataBase64), (byte) => byte.charCodeAt(0));
      return decoder.decode(bytes, { stream: page.nextOffset !== null });
    })
    .join("");
}

function numberedDiffLines(patch: string) {
  let oldLine = 0;
  let newLine = 0;
  return parseUnifiedDiffLines(patch.endsWith("\n") ? patch.slice(0, -1) : patch).map((line) => {
    if (line.kind === "hunk") {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
    }
    const oldNumber =
      oldLine > 0 && (line.kind === "del" || line.kind === "context") ? oldLine++ : null;
    const newNumber =
      newLine > 0 && (line.kind === "add" || line.kind === "context") ? newLine++ : null;
    return { ...line, oldNumber, newNumber };
  });
}

function CollabFilePatch({
  scope,
  file,
  wrap,
}: {
  readonly scope: EvidenceScope;
  readonly file: CollabEvidenceFile;
  readonly wrap: boolean;
}) {
  const load = useStableCallback((offset: number, signal: AbortSignal) =>
    fetchCollabEvidence({
      ...scope,
      view: "diff",
      path: file.path,
      offset,
      maxBytes: PAGE_BYTES,
      signal,
    }),
  );
  const { pages, loading, error, retry, loadMore } = useEvidencePages(load);
  const latest = pages.at(-1);
  const nextOffset = latest?.kind === "patch" ? latest.nextOffset : null;
  const lines = numberedDiffLines(decodePatch(pages));
  const appearance = useRenderedAppearance();
  const language = getFiletypeFromFileName(file.path);

  if (file.isBinary) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        二进制文件 · {file.sizeBytes.toLocaleString()} B
      </div>
    );
  }
  if (loading && lines.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">正在加载改动…</p>;
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>读取失败：{error}</span>
        <Button size="xs" variant="outline" onClick={retry}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="max-h-96 overflow-auto font-mono text-2xs">
        <LegendList
          data={lines}
          keyExtractor={(line) => line.id}
          estimatedItemSize={20}
          recycleItems
          renderItem={({ item: line }) => (
            <div
              className={cn(
                "grid min-w-full grid-cols-[3.5em_3.5em_1fr]",
                !wrap && "w-max",
                line.kind === "meta" && "bg-muted/35 text-muted-foreground",
                line.kind === "hunk" && "bg-muted/55 text-foreground/80",
                line.kind === "add" && "bg-diff-addition/12 text-diff-addition-foreground",
                line.kind === "del" && "bg-diff-deletion/12 text-diff-deletion-foreground",
              )}
            >
              <span className="border-e border-border/45 px-1.5 text-end text-muted-foreground select-none tabular-nums">
                {line.oldNumber}
              </span>
              <span className="border-e border-border/45 px-1.5 text-end text-muted-foreground select-none tabular-nums">
                {line.newNumber}
              </span>
              <span
                className={cn(
                  "px-2",
                  wrap ? "min-w-0 wrap-anywhere whitespace-pre-wrap" : "whitespace-pre",
                )}
              >
                {language !== "text" &&
                line.text.length <= 1000 &&
                (line.kind === "add" || line.kind === "del" || line.kind === "context") ? (
                  <RenderErrorBoundary fallback={line.text}>
                    <Suspense fallback={line.text}>
                      <HighlightedTokens
                        code={line.text}
                        language={language}
                        theme={appearance}
                      />
                    </Suspense>
                  </RenderErrorBoundary>
                ) : (
                  line.text
                )}
              </span>
            </div>
          )}
        />
      </div>
      {nextOffset !== null && (
        <div className="px-3 pb-2">
          <Button size="xs" variant="outline" onClick={() => loadMore(nextOffset)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Native right-panel Diff surface for frozen collaboration snapshots (step review or delivery).
 * Follows Opus 5.5 Rules A5 & B6: native subheader height, no backdrop-blur, blocks openInEditor,
 * and offers outline "应用到工作区" only when inspecting the ready-to-deliver batch snapshot.
 */
export function CollabDiffSurface({
  threadRef,
  workspaceRoot,
  planId,
  target,
  label,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly planId: string;
  readonly target: CollabDiffTarget;
  readonly label: string;
}) {
  const { state } = useVelaDispatchState(
    workspaceRoot,
    threadRef.threadId,
    threadRef.environmentId,
  );
  const { busyKey, runCollabAction } = useDispatchActions(workspaceRoot, threadRef);
  const collab = state?.collab;
  const scope: EvidenceScope = {
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    planId,
    target,
  };
  const loadManifest = useStableCallback((offset: number, signal: AbortSignal) =>
    fetchCollabEvidence({ ...scope, view: "manifest", offset, maxBytes: PAGE_BYTES, signal }),
  );
  const manifest = useEvidencePages(loadManifest);
  const files = manifest.pages.flatMap((page) => page.files);
  const nextOffset = manifest.pages.at(-1)?.nextOffset ?? null;
  const defaultWrap = useClientSettings((settings) => settings.wordWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? defaultWrap;
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  const isDeliveryView =
    "deliveryId" in target &&
    collab?.status === "ready_to_deliver" &&
    collab.delivery?.deliveryId === target.deliveryId;

  const switchToWorkspace = () => {
    useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* Native subheader height (h-10 / inline h-8), bg-muted/35 border-b border-border/50, no blur */}
      <div
        data-surface-subheader
        className="@container/collab-diff flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-muted/35 px-3 in-data-[preview-panel-mode=inline]:h-8 in-data-[preview-panel-mode=inline]:min-h-8"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="ghost" className="min-w-0 max-w-44" />}
            >
              <span className="truncate font-medium text-foreground">{label}</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-72">
              <DropdownMenuItem onClick={switchToWorkspace}>当前工作区</DropdownMenuItem>
              {collab?.delivery && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      useDiffPanelStore.getState().selectCollabEvidence(threadRef, {
                        planId: collab.planId,
                        target: { deliveryId: collab.delivery!.deliveryId },
                        label: "全部待应用改动",
                      })
                    }
                  >
                    全部待应用改动
                  </DropdownMenuItem>
                </>
              )}
              {collab &&
                collab.steps.some((s) => Boolean(s.reviewId ?? s.latestVerdict?.reviewId)) && (
                  <>
                    <DropdownMenuSeparator />
                    {collab.steps.map((step, idx) => {
                      const rid = step.reviewId ?? step.latestVerdict?.reviewId;
                      if (!rid) return null;
                      return (
                        <DropdownMenuItem
                          key={step.stepId}
                          onClick={() =>
                            useDiffPanelStore.getState().selectCollabEvidence(threadRef, {
                              planId: collab.planId,
                              target: { reviewId: rid },
                              label: `第 ${idx + 1} 步 · ${step.title}`,
                            })
                          }
                        >
                          <span className="truncate">
                            第 {idx + 1} 步 · {step.title}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </>
                )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 rounded-sm bg-foreground/[0.045] px-1.5 py-0.5 font-mono text-2xs text-foreground/75">
                  只读预览
                </span>
              }
            />
            <TooltipPopup side="bottom">
              此视图展示任务隔离区中的改动预览，尚未写入当前工作区。点击「应用到工作区」后才会写入本地文件。
            </TooltipPopup>
          </Tooltip>

          {files.length > 0 && (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums @[540px]/collab-diff:inline-flex">
              <span>{files.length} 个文件</span>
              <DiffStatLabel
                additions={totalAdditions}
                deletions={totalDeletions}
                layout="inline"
                className="text-2xs"
              />
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant={wrap ? "secondary" : "ghost"}
                  aria-label="切换自动换行"
                  onClick={() => setWrapOverride(!wrap)}
                >
                  <WrapTextIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">{wrap ? "取消换行" : "自动换行"}</TooltipPopup>
          </Tooltip>

          <Button size="xs" variant="ghost" onClick={switchToWorkspace}>
            切回当前工作区
          </Button>

          {isDeliveryView && collab?.delivery && (
            <Button
              size="xs"
              variant="outline"
              disabled={busyKey !== null}
              onClick={() =>
                void runCollabAction({
                  endpoint: "deliver",
                  planId: collab.planId,
                  deliveryId: collab.delivery!.deliveryId,
                  expectedTargetState: collab.delivery!.expectedTargetState,
                })
              }
            >
              {busyKey === "deliver" ? "正在应用…" : "应用到工作区"}
            </Button>
          )}
        </div>
      </div>

      {/* File diffs list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2.5">
        {manifest.loading && files.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">正在读取改动预览…</p>
        )}
        {manifest.error && (
          <div className="flex flex-col items-center gap-2 py-6 text-xs text-muted-foreground">
            <span>读取失败：{manifest.error}</span>
            <Button size="xs" variant="outline" onClick={manifest.retry}>
              重试
            </Button>
          </div>
        )}
        {!manifest.loading && !manifest.error && files.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">暂无代码改动</p>
        )}
        {files.map((file) => {
          const collapsed = collapsedPaths.has(file.path);
          return (
            <section
              key={file.path}
              className="overflow-hidden rounded-xl border border-border/65 bg-card/50"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/45 px-3 py-1.5 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedPaths((prev) => {
                      const next = new Set(prev);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {file.status}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="min-w-0 truncate font-mono text-xs text-foreground">
                          {file.path}
                        </span>
                      }
                    />
                    <TooltipPopup side="top">改动尚未写入工作区</TooltipPopup>
                  </Tooltip>
                </button>
                {file.additions !== null || file.deletions !== null ? (
                  <DiffStatLabel
                    additions={file.additions ?? 0}
                    deletions={file.deletions ?? 0}
                    layout="inline"
                    className="shrink-0 text-2xs"
                  />
                ) : null}
              </div>
              {!collapsed && <CollabFilePatch scope={scope} file={file} wrap={wrap} />}
            </section>
          );
        })}
        {nextOffset !== null && (
          <div className="flex justify-center pt-1">
            <Button size="xs" variant="outline" onClick={() => manifest.loadMore(nextOffset)}>
              加载更多文件
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
