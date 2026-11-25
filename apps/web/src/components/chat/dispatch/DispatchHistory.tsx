/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  HistoryIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import type { DispatchArchivedPlan } from "~/state/velaDispatch";
import { KIND_META, resolveStepKind, STATUS_LABEL } from "./dispatchModel";

function formatArchivedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function DispatchHistory({
  workspaceRoot,
  history,
  busyKey,
  onOpenThread,
  onDeleteArchive,
}: {
  readonly workspaceRoot: string;
  readonly history: ReadonlyArray<DispatchArchivedPlan>;
  readonly busyKey: string | null;
  readonly onOpenThread: (threadId: string) => void;
  readonly onDeleteArchive: (archiveId: string) => void;
}) {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [expandedArchives, setExpandedArchives] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedReports, setExpandedReports] = useState<ReadonlySet<string>>(() => new Set());

  if (history.length === 0) {
    return null;
  }

  const orderedHistory = [...history].toSorted(
    (a, b) => (Date.parse(b.archivedAt) || 0) - (Date.parse(a.archivedAt) || 0),
  );

  const toggleArchive = (archiveId: string) => {
    setExpandedArchives((prev) => {
      const next = new Set(prev);
      if (next.has(archiveId)) next.delete(archiveId);
      else next.add(archiveId);
      return next;
    });
  };

  const toggleReport = (reportKey: string) => {
    setExpandedReports((prev) => {
      const next = new Set(prev);
      if (next.has(reportKey)) next.delete(reportKey);
      else next.add(reportKey);
      return next;
    });
  };

  return (
    <div className="border-t border-border/45">
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 ease-drawer",
            sectionOpen && "rotate-90",
          )}
        />
        <HistoryIcon className="size-3.5 shrink-0" />
        <span>历史计划（{history.length}）</span>
      </button>

      <Collapsible open={sectionOpen}>
        <CollapsiblePanel>
          <div className="space-y-2.5 px-3.5 pb-3.5">
          {orderedHistory.map((item) => {
            const isExpanded = expandedArchives.has(item.id);
            const doneCount = item.steps.filter((s) => s.status === "done").length;
            const reqText = item.requirement?.summary?.trim() || item.requirement?.userInput?.trim();
            const isDeleting = busyKey === `delete-history:${item.id}`;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-border/65 bg-card/40 transition-colors"
              >
                <div className="flex items-start gap-2 px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => toggleArchive(item.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-start gap-1.5">
                      <ChevronRightIcon
                        className={cn(
                          "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-drawer",
                          isExpanded && "rotate-90",
                        )}
                      />
                      <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground line-clamp-2">
                        {item.planTitle || "未命名计划"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">
                        {doneCount}/{item.steps.length} 完成
                      </span>
                      <span>·</span>
                      <span>{item.mode === "strict" ? "先核查再拆" : "快速拆单"}</span>
                      <span>·</span>
                      <span>{formatArchivedTime(item.archivedAt)}</span>
                    </div>
                  </button>

                  <Button
                    size="sm"
                    variant="ghost-destructive"
                    aria-label={`删除历史计划 ${item.planTitle}`}
                    disabled={busyKey !== null}
                    onClick={() => onDeleteArchive(item.id)}
                    className="shrink-0"
                  >
                    <Trash2Icon className="size-3.5" />
                    {isDeleting ? "删除中" : "删除"}
                  </Button>
                </div>

                <Collapsible open={isExpanded}>
                  <CollapsiblePanel>
                    <div className="space-y-3 border-t border-border/50 px-3.5 py-3">
                    {reqText && (
                      <div className="space-y-1 border-l-2 border-foreground/15 pl-3">
                        <div className="text-xs font-medium text-muted-foreground">需求摘要</div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                          {reqText}
                        </p>
                      </div>
                    )}

                    <div className="space-y-2">
                      {item.steps.map((step) => {
                        const run = item.runs[step.id];
                        const kind = resolveStepKind(step);
                        const reportKey = `${item.id}:${step.id}`;
                        const reportOpen = expandedReports.has(reportKey);
                        const changedFiles = run?.diffSummary?.changedFiles ?? [];
                        const isFailed =
                          step.status === "premise_failed" ||
                          step.status === "boundary_violation" ||
                          step.status === "hard_gate_failed";

                        return (
                          <div
                            key={step.id}
                            className="space-y-2 rounded-lg border border-border/55 bg-background/60 p-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex min-w-0 flex-1 items-start gap-2">
                                {step.status === "done" ? (
                                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-foreground" />
                                ) : isFailed ? (
                                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                                ) : (
                                  <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                )}
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-mono text-xs text-muted-foreground">
                                      {step.id}
                                    </span>
                                    <Badge variant="secondary">
                                      {KIND_META[kind].label}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">
                                      {STATUS_LABEL[step.status]}
                                    </span>
                                  </div>
                                  <div className="text-sm font-medium leading-snug text-foreground">
                                    {step.title}
                                  </div>
                                </div>
                              </div>

                              {run?.childThreadId && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => onOpenThread(run.childThreadId!)}
                                >
                                  <ExternalLinkIcon className="size-3.5" />
                                  打开代理页
                                </Button>
                              )}
                            </div>

                            {run?.deliverable?.text && (
                              <div className="space-y-2">
                                <Button
                                  size="sm"
                                  variant="ghost-muted"
                                  onClick={() => toggleReport(reportKey)}
                                >
                                  <ChevronRightIcon
                                    className={cn(
                                      "size-3.5 transition-transform duration-200 ease-drawer",
                                      reportOpen && "rotate-90",
                                    )}
                                  />
                                  {reportOpen ? "收起交付报告" : "查看交付报告"}
                                </Button>
                                <Collapsible open={reportOpen}>
                                  <CollapsiblePanel>
                                    <div className="max-h-72 overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-3">
                                      <ChatMarkdown cwd={workspaceRoot} text={run.deliverable.text} />
                                    </div>
                                  </CollapsiblePanel>
                                </Collapsible>
                              </div>
                            )}

                            {changedFiles.length > 0 && (
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-muted-foreground">
                                  改动文件（{changedFiles.length}）
                                </div>
                                <div className="space-y-1">
                                  {changedFiles.map((file) => (
                                    <div
                                      key={file}
                                      className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
                                    >
                                      <FileCode2Icon className="size-3.5 shrink-0 opacity-70" />
                                      <span className="truncate">{file}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </div>
            );
          })}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
