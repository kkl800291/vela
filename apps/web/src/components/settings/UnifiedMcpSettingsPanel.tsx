import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  LockIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  fetchMcpApi,
  recordUnifiedMcpTestResult,
  refreshUnifiedMcpSnapshot,
  setUnifiedMcpSnapshot,
  unifiedMcpActiveEngineTabAtom,
  unifiedMcpErrorAtom,
  unifiedMcpSnapshotAtom,
  unifiedMcpTestResultsAtom,
  unifiedMcpViewModeAtom,
  type EngineMcpState,
  type McpEngineId,
  type McpPluginEntry,
  type McpSyncEngineResult,
  type McpTestResult,
  type McpTransport,
  type SyncMcpServerResult,
  type UnifiedMcpServerEntry,
  type UnifiedMcpSnapshot,
} from "~/state/unifiedMcp";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface AuthDialogState {
  name: string;
  sourceEngineId: McpEngineId;
  url: string;
  reason: string;
  supportsOAuth: boolean;
  tab: "oauth" | "token";
  tokenMode: "bearer_token" | "api_key_header" | "env_var";
  tokenValue: string;
  headerName: string;
  envVarName: string;
  targetEngineIds: McpEngineId[];
  oauthSessionId?: string | undefined;
  oauthUrl?: string | undefined;
  oauthStatus?: "starting" | "pending" | "completed" | "error" | undefined;
  error?: string | undefined;
}

interface McpOAuthStartResponse {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly name: string;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
}

interface McpOAuthStatusResponse {
  readonly sessionId: string;
  readonly status: "pending" | "completed" | "error";
  readonly name: string;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
  readonly message?: string;
}

interface KeyValuePair {
  id: string;
  key: string;
  value: string;
}

type CrossEngineParity = "equivalent" | "different" | "masked" | "mixed";

interface EditorState {
  mode: "create" | "edit";
  originalName?: string;
  preserveSecretsFromEngineId?: McpEngineId;
  primaryEngineId?: McpEngineId;
  divergentEngines: McpEngineId[];
  crossEngineParity: CrossEngineParity;
  enabledTouched: boolean;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command: string;
  argsText: string;
  url: string;
  bearerTokenEnvVar: string;
  envPairs: KeyValuePair[];
  headerPairs: KeyValuePair[];
  targets: McpEngineId[];
}

interface DeleteDialogState {
  name: string;
  availableEngines: McpEngineId[];
  selectedEngines: McpEngineId[];
}

interface MatrixRow {
  readonly name: string;
  readonly primaryEngineId: McpEngineId;
  readonly primaryEntry: UnifiedMcpServerEntry;
  readonly byEngine: ReadonlyMap<McpEngineId, UnifiedMcpServerEntry>;
}

const ALL_ENGINE_IDS: readonly McpEngineId[] = [
  "antigravity",
  "codex",
  "claude",
  "cursor",
  "factory",
  "kimi",
];

const ENGINE_SHORT_LABEL: Record<McpEngineId, string> = {
  antigravity: "AG",
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  factory: "Factory",
  kimi: "Kimi",
};

// Shared CSS Grid template guarantees pixel-perfect alignment between header and every row when wide enough.
const MATRIX_GRID_CLASS =
  "grid grid-cols-1 items-center gap-y-2.5 @[680px]:grid-cols-[minmax(0,1fr)_repeat(6,52px)_104px] @[680px]:gap-x-1 @[680px]:gap-y-0";

let kvCounter = 0;
function nextKvId(): string {
  kvCounter += 1;
  return `kv-${kvCounter}`;
}

function recordToPairs(record: Readonly<Record<string, string>> | undefined): KeyValuePair[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({
    id: nextKvId(),
    key,
    value,
  }));
}

function pairsToRecord(pairs: ReadonlyArray<KeyValuePair>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serverSummary(entry: UnifiedMcpServerEntry): string {
  if (entry.transport === "http") {
    return entry.url ?? "HTTP";
  }
  return [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ");
}

function areRecordsEqual(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const entriesA = Object.entries(a ?? {});
  const entriesB = Object.entries(b ?? {});
  if (entriesA.length !== entriesB.length) return false;
  for (const [k, v] of entriesA) {
    if ((b ?? {})[k] !== v) return false;
  }
  return true;
}

function hasMaskedCredentials(entry: UnifiedMcpServerEntry): boolean {
  return entry.maskedEnvKeys.length > 0 || entry.maskedHeaderKeys.length > 0;
}

function areVisibleMcpEntriesEquivalent(a: UnifiedMcpServerEntry, b: UnifiedMcpServerEntry): boolean {
  if (a.transport !== b.transport) return false;
  if ((a.command ?? "") !== (b.command ?? "")) return false;
  if ((a.url ?? "") !== (b.url ?? "")) return false;
  if ((a.bearerTokenEnvVar ?? "") !== (b.bearerTokenEnvVar ?? "")) return false;
  const argsA = a.args ?? [];
  const argsB = b.args ?? [];
  if (argsA.length !== argsB.length || argsA.some((arg, i) => arg !== argsB[i])) return false;
  if (!areRecordsEqual(a.env, b.env)) return false;
  if (!areRecordsEqual(a.headers, b.headers)) return false;
  return true;
}

/** Masked header/env values are the same sentinel on every engine, so they cannot prove equality. */
function describeCrossEngineParity(
  primary: UnifiedMcpServerEntry,
  primaryEngineId: McpEngineId,
  configuredEngines: readonly McpEngineId[],
  byEngine: ReadonlyMap<McpEngineId, UnifiedMcpServerEntry>,
): { engines: McpEngineId[]; parity: CrossEngineParity } {
  let sawDifferent = false;
  let sawMasked = false;
  const engines: McpEngineId[] = [];
  for (const id of configuredEngines) {
    if (id === primaryEngineId) continue;
    const other = byEngine.get(id);
    if (!other) continue;
    const visibleMatch = areVisibleMcpEntriesEquivalent(primary, other);
    const masked = hasMaskedCredentials(primary) || hasMaskedCredentials(other);
    if (visibleMatch && !masked) continue;
    engines.push(id);
    if (!visibleMatch) sawDifferent = true;
    if (masked) sawMasked = true;
  }
  const parity: CrossEngineParity =
    sawDifferent && sawMasked ? "mixed" : sawDifferent ? "different" : sawMasked ? "masked" : "equivalent";
  return { engines, parity };
}

function formatCrossEngineWarning(
  parity: Exclude<CrossEngineParity, "equivalent">,
  otherLabels: string,
  primaryLabel: string,
  saveLabel: string,
): string {
  const relation =
    parity === "masked"
      ? `${otherLabels} 含已脱敏凭据，无法确认是否与 ${primaryLabel} 一致`
      : parity === "mixed"
        ? `${otherLabels} 中的同名配置与 ${primaryLabel} 不同或包含已脱敏凭据`
        : `${otherLabels} 中的同名配置与 ${primaryLabel} 不同`;
  return `${relation}，默认仅保存到 ${saveLabel}；勾选其他引擎将会覆盖其原配置。`;
}

function createEmptyEditor(defaultTargets: McpEngineId[]): EditorState {
  return {
    mode: "create",
    divergentEngines: [],
    crossEngineParity: "equivalent",
    enabledTouched: true,
    name: "",
    transport: "stdio",
    enabled: true,
    command: "",
    argsText: "",
    url: "",
    bearerTokenEnvVar: "",
    envPairs: [],
    headerPairs: [],
    targets: defaultTargets.length > 0 ? defaultTargets : ["antigravity", "codex"],
  };
}

function createEditEditor(
  entry: UnifiedMcpServerEntry,
  sourceEngineId: McpEngineId,
  targets: McpEngineId[],
  divergentEngines: McpEngineId[] = [],
  crossEngineParity: CrossEngineParity = "equivalent",
): EditorState {
  return {
    mode: "edit",
    originalName: entry.name,
    preserveSecretsFromEngineId: sourceEngineId,
    primaryEngineId: sourceEngineId,
    divergentEngines,
    crossEngineParity,
    enabledTouched: false,
    name: entry.name,
    transport: entry.transport,
    enabled: entry.enabled,
    command: entry.command ?? "",
    argsText: (entry.args ?? []).join("\n"),
    url: entry.url ?? "",
    bearerTokenEnvVar: entry.bearerTokenEnvVar ?? "",
    envPairs: recordToPairs(entry.env),
    headerPairs: recordToPairs(entry.headers),
    targets: crossEngineParity === "equivalent" ? targets : [sourceEngineId],
  };
}

function resolveMatrixRowHealthBadge(
  rowName: string,
  primaryEngineId: McpEngineId,
  configuredEngines: ReadonlyArray<McpEngineId>,
  testResults: Readonly<Record<string, McpTestResult>>,
): {
  readonly result: McpTestResult | undefined;
  readonly engineId: McpEngineId;
  readonly badgeNote: string | undefined;
} {
  let errorEntry: { engineId: McpEngineId; result: McpTestResult } | undefined;
  let authEntry: { engineId: McpEngineId; result: McpTestResult } | undefined;
  let connectedEntry: { engineId: McpEngineId; result: McpTestResult } | undefined;
  let testedCount = 0;

  for (const engineId of configuredEngines) {
    const res = testResults[`${engineId}:${rowName}`];
    if (!res) continue;
    testedCount += 1;
    if (res.status === "error" && !errorEntry) {
      errorEntry = { engineId, result: res };
    } else if (res.status === "auth_required" && !authEntry) {
      authEntry = { engineId, result: res };
    } else if (res.status === "connected" && !connectedEntry) {
      connectedEntry = { engineId, result: res };
    }
  }

  const picked =
    errorEntry ??
    authEntry ??
    connectedEntry ??
    (testResults[rowName] ? { engineId: primaryEngineId, result: testResults[rowName] } : undefined);

  if (!picked) {
    return { result: undefined, engineId: primaryEngineId, badgeNote: undefined };
  }

  const multiEngine = configuredEngines.length > 1;
  const noteParts: string[] = [];
  if (multiEngine && picked.result.status !== "connected") {
    noteParts.push(ENGINE_SHORT_LABEL[picked.engineId]);
  }
  if (multiEngine && testedCount > 0 && testedCount < configuredEngines.length) {
    noteParts.push(`${testedCount}/${configuredEngines.length} 引擎已测`);
  }

  return {
    result: picked.result,
    engineId: picked.engineId,
    badgeNote: noteParts.length > 0 ? noteParts.join(" · ") : undefined,
  };
}

const INITIAL_LOADING_DELAY_MS = 150;

export function UnifiedMcpSettingsPanel() {
  const snapshot = useAtomValue(unifiedMcpSnapshotAtom);
  const error = useAtomValue(unifiedMcpErrorAtom);
  const testResults = useAtomValue(unifiedMcpTestResultsAtom);
  const [viewMode, setViewMode] = useAtom(unifiedMcpViewModeAtom);
  const [activeEngineTab, setActiveEngineTab] = useAtom(unifiedMcpActiveEngineTabAtom);
  const [refreshing, setRefreshing] = useState(false);
  const [showInitialLoading, setShowInitialLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [testingKeys, setTestingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [authDialog, setAuthDialog] = useState<AuthDialogState | null>(null);
  const [authSaving, setAuthSaving] = useState(false);
  const [syncReport, setSyncReport] = useState<{
    readonly sourceEngineId: McpEngineId;
    readonly name: string;
    readonly results: ReadonlyArray<McpSyncEngineResult>;
  } | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshUnifiedMcpSnapshot({ force: true, surfaceError: true });
    } finally {
      setRefreshing(false);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- silently revalidates cached local multi-engine MCP config snapshot on mount
  useEffect(() => {
    void refreshUnifiedMcpSnapshot({ force: false, surfaceError: false });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delays initial loading copy so fast local reads never flash a placeholder
  useEffect(() => {
    if (snapshot !== null || error !== null) return;
    const timer = window.setTimeout(() => setShowInitialLoading(true), INITIAL_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, error]);

  const isShowingInitialLoading = snapshot === null && error === null && showInitialLoading;

  const engines = snapshot?.engines ?? [];

  const engineLabelById = useMemo(() => {
    const map = new Map<McpEngineId, string>();
    for (const engine of engines) {
      map.set(engine.id, engine.label);
    }
    return map;
  }, [engines]);

  const existingEngineIds = useMemo(
    () => engines.filter((engine) => engine.exists).map((engine) => engine.id),
    [engines],
  );

  const matrixRows = useMemo<MatrixRow[]>(() => {
    const grouped = new Map<
      string,
      {
        primaryEngineId: McpEngineId;
        primaryEntry: UnifiedMcpServerEntry;
        byEngine: Map<McpEngineId, UnifiedMcpServerEntry>;
      }
    >();

    for (const engine of engines) {
      for (const server of engine.servers) {
        const existing = grouped.get(server.name);
        if (!existing) {
          grouped.set(server.name, {
            primaryEngineId: engine.id,
            primaryEntry: server,
            byEngine: new Map([[engine.id, server]]),
          });
        } else {
          existing.byEngine.set(engine.id, server);
        }
      }
    }

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const rows: MatrixRow[] = [];
    for (const [name, data] of grouped.entries()) {
      if (normalizedQuery) {
        const haystackParts: string[] = [name];
        for (const entry of data.byEngine.values()) {
          haystackParts.push(
            entry.command ?? "",
            ...(entry.args ?? []),
            entry.url ?? "",
            entry.bearerTokenEnvVar ?? "",
          );
        }
        const haystack = haystackParts.join(" ").toLowerCase();
        if (!haystack.includes(normalizedQuery)) continue;
      }
      rows.push({
        name,
        primaryEngineId: data.primaryEngineId,
        primaryEntry: data.primaryEntry,
        byEngine: data.byEngine,
      });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [engines, searchQuery]);

  const allPluginEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const items: Array<{ engine: EngineMcpState; plugin: McpPluginEntry }> = [];
    for (const engine of engines) {
      for (const plugin of engine.plugins) {
        if (normalizedQuery) {
          const haystack = `${plugin.name} ${plugin.pluginName} ${plugin.summary}`.toLowerCase();
          if (!haystack.includes(normalizedQuery)) continue;
        }
        items.push({ engine, plugin });
      }
    }
    return items;
  }, [engines, searchQuery]);

  const activeEngine = useMemo(() => {
    const found = engines.find((engine) => engine.id === activeEngineTab) ?? engines[0];
    if (!found) return null;
    const unfilteredServerCount = found.servers.length;
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return { ...found, unfilteredServerCount };
    }
    return {
      ...found,
      unfilteredServerCount,
      servers: found.servers.filter((server) =>
        `${server.name} ${serverSummary(server)} ${server.bearerTokenEnvVar ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
      plugins: found.plugins.filter((plugin) =>
        `${plugin.name} ${plugin.pluginName} ${plugin.summary}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    };
  }, [activeEngineTab, engines, searchQuery]);

  const handleToggle = async (engineId: McpEngineId, name: string, nextEnabled: boolean) => {
    const key = `toggle:${engineId}:${name}`;
    setBusyKey(key);
    try {
      const next = await fetchMcpApi<UnifiedMcpSnapshot>("/api/vela/mcp/toggle", {
        method: "POST",
        body: JSON.stringify({ engineId, name, enabled: nextEnabled }),
      });
      setUnifiedMcpSnapshot(next);
      const label = engineLabelById.get(engineId) ?? engineId;
      toastManager.add({
        type: "success",
        title: nextEnabled ? `已在 ${label} 启用 ${name}` : `已在 ${label} 禁用 ${name}`,
      });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "切换状态失败",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSync = async (
    sourceEngineId: McpEngineId,
    name: string,
    targetEngineIds: McpEngineId[],
  ) => {
    if (targetEngineIds.length === 0) return;
    const key = `sync:${name}:${targetEngineIds.join(",")}`;
    setBusyKey(key);
    try {
      const res = await fetchMcpApi<SyncMcpServerResult>("/api/vela/mcp/sync", {
        method: "POST",
        body: JSON.stringify({ sourceEngineId, name, targetEngineIds }),
      });
      setUnifiedMcpSnapshot(res.snapshot);
      const succeeded = res.results
        .filter((r) => r.ok)
        .map((r) => engineLabelById.get(r.engineId) ?? r.engineId);
      const failed = res.results.filter((r) => !r.ok);

      if (failed.length === 0) {
        setSyncReport((prev) =>
          prev && prev.name === name && prev.sourceEngineId === sourceEngineId ? null : prev,
        );
        toastManager.add({
          type: "success",
          title: `已同步 ${name}`,
          description: `已写入：${succeeded.join("、")}`,
        });
      } else {
        setSyncReport({ sourceEngineId, name, results: res.results });
        const failedLabels = failed
          .map((r) => `${engineLabelById.get(r.engineId) ?? r.engineId}（${r.error ?? "写入失败"}）`)
          .join("；");
        toastManager.add({
          type: succeeded.length > 0 ? "warning" : "error",
          title:
            succeeded.length > 0
              ? `部分同步失败：${succeeded.length} 成功，${failed.length} 失败`
              : "同步失败",
          description:
            succeeded.length > 0
              ? `已写入：${succeeded.join("、")}。失败：${failedLabels}`
              : failedLabels,
        });
      }
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "同步失败",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteDialog || deleteDialog.selectedEngines.length === 0) return;
    const key = `delete:${deleteDialog.name}`;
    setBusyKey(key);
    try {
      const next = await fetchMcpApi<UnifiedMcpSnapshot>("/api/vela/mcp/delete", {
        method: "POST",
        body: JSON.stringify({
          name: deleteDialog.name,
          engineIds: deleteDialog.selectedEngines,
        }),
      });
      setUnifiedMcpSnapshot(next);
      toastManager.add({
        type: "success",
        title: `已移除 ${deleteDialog.name}`,
        description: `已从 ${deleteDialog.selectedEngines.length} 个引擎配置中删除`,
      });
      setDeleteDialog(null);
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveEditor = async () => {
    if (!editor) return;
    const trimmedName = editor.name.trim();
    if (!trimmedName) {
      setEditorError("请填写 MCP 名称");
      return;
    }
    if (editor.targets.length === 0) {
      setEditorError("请至少选择一个目标引擎");
      return;
    }
    if (editor.transport === "stdio" && !editor.command.trim()) {
      setEditorError("stdio 模式必须填写启动命令 (command)");
      return;
    }
    if (editor.transport === "http" && !editor.url.trim()) {
      setEditorError("HTTP 模式必须填写服务地址 (URL)");
      return;
    }

    setSaving(true);
    setEditorError(null);
    try {
      const args = editor.argsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const env = pairsToRecord(editor.envPairs);
      const headers = pairsToRecord(editor.headerPairs);

      const shouldSendEnabled = editor.mode === "create" || editor.enabledTouched;

      const next = await fetchMcpApi<UnifiedMcpSnapshot>("/api/vela/mcp/upsert", {
        method: "POST",
        body: JSON.stringify({
          name: trimmedName,
          ...(editor.originalName ? { originalName: editor.originalName } : {}),
          transport: editor.transport,
          ...(shouldSendEnabled ? { enabled: editor.enabled } : {}),
          ...(editor.transport === "stdio"
            ? {
                command: editor.command.trim(),
                args,
                ...(env ? { env } : {}),
              }
            : {
                url: editor.url.trim(),
                ...(editor.bearerTokenEnvVar.trim()
                  ? { bearerTokenEnvVar: editor.bearerTokenEnvVar.trim() }
                  : {}),
                ...(headers ? { headers } : {}),
              }),
          targets: editor.targets,
          ...(editor.preserveSecretsFromEngineId
            ? { preserveSecretsFromEngineId: editor.preserveSecretsFromEngineId }
            : {}),
        }),
      });
      setUnifiedMcpSnapshot(next);
      setEditor(null);
      toastManager.add({
        type: "success",
        title: editor.mode === "create" ? `已添加 ${trimmedName}` : `已更新 ${trimmedName}`,
        description: `已同步写入 ${editor.targets.length} 个引擎配置`,
      });
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runTestServer = useCallback(async (engineId: McpEngineId, name: string) => {
    const engineKey = `${engineId}:${name}`;
    setTestingKeys((prev) => {
      const next = new Set(prev);
      next.add(engineKey);
      next.add(name);
      return next;
    });
    try {
      const result = await fetchMcpApi<McpTestResult>("/api/vela/mcp/test", {
        method: "POST",
        body: JSON.stringify({ engineId, name }),
      });
      recordUnifiedMcpTestResult(engineId, name, result);
      return result;
    } catch (err) {
      const fallback: McpTestResult = {
        ok: false,
        status: "error",
        engineId,
        name,
        transport: "stdio",
        latencyMs: 0,
        message: err instanceof Error ? err.message : String(err),
        testedAt: new Date().toISOString(),
      };
      recordUnifiedMcpTestResult(engineId, name, fallback);
      return fallback;
    } finally {
      setTestingKeys((prev) => {
        const next = new Set(prev);
        next.delete(engineKey);
        next.delete(name);
        return next;
      });
    }
  }, []);

  const handleTestAll = async () => {
    const targets: Array<{ engineId: McpEngineId; name: string }> =
      viewMode === "engine" && activeEngine
        ? activeEngine.servers.map((server) => ({ engineId: activeEngine.id, name: server.name }))
        : matrixRows.flatMap((row) =>
            [...row.byEngine.keys()].map((engineId) => ({ engineId, name: row.name })),
          );

    if (targets.length === 0) return;
    setTestingAll(true);
    try {
      const concurrency = 3;
      let passed = 0;
      let index = 0;
      const worker = async () => {
        while (index < targets.length) {
          const current = targets[index];
          index += 1;
          if (!current) break;
          const res = await runTestServer(current.engineId, current.name);
          if (res.ok) passed += 1;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
      );
      toastManager.add({
        type: passed === targets.length ? "success" : "info",
        title: `连接检测完成：${passed}/${targets.length} 可用`,
      });
    } finally {
      setTestingAll(false);
    }
  };

  const openExternalBrowser = useCallback((url: string) => {
    if (typeof window !== "undefined" && window.desktopBridge?.openExternal) {
      void window.desktopBridge.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const openAuthDialog = useCallback(
    (
      entry: UnifiedMcpServerEntry,
      sourceEngineId: McpEngineId,
      configuredEngines: McpEngineId[],
      result?: McpTestResult,
    ) => {
      const supportsOAuth = result?.supportsOAuth ?? true;
      const missingEnvVar = result?.missingEnvVars?.[0] ?? entry.bearerTokenEnvVar ?? "";
      setAuthDialog({
        name: entry.name,
        sourceEngineId,
        url: entry.url ?? "",
        reason: result?.message ?? "该服务需要认证凭据后才能连接",
        supportsOAuth,
        tab: missingEnvVar ? "token" : supportsOAuth ? "oauth" : "token",
        tokenMode: missingEnvVar ? "env_var" : "bearer_token",
        tokenValue: "",
        headerName: "X-API-Key",
        envVarName: missingEnvVar,
        targetEngineIds: configuredEngines.length > 0 ? configuredEngines : [sourceEngineId],
      });
    },
    [],
  );

  const handleStartOAuth = async () => {
    if (!authDialog) return;
    if (authDialog.targetEngineIds.length === 0) {
      setAuthDialog((prev) => (prev ? { ...prev, error: "请至少选择一个目标引擎" } : null));
      return;
    }
    setAuthDialog((prev) =>
      prev ? { ...prev, oauthStatus: "starting", error: undefined } : null,
    );
    try {
      const started = await fetchMcpApi<McpOAuthStartResponse>("/api/vela/mcp/auth/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          name: authDialog.name,
          sourceEngineId: authDialog.sourceEngineId,
          targetEngineIds: authDialog.targetEngineIds,
        }),
      });
      setAuthDialog((prev) =>
        prev
          ? {
              ...prev,
              oauthSessionId: started.sessionId,
              oauthUrl: started.authorizationUrl,
              oauthStatus: "pending",
              error: undefined,
            }
          : null,
      );
      openExternalBrowser(started.authorizationUrl);
    } catch (err) {
      setAuthDialog((prev) =>
        prev
          ? {
              ...prev,
              oauthStatus: "error",
              error: err instanceof Error ? err.message : String(err),
            }
          : null,
      );
    }
  };

  const handleSaveQuickToken = async () => {
    if (!authDialog) return;
    if (authDialog.targetEngineIds.length === 0) {
      setAuthDialog((prev) => (prev ? { ...prev, error: "请至少选择一个目标引擎" } : null));
      return;
    }
    if (authDialog.tokenMode === "env_var" && !authDialog.envVarName.trim()) {
      setAuthDialog((prev) => (prev ? { ...prev, error: "请填写环境变量名" } : null));
      return;
    }
    if (authDialog.tokenMode !== "env_var" && !authDialog.tokenValue.trim()) {
      setAuthDialog((prev) => (prev ? { ...prev, error: "请粘贴 Token 或密钥值" } : null));
      return;
    }

    setAuthSaving(true);
    setAuthDialog((prev) => (prev ? { ...prev, error: undefined } : null));
    try {
      const next = await fetchMcpApi<UnifiedMcpSnapshot>("/api/vela/mcp/auth/token", {
        method: "POST",
        body: JSON.stringify({
          name: authDialog.name,
          sourceEngineId: authDialog.sourceEngineId,
          targetEngineIds: authDialog.targetEngineIds,
          mode: authDialog.tokenMode,
          ...(authDialog.tokenMode === "env_var"
            ? { envVarName: authDialog.envVarName.trim() }
            : {
                token: authDialog.tokenValue.trim(),
                ...(authDialog.tokenMode === "api_key_header"
                  ? { headerName: authDialog.headerName.trim() || "X-API-Key" }
                  : {}),
              }),
        }),
      });
      setUnifiedMcpSnapshot(next);
      const testEngineId = authDialog.targetEngineIds[0] ?? authDialog.sourceEngineId;
      const serverName = authDialog.name;
      setAuthDialog(null);
      const testRes = await runTestServer(testEngineId, serverName);
      toastManager.add({
        type: testRes.ok ? "success" : "info",
        title: testRes.ok
          ? `${serverName} 认证成功（${testRes.toolCount ?? 0} 个工具）`
          : `已写入凭据，${testRes.message}`,
      });
    } catch (err) {
      setAuthDialog((prev) =>
        prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : null,
      );
    } finally {
      setAuthSaving(false);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls local OAuth loopback callback session while user authorizes in browser
  useEffect(() => {
    const sessionId = authDialog?.oauthSessionId;
    if (!sessionId || authDialog?.oauthStatus !== "pending") return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetchMcpApi<McpOAuthStatusResponse>(
          `/api/vela/mcp/auth/oauth/status?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (cancelled) return;
        if (res.status === "completed") {
          const targetEngine = res.targetEngineIds[0] ?? authDialog.sourceEngineId;
          const serverName = res.name;
          setAuthDialog(null);
          await refreshUnifiedMcpSnapshot({ force: true, surfaceError: false });
          const testRes = await runTestServer(targetEngine, serverName);
          toastManager.add({
            type: testRes.ok ? "success" : "info",
            title: testRes.ok
              ? `${serverName} OAuth 授权成功（${testRes.toolCount ?? 0} 个工具）`
              : `${serverName} 授权已保存`,
            description: res.message,
          });
        } else if (res.status === "error") {
          setAuthDialog((prev) =>
            prev
              ? {
                  ...prev,
                  oauthStatus: "error",
                  error: res.message ?? "授权失败，请重试",
                }
              : null,
          );
        }
      } catch {
        // Keep polling transiently
      }
    };

    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    authDialog?.oauthSessionId,
    authDialog?.oauthStatus,
    authDialog?.sourceEngineId,
    runTestServer,
  ]);

  return (
    <SettingsPageContainer width="readable" className="gap-5">
      {/* Flush-aligned minimalist toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          value={[viewMode]}
          onValueChange={(nextValue) => {
            const first = nextValue[0];
            if (first === "matrix" || first === "engine") {
              setViewMode(first);
            }
          }}
        >
          <Toggle value="matrix">跨引擎矩阵</Toggle>
          <Toggle value="engine">按引擎管理</Toggle>
        </ToggleGroup>

        <div className="flex flex-1 items-center justify-end gap-2 sm:flex-initial">
          <div className="relative w-full sm:w-48">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              size="compact"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="筛选 MCP..."
              className="pl-7"
            />
          </div>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!snapshot || testingAll || matrixRows.length === 0}
                  onClick={() => void handleTestAll()}
                >
                  <ActivityIcon className={cn("size-3.5", testingAll && "animate-pulse")} />
                  {testingAll ? "检测中..." : "检测连接"}
                </Button>
              }
            />
            <TooltipPopup side="top">真实握手测试各 MCP 服务连通性与可用工具数</TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="刷新配置"
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                >
                  <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">重新扫描本机 6 个引擎配置</TooltipPopup>
          </Tooltip>

          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditorError(null);
              setEditor(
                createEmptyEditor(
                  viewMode === "engine" ? [activeEngineTab] : existingEngineIds,
                ),
              );
            }}
          >
            <PlusIcon className="size-3.5" />
            添加 MCP
          </Button>
        </div>
      </div>

      {/* Per-engine partial sync report */}
      {syncReport && (
        <div className="space-y-2 rounded-xl border border-warning/35 bg-warning-surface/40 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <AlertCircleIcon className="size-4 shrink-0 text-warning" />
              <span>
                「{syncReport.name}」同步结果（来自{" "}
                {engineLabelById.get(syncReport.sourceEngineId) ?? syncReport.sourceEngineId}）
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {syncReport.results.some((r) => !r.ok) && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void handleSync(
                      syncReport.sourceEngineId,
                      syncReport.name,
                      syncReport.results.filter((r) => !r.ok).map((r) => r.engineId),
                    )
                  }
                >
                  重试失败项
                </Button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="关闭同步结果提示"
                onClick={() => setSyncReport(null)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {syncReport.results.map((item) => {
              const label = engineLabelById.get(item.engineId) ?? item.engineId;
              return (
                <div
                  key={item.engineId}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1",
                    item.ok
                      ? "border-border/60 bg-background/70 text-foreground"
                      : "border-destructive/35 bg-destructive/8 text-destructive",
                  )}
                >
                  {item.ok ? (
                    <CheckIcon className="size-3.5 shrink-0" />
                  ) : (
                    <AlertCircleIcon className="size-3.5 shrink-0" />
                  )}
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground">
                    {item.ok ? "已写入" : item.error || "写入失败"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/6 px-4 py-3 text-xs text-destructive">
          <div className="flex items-center gap-2">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>无法读取本机 MCP 配置：{error}</span>
          </div>
          <Button size="xs" variant="outline" onClick={() => void handleRefresh()}>
            重试
          </Button>
        </div>
      )}

      {!snapshot ? (
        isShowingInitialLoading ? (
          <SettingsSection id="unified-mcp-matrix" title="MCP 服务">
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              正在读取本机配置...
            </div>
          </SettingsSection>
        ) : null
      ) : viewMode === "matrix" ? (
        <>
          {/* Pixel-aligned Matrix Table with container-aware responsive layout */}
          <SettingsSection
            id="unified-mcp-matrix"
            title="MCP 服务"
            headerAction={
              <span className="text-xs text-muted-foreground">
                点击勾选切换启停 · 窄屏支持单键同步
              </span>
            }
          >
            <div className="@container">
              {/* Header row using exact same grid columns */}
              <div
                className={cn(
                  MATRIX_GRID_CLASS,
                  "hidden bg-muted/25 px-4 py-2 text-[11px] font-medium text-muted-foreground @[680px]:grid",
                )}
              >
                <div className="min-w-0 pr-3">服务</div>
                {engines.map((engine) => (
                  <div key={engine.id} className="flex justify-center">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => {
                              setActiveEngineTab(engine.id);
                              setViewMode("engine");
                            }}
                            className="cursor-pointer truncate rounded px-1 py-0.5 text-center transition-colors hover:bg-accent/60 hover:text-foreground"
                          >
                            {ENGINE_SHORT_LABEL[engine.id]}
                          </button>
                        }
                      />
                      <TooltipPopup side="top">
                        {engine.label} · {engine.displayPath}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                ))}
                <div className="text-right">操作</div>
              </div>

              {matrixRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                  {searchQuery ? "没有匹配的 MCP 服务" : "暂未发现 MCP 服务，点击右上角「添加 MCP」新建。"}
                </div>
              ) : (
                matrixRows.map((row) => {
                  const missingEngines = ALL_ENGINE_IDS.filter((id) => !row.byEngine.has(id));
                  const configuredEngines = ALL_ENGINE_IDS.filter((id) => row.byEngine.has(id));
                  const isRowBusy = busyKey !== null && busyKey.includes(`:${row.name}`);
                  const isRowTesting = configuredEngines.some((id) =>
                    testingKeys.has(`${id}:${row.name}`),
                  );
                  const rowHealth = resolveMatrixRowHealthBadge(
                    row.name,
                    row.primaryEngineId,
                    configuredEngines,
                    testResults,
                  );
                  const rowHealthEntry = row.byEngine.get(rowHealth.engineId) ?? row.primaryEntry;
                  const crossEngine = describeCrossEngineParity(
                    row.primaryEntry,
                    row.primaryEngineId,
                    configuredEngines,
                    row.byEngine,
                  );
                  const hasMaskedSecrets =
                    row.primaryEntry.maskedEnvKeys.length > 0 ||
                    row.primaryEntry.maskedHeaderKeys.length > 0;

                  return (
                    <div
                      key={row.name}
                      className={cn(
                        MATRIX_GRID_CLASS,
                        "group px-4 py-3 transition-colors hover:bg-muted/20",
                      )}
                    >
                      {/* Column 1: Service name + summary */}
                      <div className="min-w-0 @[680px]:pr-3">
                        <div className="flex items-center gap-2">
                          {row.primaryEntry.transport === "http" ? (
                            <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          ) : (
                            <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          )}
                          <span className="truncate text-sm font-medium text-foreground">
                            {row.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                            {row.primaryEntry.transport === "http" ? "http" : "stdio"}
                          </span>
                          {row.primaryEntry.bearerTokenEnvVar && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/75">
                                    <LockIcon className="size-2.5" />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">
                                Bearer Token 环境变量：{row.primaryEntry.bearerTokenEnvVar}
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          {!row.primaryEntry.bearerTokenEnvVar && hasMaskedSecrets && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="inline-flex shrink-0 items-center text-muted-foreground/75">
                                    <LockIcon className="size-2.5" />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">含已脱敏凭据，编辑与同步时自动保留</TooltipPopup>
                            </Tooltip>
                          )}
                          <McpHealthBadge
                            testing={isRowTesting}
                            result={rowHealth.result}
                            prefixLabel={rowHealth.badgeNote}
                            onQuickAuth={
                              rowHealthEntry.transport === "http"
                                ? () =>
                                    openAuthDialog(
                                      rowHealthEntry,
                                      rowHealth.engineId,
                                      [rowHealth.engineId],
                                      rowHealth.result,
                                    )
                                : undefined
                            }
                          />
                        </div>
                        <p className="mt-0.5 truncate pl-[22px] font-mono text-[11px] text-muted-foreground">
                          {serverSummary(row.primaryEntry)}
                        </p>
                      </div>

                      {/* Columns 2-7: 6 Engine status cells (wide container direct grid children) */}
                      {engines.map((engine) => {
                        const entry = row.byEngine.get(engine.id);
                        const cellBusy =
                          busyKey === `toggle:${engine.id}:${row.name}` ||
                          busyKey === `sync:${row.name}:${engine.id}`;

                        return (
                          <div
                            key={engine.id}
                            className="hidden items-center justify-center @[680px]:flex"
                          >
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    disabled={busyKey !== null}
                                    onClick={() => {
                                      if (entry) {
                                        void handleToggle(engine.id, row.name, !entry.enabled);
                                      } else {
                                        void handleSync(row.primaryEngineId, row.name, [engine.id]);
                                      }
                                    }}
                                    aria-label={
                                      entry
                                        ? `${engine.label} ${entry.enabled ? "已启用" : "已禁用"}`
                                        : `同步到 ${engine.label}`
                                    }
                                    className={cn(
                                      "group/cell flex size-5 cursor-pointer items-center justify-center rounded-full transition-all disabled:pointer-events-none disabled:opacity-50",
                                      entry?.enabled
                                        ? "bg-foreground/88 text-background hover:bg-foreground"
                                        : entry
                                          ? "border border-border bg-muted/60 text-muted-foreground hover:border-foreground/35 hover:text-foreground"
                                          : "text-muted-foreground/30 hover:border hover:border-border hover:bg-background hover:text-foreground",
                                    )}
                                  >
                                    {cellBusy ? (
                                      <RefreshCwIcon className="size-2.5 animate-spin" />
                                    ) : entry?.enabled ? (
                                      <CheckIcon className="size-3 stroke-[2.5]" />
                                    ) : entry ? (
                                      <MinusIcon className="size-2.5" />
                                    ) : (
                                      <>
                                        <span className="size-1.5 rounded-full bg-current group-hover/cell:hidden" />
                                        <PlusIcon className="hidden size-3 group-hover/cell:block" />
                                      </>
                                    )}
                                  </button>
                                }
                              />
                              <TooltipPopup side="top">
                                {entry?.enabled
                                  ? `${engine.label}：已启用（点击禁用）`
                                  : entry
                                    ? `${engine.label}：已禁用（点击启用）`
                                    : `未配置 · 点击同步到 ${engine.label}`}
                              </TooltipPopup>
                            </Tooltip>
                          </div>
                        );
                      })}

                      {/* Compact engine pills + explicit sync action for narrow containers */}
                      <div className="flex flex-wrap items-center gap-1.5 pl-[22px] @[680px]:hidden">
                        {engines.map((engine) => {
                          const entry = row.byEngine.get(engine.id);
                          return (
                            <button
                              key={engine.id}
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() => {
                                if (entry) {
                                  void handleToggle(engine.id, row.name, !entry.enabled);
                                } else {
                                  void handleSync(row.primaryEngineId, row.name, [engine.id]);
                                }
                              }}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                                entry?.enabled
                                  ? "border-foreground/25 bg-foreground/[0.06] text-foreground"
                                  : entry
                                    ? "border-border text-muted-foreground line-through"
                                    : "border-dashed border-border/70 text-muted-foreground/75 hover:border-border hover:text-foreground",
                              )}
                            >
                              {entry?.enabled ? (
                                <CheckIcon className="size-2.5" />
                              ) : !entry ? (
                                <PlusIcon className="size-2.5 opacity-70" />
                              ) : null}
                              {ENGINE_SHORT_LABEL[engine.id]}
                            </button>
                          );
                        })}
                        {missingEngines.length > 0 && (
                          <button
                            type="button"
                            disabled={isRowBusy}
                            onClick={() =>
                              void handleSync(row.primaryEngineId, row.name, missingEngines)
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-foreground/85 hover:bg-accent disabled:opacity-50"
                          >
                            <ArrowLeftRightIcon className="size-2.5" />
                            同步其余 {missingEngines.length} 个
                          </button>
                        )}
                      </div>

                      {/* Column 8: Row actions */}
                      <div className="flex items-center justify-end gap-0.5 opacity-85 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`检测 ${row.name} 连接`}
                                disabled={isRowTesting || isRowBusy}
                                onClick={() =>
                                  void Promise.all(
                                    configuredEngines.map((engineId) =>
                                      runTestServer(engineId, row.name),
                                    ),
                                  )
                                }
                              >
                                <ActivityIcon
                                  className={cn("size-3.5", isRowTesting && "animate-pulse")}
                                />
                              </Button>
                            }
                          />
                          <TooltipPopup side="top">
                            {configuredEngines.length > 1
                              ? `检测全部 ${configuredEngines.length} 个已配引擎的连接`
                              : "测试连接与工具列表"}
                          </TooltipPopup>
                        </Tooltip>

                        {missingEngines.length > 0 && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`同步 ${row.name} 到全部引擎`}
                                  disabled={isRowBusy}
                                  onClick={() =>
                                    void handleSync(row.primaryEngineId, row.name, missingEngines)
                                  }
                                >
                                  <ArrowLeftRightIcon className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">
                              同步到剩余 {missingEngines.length} 个引擎
                            </TooltipPopup>
                          </Tooltip>
                        )}

                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`编辑 ${row.name}`}
                                disabled={isRowBusy}
                                onClick={() => {
                                  setEditorError(null);
                                  setEditor(
                                    createEditEditor(
                                      row.primaryEntry,
                                      row.primaryEngineId,
                                      configuredEngines,
                                      crossEngine.engines,
                                      crossEngine.parity,
                                    ),
                                  );
                                }}
                              >
                                <PencilIcon className="size-3.5" />
                              </Button>
                            }
                          />
                          <TooltipPopup side="top">编辑配置</TooltipPopup>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost-destructive"
                                aria-label={`删除 ${row.name}`}
                                disabled={isRowBusy}
                                onClick={() =>
                                  setDeleteDialog({
                                    name: row.name,
                                    availableEngines: configuredEngines,
                                    selectedEngines: configuredEngines,
                                  })
                                }
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            }
                          />
                          <TooltipPopup side="top">删除</TooltipPopup>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </SettingsSection>

          {/* Compact Collapsible Plugin-managed MCPs */}
          {allPluginEntries.length > 0 && (
            <SettingsSection id="unified-mcp-plugins" title="插件托管 MCP" hideTitle>
              <Collapsible open={pluginsOpen} onOpenChange={setPluginsOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20">
                  <div className="flex items-center gap-2">
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 text-muted-foreground transition-transform duration-150",
                        pluginsOpen && "rotate-90",
                      )}
                    />
                    <PuzzleIcon className="size-3.5 text-muted-foreground/80" />
                    <span className="text-sm font-medium text-foreground">插件托管 MCP</span>
                    <span className="text-xs text-muted-foreground">
                      {allPluginEntries.length} 个只读
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {pluginsOpen ? "收起" : "展开"}
                  </span>
                </CollapsibleTrigger>

                <CollapsiblePanel>
                  <div className="divide-y divide-border/50 border-t border-border/50">
                    {allPluginEntries.map(({ engine, plugin }) => (
                      <div
                        key={`${engine.id}:${plugin.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-mono text-xs font-medium text-foreground">
                              {plugin.name}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {engine.label}
                            </span>
                          </div>
                          <p className="truncate font-mono text-[11px] text-muted-foreground/75">
                            {plugin.summary}
                          </p>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {plugin.enabled ? "已启用" : "已关闭"}
                        </span>
                      </div>
                    ))}
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </SettingsSection>
          )}
        </>
      ) : (
        /* Per-Engine Focused View */
        <div className="space-y-4">
          <ToggleGroup
            value={[activeEngineTab]}
            onValueChange={(nextValue) => {
              const first = nextValue[0] as McpEngineId | undefined;
              if (first) setActiveEngineTab(first);
            }}
            className="flex-wrap"
          >
            {engines.map((engine) => (
              <Toggle key={engine.id} value={engine.id} className="gap-1.5">
                <span>{engine.label}</span>
                <span className="font-mono text-[11px] opacity-55">
                  {engine.servers.length}
                </span>
              </Toggle>
            ))}
          </ToggleGroup>

          {activeEngine && (
            <SettingsSection
              title={activeEngine.label}
              headerAction={
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {activeEngine.displayPath}
                  </span>
                  <Badge variant="outline" size="sm" className="uppercase">
                    {activeEngine.format}
                  </Badge>
                </div>
              }
            >
              {activeEngine.parseError && (
                <div className="flex items-center gap-2 bg-destructive/6 px-4 py-2.5 text-xs text-destructive">
                  <AlertCircleIcon className="size-3.5 shrink-0" />
                  <span>配置解析失败：{activeEngine.parseError}</span>
                </div>
              )}

              {activeEngine.servers.length === 0 ? (
                searchQuery.trim().length > 0 ? (
                  <div className="flex items-center justify-between gap-3 px-4 py-8">
                    <span className="text-xs text-muted-foreground">
                      {activeEngine.unfilteredServerCount > 0
                        ? `${activeEngine.label} 中没有匹配「${searchQuery.trim()}」的 MCP 服务。`
                        : `${activeEngine.label} 暂未配置自定义 MCP 服务（当前有筛选条件）。`}
                    </span>
                    <Button size="xs" variant="outline" onClick={() => setSearchQuery("")}>
                      清除筛选
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-4 py-8">
                    <span className="text-xs text-muted-foreground">
                      {activeEngine.exists
                        ? "当前引擎暂未配置自定义 MCP 服务。"
                        : "尚未创建该引擎的配置文件，添加或同步时将自动创建。"}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setEditorError(null);
                        setEditor(createEmptyEditor([activeEngine.id]));
                      }}
                    >
                      <PlusIcon className="size-3" />
                      添加
                    </Button>
                  </div>
                )
              ) : (
                activeEngine.servers.map((server) => {
                  const otherEngines = ALL_ENGINE_IDS.filter((id) => id !== activeEngine.id);
                  const isBusy = busyKey === `toggle:${activeEngine.id}:${server.name}`;

                  return (
                    <div
                      key={server.name}
                      className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/20"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {server.transport === "http" ? (
                            <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          ) : (
                            <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          )}
                          <span
                            className={cn(
                              "truncate text-sm font-medium",
                              server.enabled
                                ? "text-foreground"
                                : "text-muted-foreground line-through",
                            )}
                          >
                            {server.name}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                            {server.transport === "http" ? "http" : "stdio"}
                          </span>
                          <McpHealthBadge
                            testing={testingKeys.has(`${activeEngine.id}:${server.name}`)}
                            result={testResults[`${activeEngine.id}:${server.name}`]}
                            onQuickAuth={
                              server.transport === "http"
                                ? () =>
                                    openAuthDialog(
                                      server,
                                      activeEngine.id,
                                      [activeEngine.id],
                                      testResults[`${activeEngine.id}:${server.name}`],
                                    )
                                : undefined
                            }
                          />
                        </div>
                        <p className="mt-0.5 truncate pl-[22px] font-mono text-[11px] text-muted-foreground">
                          {serverSummary(server)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <div className="flex items-center gap-0.5 opacity-85 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`检测 ${server.name} 连接`}
                                  disabled={testingKeys.has(`${activeEngine.id}:${server.name}`)}
                                  onClick={() => void runTestServer(activeEngine.id, server.name)}
                                >
                                  <ActivityIcon
                                    className={cn(
                                      "size-3.5",
                                      testingKeys.has(`${activeEngine.id}:${server.name}`) &&
                                        "animate-pulse",
                                    )}
                                  />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">测试此引擎下的连接状态</TooltipPopup>
                          </Tooltip>

                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="同步到其他引擎"
                                  disabled={busyKey !== null}
                                  onClick={() =>
                                    void handleSync(activeEngine.id, server.name, otherEngines)
                                  }
                                >
                                  <ArrowLeftRightIcon className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">同步到其他 5 个引擎</TooltipPopup>
                          </Tooltip>

                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`编辑 ${server.name}`}
                            onClick={() => {
                              setEditorError(null);
                              setEditor(createEditEditor(server, activeEngine.id, [activeEngine.id]));
                            }}
                          >
                            <PencilIcon className="size-3.5" />
                          </Button>

                          <Button
                            size="icon-xs"
                            variant="ghost-destructive"
                            aria-label={`删除 ${server.name}`}
                            onClick={() =>
                              setDeleteDialog({
                                name: server.name,
                                availableEngines: [activeEngine.id],
                                selectedEngines: [activeEngine.id],
                              })
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>

                        <Switch
                          size="sm"
                          checked={server.enabled}
                          disabled={isBusy || busyKey !== null}
                          onCheckedChange={(checked) =>
                            void handleToggle(activeEngine.id, server.name, checked)
                          }
                          className="ml-1.5"
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </SettingsSection>
          )}
        </div>
      )}

      {/* Subtle safety footnote */}
      <p className="text-[11px] text-muted-foreground/70">
        首次修改任意引擎配置前会自动留存 <code className="font-mono">.vela.bak</code> 备份；敏感凭据在界面脱敏显示并在编辑或跨引擎同步时自动保留。
      </p>

      {/* Add / Edit Dialog */}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setEditor(null);
            setEditorError(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          {editor && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editor.mode === "create" ? "添加 MCP 服务" : `编辑 ${editor.originalName}`}
                </DialogTitle>
                <DialogDescription>
                  按各引擎规范（JSON / TOML）同步写入本地配置文件。
                </DialogDescription>
              </DialogHeader>

              <DialogPanel className="max-h-[65vh] space-y-4">
                {editorError && (
                  <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs text-destructive">
                    <AlertCircleIcon className="size-3.5 shrink-0" />
                    <span>{editorError}</span>
                  </div>
                )}

                {editor.divergentEngines.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning-surface/50 px-3 py-2 text-xs text-foreground">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>
                      {formatCrossEngineWarning(
                        editor.crossEngineParity === "equivalent" ? "different" : editor.crossEngineParity,
                        editor.divergentEngines.map((id) => engineLabelById.get(id) ?? id).join("、"),
                        engineLabelById.get(editor.primaryEngineId ?? "codex") ?? "当前载入引擎",
                        engineLabelById.get(editor.primaryEngineId ?? "codex") ?? "主引擎",
                      )}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">服务名称</label>
                    <Input
                      font="mono"
                      size="compact"
                      placeholder="github / lanhu / docmesh"
                      value={editor.name}
                      onChange={(event) =>
                        setEditor((prev) => (prev ? { ...prev, name: event.target.value } : null))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">传输协议</label>
                    <ToggleGroup
                      value={[editor.transport]}
                      onValueChange={(next) => {
                        const first = next[0];
                        if (first === "stdio" || first === "http") {
                          setEditor((prev) => (prev ? { ...prev, transport: first } : null));
                        }
                      }}
                      className="w-full"
                    >
                      <Toggle value="stdio" className="flex-1">
                        stdio
                      </Toggle>
                      <Toggle value="http" className="flex-1">
                        HTTP
                      </Toggle>
                    </ToggleGroup>
                  </div>
                </div>

                {editor.transport === "stdio" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">启动命令</label>
                      <Input
                        font="mono"
                        size="compact"
                        placeholder="npx / uvx / node / 可执行文件路径"
                        value={editor.command}
                        onChange={(event) =>
                          setEditor((prev) =>
                            prev ? { ...prev, command: event.target.value } : null,
                          )
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">
                        参数列表（每行一个）
                      </label>
                      <textarea
                        rows={3}
                        placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                        value={editor.argsText}
                        onChange={(event) =>
                          setEditor((prev) =>
                            prev ? { ...prev, argsText: event.target.value } : null,
                          )
                        }
                        className="w-full rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 dark:bg-input/32"
                      />
                    </div>

                    <KeyValueEditor
                      label="环境变量"
                      hint="保留 •••••••• 即维持原值"
                      pairs={editor.envPairs}
                      keyPlaceholder="API_KEY"
                      valuePlaceholder="值"
                      onChange={(nextPairs) =>
                        setEditor((prev) => (prev ? { ...prev, envPairs: nextPairs } : null))
                      }
                    />
                  </>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">服务地址 (URL)</label>
                      <Input
                        font="mono"
                        size="compact"
                        placeholder="https://api.githubcopilot.com/mcp/"
                        value={editor.url}
                        onChange={(event) =>
                          setEditor((prev) => (prev ? { ...prev, url: event.target.value } : null))
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">
                        Bearer Token 环境变量名（可选）
                      </label>
                      <Input
                        font="mono"
                        size="compact"
                        placeholder="CODEX_GITHUB_PERSONAL_ACCESS_TOKEN"
                        value={editor.bearerTokenEnvVar}
                        onChange={(event) =>
                          setEditor((prev) =>
                            prev ? { ...prev, bearerTokenEnvVar: event.target.value } : null,
                          )
                        }
                      />
                    </div>

                    <KeyValueEditor
                      label="请求头"
                      hint="保留 •••••••• 即维持原值"
                      pairs={editor.headerPairs}
                      keyPlaceholder="Authorization"
                      valuePlaceholder="Bearer ..."
                      onChange={(nextPairs) =>
                        setEditor((prev) => (prev ? { ...prev, headerPairs: nextPairs } : null))
                      }
                    />
                  </>
                )}

                <div className="space-y-2 border-t border-border/60 pt-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">目标引擎</label>
                    <button
                      type="button"
                      onClick={() =>
                        setEditor((prev) =>
                          prev
                            ? {
                                ...prev,
                                targets:
                                  prev.targets.length === ALL_ENGINE_IDS.length
                                    ? [...existingEngineIds]
                                    : [...ALL_ENGINE_IDS],
                              }
                            : null,
                        )
                      }
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {editor.targets.length === ALL_ENGINE_IDS.length ? "仅已安装" : "全选"}
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {engines.map((engine) => {
                      const active = editor.targets.includes(engine.id);
                      return (
                        <button
                          key={engine.id}
                          type="button"
                          onClick={() =>
                            setEditor((prev) => {
                              if (!prev) return null;
                              const nextTargets = prev.targets.includes(engine.id)
                                ? prev.targets.filter((id) => id !== engine.id)
                                : [...prev.targets, engine.id];
                              return { ...prev, targets: nextTargets };
                            })
                          }
                          className={cn(
                            "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                            active
                              ? "border-foreground bg-foreground text-background"
                              : "border-input bg-background text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {active && <CheckIcon className="size-3" />}
                          {engine.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </DialogPanel>

              <DialogFooter>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setEditor(null);
                    setEditorError(null);
                  }}
                >
                  取消
                </Button>
                <Button size="sm" disabled={saving} onClick={() => void handleSaveEditor()}>
                  {saving ? "保存中..." : "保存"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>

      {/* Quick Auth Dialog (OAuth 2.1 + Token/Env) */}
      <Dialog
        open={authDialog !== null}
        onOpenChange={(open) => {
          if (!open && !authSaving) setAuthDialog(null);
        }}
      >
        <DialogPopup className="max-w-md">
          {authDialog && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <KeyRoundIcon className="size-4 text-muted-foreground" />
                  <span>快捷认证：{authDialog.name}</span>
                </DialogTitle>
                <DialogDescription className="truncate font-mono text-xs">
                  {authDialog.url || authDialog.reason}
                </DialogDescription>
              </DialogHeader>

              <DialogPanel className="space-y-4">
                {authDialog.error && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs text-destructive">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span>{authDialog.error}</span>
                  </div>
                )}

                <ToggleGroup
                  value={[authDialog.tab]}
                  onValueChange={(next) => {
                    const first = next[0];
                    if (first === "oauth" || first === "token") {
                      setAuthDialog((prev) =>
                        prev ? { ...prev, tab: first, error: undefined } : null,
                      );
                    }
                  }}
                  className="w-full"
                >
                  <Toggle value="oauth" className="flex-1">
                    浏览器 OAuth 授权
                  </Toggle>
                  <Toggle value="token" className="flex-1">
                    填入 Token / 环境变量
                  </Toggle>
                </ToggleGroup>

                {authDialog.tab === "oauth" ? (
                  <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      将通过标准 MCP OAuth 2.1 (PKCE) 在系统浏览器中打开授权页面；完成登录后，Vela
                      会自动接收回调并把凭据同步写入下方选中的引擎配置。
                    </p>

                    {authDialog.oauthStatus === "pending" && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs">
                        <span className="flex items-center gap-2 text-foreground">
                          <RefreshCwIcon className="size-3.5 animate-spin text-muted-foreground" />
                          等待浏览器完成授权...
                        </span>
                        {authDialog.oauthUrl && (
                          <button
                            type="button"
                            onClick={() => openExternalBrowser(authDialog.oauthUrl!)}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            重新打开
                            <ExternalLinkIcon className="size-3" />
                          </button>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
                      <span>若服务端限制第三方注册（如 Figma），可改用 Codex 原生 CLI 登录：</span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={authSaving}
                        onClick={async () => {
                          setAuthSaving(true);
                          setAuthDialog((prev) => (prev ? { ...prev, error: undefined } : null));
                          try {
                            const res = await fetchMcpApi<{ ok: boolean; message: string }>(
                              "/api/vela/mcp/auth/codex-login",
                              {
                                method: "POST",
                                body: JSON.stringify({ name: authDialog.name }),
                              },
                            );
                            toastManager.add({
                              type: "success",
                              title: res.message,
                            });
                          } catch (err) {
                            setAuthDialog((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    error: err instanceof Error ? err.message : String(err),
                                  }
                                : null,
                            );
                          } finally {
                            setAuthSaving(false);
                          }
                        }}
                      >
                        Codex CLI 登录
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          ["bearer_token", "Bearer Token"],
                          ["api_key_header", "自定义请求头"],
                          ["env_var", "环境变量"],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            setAuthDialog((prev) =>
                              prev ? { ...prev, tokenMode: mode, error: undefined } : null,
                            )
                          }
                          className={cn(
                            "rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                            authDialog.tokenMode === mode
                              ? "border-foreground bg-foreground text-background"
                              : "border-input bg-background text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {authDialog.tokenMode === "env_var" ? (
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">环境变量名</label>
                        <Input
                          font="mono"
                          size="compact"
                          placeholder="例如：CODEX_GITHUB_PERSONAL_ACCESS_TOKEN"
                          value={authDialog.envVarName}
                          onChange={(event) =>
                            setAuthDialog((prev) =>
                              prev ? { ...prev, envVarName: event.target.value } : null,
                            )
                          }
                        />
                      </div>
                    ) : (
                      <>
                        {authDialog.tokenMode === "api_key_header" && (
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-foreground">请求头名称</label>
                            <Input
                              font="mono"
                              size="compact"
                              placeholder="X-API-Key"
                              value={authDialog.headerName}
                              onChange={(event) =>
                                setAuthDialog((prev) =>
                                  prev ? { ...prev, headerName: event.target.value } : null,
                                )
                              }
                            />
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-foreground">
                            {authDialog.tokenMode === "bearer_token" ? "Access Token" : "请求头值"}
                          </label>
                          <Input
                            font="mono"
                            size="compact"
                            type="password"
                            placeholder="粘贴 Token 或密钥..."
                            value={authDialog.tokenValue}
                            onChange={(event) =>
                              setAuthDialog((prev) =>
                                prev ? { ...prev, tokenValue: event.target.value } : null,
                              )
                            }
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Target Engines */}
                <div className="space-y-2 border-t border-border/60 pt-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">同步写入目标引擎</label>
                    <button
                      type="button"
                      onClick={() =>
                        setAuthDialog((prev) =>
                          prev
                            ? {
                                ...prev,
                                targetEngineIds:
                                  prev.targetEngineIds.length === ALL_ENGINE_IDS.length
                                    ? [prev.sourceEngineId]
                                    : [...ALL_ENGINE_IDS],
                              }
                            : null,
                        )
                      }
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {authDialog.targetEngineIds.length === ALL_ENGINE_IDS.length
                        ? "仅当前引擎"
                        : "全选 6 个引擎"}
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {engines.map((engine) => {
                      const active = authDialog.targetEngineIds.includes(engine.id);
                      return (
                        <button
                          key={engine.id}
                          type="button"
                          onClick={() =>
                            setAuthDialog((prev) => {
                              if (!prev) return null;
                              const next = prev.targetEngineIds.includes(engine.id)
                                ? prev.targetEngineIds.filter((id) => id !== engine.id)
                                : [...prev.targetEngineIds, engine.id];
                              return { ...prev, targetEngineIds: next };
                            })
                          }
                          className={cn(
                            "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                            active
                              ? "border-foreground bg-foreground text-background"
                              : "border-input bg-background text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {active && <CheckIcon className="size-3" />}
                          {engine.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </DialogPanel>

              <DialogFooter>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={authSaving}
                  onClick={() => setAuthDialog(null)}
                >
                  取消
                </Button>
                {authDialog.tab === "oauth" ? (
                  <Button
                    size="sm"
                    disabled={
                      authDialog.oauthStatus === "starting" ||
                      authDialog.targetEngineIds.length === 0
                    }
                    onClick={() => void handleStartOAuth()}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    {authDialog.oauthStatus === "starting"
                      ? "准备授权中..."
                      : authDialog.oauthStatus === "pending"
                        ? "重新发起授权"
                        : "打开浏览器授权"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={authSaving || authDialog.targetEngineIds.length === 0}
                    onClick={() => void handleSaveQuickToken()}
                  >
                    {authSaving ? "保存中..." : "保存并测试"}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open && busyKey === null) setDeleteDialog(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          {deleteDialog && (
            <>
              <DialogHeader>
                <DialogTitle>移除 {deleteDialog.name}</DialogTitle>
                <DialogDescription>选择要从中移除该 MCP 配置的引擎。</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="grid grid-cols-2 gap-1.5">
                  {deleteDialog.availableEngines.map((engineId) => {
                    const selected = deleteDialog.selectedEngines.includes(engineId);
                    return (
                      <button
                        key={engineId}
                        type="button"
                        onClick={() =>
                          setDeleteDialog((prev) => {
                            if (!prev) return null;
                            const next = prev.selectedEngines.includes(engineId)
                              ? prev.selectedEngines.filter((id) => id !== engineId)
                              : [...prev.selectedEngines, engineId];
                            return { ...prev, selectedEngines: next };
                          })
                        }
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                          selected
                            ? "border-destructive bg-destructive text-white"
                            : "border-input bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {selected && <CheckIcon className="size-3" />}
                        {engineLabelById.get(engineId) ?? engineId}
                      </button>
                    );
                  })}
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() => setDeleteDialog(null)}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyKey !== null || deleteDialog.selectedEngines.length === 0}
                  onClick={() => void handleConfirmDelete()}
                >
                  {busyKey !== null ? "删除中..." : `删除 (${deleteDialog.selectedEngines.length})`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}

function McpHealthBadge({
  testing,
  result,
  prefixLabel,
  onQuickAuth,
}: {
  testing: boolean;
  result?: McpTestResult | undefined;
  prefixLabel?: string | undefined;
  onQuickAuth?: (() => void) | undefined;
}) {
  if (testing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <RefreshCwIcon className="size-2.5 animate-spin" />
        检测中
      </span>
    );
  }
  if (!result) return null;

  const isAuthActionable = result.status === "auth_required" && onQuickAuth !== undefined;

  const rawLabel =
    result.status === "connected"
      ? result.toolCount !== undefined
        ? `${result.toolCount} 工具 · ${result.latencyMs}ms`
        : `已连通 · ${result.latencyMs}ms`
      : isAuthActionable
        ? "去认证"
        : result.status === "auth_required"
          ? "需认证"
          : "连接失败";
  const label = prefixLabel ? `${prefixLabel} · ${rawLabel}` : rawLabel;

  const dotClass =
    result.status === "connected"
      ? "bg-success"
      : result.status === "auth_required"
        ? "bg-warning"
        : "bg-destructive";

  const textClass =
    result.status === "connected"
      ? "text-muted-foreground"
      : result.status === "auth_required"
        ? "text-warning"
        : "text-destructive";

  const detailLines: string[] = [];
  if (result.serverName) {
    detailLines.push(
      `服务：${result.serverName}${result.serverVersion ? ` v${result.serverVersion}` : ""}`,
    );
  }
  detailLines.push(result.message);
  if (isAuthActionable) {
    detailLines.push("点击打开快捷认证（支持浏览器 OAuth 或填入 Token）");
  }
  if (result.sampleTools && result.sampleTools.length > 0) {
    const suffix =
      result.toolCount && result.toolCount > result.sampleTools.length
        ? ` 等 ${result.toolCount} 个`
        : "";
    detailLines.push(`工具：${result.sampleTools.slice(0, 5).join(", ")}${suffix}`);
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isAuthActionable ? (
            <button
              type="button"
              onClick={onQuickAuth}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-warning/35 bg-warning-surface/60 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:border-warning/60 hover:bg-warning-surface"
            >
              <span className={cn("size-1.5 rounded-full", dotClass)} />
              {label}
            </button>
          ) : (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-normal tabular-nums",
                textClass,
              )}
            >
              <span className={cn("size-1.5 rounded-full", dotClass)} />
              {label}
            </span>
          )
        }
      />
      <TooltipPopup side="top" className="max-w-xs whitespace-pre-line text-left">
        {detailLines.join("\n")}
      </TooltipPopup>
    </Tooltip>
  );
}

function KeyValueEditor({
  label,
  hint,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  hint: string;
  pairs: ReadonlyArray<KeyValuePair>;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (next: KeyValuePair[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => onChange([...pairs, { id: nextKvId(), key: "", value: "" }])}
        >
          <PlusIcon className="size-3" />
          添加
        </Button>
      </div>

      {pairs.length > 0 && (
        <div className="space-y-1.5">
          {pairs.map((pair) => (
            <div key={pair.id} className="flex items-center gap-1.5">
              <Input
                font="mono"
                size="compact"
                placeholder={keyPlaceholder}
                value={pair.key}
                onChange={(event) =>
                  onChange(
                    pairs.map((item) =>
                      item.id === pair.id ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
                className="w-2/5"
              />
              <Input
                font="mono"
                size="compact"
                placeholder={valuePlaceholder}
                value={pair.value}
                onChange={(event) =>
                  onChange(
                    pairs.map((item) =>
                      item.id === pair.id ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
                className="flex-1"
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="移除"
                onClick={() => onChange(pairs.filter((item) => item.id !== pair.id))}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
