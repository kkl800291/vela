// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as itEffect } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  applyWorktreeDeltaToWorkspace,
  auditPathBoundaries,
  captureWorkspaceSnapshot,
  inspectWorkspaceDelta,
  revertWorkspaceToSnapshot,
  runHardGates,
} from "./VelaDispatchGit.ts";
import {
  parseExecutorQuestion,
  parsePremiseFailure,
  parseReviewVerdict,
} from "./VelaDispatchPrompts.ts";
import {
  VelaDispatchService,
  normalizeAgentOptionSelections,
  partitionHardGates,
  summarizeLiveRunActivity,
  toModelSelection,
  layer as velaDispatchServiceLayer,
} from "./VelaDispatchService.ts";
import { VelaDispatchStore, unlockReadySteps } from "./VelaDispatchStore.ts";
import type { DispatchStepRun, DispatchTaskCard } from "./VelaDispatchTypes.ts";

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-test-"));
  tempDirs.push(dir);
  NodeChildProcess.execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "vela@test.local"], {
    cwd: dir,
    stdio: "ignore",
  });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Vela Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  NodeFS.mkdirSync(NodePath.join(dir, "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "src", "index.ts"), "export const v = 1;\n");
  NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function createTempStateDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VelaDispatchGit", () => {
  it("captures invisible snapshot, computes incremental delta, and reverts cleanly without touching real git index", async () => {
    const repo = createTempGitRepo();
    // Simulate pre-existing uncommitted edit from an earlier step.
    NodeFS.writeFileSync(NodePath.join(repo, "src", "existing.ts"), "export const prev = true;\n");

    const snap = await captureWorkspaceSnapshot(repo);
    expect(snap.isGitRepo).toBe(true);
    expect(snap.baselineTree).toBeTruthy();

    // Simulate changes made during this step + internal .vela metadata.
    NodeFS.writeFileSync(NodePath.join(repo, "src", "index.ts"), "export const v = 2;\n");
    NodeFS.writeFileSync(NodePath.join(repo, "src", "added.ts"), "export const added = 1;\n");
    NodeFS.mkdirSync(NodePath.join(repo, ".vela", "dispatch"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, ".vela", "dispatch", "state.json"), "{}");

    const delta = await inspectWorkspaceDelta(repo, snap.baselineTree);
    expect(delta.changedFiles).toEqual(["src/added.ts", "src/index.ts"]);
    expect(delta.patch).toContain("export const v = 2;");
    // Earlier uncommitted file and .vela metadata must NOT appear in this step's delta.
    expect(delta.changedFiles).not.toContain("src/existing.ts");
    expect(delta.changedFiles.some((f) => f.startsWith(".vela/"))).toBe(false);

    // One-click step revert restores index.ts, removes added.ts, preserves existing.ts & .vela/state.json!
    const reverted = await revertWorkspaceToSnapshot(repo, snap.baselineTree!);
    expect(reverted.restoredFiles).toEqual(["src/index.ts"]);
    expect(reverted.removedFiles).toEqual(["src/added.ts"]);
    expect(NodeFS.readFileSync(NodePath.join(repo, "src", "index.ts"), "utf8")).toBe(
      "export const v = 1;\n",
    );
    expect(NodeFS.existsSync(NodePath.join(repo, "src", "added.ts"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(repo, "src", "existing.ts"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(repo, ".vela", "dispatch", "state.json"))).toBe(true);
  });

  it("audits allowedGlobs, forbiddenGlobs, and sensitiveGlobs accurately", () => {
    const audit = auditPathBoundaries(
      ["apps/web/src/a.ts", "apps/server/src/b.ts", "apps/web/src/secret.key", ".vela/dispatch/state.json"],
      {
        allowedGlobs: ["apps/web/src/**"],
        forbiddenGlobs: ["apps/server/**"],
        sensitiveGlobs: ["**/*.key", ".env"],
      },
    );
    expect(audit.ok).toBe(false);
    expect(audit.outOfScopeFiles).toEqual(["apps/server/src/b.ts"]);
    expect(audit.forbiddenFiles).toEqual(["apps/server/src/b.ts"]);
    expect(audit.sensitiveFiles).toEqual(["apps/web/src/secret.key"]);
  });

  it("runs deterministic Hard Gates and stops at first failing command", async () => {
    const repo = createTempGitRepo();
    const okRes = await runHardGates(repo, ["echo gate-one", "echo gate-two"]);
    expect(okRes.ok).toBe(true);
    expect(okRes.results).toHaveLength(2);

    const failRes = await runHardGates(repo, ["echo ok", "exit 2", "echo skipped"]);
    expect(failRes.ok).toBe(false);
    expect(failRes.results).toHaveLength(2);
    expect(failRes.results[1]?.exitCode).toBe(2);
  });
});

describe("VelaDispatchPrompts parsers", () => {
  it("parses PREMISE_FAILED, NEED_DECISION, and independent review verdicts", () => {
    const premise = parsePremiseFailure(
      'Checking...\n```json\n{"status":"PREMISE_FAILED","failedPremises":[{"premise":"foo exists","actual":"foo missing"}]}\n```',
    );
    expect(premise?.failedPremises).toEqual([{ premise: "foo exists", actual: "foo missing" }]);

    const question = parseExecutorQuestion(
      '```json\n{"status":"NEED_DECISION","title":"Auth choice","question":"OAuth or token?","needsHuman":true,"options":[{"id":"A","label":"OAuth"}]}\n```',
    );
    expect(question?.needsHuman).toBe(true);
    expect(question?.options[0]?.label).toBe("OAuth");

    const verdict = parseReviewVerdict(
      '```json\n{"verdict":"fail","summary":"Missing null check","issues":[{"severity":"blocker","file":"src/a.ts","summary":"NPE"}]}\n```',
      { round: 1, reviewerThreadId: "thr-rev-1" },
    );
    expect(verdict.verdict).toBe("fail");
    expect(verdict.issues[0]?.severity).toBe("blocker");
    expect(verdict.reviewerThreadId).toBe("thr-rev-1");
  });
});

describe("VelaDispatchStore unlockReadySteps & persistence", () => {
  const makeCard = (
    id: string,
    order: number,
    status: DispatchTaskCard["status"],
    parallelGroup?: string,
  ): DispatchTaskCard => ({
    id,
    order,
    title: id,
    goal: id,
    isolation: parallelGroup ? "worktree" : "direct",
    parallelGroup,
    premisesToVerify: [],
    contextFiles: [],
    acceptanceCriteria: [],
    allowedGlobs: [],
    forbiddenGlobs: [],
    sensitiveGlobs: [],
    hardGates: [],
    executor: { providerInstanceId: "codex" },
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("unlocks single step sequentially and unlocks parallelGroup steps together", () => {
    const initial = [
      makeCard("S1", 1, "locked"),
      makeCard("S2", 2, "locked", "fe-be"),
      makeCard("S3", 3, "locked", "fe-be"),
      makeCard("S4", 4, "locked"),
    ];
    const afterStart = unlockReadySteps(initial);
    expect(afterStart.map((s) => s.status)).toEqual(["ready", "locked", "locked", "locked"]);

    // Complete S1 -> both S2 and S3 in parallelGroup "fe-be" unlock together; S4 stays locked.
    const afterS1 = unlockReadySteps(
      afterStart.map((s) => (s.id === "S1" ? { ...s, status: "done" as const } : s)),
    );
    expect(afterS1.map((s) => s.status)).toEqual(["done", "ready", "ready", "locked"]);

    // Complete S2 only -> S4 stays locked while S3 is still ready.
    const afterS2 = unlockReadySteps(
      afterS1.map((s) => (s.id === "S2" ? { ...s, status: "done" as const } : s)),
    );
    expect(afterS2.map((s) => s.status)).toEqual(["done", "done", "ready", "locked"]);

    // Complete S3 -> S4 unlocks.
    const afterS3 = unlockReadySteps(
      afterS2.map((s) => (s.id === "S3" ? { ...s, status: "done" as const } : s)),
    );
    expect(afterS3.map((s) => s.status)).toEqual(["done", "done", "done", "ready"]);
  });

  it("persists state atomically under stateDir without touching the project repo and notifies subscribers", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const store = new VelaDispatchStore(stateDir);
    const seen: string[] = [];
    const unsub = store.subscribe(repo, (s) => seen.push(s.planTitle ?? ""));
    await store.update(repo, (curr) => ({ ...curr, planTitle: "Test Plan" }), {
      text: "created",
    });
    unsub();

    expect(seen).toEqual(["Test Plan"]);
    expect(NodeFS.existsSync(NodePath.join(repo, ".vela"))).toBe(false);
    const freshStore = new VelaDispatchStore(stateDir);
    const loaded = await freshStore.read(repo);
    expect(loaded.planTitle).toBe("Test Plan");
    expect(loaded.events[0]?.text).toBe("created");
  });

  it("isolates dispatch state, contracts, ledger, and subscribers per threadId while keeping project-level fallback", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const store = new VelaDispatchStore(stateDir);
    const threadA = "thread:project:p1:a";
    const threadB = "thread:project:p1:b";

    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = store.subscribe({ projectRoot: repo, threadId: threadA }, (s) =>
      seenA.push(s.planTitle ?? ""),
    );
    const unsubB = store.subscribe({ projectRoot: repo, threadId: threadB }, (s) =>
      seenB.push(s.planTitle ?? ""),
    );

    const contractA = await store.writeSharedContract({ projectRoot: repo, threadId: threadA }, "Contract A");
    const contractB = await store.writeSharedContract({ projectRoot: repo, threadId: threadB }, "Contract B");
    await store.appendLedger({ projectRoot: repo, threadId: threadA }, "Ledger A");
    await store.appendLedger({ projectRoot: repo, threadId: threadB }, "Ledger B");

    await store.update(
      { projectRoot: repo, threadId: threadA },
      (curr) => ({ ...curr, planTitle: "Plan A", sharedContractPath: contractA }),
      { text: "A created" },
    );
    await store.update(
      { projectRoot: repo, threadId: threadB },
      (curr) => ({ ...curr, planTitle: "Plan B", sharedContractPath: contractB }),
      { text: "B created" },
    );

    unsubA();
    unsubB();

    expect(seenA).toEqual(["Plan A"]);
    expect(seenB).toEqual(["Plan B"]);
    expect(contractA.startsWith(stateDir)).toBe(true);
    expect(contractB.startsWith(stateDir)).toBe(true);
    expect(contractA).not.toBe(contractB);
    expect(NodeFS.existsSync(NodePath.join(repo, ".vela"))).toBe(false);

    const freshStore = new VelaDispatchStore(stateDir);
    const loadedA = await freshStore.read({ projectRoot: repo, threadId: threadA });
    const loadedB = await freshStore.read({ projectRoot: repo, threadId: threadB });
    const loadedLegacy = await freshStore.read(repo);

    expect(loadedA.planTitle).toBe("Plan A");
    expect(loadedA.parentThreadId).toBe(threadA);
    expect(loadedB.planTitle).toBe("Plan B");
    expect(loadedB.parentThreadId).toBe(threadB);
    expect(loadedLegacy.planTitle).toBeNull();
    expect(await freshStore.readSharedContract({ projectRoot: repo, threadId: threadA })).toBe("Contract A\n");
    expect(await freshStore.readSharedContract({ projectRoot: repo, threadId: threadB })).toBe("Contract B\n");
    expect(await freshStore.readLedgerExcerpt({ projectRoot: repo, threadId: threadA })).toContain("Ledger A");
    expect(await freshStore.readLedgerExcerpt({ projectRoot: repo, threadId: threadB })).not.toContain("Ledger A");
  });

  it("falls back to reading legacy .vela/dispatch data once and writes updates into stateDir", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const legacyDir = NodePath.join(repo, ".vela", "dispatch", "threads", "thr-legacy");
    NodeFS.mkdirSync(legacyDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(legacyDir, "state.json"),
      JSON.stringify({ version: 1, projectRoot: repo, parentThreadId: "thr-legacy", planTitle: "Legacy Plan" }),
      "utf8",
    );
    NodeFS.writeFileSync(NodePath.join(legacyDir, "contract.md"), "Legacy Contract\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(legacyDir, "ledger.md"), "Legacy Ledger\n", "utf8");

    const store = new VelaDispatchStore(stateDir);
    const scope = { projectRoot: repo, threadId: "thr-legacy" };
    const loaded = await store.read(scope);
    expect(loaded.planTitle).toBe("Legacy Plan");
    expect(await store.readSharedContract(scope)).toBe("Legacy Contract\n");
    expect(await store.readLedgerExcerpt(scope)).toContain("Legacy Ledger");

    await store.update(scope, (curr) => ({ ...curr, planTitle: "Migrated Plan" }));
    const freshStore = new VelaDispatchStore(stateDir);
    expect((await freshStore.read(scope)).planTitle).toBe("Migrated Plan");
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(legacyDir, "state.json"), "utf8")).planTitle,
    ).toBe("Legacy Plan");
  });
});

describe("summarizeLiveRunActivity", () => {
  const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
  const runA = RunId.make("run-a");
  const runB = RunId.make("run-b");
  const baseFields = {
    threadId: ThreadId.make("thr-activity"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "running" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  };

  it("filters user_message and non-matching runId, summarizes latest item, and truncates long commands", () => {
    expect(summarizeLiveRunActivity({ turnItems: [] }, runA)).toBeNull();

    const onlyUser = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-user"),
      runId: runA,
      ordinal: 0,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("msg-1"),
      workflowScript: false,
      freshContext: false,
      inputIntent: "turn_start",
      text: "hello",
      textOmitted: true,
      attachments: [],
    });
    const otherRun = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-other"),
      runId: runB,
      ordinal: 1,
      type: "reasoning",
      text: "other run reasoning",
      streaming: true,
    });
    expect(summarizeLiveRunActivity({ turnItems: [onlyUser, otherRun] }, runA)).toBeNull();

    const reasoningItem = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-reason"),
      runId: runA,
      ordinal: 2,
      type: "reasoning",
      text: "thinking...",
      streaming: true,
    });
    expect(summarizeLiveRunActivity({ turnItems: [onlyUser, otherRun, reasoningItem] }, runA)).toBe(
      "正在深度分析推理（第 1 步）",
    );

    const fileSearchItem = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-search"),
      runId: runA,
      ordinal: 3,
      type: "file_search",
      pattern: "VelaDispatchService\n  waitForThreadRun",
    });
    expect(
      summarizeLiveRunActivity({ turnItems: [onlyUser, reasoningItem, fileSearchItem] }, runA),
    ).toBe("正在检索代码：VelaDispatchService waitForThreadRun（第 2 步）");

    const fileChangeItem = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-change"),
      runId: runA,
      ordinal: 4,
      type: "file_change",
      fileName: "apps/server/src/dispatch/VelaDispatchService.ts",
    });
    expect(
      summarizeLiveRunActivity(
        { turnItems: [onlyUser, reasoningItem, fileSearchItem, fileChangeItem] },
        runA,
      ),
    ).toBe("正在修改文件：apps/server/src/dispatch/VelaDispatchService.ts（第 3 步）");

    const longCommand =
      "vp run --filter t3 typecheck && cd apps/server &&\n  vp test run src/dispatch/VelaDispatchService.test.ts";
    const cmdItem = decodeTurnItem({
      ...baseFields,
      id: TurnItemId.make("item-cmd"),
      runId: runA,
      ordinal: 5,
      type: "command_execution",
      input: longCommand,
    });
    expect(
      summarizeLiveRunActivity(
        { turnItems: [onlyUser, reasoningItem, fileSearchItem, fileChangeItem, cmdItem] },
        runA,
      ),
    ).toBe("正在运行命令：vp run --filter t3 typecheck && cd apps/se...（第 4 步）");

    expect(summarizeLiveRunActivity({ turnItems: [onlyUser, otherRun] }, null)).toBe(
      "正在深度分析推理（第 1 步）",
    );
  });
});

describe("partitionHardGates", () => {
  it("keeps executable shell commands and moves natural-language prose constraints to proseNotes", () => {
    const res = partitionHardGates([
      "vp run typecheck",
      "FOO=1 node scripts/check.js",
      "git diff --exit-code",
      "全程只读，不安装任何软件到远程机",
      "端口探测仅限 18200-18299 与 443",
      "   ",
    ]);
    expect(res.commands).toEqual([
      "vp run typecheck",
      "FOO=1 node scripts/check.js",
      "git diff --exit-code",
    ]);
    expect(res.proseNotes).toEqual([
      "全程只读，不安装任何软件到远程机",
      "端口探测仅限 18200-18299 与 443",
    ]);
  });
});

describe("DAG dependsOn unlocking & worktree merge-back", () => {
  it("unlocks independent dependsOn:[] steps immediately and unlocks join step only after all deps finish", () => {
    const mkDagCard = (
      id: string,
      order: number,
      dependsOn: ReadonlyArray<string>,
    ): DispatchTaskCard => ({
      id,
      order,
      title: id,
      goal: id,
      isolation: "direct",
      dependsOn,
      premisesToVerify: [],
      contextFiles: [],
      acceptanceCriteria: [],
      allowedGlobs: [],
      forbiddenGlobs: [],
      sensitiveGlobs: [],
      hardGates: [],
      executor: { providerInstanceId: "pi" },
      status: "locked",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const initial = [
      mkDagCard("S1", 1, []),
      mkDagCard("S2", 2, []),
      mkDagCard("S3", 3, ["S1", "S2"]),
    ];

    const step0 = unlockReadySteps(initial);
    expect(step0.map((s) => s.status)).toEqual(["ready", "ready", "locked"]);

    const afterS1 = unlockReadySteps(
      step0.map((s) => (s.id === "S1" ? { ...s, status: "done" as const } : s)),
    );
    expect(afterS1.map((s) => s.status)).toEqual(["done", "ready", "locked"]);

    const afterS2 = unlockReadySteps(
      afterS1.map((s) => (s.id === "S2" ? { ...s, status: "done" as const } : s)),
    );
    expect(afterS2.map((s) => s.status)).toEqual(["done", "done", "ready"]);
  });

  it("applies worktree delta (modified + added files) to main workspace without disturbing existing edits", async () => {
    const mainRepo = createTempGitRepo();
    NodeFS.writeFileSync(NodePath.join(mainRepo, "src", "other.ts"), "export const keep = 1;\n");

    const wtDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-wt-"));
    NodeFS.rmSync(wtDir, { recursive: true, force: true });
    tempDirs.push(wtDir);
    NodeChildProcess.execFileSync("git", ["worktree", "add", "--detach", wtDir, "HEAD"], {
      cwd: mainRepo,
      stdio: "ignore",
    });

    NodeFS.writeFileSync(NodePath.join(wtDir, "src", "index.ts"), "export const v = 99;\n");
    NodeFS.writeFileSync(NodePath.join(wtDir, "src", "feature.ts"), "export const ok = true;\n");

    const merged = await applyWorktreeDeltaToWorkspace(wtDir, mainRepo);
    expect(merged.appliedFiles).toEqual(["src/feature.ts", "src/index.ts"]);
    expect(NodeFS.readFileSync(NodePath.join(mainRepo, "src", "index.ts"), "utf8")).toBe(
      "export const v = 99;\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(mainRepo, "src", "feature.ts"), "utf8")).toBe(
      "export const ok = true;\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(mainRepo, "src", "other.ts"), "utf8")).toBe(
      "export const keep = 1;\n",
    );
  });
});

function makeDispatchTestLayer(
  workspaceRoot: string,
  options?: {
    readonly stateDir?: string | undefined;
    readonly activeShell?: boolean | undefined;
    readonly parentModelSelection?: ModelSelection | undefined;
    readonly providers?: ReadonlyArray<ServerProvider> | undefined;
    readonly onSendToThread?: ((text: string) => void) | undefined;
    readonly onLaunch?: ((input: ThreadLaunchService.ThreadLaunchInput) => void) | undefined;
    readonly getThreadProjection?:
      | ((threadId: ThreadId) => OrchestrationV2ThreadProjection | null)
      | undefined;
  },
) {
  const stateDir = options?.stateDir ?? createTempStateDir();
  let childSeq = 0;
  const mockProject: Project = {
    id: ProjectId.make("proj-dispatch-test"),
    title: "Dispatch Test",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };

  return velaDispatchServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)(
          { stateDir } as unknown as ServerConfig.ServerConfig["Service"],
        ),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-dispatch-test")),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed(
              options?.activeShell
                ? ({
                    deletedAt: null,
                    archivedAt: null,
                    runtimeMode: "full-access",
                    ...(options.parentModelSelection
                      ? { modelSelection: options.parentModelSelection }
                      : {}),
                  } as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          ...(options?.getThreadProjection
            ? {
                getThreadProjection: (threadId: ThreadId) => {
                  const found = options.getThreadProjection?.(threadId) ?? null;
                  return found
                    ? Effect.succeed(found)
                    : Effect.fail(
                        new Orchestrator.OrchestratorProjectionError({
                          threadId,
                          cause: "not found",
                        }),
                      );
                },
              }
            : {}),
          waitForThread: (waitInput) =>
            Effect.succeed({
              threadId: waitInput.threadId,
              run: { id: waitInput.runId ?? RunId.make("run-mock"), status: "completed" },
              timedOut: false,
            } as unknown as Effect.Success<
              ReturnType<ThreadManagementService.ThreadManagementService["Service"]["waitForThread"]>
            >),
          ...(options?.onSendToThread
            ? {
                sendToThread: (input) => {
                  options.onSendToThread?.(input.text);
                  return Effect.fail(
                    new ThreadManagementService.ThreadManagementThreadNotFoundError({
                      projectId: input.projectId,
                      threadId: input.threadId,
                    }),
                  );
                },
              }
            : {}),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)(
          options?.onLaunch
            ? {
                launch: (launchInput) => {
                  options.onLaunch?.(launchInput);
                  childSeq += 1;
                  const childThreadId = ThreadId.make(`thr-child-${childSeq}`);
                  const childRunId = RunId.make(`run-child-${childSeq}`);
                  return Effect.succeed({
                    threadId: childThreadId,
                    resumed: false,
                    projection: {
                      thread: { id: childThreadId, worktreePath: null },
                      runs: [{ id: childRunId, status: "completed" }],
                      messages: [],
                      turnItems: [],
                    },
                  } as unknown as ThreadLaunchService.ThreadLaunchResult);
                },
              }
            : {},
        ),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: () => Effect.succeedSome(mockProject),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(options?.providers ?? []),
        }),
      ),
    ),
  );
}

describe("VelaDispatchService", () => {
  itEffect.effect("rejects publish when steps contain a cyclic dependency", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);
      const err = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service
          .publishPlan({
            projectRoot: repo,
            threadId: "thr-cycle",
            requirementSummary: "只测试循环依赖校验",
            steps: [
              {
                id: "S1",
                title: "Step 1",
                goal: "First",
                kind: "research",
                dependsOn: ["S2"],
              },
              {
                id: "S2",
                title: "Step 2",
                goal: "Second",
                kind: "change",
                dependsOn: ["S1"],
                acceptanceCriteria: ["Done"],
              },
            ],
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));

      expect(err.message).toContain("任务卡校验未通过");
      expect(err.message).toContain("循环依赖");
    }),
  );

  itEffect.effect("unlocks downstream steps after decideStep completes a decision card", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);

      const finalState = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-decide",
          requirementSummary: "调研后由用户拍板再改代码",
          steps: [
            {
              id: "S1",
              title: "Choose approach",
              goal: "Pick implementation strategy",
              kind: "decision",
              dependsOn: [],
              decisionOptions: [
                { id: "A", label: "SQLite", description: "Zero external deps" },
                { id: "B", label: "File JSON" },
              ],
            },
            {
              id: "S2",
              title: "Implement chosen approach",
              goal: "Write code based on S1 decision",
              kind: "change",
              dependsOn: ["S1"],
              acceptanceCriteria: ["Passes unit tests"],
            },
          ],
        });

        const afterLaunch = yield* service.dispatchStep({
          projectRoot: repo,
          threadId: "thr-decide",
          stepId: "S1",
        });
        expect(afterLaunch.steps.find((s) => s.id === "S1")?.status).toBe("awaiting_decision");
        expect(afterLaunch.steps.find((s) => s.id === "S2")?.status).toBe("locked");

        return yield* service.decideStep({
          projectRoot: repo,
          threadId: "thr-decide",
          stepId: "S1",
          selectedOptionId: "A",
          decision: "优先用 SQLite 保证并发安全",
        });
      }).pipe(Effect.provide(layer));

      const s1 = finalState.steps.find((s) => s.id === "S1");
      const s2 = finalState.steps.find((s) => s.id === "S2");
      expect(s1?.status).toBe("done");
      expect(s1?.reviewer).toBeNull();
      expect(s2?.status).toBe("ready");
      expect(finalState.runs.S1?.deliverable?.kind).toBe("decision");
      expect(finalState.runs.S1?.deliverable?.selectedOptionId).toBe("A");
      expect(finalState.runs.S1?.deliverable?.text).toContain("选择：SQLite（Zero external deps）");
      expect(finalState.runs.S1?.deliverable?.text).toContain("补充：优先用 SQLite 保证并发安全");
      expect(finalState.requirement?.summary).toBe("调研后由用户拍板再改代码");
    }),
  );

  itEffect.effect("removes step, cleans dependsOn references, and unlocks dependent steps on deleteStep", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);

      const afterDelete = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-delete",
          steps: [
            {
              id: "S1",
              title: "Optional research",
              goal: "Check existing code",
              kind: "research",
              dependsOn: [],
            },
            {
              id: "S2",
              title: "Implement feature",
              goal: "Apply change",
              kind: "change",
              dependsOn: ["S1"],
              acceptanceCriteria: ["Works"],
            },
          ],
        });

        return yield* service.deleteStep(repo, "S1", "thr-delete");
      }).pipe(Effect.provide(layer));

      expect(afterDelete.steps.map((s) => s.id)).toEqual(["S2"]);
      expect(afterDelete.steps[0]?.dependsOn).toEqual([]);
      expect(afterDelete.steps[0]?.status).toBe("ready");
      expect(afterDelete.runs.S1).toBeUndefined();
    }),
  );

  itEffect.effect("returns prompt for client delivery without sendToThread and rejects missing server thread before writing state", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);

      const serverErr = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service
          .kickoffPlan({
            projectRoot: repo,
            threadId: "thr-missing-server",
            requirement: "Check test failure",
            mode: "fast",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));

      expect(serverErr.message).toContain("当前对话还没有创建");

      const afterFailedServer = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service.getState(repo, "thr-missing-server");
      }).pipe(Effect.provide(layer));
      expect(afterFailedServer.requirement ?? null).toBeNull();

      const clientRes = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service.kickoffPlan({
          projectRoot: repo,
          threadId: "thr-draft-client",
          requirement: "Check why npm test fails",
          mode: "fast",
          deliver: "client",
        });
      }).pipe(Effect.provide(layer));

      expect(clientRes.ok).toBe(true);
      expect(clientRes.prompt).toContain("Check why npm test fails");
    }),
  );

  itEffect.effect("clearPlan archives non-empty plan into history, preserves config, and skips duplicate empty archive", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);
      const threadId = "thr-archive-clear";

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.updateConfig({
          projectRoot: repo,
          threadId,
          defaultAgent: { providerInstanceId: "codex", model: "gpt-5" },
        });
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          planTitle: "归档测试计划",
          mode: "strict",
          requirementSummary: "验证清空计划时的归档逻辑",
          steps: [
            {
              id: "S1",
              title: "Choose strategy",
              goal: "Pick one option",
              kind: "decision",
              dependsOn: [],
              decisionOptions: [
                { id: "A", label: "Option A" },
                { id: "B", label: "Option B" },
              ],
            },
          ],
        });
        yield* service.dispatchStep({
          projectRoot: repo,
          threadId,
          stepId: "S1",
        });
        yield* service.decideStep({
          projectRoot: repo,
          threadId,
          stepId: "S1",
          selectedOptionId: "A",
        });

        const afterFirstClear = yield* service.clearPlan(repo, threadId);
        const afterSecondClear = yield* service.clearPlan(repo, threadId);
        return { afterFirstClear, afterSecondClear };
      }).pipe(Effect.provide(layer));

      expect(result.afterFirstClear.steps).toEqual([]);
      expect(result.afterFirstClear.planTitle).toBeNull();
      expect(result.afterFirstClear.config.defaultAgent).toEqual({
        providerInstanceId: "codex",
        model: "gpt-5",
      });
      expect(result.afterFirstClear.history).toHaveLength(1);
      const archived = result.afterFirstClear.history?.[0];
      expect(archived?.id).toMatch(/^PLAN-/);
      expect(archived?.planTitle).toBe("归档测试计划");
      expect(archived?.mode).toBe("strict");
      expect(archived?.requirement?.summary).toBe("验证清空计划时的归档逻辑");
      expect(archived?.steps.map((s) => s.id)).toEqual(["S1"]);
      expect(archived?.runs.S1?.deliverable?.selectedOptionId).toBe("A");
      expect(archived?.archivedAt).toBeTruthy();

      expect(result.afterSecondClear.history).toHaveLength(1);
      expect(result.afterSecondClear.history?.[0]?.id).toBe(archived?.id);
    }),
  );

  itEffect.effect("publishPlan without append archives previous non-empty plan and strips diff patch", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-archive-overwrite";
      const seedStore = new VelaDispatchStore(stateDir);
      const seededRun: DispatchStepRun = {
        stepId: "S1",
        isolation: "direct",
        branchName: "",
        baseCommit: "abc123",
        baselineTree: "tree123",
        workspacePath: repo,
        childThreadId: "child-1",
        childRunId: null,
        reviewerThreadIds: ["rev-1"],
        status: "done",
        headline: "Completed",
        lastError: null,
        premiseFailures: [],
        diffSummary: {
          changedFiles: ["apps/server/src/a.ts"],
          patch: "diff --git a/apps/server/src/a.ts b/apps/server/src/a.ts\n+const x = 1;",
          truncated: false,
        },
        boundaryAudit: {
          ok: true,
          outOfScopeFiles: [],
          forbiddenFiles: [],
          sensitiveFiles: [],
        },
        hardGate: null,
        reviews: [],
        acceptanceReports: [],
        escalationRounds: 0,
        reviewRound: 1,
        acceptanceRound: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      };

      yield* Effect.promise(() =>
        seedStore.update({ projectRoot: repo, threadId }, (curr) => ({
          ...curr,
          planTitle: "旧计划",
          mode: "fast",
          steps: [
            {
              id: "S1",
              order: 1,
              title: "Old step",
              goal: "Old goal",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              premisesToVerify: [],
              contextFiles: [],
              acceptanceCriteria: ["Done"],
              allowedGlobs: [],
              forbiddenGlobs: [],
              sensitiveGlobs: [],
              hardGates: [],
              executor: { providerInstanceId: "codex" },
              reviewer: null,
              status: "done",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:01:00.000Z",
            },
          ],
          runs: { S1: seededRun },
        })),
      );

      const layer = makeDispatchTestLayer(repo, { stateDir });
      const nextState = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          planTitle: "新计划",
          steps: [
            {
              id: "S1",
              title: "New step",
              goal: "New goal",
              kind: "research",
              dependsOn: [],
            },
          ],
        });
      }).pipe(Effect.provide(layer));

      expect(nextState.planTitle).toBe("新计划");
      expect(nextState.history).toHaveLength(1);
      const archived = nextState.history?.[0];
      expect(archived?.planTitle).toBe("旧计划");
      expect(archived?.steps[0]?.title).toBe("Old step");
      expect(archived?.runs.S1?.childThreadId).toBe("child-1");
      expect(archived?.runs.S1?.reviewerThreadIds).toEqual(["rev-1"]);
      expect(archived?.runs.S1?.diffSummary).toEqual({
        changedFiles: ["apps/server/src/a.ts"],
        patch: "",
        truncated: true,
      });
    }),
  );

  itEffect.effect("deleteArchivedPlan removes target archive item and safely handles missing ids", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const layer = makeDispatchTestLayer(repo);
      const threadId = "thr-archive-delete";

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          planTitle: "计划一",
          steps: [
            {
              id: "S1",
              title: "Step 1",
              goal: "Goal 1",
              kind: "research",
              dependsOn: [],
            },
          ],
        });
        yield* service.clearPlan(repo, threadId);

        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          planTitle: "计划二",
          steps: [
            {
              id: "S1",
              title: "Step 2",
              goal: "Goal 2",
              kind: "research",
              dependsOn: [],
            },
          ],
        });
        const withTwo = yield* service.clearPlan(repo, threadId);
        const firstId = withTwo.history?.[0]?.id ?? "";
        const secondId = withTwo.history?.[1]?.id ?? "";

        const afterMissing = yield* service.deleteArchivedPlan(repo, "PLAN-NOT-EXIST", threadId);
        const afterDelete = yield* service.deleteArchivedPlan(repo, firstId, threadId);
        return { withTwo, firstId, secondId, afterMissing, afterDelete };
      }).pipe(Effect.provide(layer));

      expect(result.withTwo.history).toHaveLength(2);
      expect(result.afterMissing.history).toHaveLength(2);
      expect(result.afterDelete.history).toHaveLength(1);
      expect(result.afterDelete.history?.[0]?.id).toBe(result.secondId);
    }),
  );

  itEffect.effect("wakes parent orchestrator when a single decision step completes the plan", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const sentTexts: string[] = [];
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        onSendToThread: (text) => sentTexts.push(text),
      });

      yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-parent-decide",
          parentThreadId: "thr-parent-decide",
          planTitle: "格式拍板计划",
          steps: [
            {
              id: "S1",
              title: "Choose export format",
              goal: "Pick CSV or JSON",
              kind: "decision",
              dependsOn: [],
              decisionOptions: [
                { id: "A", label: "CSV" },
                { id: "B", label: "JSON" },
              ],
            },
          ],
        });

        yield* service.decideStep({
          projectRoot: repo,
          threadId: "thr-parent-decide",
          stepId: "S1",
          selectedOptionId: "B",
          decision: "优先用 JSON",
        });
      }).pipe(Effect.provide(layer));

      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain("[Vela 分步派发回执]");
      expect(sentTexts[0]).toContain("格式拍板计划");
      expect(sentTexts[0]).toContain("选择：JSON");
      expect(sentTexts[0]).toContain("优先用 JSON");
    }),
  );

  itEffect.effect("does not wake parent again on acceptStep for a single-step research plan", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const sentTexts: string[] = [];
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        onSendToThread: (text) => sentTexts.push(text),
      });

      yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-single-research",
          parentThreadId: "thr-single-research",
          steps: [
            {
              id: "S1",
              title: "Diagnose bug",
              goal: "Inspect failing test",
              kind: "research",
              dependsOn: [],
            },
          ],
        });

        yield* service.acceptStep(repo, "S1", "thr-single-research");
      }).pipe(Effect.provide(layer));

      expect(sentTexts).toHaveLength(0);
    }),
  );

  itEffect.effect("wakes parent orchestrator when the final step of a multi-step plan is accepted", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const sentTexts: string[] = [];
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        onSendToThread: (text) => sentTexts.push(text),
      });

      yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-multi-complete",
          parentThreadId: "thr-multi-complete",
          planTitle: "排查并修复",
          steps: [
            {
              id: "S1",
              title: "Diagnose",
              goal: "Find root cause",
              kind: "research",
              dependsOn: [],
            },
            {
              id: "S2",
              title: "Fix bug",
              goal: "Apply fix",
              kind: "change",
              dependsOn: ["S1"],
              acceptanceCriteria: ["Tests pass"],
            },
          ],
        });

        yield* service.acceptStep(repo, "S1", "thr-multi-complete");
        expect(sentTexts).toHaveLength(0);

        yield* service.acceptStep(repo, "S2", "thr-multi-complete");
      }).pipe(Effect.provide(layer));

      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain("[Vela 分步派发回执]");
      expect(sentTexts[0]).toContain("全部 2 步已完成");
      expect(sentTexts[0]).toContain("S1 Diagnose (research)");
      expect(sentTexts[0]).toContain("S2 Fix bug (change)");
    }),
  );

  it("maps effort and preserves native ModelSelection options across harnesses", () => {
    const codexProvider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      status: "ready",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                label: "Reasoning",
                role: "reasoning",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "XHigh" },
                ],
              },
            ],
          },
        },
      ],
    } as unknown as ServerProvider;

    const claudeProvider = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude Code",
      enabled: true,
      status: "ready",
      models: [
        {
          slug: "claude-opus-4-6",
          name: "Claude Opus",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                label: "Effort",
                role: "reasoning",
                options: [
                  { id: "medium", label: "Medium" },
                  { id: "max", label: "Max" },
                ],
              },
              {
                id: "fastMode",
                type: "boolean",
                label: "Fast",
              },
            ],
          },
        },
      ],
    } as unknown as ServerProvider;

    const codexSelection = toModelSelection(
      { providerInstanceId: "codex", model: "gpt-5.4", effort: "XHigh" },
      [codexProvider, claudeProvider],
    );
    expect(codexSelection.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);

    // Cross-harness remapping: `reasoningEffort` passed to Claude maps to `effort` while keeping fastMode.
    const remapped = normalizeAgentOptionSelections(
      {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-4-6",
        options: [
          { id: "reasoningEffort", value: "Max" },
          { id: "fastMode", value: true },
        ],
      },
      [codexProvider, claudeProvider],
      "claude-opus-4-6",
    );
    expect(remapped).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });

  itEffect.live(
    "launches Dispatch child threads with native subagentParentThreadId and inherits parent effort options",
    () =>
      Effect.gen(function* () {
        const repo = createTempGitRepo();
        const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
        let resolveLaunched: (() => void) | undefined;
        const launchedReady = new Promise<void>((resolve) => {
          resolveLaunched = resolve;
        });
        const layer = makeDispatchTestLayer(repo, {
          activeShell: true,
          parentModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          onLaunch: (input) => {
            launches.push(input);
            resolveLaunched?.();
          },
        });

        yield* Effect.gen(function* () {
          const service = yield* VelaDispatchService;
          yield* service.publishPlan({
            projectRoot: repo,
            threadId: "thr-parent-subagent",
            parentThreadId: "thr-parent-subagent",
            steps: [
              {
                id: "S1",
                title: "Inspect architecture",
                goal: "Check subagent wiring",
                kind: "research",
                dependsOn: [],
                reviewer: null,
              },
            ],
          });
          yield* service.dispatchStep({
            projectRoot: repo,
            threadId: "thr-parent-subagent",
            parentThreadId: "thr-parent-subagent",
            stepId: "S1",
          });
          yield* Effect.promise(() => launchedReady);
          yield* service.cancelStep(repo, "S1", "thr-parent-subagent");
        }).pipe(Effect.provide(layer));

        expect(launches).toHaveLength(1);
        expect(launches[0]?.subagentParentThreadId).toBe(ThreadId.make("thr-parent-subagent"));
        expect(launches[0]?.initialMessage?.senderThreadId).toBe(
          ThreadId.make("thr-parent-subagent"),
        );
        expect(launches[0]?.modelSelection.options).toEqual([
          { id: "reasoningEffort", value: "xhigh" },
        ]);
      }),
  );

  itEffect.live(
    "reconciles orphaned running steps on restart: settles cancelled runs and resumes completed research runs",
    () =>
      Effect.gen(function* () {
        const repo = createTempGitRepo();
        const stateDir = createTempStateDir();
        const store = new VelaDispatchStore(stateDir);
        const cancelledChildId = ThreadId.make("thr-child-cancelled");
        const completedChildId = ThreadId.make("thr-child-completed");
        const completedRunId = RunId.make("run-child-completed");

        yield* Effect.promise(() =>
          store.update({ projectRoot: repo, threadId: "thr-restart" }, (curr) => ({
            ...curr,
            projectId: "proj-dispatch-test",
            parentThreadId: "thr-restart",
            steps: [
              {
                id: "S1",
                order: 1,
                title: "Interrupted change",
                goal: "Edit code",
                kind: "change",
                isolation: "direct",
                dependsOn: [],
                premisesToVerify: [],
                contextFiles: [],
                acceptanceCriteria: ["Passes"],
                allowedGlobs: [],
                forbiddenGlobs: [],
                sensitiveGlobs: [],
                hardGates: [],
                executor: { providerInstanceId: "codex", model: "gpt-5.4" },
                reviewer: null,
                status: "running",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "S2",
                order: 2,
                title: "Finished research before restart",
                goal: "Summarize findings",
                kind: "research",
                isolation: "direct",
                dependsOn: [],
                premisesToVerify: [],
                contextFiles: [],
                acceptanceCriteria: [],
                allowedGlobs: [],
                forbiddenGlobs: [],
                sensitiveGlobs: [],
                hardGates: [],
                executor: { providerInstanceId: "codex", model: "gpt-5.4" },
                reviewer: null,
                status: "running",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            runs: {
              S1: {
                stepId: "S1",
                isolation: "direct",
                branchName: "main",
                baseCommit: "HEAD",
                baselineTree: null,
                workspacePath: repo,
                childThreadId: cancelledChildId,
                childRunId: "run-child-cancelled",
                reviewerThreadIds: [],
                status: "running",
                headline: "执行中...",
                lastError: null,
                premiseFailures: [],
                diffSummary: null,
                boundaryAudit: null,
                hardGate: null,
                reviews: [],
                acceptanceReports: [],
                escalationRounds: 0,
                reviewRound: 0,
                acceptanceRound: 0,
                startedAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              S2: {
                stepId: "S2",
                isolation: "direct",
                branchName: "main",
                baseCommit: "HEAD",
                baselineTree: null,
                workspacePath: repo,
                childThreadId: completedChildId,
                childRunId: completedRunId,
                reviewerThreadIds: [],
                status: "running",
                headline: "调研中...",
                lastError: null,
                premiseFailures: [],
                diffSummary: null,
                boundaryAudit: null,
                hardGate: null,
                reviews: [],
                acceptanceReports: [],
                escalationRounds: 0,
                reviewRound: 0,
                acceptanceRound: 0,
                startedAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          })),
        );

        const layer = makeDispatchTestLayer(repo, {
          stateDir,
          activeShell: true,
          getThreadProjection: (tid) => {
            if (tid === cancelledChildId) {
              return {
                thread: { id: cancelledChildId },
                runs: [{ id: RunId.make("run-child-cancelled"), status: "cancelled" }],
                messages: [],
                turnItems: [],
              } as unknown as OrchestrationV2ThreadProjection;
            }
            if (tid === completedChildId) {
              return {
                thread: { id: completedChildId },
                runs: [{ id: completedRunId, status: "completed" }],
                messages: [
                  {
                    id: MessageId.make("msg-research-done"),
                    runId: completedRunId,
                    role: "assistant",
                    text: "## 调研结论\n重启前已完成排查。",
                  },
                ],
                turnItems: [],
              } as unknown as OrchestrationV2ThreadProjection;
            }
            return null;
          },
        });

        const settled = yield* Effect.gen(function* () {
          const service = yield* VelaDispatchService;
          let resolveS2Done: (() => void) | undefined;
          const s2Done = new Promise<void>((resolve) => {
            resolveS2Done = resolve;
          });
          const unsubscribe = service.subscribe(
            repo,
            (next) => {
              if (next.steps.find((s) => s.id === "S2")?.status === "ready_to_accept") {
                resolveS2Done?.();
              }
            },
            "thr-restart",
          );
          try {
            const first = yield* service.getState(repo, "thr-restart");
            if (first.steps.find((s) => s.id === "S2")?.status !== "ready_to_accept") {
              yield* Effect.promise(() => s2Done);
            }
            return yield* service.getState(repo, "thr-restart");
          } finally {
            unsubscribe();
          }
        }).pipe(Effect.provide(layer));

        const s1 = settled.steps.find((s) => s.id === "S1");
        const s2 = settled.steps.find((s) => s.id === "S2");
        expect(s1?.status).toBe("cancelled");
        expect(settled.runs.S1?.lastError).toContain("服务端重启");
        expect(s2?.status).toBe("ready_to_accept");
        expect(settled.runs.S2?.deliverable?.text).toContain("重启前已完成排查");
      }),
  );
});
