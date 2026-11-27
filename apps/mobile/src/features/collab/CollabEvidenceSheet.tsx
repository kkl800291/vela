/* oxlint-disable t3code/no-untranslated-copy -- Vela mobile collaboration diff viewer keeps inline Chinese copy aligned with desktop */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  fetchCollabEvidence,
  type CollabEvidenceFile,
  type CollabEvidenceResults,
  type CollabEvidenceTarget,
} from "./collabApi";
import {
  decodeCollabDiffPages,
  formatByteSize,
  parseNumberedUnifiedDiff,
} from "./collabModel";

const DIFF_PAGE_BYTES = 64 * 1024;

export interface CollabEvidenceSheetProps {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly planId: string;
  readonly title: string;
  readonly target: CollabEvidenceTarget | null;
  readonly onClose: () => void;
}

const FILE_STATUS_BADGE: Record<CollabEvidenceFile["status"], string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名",
};

export function CollabEvidenceSheet(props: CollabEvidenceSheetProps) {
  const insets = useSafeAreaInsets();
  const [selectedFile, setSelectedFile] = useState<CollabEvidenceFile | null>(null);
  const [manifestPages, setManifestPages] = useState<ReadonlyArray<CollabEvidenceResults["manifest"]>>([]);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);

  const [diffPages, setDiffPages] = useState<ReadonlyArray<CollabEvidenceResults["diff"]>>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadManifestPage = useCallback(
    async (offset: number, signal?: AbortSignal) => {
      if (!props.target) return;
      setManifestLoading(true);
      setManifestError(null);
      await fetchCollabEvidence({
        environmentId: props.environmentId,
        threadId: props.threadId,
        planId: props.planId,
        target: props.target,
        view: "manifest",
        offset,
        ...(signal ? { signal } : {}),
      }).then(
        (page) => {
          if (signal?.aborted) return;
          setManifestPages((prev) => (offset === 0 ? [page] : [...prev, page]));
          setManifestLoading(false);
        },
        (err: unknown) => {
          if (signal?.aborted) return;
          setManifestError(err instanceof Error ? err.message : String(err));
          setManifestLoading(false);
        },
      );
    },
    [props.environmentId, props.planId, props.target, props.threadId],
  );

  const loadDiffPage = useCallback(
    async (file: CollabEvidenceFile, offset: number, signal?: AbortSignal) => {
      if (!props.target) return;
      setDiffLoading(true);
      setDiffError(null);
      await fetchCollabEvidence({
        environmentId: props.environmentId,
        threadId: props.threadId,
        planId: props.planId,
        target: props.target,
        view: "diff",
        path: file.path,
        offset,
        maxBytes: DIFF_PAGE_BYTES,
        ...(signal ? { signal } : {}),
      }).then(
        (page) => {
          if (signal?.aborted) return;
          setDiffPages((prev) => (offset === 0 ? [page] : [...prev, page]));
          setDiffLoading(false);
        },
        (err: unknown) => {
          if (signal?.aborted) return;
          setDiffError(err instanceof Error ? err.message : String(err));
          setDiffLoading(false);
        },
      );
    },
    [props.environmentId, props.planId, props.target, props.threadId],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads frozen snapshot manifest on modal open and aborts on close
  useEffect(() => {
    if (!props.visible || !props.target) {
      setSelectedFile(null);
      setManifestPages([]);
      setManifestError(null);
      setDiffPages([]);
      setDiffError(null);
      return;
    }
    const abort = new AbortController();
    setSelectedFile(null);
    setManifestPages([]);
    void loadManifestPage(0, abort.signal);
    return () => abort.abort();
  }, [loadManifestPage, props.target, props.visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads selected file diff lazily and aborts when switching files
  useEffect(() => {
    if (!props.visible || !selectedFile || selectedFile.isBinary) {
      setDiffPages([]);
      setDiffError(null);
      return;
    }
    const abort = new AbortController();
    setDiffPages([]);
    void loadDiffPage(selectedFile, 0, abort.signal);
    return () => abort.abort();
  }, [loadDiffPage, props.visible, selectedFile]);

  const files = manifestPages.flatMap((page) => page.files);
  const manifestSummary = manifestPages.find((page) => page.summary)?.summary;
  const manifestNextOffset = manifestPages.at(-1)?.nextOffset ?? null;

  const lastDiffPage = diffPages.at(-1);
  const diffNextOffset =
    lastDiffPage && lastDiffPage.kind === "patch" ? lastDiffPage.nextOffset : null;
  const patchText = decodeCollabDiffPages(diffPages);
  const diffLines = parseNumberedUnifiedDiff(patchText);

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (selectedFile) setSelectedFile(null);
        else props.onClose();
      }}
    >
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <View className="flex-row items-center gap-2 border-b border-border-subtle px-4 py-3">
          {selectedFile ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回文件列表"
              onPress={() => setSelectedFile(null)}
              className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <SymbolView name="chevron.left" size={16} tintColorClassName="accent-icon" />
            </Pressable>
          ) : null}
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="font-t3-bold text-base text-foreground">
              {selectedFile ? selectedFile.path : props.title}
            </Text>
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {selectedFile
                ? `${FILE_STATUS_BADGE[selectedFile.status]} · ${formatByteSize(selectedFile.sizeBytes)}`
                : props.target && "deliveryId" in props.target
                  ? `冻结交付快照 · ${files.length} 个文件`
                  : `冻结审查快照 · ${files.length} 个文件`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭快照查看器"
            onPress={props.onClose}
            className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView name="xmark" size={15} tintColorClassName="accent-icon" />
          </Pressable>
        </View>

        {!selectedFile ? (
          <ScrollView className="flex-1" contentContainerClassName="gap-2.5 p-4">
            {manifestSummary ? (
              <View className="rounded-xl border border-border-subtle bg-card p-3">
                <Text className="text-xs leading-5 text-foreground-secondary">{manifestSummary}</Text>
              </View>
            ) : null}

            {manifestError ? (
              <View className="gap-2 rounded-xl border border-danger-border bg-danger p-3">
                <Text className="text-xs text-danger-foreground">读取快照失败：{manifestError}</Text>
                <Button
                  label="重试"
                  size="compact"
                  tone="secondary"
                  onPress={() => void loadManifestPage(0)}
                />
              </View>
            ) : null}

            {!manifestLoading && !manifestError && files.length === 0 ? (
              <View className="items-center py-10">
                <Text className="text-sm text-foreground-muted">该快照无文件变更</Text>
              </View>
            ) : null}

            {files.map((file) => (
              <Pressable
                key={`${file.status}:${file.path}`}
                accessibilityRole="button"
                onPress={() => setSelectedFile(file)}
                className="flex-row items-center gap-2.5 rounded-xl border border-border-subtle bg-card px-3.5 py-3 active:opacity-75"
              >
                <View className="rounded-md bg-subtle px-1.5 py-0.5">
                  <Text className="font-mono text-2xs font-t3-bold text-foreground-muted">
                    {file.status}
                  </Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={2} className="font-mono text-xs text-foreground">
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </Text>
                  <Text className="mt-0.5 text-2xs text-foreground-muted">
                    {file.isBinary
                      ? `二进制 · ${formatByteSize(file.sizeBytes)}`
                      : `+${file.additions ?? 0} / -${file.deletions ?? 0} · ${formatByteSize(file.sizeBytes)}`}
                  </Text>
                </View>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
            ))}

            {manifestLoading ? (
              <View className="items-center py-4">
                <AppActivityIndicator />
              </View>
            ) : manifestNextOffset !== null ? (
              <Button
                label="加载更多文件"
                size="compact"
                tone="secondary"
                onPress={() => void loadManifestPage(manifestNextOffset)}
              />
            ) : null}
          </ScrollView>
        ) : selectedFile.isBinary ? (
          <View className="gap-2 p-4">
            <View className="gap-1.5 rounded-xl border border-border-subtle bg-card p-4">
              <Text className="font-t3-medium text-sm text-foreground">二进制文件</Text>
              <Text className="text-xs text-foreground-muted">
                大小：{formatByteSize(selectedFile.sizeBytes)}
              </Text>
              <Text className="font-mono text-2xs text-foreground-muted">
                原 OID：{selectedFile.oldOid ?? "无"}
              </Text>
              <Text className="font-mono text-2xs text-foreground-muted">
                新 OID：{selectedFile.newOid ?? "无"}
              </Text>
            </View>
          </View>
        ) : (
          <ScrollView className="flex-1" contentContainerClassName="pb-8">
            {diffError ? (
              <View className="m-4 gap-2 rounded-xl border border-danger-border bg-danger p-3">
                <Text className="text-xs text-danger-foreground">读取 Diff 失败：{diffError}</Text>
                <Button
                  label="重试"
                  size="compact"
                  tone="secondary"
                  onPress={() => void loadDiffPage(selectedFile, 0)}
                />
              </View>
            ) : null}

            {diffLines.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View className="min-w-full py-2">
                  {diffLines.map((line, index) => {
                    const bgClass =
                      line.kind === "add"
                        ? "bg-emerald-500/15"
                        : line.kind === "del"
                          ? "bg-rose-500/15"
                          : line.kind === "hunk"
                            ? "bg-subtle"
                            : "";
                    const textClass =
                      line.kind === "add"
                        ? "text-emerald-700 dark:text-emerald-300"
                        : line.kind === "del"
                          ? "text-rose-700 dark:text-rose-300"
                          : line.kind === "hunk" || line.kind === "meta"
                            ? "text-foreground-muted"
                            : "text-foreground";
                    return (
                      <View
                        key={`${index}:${line.oldNumber ?? ""}:${line.newNumber ?? ""}`}
                        className={`flex-row px-2 py-0.5 ${bgClass}`}
                      >
                        <Text className="w-10 text-right font-mono text-2xs text-foreground-tertiary">
                          {line.oldNumber ?? ""}
                        </Text>
                        <Text className="mr-2 w-10 text-right font-mono text-2xs text-foreground-tertiary">
                          {line.newNumber ?? ""}
                        </Text>
                        <Text selectable className={`font-mono text-xs ${textClass}`}>
                          {line.text || " "}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            ) : !diffLoading && !diffError ? (
              <View className="items-center py-10">
                <Text className="text-sm text-foreground-muted">暂无文本差异</Text>
              </View>
            ) : null}

            {diffLoading ? (
              <View className="items-center py-4">
                <AppActivityIndicator />
              </View>
            ) : diffNextOffset !== null ? (
              <View className="px-4 pt-3">
                <Button
                  label="加载更多 Diff"
                  size="compact"
                  tone="secondary"
                  onPress={() => void loadDiffPage(selectedFile, diffNextOffset)}
                />
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
