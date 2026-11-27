import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState, useId } from "react";
import { findRevealRef } from "./markdownFindContext";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon, LayersIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import {
  fetchDispatchApi,
  refreshDispatchState,
  requestFocusDispatchStep,
  useVelaDispatchState,
} from "~/state/velaDispatch";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  findActive = false,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  findActive?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [lastSavePath, setLastSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [isTurningIntoDispatch, setIsTurningIntoDispatch] = useState(false);
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const { state: dispatchState } = useVelaDispatchState(
    workspaceRoot,
    threadRef?.threadId,
    environmentId,
  );
  const linkedCollab = dispatchState?.collab ?? null;
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "plan",
      unavailableMessage: msg("Clipboard API is unavailable while copying plan."),
      failureMessage: msg("Failed to copy plan to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy plan"),
          description:
            error instanceof Error ? error.message : gt("An error occurred while copying."),
        }),
      );
    },
  });
  const title = proposedPlanTitle(planMarkdown) ?? gt("Proposed plan");
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 }, messages)
    : null;
  const isCollapsed = canCollapse && !expanded;
  // Mount clipped plans during find to count hidden matches without revealing them.
  const showPreview = isCollapsed && !findActive;
  const revealRef = findRevealRef(() => setExpanded(true));
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const handleTurnIntoDispatchPlan = async () => {
    if (!workspaceRoot || !threadRef || isTurningIntoDispatch) return;
    setIsTurningIntoDispatch(true);
    try {
      await fetchDispatchApi<{ ok: true }>(
        "/api/vela/dispatch/kickoff",
        {
          method: "POST",
          body: JSON.stringify({
            projectRoot: workspaceRoot,
            threadId: threadRef.threadId,
            requirement: planMarkdown,
            mode: "fast",
          }),
        },
        undefined,
        environmentId,
      );
      void refreshDispatchState(workspaceRoot, threadRef.threadId, environmentId);
      toastManager.add({
        type: "success",
        // oxlint-disable-next-line t3code/no-untranslated-copy -- Vela collaboration UI uses curated Chinese copy
        title: "已开始拆分并行任务",
      });
    } catch (err) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          // oxlint-disable-next-line t3code/no-untranslated-copy -- Vela collaboration UI uses curated Chinese copy
          title: "拆分并行任务失败",
          description: err instanceof Error ? err.message : gt("An error occurred while dispatching."),
        }),
      );
    } finally {
      setIsTurningIntoDispatch(false);
    }
  };

  const openSaveDialog = () => {
    if (!canWriteFiles) return;
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Workspace path is unavailable"),
          description: gt("This thread does not have a workspace path to save into."),
        }),
      );
      return;
    }
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = (savePath: string) => {
    const relativePath = savePath.trim();
    if (!workspaceRoot || !readEnvironmentScope(environmentId, AuthFilesystemWriteScope)) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: gt("Enter a workspace path"),
      });
      return;
    }

    setLastSavePath(savePath);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: gt("Plan saved to workspace"),
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not save plan"),
            description:
              error instanceof Error ? error.message : gt("An error occurred while saving."),
          }),
        );
      }
    })();
  };

  if (linkedCollab && !sourceExpanded && !findActive) {
    /* oxlint-disable t3code/no-untranslated-copy -- Vela collaboration UI uses curated Chinese copy */
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/45 bg-card/35 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">计划</Badge>
          <span className="truncate text-sm font-medium text-foreground/80">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            · 已拆分为 {linkedCollab.stepCount} 步
          </span>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setSourceExpanded(true)}>
          展开
        </Button>
      </div>
    );
    /* oxlint-enable t3code/no-untranslated-copy */
  }

  return (
    <div className="rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{gt("Plan", { $context: "badge, noun" })}</Badge>
          {}
          <h3 data-thread-find-text="true" className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {linkedCollab && threadRef ? (
            /* oxlint-disable t3code/no-untranslated-copy -- Vela collaboration UI uses curated Chinese copy */
            <>
              <button
                type="button"
                onClick={() => requestFocusDispatchStep(threadRef.threadId, "__plan__")}
                className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                已生成并行任务
              </button>
              <Button size="xs" variant="ghost" onClick={() => setSourceExpanded(false)}>
                收起
              </Button>
            </>
            /* oxlint-enable t3code/no-untranslated-copy */
          ) : workspaceRoot && threadRef ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isTurningIntoDispatch}
              onClick={() => void handleTurnIntoDispatchPlan()}
            >
              <LayersIcon aria-hidden="true" className="size-3.5" />
              {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Vela collaboration UI uses curated Chinese copy */}
              {isTurningIntoDispatch ? "正在拆分…" : "并行执行"}
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button aria-label={gt("Plan actions")} size="icon-xs" variant="outline" />}
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={handleCopyPlan}>
                {isCopied ? gt("Copied!") : gt("Copy to clipboard")}
              </MenuItem>
              <MenuItem onClick={handleDownload}>
                <T>Download as markdown</T>
              </MenuItem>
              <MenuItem
                onClick={openSaveDialog}
                disabled={!canWriteFiles || !workspaceRoot || isSavingToWorkspace}
              >
                <T>Save to workspace</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="mt-4">
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
        >
          {showPreview ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          )}
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? gt("Collapse plan") : gt("Expand plan")}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <SavePlanToWorkspaceForm
            initialPath={lastSavePath || downloadFilename}
            placeholder={downloadFilename}
            workspaceRoot={workspaceRoot}
            canWriteFiles={canWriteFiles}
            saving={isSavingToWorkspace}
            onCancel={() => setIsSaveDialogOpen(false)}
            onSave={handleSaveToWorkspace}
          />
        </DialogPopup>
      </Dialog>
    </div>
  );
});

function SavePlanToWorkspaceForm({
  initialPath,
  placeholder,
  workspaceRoot,
  canWriteFiles,
  saving,
  onCancel,
  onSave,
}: {
  initialPath: string;
  placeholder: string;
  workspaceRoot: string | undefined;
  canWriteFiles: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (path: string) => void;
}) {
  const gt = useGT();
  const [savePath, setSavePath] = useState(initialPath);
  const savePathInputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Save plan to workspace</T>
        </DialogTitle>
        <DialogDescription>
          {workspaceRoot !== undefined ? (
            <T>
              Enter a path relative to{" "}
              <code>
                <Var>{workspaceRoot}</Var>
              </code>
              .
            </T>
          ) : (
            <T>
              Enter a path relative to <code>the workspace</code>.
            </T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label htmlFor={savePathInputId} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Workspace path</T>
          </span>
          <Input
            id={savePathInputId}
            value={savePath}
            onChange={(event) => setSavePath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={saving}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          <T>Cancel</T>
        </Button>
        <Button size="sm" onClick={() => onSave(savePath)} disabled={!canWriteFiles || saving}>
          {saving ? gt("Saving...") : gt("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}
