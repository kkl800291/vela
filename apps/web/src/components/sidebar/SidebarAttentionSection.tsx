/* oxlint-disable t3code/no-untranslated-copy -- Vela attention inbox keeps inline Chinese copy without modifying i18n catalogs */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  GitForkIcon,
  MessageSquareIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { requestFocusDispatchStep, useVelaDispatchAttention } from "~/state/velaDispatch";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { collabAttentionLabel } from "../chat/dispatch/dispatchModel";

interface NormalizedAttentionEntry {
  readonly id: string;
  readonly source: "dispatch" | "thread";
  readonly kind: "escalation" | "decision" | "accept" | "approval" | "input" | "request";
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly stepId?: string | undefined;
  readonly title: string;
  readonly label?: string | undefined;
  readonly projectLabel: string;
  readonly detail: string;
  readonly updatedAtMs: number;
}

function projectBasename(projectRoot: string): string {
  const parts = projectRoot.split(/[/\\]+/).filter(Boolean);
  return parts.at(-1) ?? projectRoot;
}

function renderAttentionGlyph(kind: NormalizedAttentionEntry["kind"]) {
  switch (kind) {
    case "escalation":
    case "approval":
      return <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />;
    case "decision":
      return <GitForkIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />;
    case "accept":
      return <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-foreground" />;
    case "input":
    case "request":
      return <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-sidebar-foreground/85" />;
  }
}

export function SidebarAttentionSection({
  connectedEnvironmentIds,
  threads,
  projectDisplayNameByKey,
  activeThreadKey,
  onSelectThread,
}: {
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly activeThreadKey: string | null;
  readonly onSelectThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const dispatchItems = useVelaDispatchAttention(connectedEnvironmentIds);

  const activeThreadByKey = new Map<string, EnvironmentThreadShell>();
  const archivedThreadKeys = new Set<string>();
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (thread.archivedAt !== null) {
      archivedThreadKeys.add(key);
    } else {
      activeThreadByKey.set(key, thread);
    }
  }

  const entries: NormalizedAttentionEntry[] = [];

  for (const item of dispatchItems) {
    if (item.engineVersion === 2) continue;
    if (!item.threadId) continue;
    const ref = scopeThreadRef(item.environmentId, ThreadId.make(item.threadId));
    const key = scopedThreadKey(ref);
    if (archivedThreadKeys.has(key)) continue;

    const matchedThread = activeThreadByKey.get(key);
    const collabLabel = collabAttentionLabel(item);
    const projectLabel =
      (matchedThread
        ? projectDisplayNameByKey.get(`${matchedThread.environmentId}:${matchedThread.projectId}`)
        : undefined) ?? projectBasename(item.projectRoot);

    const kindVerb =
      item.kind === "accept" ? "等你验收" : item.kind === "decision" ? "等你拍板" : "需要你拍板";
    const blockedText =
      item.blockedStepTitles.length > 0
        ? `卡住后续：${item.blockedStepTitles[0]}${
            item.blockedStepTitles.length > 1 ? ` 等 ${item.blockedStepTitles.length} 步` : ""
          }`
        : "";

    entries.push({
      id: `dispatch:${item.environmentId}:${item.id}`,
      source: "dispatch",
      kind: item.kind,
      threadRef: ref,
      threadKey: key,
      stepId: item.stepId,
      title: collabLabel ? item.stepTitle : `${item.stepId} ${item.stepTitle} · ${kindVerb}`,
      label: collabLabel,
      projectLabel,
      detail: blockedText || item.summary,
      updatedAtMs: Date.parse(item.updatedAt) || 0,
    });
  }

  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status !== "approval" && status !== "input" && status !== "request") {
      continue;
    }

    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(ref);
    const projectLabel =
      projectDisplayNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? "";
    const detail =
      status === "approval"
        ? "等待你授权命令执行"
        : status === "input"
          ? "等待你回答后继续"
          : "有新消息待处理";

    entries.push({
      id: `thread:${key}`,
      source: "thread",
      kind: status,
      threadRef: ref,
      threadKey: key,
      title: thread.title || "未命名会话",
      projectLabel,
      detail,
      updatedAtMs: Date.parse(thread.updatedAt) || 0,
    });
  }

  if (entries.length === 0) {
    return null;
  }

  const orderedEntries = entries.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);

  return (
    <div className="mb-2.5 rounded-xl border border-sidebar-border/80 bg-muted/25 p-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-sidebar-row-hover"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-sidebar-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-warning" />
          <span className="truncate">需要你处理</span>
          <span className="font-mono text-2xs text-sidebar-muted-foreground tabular-nums">
            · {orderedEntries.length}
          </span>
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-200 ease-drawer",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <ul className="mt-1 max-h-52 space-y-0.5 overflow-y-auto pr-0.5">
          {orderedEntries.map((entry) => {
            const isActive = entry.threadKey === activeThreadKey;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectThread(entry.threadRef);
                    if (entry.source === "dispatch" && entry.stepId) {
                      requestFocusDispatchStep(entry.threadRef.threadId, entry.stepId);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-row-hover",
                    isActive && "bg-sidebar-row-hover text-sidebar-foreground",
                  )}
                >
                  {renderAttentionGlyph(entry.kind)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-sidebar-foreground">
                      {entry.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-sidebar-muted-foreground">
                      {entry.projectLabel && (
                        <span className="max-w-20 shrink-0 truncate font-medium text-sidebar-foreground/75">
                          {entry.projectLabel}
                        </span>
                      )}
                      {entry.projectLabel && entry.detail && <span className="opacity-45">·</span>}
                      {entry.label ? (
                        <Badge variant="outline" size="sm" className="min-w-0">
                          <span className="truncate">{entry.label}</span>
                        </Badge>
                      ) : (
                        <span className="min-w-0 truncate">{entry.detail}</span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
