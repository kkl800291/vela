/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { LegendList } from "@legendapp/list/react";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import type { EnvironmentId } from "@t3tools/contracts";
import { WrapTextIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import {
  fetchCollabEvidence,
  type CollabEvidenceFile,
  type CollabEvidenceResults,
  type CollabEvidenceTarget,
} from "~/state/velaDispatch";
import { HighlightedTokens } from "../HighlightedTokens";
import { parseUnifiedDiffLines } from "./dispatchModel";

interface EvidenceScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly planId: string;
  readonly target: CollabEvidenceTarget;
}

const PAGE_BYTES = 64 * 1024;

function useEvidencePages<Page>(load: (offset: number, signal: AbortSignal) => Promise<Page>) {
  const [request, setRequest] = useState({ offset: 0 });
  const [result, setResult] = useState<{
    readonly request: { readonly offset: number };
    readonly pages: ReadonlyArray<Page>;
    readonly error: string | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches one frozen evidence page and aborts the request when its view closes
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

function EvidencePagination({
  loading,
  error,
  retry,
  onLoadMore,
}: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
  readonly onLoadMore?: (() => void) | undefined;
}) {
  if (loading)
    return (
      <p role="status" className="py-1 text-xs text-muted-foreground">
        正在读取快照…
      </p>
    );
  if (error) {
    return (
      <div role="alert" className="space-y-2 text-xs text-muted-foreground">
        <p className="wrap-break-word">读取快照失败 · {error}</p>
        <Button size="xs" variant="outline" onClick={retry}>
          重试
        </Button>
      </div>
    );
  }
  return onLoadMore ? (
    <Button size="xs" variant="outline" onClick={onLoadMore}>
      加载更多
    </Button>
  ) : null;
}

function BinaryEvidence({ file }: { readonly file: CollabEvidenceFile }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">二进制大小</dt>
      <dd className="tabular-nums">{file.sizeBytes.toLocaleString()} B</dd>
      <dt className="text-muted-foreground">原对象 OID</dt>
      <dd className="font-mono wrap-anywhere">{file.oldOid ?? "无"}</dd>
      <dt className="text-muted-foreground">新对象 OID</dt>
      <dd className="font-mono wrap-anywhere">{file.newOid ?? "无"}</dd>
    </dl>
  );
}

function decodePatch(pages: ReadonlyArray<CollabEvidenceResults["diff"]>) {
  // Pages may split a UTF-8 code point, in which case the server returns raw bytes as base64.
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

function FileDiff({ scope, path }: { readonly scope: EvidenceScope; readonly path: string }) {
  const load = useStableCallback((offset: number, signal: AbortSignal) =>
    fetchCollabEvidence({ ...scope, view: "diff", path, offset, maxBytes: PAGE_BYTES, signal }),
  );
  const { pages, loading, error, retry, loadMore } = useEvidencePages(load);
  const latest = pages.at(-1);
  const nextOffset = latest?.kind === "patch" ? latest.nextOffset : null;
  const lines = numberedDiffLines(decodePatch(pages));
  const defaultWrap = useClientSettings((settings) => settings.wordWrap);
  const appearance = useRenderedAppearance();
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? defaultWrap;
  const language = getFiletypeFromFileName(path);
  const renderLine = (line: (typeof lines)[number]) => (
    <div
      key={line.id}
      className={cn(
        "grid min-w-full grid-cols-[4em_4em_1fr]",
        !wrap && "w-max",
        line.kind === "meta" && "bg-muted/40 text-muted-foreground",
        line.kind === "hunk" && "bg-muted/65 text-foreground/80",
        line.kind === "add" && "bg-diff-addition/12 text-diff-addition-foreground",
        line.kind === "del" && "bg-diff-deletion/12 text-diff-deletion-foreground",
      )}
    >
      <span className="border-e border-border/50 px-1.5 text-end text-muted-foreground select-none">
        {line.oldNumber}
      </span>
      <span className="border-e border-border/50 px-1.5 text-end text-muted-foreground select-none">
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
        (line.oldNumber !== null || line.newNumber !== null) ? (
          <RenderErrorBoundary fallback={line.text}>
            <Suspense fallback={line.text}>
              {line.text[0]}
              <HighlightedTokens code={line.text.slice(1)} language={language} theme={appearance} />
            </Suspense>
          </RenderErrorBoundary>
        ) : (
          line.text || " "
        )}
      </span>
    </div>
  );

  if (latest?.kind === "binary") return <BinaryEvidence file={latest.file} />;
  return (
    <div className="space-y-2">
      {lines.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/70">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1">
            <span className="min-w-0 wrap-anywhere font-mono text-xs">{path}</span>
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={wrap}
              onClick={() => setWrapOverride(!wrap)}
            >
              <WrapTextIcon className="size-3" />
              自动换行
            </Button>
          </div>
          {lines.length > 200 ? (
            <LegendList
              data={lines}
              keyExtractor={(line) => line.id}
              renderItem={({ item }) => renderLine(item)}
              estimatedItemSize={20}
              className="h-[44vh] overflow-auto font-mono text-xs leading-relaxed"
            />
          ) : (
            <div className="max-h-[44vh] overflow-auto font-mono text-xs leading-relaxed">
              {lines.map(renderLine)}
            </div>
          )}
        </div>
      )}
      {latest?.kind === "patch" && lines.length === 0 && nextOffset === null && (
        <p className="text-xs text-muted-foreground">此文件没有文本补丁。</p>
      )}
      <EvidencePagination
        loading={loading}
        error={error}
        retry={retry}
        onLoadMore={nextOffset === null ? undefined : () => loadMore(nextOffset)}
      />
    </div>
  );
}

export function CollabEvidenceDialog({
  environmentId,
  threadId,
  planId,
  target,
  title,
  onClose,
}: EvidenceScope & { readonly title: string; readonly onClose: () => void }) {
  const scope = { environmentId, threadId, planId, target };
  const load = useStableCallback((offset: number, signal: AbortSignal) =>
    fetchCollabEvidence({ ...scope, view: "manifest", offset, maxBytes: PAGE_BYTES, signal }),
  );
  const { pages, loading, error, retry, loadMore } = useEvidencePages(load);
  const [selectedFile, setSelectedFile] = useState<CollabEvidenceFile | null>(null);
  const files = pages.flatMap((page) => page.files);
  const summary = pages.find((page) => page.summary)?.summary;
  const nextOffset = pages.at(-1)?.nextOffset ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="me-6">{title}</DialogTitle>
          <DialogDescription>冻结快照 · 选择文件查看改动</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {summary && (
              <p className="text-xs whitespace-pre-wrap text-muted-foreground">{summary}</p>
            )}
            {files.length > 0 && (
              <ul
                aria-label="变更文件"
                className="max-h-[24vh] space-y-0.5 overflow-auto rounded-lg border border-border/65 p-1"
              >
                {files.map((file) => (
                  <li key={file.path}>
                    <Button
                      size="xs"
                      variant={selectedFile?.path === file.path ? "secondary" : "ghost"}
                      className="w-full justify-start"
                      aria-pressed={selectedFile?.path === file.path}
                      onClick={() => setSelectedFile(file)}
                    >
                      <Badge variant="outline" size="sm" className="shrink-0">
                        <span className="font-mono">{file.status}</span>
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-left font-mono">
                        {file.oldPath ? `${file.oldPath} → ` : ""}
                        {file.path}
                      </span>
                      {file.isBinary ? (
                        <span className="shrink-0 text-muted-foreground">二进制</span>
                      ) : (
                        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                          +{file.additions ?? 0} −{file.deletions ?? 0}
                        </span>
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {pages.length > 0 && files.length === 0 && (
              <p className="text-xs text-muted-foreground">快照没有文件改动。</p>
            )}
            <EvidencePagination
              loading={loading}
              error={error}
              retry={retry}
              onLoadMore={nextOffset === null ? undefined : () => loadMore(nextOffset)}
            />
            {selectedFile &&
              (selectedFile.isBinary ? (
                <BinaryEvidence file={selectedFile} />
              ) : (
                <FileDiff key={selectedFile.path} scope={scope} path={selectedFile.path} />
              ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
