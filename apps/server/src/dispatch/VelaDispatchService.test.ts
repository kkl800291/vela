// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  inspectWorkspaceDeltaWithTree,
  revertStepSnapshotSafely,
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
import { VelaDispatchStore, dispatchStateFileOf, unlockReadySteps } from "./VelaDispatchStore.ts";
import type { DispatchStepRun, DispatchTaskCard } from "./VelaDispatchTypes.ts";
import type { DispatchEscalationRecord } from "./VelaDispatchTypes.ts";

const fsReadGate = vi.hoisted(() => ({
  armed: false,
  wait: Promise.resolve() as Promise<void>,
  notifyPaused: () => {},
}));

const fsWriteGate = vi.hoisted(() => ({
  armed: false,
  pathIncludes: "",
  wait: Promise.resolve() as Promise<void>,
  notifyPaused: () => {},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], options?: unknown) => {
      if (fsReadGate.armed && String(path).endsWith("state.json")) {
        fsReadGate.armed = false;
        const stale = await actual.readFile(path, options as never);
        fsReadGate.notifyPaused();
        await fsReadGate.wait;
        return stale;
      }
      return actual.readFile(path, options as never);
    }) as typeof actual.readFile,
    writeFile: (async (
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (
        fsWriteGate.armed &&
        fsWriteGate.pathIncludes.length > 0 &&
        String(path).includes("state.json") &&
        String(path).includes(fsWriteGate.pathIncludes)
      ) {
        fsWriteGate.armed = false;
        fsWriteGate.notifyPaused();
        await fsWriteGate.wait;
      }
      return actual.writeFile(path, data, options);
    }) as typeof actual.writeFile,
  };
});

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

function deferFirstStateJsonRead(): {
  readonly paused: Promise<void>;
  readonly release: () => void;
  readonly restore: () => void;
} {
  let releaseGate!: () => void;
  let markPaused!: () => void;
  fsReadGate.wait = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  fsReadGate.notifyPaused = () => markPaused();
  fsReadGate.armed = true;
  return {
    paused,
    release: () => releaseGate(),
    restore: () => {
      fsReadGate.armed = false;
      releaseGate();
    },
  };
}

function deferFirstStateJsonWrite(pathIncludes: string): {
  readonly paused: Promise<void>;
  readonly release: () => void;
  readonly restore: () => void;
} {
  let releaseGate!: () => void;
  let markPaused!: () => void;
  fsWriteGate.wait = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  fsWriteGate.notifyPaused = () => markPaused();
  fsWriteGate.pathIncludes = pathIncludes;
  fsWriteGate.armed = true;
  return {
    paused,
    release: () => releaseGate(),
    restore: () => {
      fsWriteGate.armed = false;
      fsWriteGate.pathIncludes = "";
      releaseGate();
    },
  };
}

function makeDispatchStep(
  id: string,
  status: DispatchTaskCard["status"],
  patch: Partial<DispatchTaskCard> = {},
): DispatchTaskCard {
  return {
    id,
    order: 1,
    title: id,
    goal: id,
    kind: "change",
    isolation: "direct",
    dependsOn: [],
    premisesToVerify: [],
    contextFiles: [],
    acceptanceCriteria: ["done"],
    allowedGlobs: [],
    forbiddenGlobs: [],
    sensitiveGlobs: [],
    hardGates: [],
    executor: { providerInstanceId: "codex" },
    reviewer: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function makeDispatchRun(stepId: string, patch: Partial<DispatchStepRun> = {}): DispatchStepRun {
  return {
    stepId,
    isolation: "direct",
    branchName: "main",
    baseCommit: "HEAD",
    baselineTree: null,
    workspacePath: "",
    childThreadId: "thr-child",
    childRunId: null,
    reviewerThreadIds: [],
    status: "needs_human_decision",
    headline: "waiting",
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
    ...patch,
  };
}

function throwingDispatchSubscriber(counter: { count: number }): () => void {
  return () => {
    counter.count += 1;
    throw new Error("subscriber failed");
  };
}

function makeEscalation(
  id: string,
  stepId: string,
  patch: Partial<DispatchEscalationRecord> = {},
): DispatchEscalationRecord {
  return {
    id,
    stepId,
    kind: "executor_question",
    status: "open_human",
    title: "Need a decision",
    question: "Which approach?",
    options: [{ id: "A", label: "Continue" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it("revertStepSnapshotSafely preserves manual edits & new user notes, 3-way merges non-overlapping edits, and flags conflicts", async () => {
    const repo = createTempGitRepo();
    NodeFS.writeFileSync(
      NodePath.join(repo, "src", "shared.ts"),
      ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n") + "\n",
    );
    NodeFS.writeFileSync(NodePath.join(repo, "src", "other.ts"), "export const other = 1;\n");

    const snap = await captureWorkspaceSnapshot(repo);
    expect(snap.baselineTree).toBeTruthy();

    // Step modifies shared.ts (line 2) and creates step-added.ts.
    NodeFS.writeFileSync(
      NodePath.join(repo, "src", "shared.ts"),
      ["line 1", "line 2-by-step", "line 3", "line 4", "line 5", "line 6"].join("\n") + "\n",
    );
    NodeFS.writeFileSync(NodePath.join(repo, "src", "step-added.ts"), "export const s = 1;\n");

    const deltaWithTree = await inspectWorkspaceDeltaWithTree(repo, snap.baselineTree);
    expect(deltaWithTree.currentTree).toBeTruthy();

    // User manually edits unrelated other.ts, creates user-note.md, and makes a non-overlapping edit to shared.ts (line 6).
    NodeFS.writeFileSync(NodePath.join(repo, "src", "other.ts"), "export const other = 999;\n");
    NodeFS.writeFileSync(NodePath.join(repo, "user-note.md"), "# My Note\n");
    NodeFS.writeFileSync(
      NodePath.join(repo, "src", "shared.ts"),
      ["line 1", "line 2-by-step", "line 3", "line 4", "line 5", "line 6-by-user"].join("\n") +
        "\n",
    );

    const safeResult = await revertStepSnapshotSafely(repo, {
      baselineTree: snap.baselineTree!,
      completedTree: deltaWithTree.currentTree,
    });
    expect(safeResult.conflicts).toEqual([]);
    expect(safeResult.removedFiles).toEqual(["src/step-added.ts"]);
    expect(safeResult.mergedFiles).toEqual(["src/shared.ts"]);
    expect(NodeFS.existsSync(NodePath.join(repo, "src", "step-added.ts"))).toBe(false);
    // User's unrelated file & new note are completely untouched!
    expect(NodeFS.readFileSync(NodePath.join(repo, "src", "other.ts"), "utf8")).toBe(
      "export const other = 999;\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(repo, "user-note.md"), "utf8")).toBe("# My Note\n");
    // Step's line 2 edit was reverted while user's line 6 edit survived via 3-way merge!
    expect(NodeFS.readFileSync(NodePath.join(repo, "src", "shared.ts"), "utf8")).toBe(
      ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6-by-user"].join("\n") + "\n",
    );

    // Now test overlapping conflict: step modifies line 2, then user also modifies line 2 differently.
    const snap2 = await captureWorkspaceSnapshot(repo);
    NodeFS.writeFileSync(
      NodePath.join(repo, "src", "shared.ts"),
      ["line 1", "line 2-by-step-v2", "line 3", "line 4", "line 5", "line 6-by-user"].join("\n") +
        "\n",
    );
    const delta2 = await inspectWorkspaceDeltaWithTree(repo, snap2.baselineTree);
    NodeFS.writeFileSync(
      NodePath.join(repo, "src", "shared.ts"),
      ["line 1", "line 2-by-user-conflict", "line 3", "line 4", "line 5", "line 6-by-user"].join(
        "\n",
      ) + "\n",
    );

    const conflictResult = await revertStepSnapshotSafely(repo, {
      baselineTree: snap2.baselineTree!,
      completedTree: delta2.currentTree,
    });
    expect(conflictResult.conflicts).toHaveLength(1);
    expect(conflictResult.conflicts[0]?.file).toBe("src/shared.ts");
    // Conflict aborted without clobbering disk!
    expect(NodeFS.readFileSync(NodePath.join(repo, "src", "shared.ts"), "utf8")).toContain(
      "line 2-by-user-conflict",
    );
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

  it("does not let a cold listAllStates scan roll back a newer update", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const seeded = new VelaDispatchStore(stateDir);
    const step = makeCard("S1", 1, "ready");
    await seeded.update(repo, (curr) => ({
      ...curr,
      planTitle: "stale-title",
      steps: [step],
    }));

    const store = new VelaDispatchStore(stateDir);
    const disk = deferFirstStateJsonRead();
    try {
      const listed = store.listAllStates();
      await Promise.race([
        disk.paused,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("listAllStates disk read was not deferred")), 2000),
        ),
      ]);
      await store.update(repo, (curr) => ({
        ...curr,
        planTitle: "fresh-title",
        steps: curr.steps.length > 0 ? curr.steps : [step],
      }));
      disk.release();
      const states = await listed;
      expect(states.find((state) => state.projectRoot === repo)?.planTitle).toBe("fresh-title");

      const next = await store.update(repo, (curr) => ({
        ...curr,
        planTitle: curr.planTitle === "fresh-title" ? "fresher-title" : "rolled-back",
      }));
      expect(next.planTitle).toBe("fresher-title");
      const persisted = JSON.parse(
        NodeFS.readFileSync(dispatchStateFileOf(repo, stateDir), "utf8"),
      ) as { planTitle?: string };
      expect(persisted.planTitle).toBe("fresher-title");
    } finally {
      disk.release();
      disk.restore();
    }
  });

  it("does not let a cold read roll back a newer update into the cache", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const seeded = new VelaDispatchStore(stateDir);
    await seeded.update(repo, (curr) => ({ ...curr, planTitle: "stale-title" }));

    const store = new VelaDispatchStore(stateDir);
    const disk = deferFirstStateJsonRead();
    try {
      const reading = store.read(repo);
      await Promise.race([
        disk.paused,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("read disk read was not deferred")), 2000),
        ),
      ]);
      await store.update(repo, (curr) => ({ ...curr, planTitle: "fresh-title" }));
      disk.release();
      expect((await reading).planTitle).toBe("fresh-title");

      const next = await store.update(repo, (curr) => ({
        ...curr,
        planTitle: curr.planTitle === "fresh-title" ? "fresher-title" : "rolled-back",
      }));
      expect(next.planTitle).toBe("fresher-title");
      const persisted = JSON.parse(
        NodeFS.readFileSync(dispatchStateFileOf(repo, stateDir), "utf8"),
      ) as { planTitle?: string };
      expect(persisted.planTitle).toBe("fresher-title");
    } finally {
      disk.release();
      disk.restore();
    }
  });

  it("keys a project-level state file without its legacy parentThreadId so a clear wins the scan", async () => {
    const repo = createTempGitRepo();
    const stateDir = createTempStateDir();
    const seeded = new VelaDispatchStore(stateDir);
    await seeded.update(repo, (curr) => ({
      ...curr,
      parentThreadId: "legacy-thread",
      planTitle: "legacy-project-plan",
      steps: [makeCard("S1", 1, "ready")],
    }));

    const store = new VelaDispatchStore(stateDir);
    const disk = deferFirstStateJsonRead();
    try {
      const listed = store.listAllStates();
      await Promise.race([
        disk.paused,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("project scan was not deferred")), 2000),
        ),
      ]);
      await store.update(repo, (curr) => ({
        ...curr,
        steps: [],
        escalations: [],
        runs: {},
        planTitle: null,
      }));
      disk.release();
      const states = await listed;
      expect(states.filter((state) => state.projectRoot === repo)).toEqual([]);
      expect(states.some((state) => state.steps.some((step) => step.id === "S1"))).toBe(false);
    } finally {
      disk.release();
      disk.restore();
    }
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
    readonly onProjectLookup?: (() => void) | undefined;
    readonly onDeferredProvider?: (() => void) | undefined;
    readonly providerGate?: Promise<void> | undefined;
    readonly launchGate?: Promise<void> | undefined;
    readonly holdBackground?: Promise<void> | undefined;
    readonly getThreadProjection?:
      | ((threadId: ThreadId) => OrchestrationV2ThreadProjection | null)
      | undefined;
  },
) {
  const stateDir = options?.stateDir ?? createTempStateDir();
  let childSeq = 0;
  let providerReads = 0;
  const providerGate = options?.providerGate;
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
          ...(options?.onSendToThread || options?.holdBackground
            ? {
                sendToThread: (input) => {
                  options?.onSendToThread?.(input.text);
                  if (options?.holdBackground) {
                    const held = options.holdBackground;
                    return Effect.promise(async () => {
                      await held;
                      return {
                        run: { id: RunId.make("run-held") },
                      } as unknown as Effect.Success<
                        ReturnType<
                          ThreadManagementService.ThreadManagementService["Service"]["sendToThread"]
                        >
                      >;
                    });
                  }
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
                launch: (launchInput) =>
                  Effect.promise(async () => {
                    options.onLaunch?.(launchInput);
                    if (options.launchGate) await options.launchGate;
                    childSeq += 1;
                    const childThreadId = ThreadId.make(`thr-child-${childSeq}`);
                    const childRunId = RunId.make(`run-child-${childSeq}`);
                    return {
                      threadId: childThreadId,
                      resumed: false,
                      projection: {
                        thread: { id: childThreadId, worktreePath: null },
                        runs: [{ id: childRunId, status: "completed" }],
                        messages: [],
                        turnItems: [],
                      },
                    } as unknown as ThreadLaunchService.ThreadLaunchResult;
                  }),
              }
            : {},
        ),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: () => {
            options?.onProjectLookup?.();
            return Effect.succeedSome(mockProject);
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: providerGate
            ? Effect.promise(async () => {
                providerReads += 1;
                if (providerReads > 1) {
                  options?.onDeferredProvider?.();
                  await providerGate;
                }
                return options?.providers ?? [];
              })
            : Effect.succeed(options?.providers ?? []),
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
          enableBatchAudit: true,
          deliver: "client",
        });
      }).pipe(Effect.provide(layer));

      expect(clientRes.ok).toBe(true);
      expect(clientRes.prompt).toContain("Check why npm test fails");
      expect(clientRes.prompt).toContain("enableBatchAudit: true");
      const kickoffState = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service.getState(repo, "thr-draft-client");
      }).pipe(Effect.provide(layer));
      expect(kickoffState.config.enableBatchAudit).toBe(true);
    }),
  );

  itEffect.effect("keeps legacy review targets when applying a new default executor", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const threadId = "thread:legacy-review-config";
      const reviewer = { providerInstanceId: "codex", model: "existing-reviewer" };
      const defaultAgent = { providerInstanceId: "codex", model: "new-default" };
      const updated = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          steps: [
            {
              id: "S1",
              title: "Change",
              goal: "Make a change",
              acceptanceCriteria: ["Works"],
              reviewer,
            },
          ],
        });
        return yield* service.updateConfig({
          projectRoot: repo,
          threadId,
          defaultAgent,
          applyToPendingSteps: true,
        });
      }).pipe(Effect.provide(makeDispatchTestLayer(repo)));
      expect(updated.steps[0]).toMatchObject({ executor: defaultAgent, reviewer });
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

  itEffect.effect("lists cross-project dispatch attention items with blocked downstream steps", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vela-attn-state-"));

      // Pre-populate a ready_to_accept step on disk for thr-attn-1 (tests disk discovery)
      const preStore = new VelaDispatchStore(stateDir);
      yield* Effect.promise(() =>
        preStore.update(
          { projectRoot: repo, threadId: "thr-attn-1" },
          (curr) => ({
            ...curr,
            planTitle: "导出重构计划",
            steps: [
              {
                id: "S1",
                order: 1,
                title: "调研编码兼容",
                goal: "检查 BOM 与 UTF-8",
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
                executor: { providerInstanceId: "codex" },
                status: "ready_to_accept",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:01:00.000Z",
              },
              {
                id: "S2",
                order: 2,
                title: "实现导出修复",
                goal: "写入导出补丁",
                kind: "change",
                isolation: "direct",
                dependsOn: ["S1"],
                premisesToVerify: [],
                contextFiles: [],
                acceptanceCriteria: ["导出正常"],
                allowedGlobs: [],
                forbiddenGlobs: [],
                sensitiveGlobs: [],
                hardGates: [],
                executor: { providerInstanceId: "codex" },
                status: "locked",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      );

      const layer = makeDispatchTestLayer(repo, {
        stateDir,
        activeShell: true,
      });

      const items = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-attn-2",
          parentThreadId: "thr-attn-2",
          planTitle: "重试策略方案",
          steps: [
            {
              id: "D1",
              title: "选择重试策略",
              goal: "确认指数退避还是固定间隔",
              kind: "decision",
              dependsOn: [],
              decisionOptions: [
                { id: "A", label: "指数退避" },
                { id: "B", label: "固定间隔" },
              ],
            },
            {
              id: "D2",
              title: "接入支付重试",
              goal: "按所选策略改造",
              kind: "change",
              dependsOn: ["D1"],
              acceptanceCriteria: ["重试生效"],
            },
          ],
        });
        return yield* service.listAttentionItems();
      }).pipe(Effect.provide(layer));

      expect(items).toHaveLength(2);
      const acceptItem = items.find((item) => item.stepId === "S1");
      expect(acceptItem).toMatchObject({
        kind: "accept",
        threadId: "thr-attn-1",
        stepTitle: "调研编码兼容",
        blockedStepTitles: ["S2 实现导出修复"],
      });

      const decisionItem = items.find((item) => item.stepId === "D1");
      expect(decisionItem).toMatchObject({
        kind: "decision",
        threadId: "thr-attn-2",
        stepTitle: "选择重试策略",
        blockedStepTitles: ["D2 接入支付重试"],
      });
    }),
  );

  itEffect.effect("admits only one launch when the same step is started twice", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
      let releaseProviders!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProviders = resolve;
      });
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      let deferredProviders = 0;
      let lookups = 0;
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        providerGate,
        launchGate,
        onDeferredProvider: () => {
          deferredProviders += 1;
        },
        onProjectLookup: () => {
          lookups += 1;
        },
        onLaunch: (input) => {
          launches.push(input);
        },
      });

      const outcome = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-dup-launch",
          parentThreadId: "thr-dup-launch",
          steps: [
            {
              id: "S1",
              title: "Inspect once",
              goal: "Read the tree",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });

        const firstFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-dup-launch",
            parentThreadId: "thr-dup-launch",
            stepId: "S1",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => deferredProviders >= 1, "first admission"));
        const secondFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-dup-launch",
            parentThreadId: "thr-dup-launch",
            stepId: "S1",
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => lookups >= 3, "second lookup"));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(deferredProviders).toBe(1);
        releaseProviders();

        const first = yield* Fiber.join(firstFiber);
        const secondError = yield* Fiber.join(secondFiber);
        yield* Effect.promise(() => waitUntil(() => launches.length >= 1, "child launch"));
        expect(launches).toHaveLength(1);
        return { first, secondError };
      }).pipe(Effect.provide(layer));

      releaseLaunch();
      expect(outcome.secondError.message).toContain("正在运行中");
      expect(outcome.first.steps.find((step) => step.id === "S1")?.status).toBe("running");
    }),
  );

  itEffect.effect("upgrades an overlapping direct-write step to a worktree instead of a second writer", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
      let releaseProviders!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProviders = resolve;
      });
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      let deferredProviders = 0;
      let lookups = 0;
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        providerGate,
        launchGate,
        onDeferredProvider: () => {
          deferredProviders += 1;
        },
        onProjectLookup: () => {
          lookups += 1;
        },
        onLaunch: (input) => {
          launches.push(input);
        },
      });

      const outcome = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-direct-race",
          parentThreadId: "thr-direct-race",
          steps: [
            {
              id: "S1",
              title: "Edit A",
              goal: "Change A",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["A updated"],
              executor: { providerInstanceId: "codex" },
            },
            {
              id: "S2",
              title: "Edit B",
              goal: "Change B",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["B updated"],
              executor: { providerInstanceId: "codex" },
            },
          ],
        });

        const firstFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-direct-race",
            parentThreadId: "thr-direct-race",
            stepId: "S1",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => deferredProviders >= 1, "first direct admission"));
        const secondFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-direct-race",
            parentThreadId: "thr-direct-race",
            stepId: "S2",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => lookups >= 3, "second direct lookup"));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(deferredProviders).toBe(1);
        releaseProviders();

        const first = yield* Fiber.join(firstFiber);
        const second = yield* Fiber.join(secondFiber);
        yield* Effect.promise(() => waitUntil(() => launches.length >= 2, "both child launches"));
        return { first, second };
      }).pipe(Effect.provide(layer));

      const strategies = launches.map((launch) => launch.workspaceStrategy?.type).toSorted();
      expect(strategies).toEqual(["root", "worktree"]);
      expect(outcome.first.runs.S1?.isolation).toBe("direct");
      expect(outcome.second.runs.S2?.isolation).toBe("worktree");
      expect(
        launches.filter((launch) => launch.workspaceStrategy?.type === "root"),
      ).toHaveLength(1);
      releaseLaunch();
    }),
  );

  itEffect.effect("rejects a second self direct-write while another direct step is being admitted", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const sends: string[] = [];
      let releaseProviders!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProviders = resolve;
      });
      let releaseHold!: () => void;
      const holdBackground = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let deferredProviders = 0;
      let lookups = 0;
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        providerGate,
        holdBackground,
        onDeferredProvider: () => {
          deferredProviders += 1;
        },
        onProjectLookup: () => {
          lookups += 1;
        },
        onSendToThread: (text) => {
          sends.push(text);
        },
      });

      const outcome = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-self-race",
          parentThreadId: "thr-self-race",
          steps: [
            {
              id: "S1",
              title: "Self A",
              goal: "Edit A in the current chat",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["A updated"],
              executor: "self",
            },
            {
              id: "S2",
              title: "Self B",
              goal: "Edit B in the current chat",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["B updated"],
              executor: "self",
            },
          ],
        });

        const firstFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-self-race",
            parentThreadId: "thr-self-race",
            stepId: "S1",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => deferredProviders >= 1, "first self admission"));
        const secondFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-self-race",
            parentThreadId: "thr-self-race",
            stepId: "S2",
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => lookups >= 3, "second self lookup"));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(deferredProviders).toBe(1);
        releaseProviders();

        const first = yield* Fiber.join(firstFiber);
        const secondError = yield* Fiber.join(secondFiber);
        yield* Effect.promise(() => waitUntil(() => sends.length >= 1, "self send"));
        return { first, secondError };
      }).pipe(Effect.provide(layer));

      expect(outcome.secondError.message).toContain("当前分支直写已有 S1 运行中");
      expect(outcome.first.runs.S1?.isolation).toBe("direct");
      expect(sends).toHaveLength(1);
      releaseHold();
    }),
  );

  itEffect.effect("sends one continuation when replyEscalation resumes overlap", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-reply-dup";
      const seed = new VelaDispatchStore(stateDir);
      yield* Effect.promise(() =>
        seed.update({ projectRoot: repo, threadId }, (curr) => ({
          ...curr,
          parentThreadId: threadId,
          steps: [makeDispatchStep("S1", "needs_human_decision")],
          runs: { S1: makeDispatchRun("S1", { workspacePath: repo, childThreadId: "thr-child-s1" }) },
          escalations: [makeEscalation("ESC-1", "S1")],
        })),
      );
      const sends: string[] = [];
      let releaseHold!: () => void;
      const holdBackground = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let lookups = 0;
      const disk = deferFirstStateJsonWrite(stateDir);
      const layer = makeDispatchTestLayer(repo, {
        stateDir,
        activeShell: true,
        holdBackground,
        onProjectLookup: () => {
          lookups += 1;
        },
        onSendToThread: (text) => {
          sends.push(text);
        },
      });

      const outcome = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        const reply = {
          projectRoot: repo,
          threadId,
          escalationId: "ESC-1",
          decision: "Continue with the patch",
          resolvedBy: "human" as const,
        };
        const firstFiber = yield* service.replyEscalation(reply).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          Promise.race([
            disk.paused,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("reply write was not deferred")), 2000),
            ),
          ]),
        );
        const secondFiber = yield* service
          .replyEscalation(reply)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => lookups >= 2, "second reply lookup"));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(sends).toHaveLength(0);
        disk.release();
        const first = yield* Fiber.join(firstFiber);
        const secondError = yield* Fiber.join(secondFiber);
        yield* Effect.promise(() => waitUntil(() => sends.length >= 1, "reply send"));
        yield* service.clearPlan(repo, threadId);
        return { first, secondError };
      }).pipe(Effect.provide(layer));

      expect(outcome.secondError.message).toMatch(/正在运行中|已处理/);
      expect(outcome.first.steps.find((step) => step.id === "S1")?.status).toBe("running");
      expect(sends).toHaveLength(1);
      releaseHold();
      disk.restore();
    }),
  );

  itEffect.effect("sends one repair when failed submitAcceptance calls overlap", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-accept-dup";
      const seed = new VelaDispatchStore(stateDir);
      yield* Effect.promise(() =>
        seed.update({ projectRoot: repo, threadId }, (curr) => ({
          ...curr,
          parentThreadId: threadId,
          steps: [makeDispatchStep("S1", "awaiting_product_acceptance")],
          runs: {
            S1: makeDispatchRun("S1", {
              workspacePath: repo,
              childThreadId: "thr-child-s1",
              status: "awaiting_product_acceptance",
              acceptanceRound: 0,
            }),
          },
        })),
      );
      const sends: string[] = [];
      let releaseHold!: () => void;
      const holdBackground = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let lookups = 0;
      const disk = deferFirstStateJsonWrite(stateDir);
      const layer = makeDispatchTestLayer(repo, {
        stateDir,
        activeShell: true,
        holdBackground,
        onProjectLookup: () => {
          lookups += 1;
        },
        onSendToThread: (text) => {
          sends.push(text);
        },
      });
      const acceptance = {
        projectRoot: repo,
        threadId,
        stepId: "S1",
        summary: "Export is still broken",
        items: [{ criterion: "done", status: "failed" as const, reason: "missing export" }],
      };

      const outcome = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        const firstFiber = yield* service.submitAcceptance(acceptance).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          Promise.race([
            disk.paused,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("acceptance write was not deferred")), 2000),
            ),
          ]),
        );
        const secondFiber = yield* service
          .submitAcceptance(acceptance)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => lookups >= 2, "second acceptance lookup"));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(sends).toHaveLength(0);
        disk.release();
        const first = yield* Fiber.join(firstFiber);
        const secondError = yield* Fiber.join(secondFiber);
        yield* Effect.promise(() => waitUntil(() => sends.length >= 1, "acceptance send"));
        yield* service.clearPlan(repo, threadId);
        return { first, secondError };
      }).pipe(Effect.provide(layer));

      expect(outcome.secondError.message).toContain("正在运行中");
      expect(outcome.first.steps.find((step) => step.id === "S1")?.status).toBe(
        "fixing_acceptance",
      );
      expect(sends).toHaveLength(1);
      releaseHold();
      disk.restore();
    }),
  );

  itEffect.effect("rejects a direct escalation resume and acceptance repair while another direct step is active", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-direct-busy";
      const seed = new VelaDispatchStore(stateDir);
      yield* Effect.promise(() =>
        seed.update({ projectRoot: repo, threadId }, (curr) => ({
          ...curr,
          parentThreadId: threadId,
          steps: [
            makeDispatchStep("S1", "running"),
            makeDispatchStep("S2", "needs_human_decision", { order: 2 }),
            makeDispatchStep("S3", "awaiting_product_acceptance", { order: 3 }),
          ],
          runs: {
            S1: makeDispatchRun("S1", { workspacePath: repo, status: "running", childThreadId: "thr-s1" }),
            S2: makeDispatchRun("S2", {
              workspacePath: repo,
              status: "needs_human_decision",
              childThreadId: "thr-s2",
            }),
            S3: makeDispatchRun("S3", {
              workspacePath: repo,
              status: "awaiting_product_acceptance",
              childThreadId: "thr-s3",
              acceptanceRound: 0,
            }),
          },
          escalations: [makeEscalation("ESC-2", "S2")],
        })),
      );
      const sends: string[] = [];
      const layer = makeDispatchTestLayer(repo, {
        stateDir,
        activeShell: true,
        onSendToThread: (text) => {
          sends.push(text);
        },
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        const replyError = yield* service
          .replyEscalation({
            projectRoot: repo,
            threadId,
            escalationId: "ESC-2",
            decision: "Keep going",
            resolvedBy: "orchestrator",
          })
          .pipe(Effect.flip);
        const acceptanceError = yield* service
          .submitAcceptance({
            projectRoot: repo,
            threadId,
            stepId: "S3",
            summary: "Still failing",
            items: [{ criterion: "done", status: "failed", reason: "not fixed" }],
          })
          .pipe(Effect.flip);
        const state = yield* Effect.promise(() =>
          new VelaDispatchStore(stateDir).read({ projectRoot: repo, threadId }),
        );
        return { replyError, acceptanceError, state };
      }).pipe(Effect.provide(layer));

      expect(result.replyError.message).toContain("当前分支直写已有 S1 运行中");
      expect(result.acceptanceError.message).toContain("当前分支直写已有 S1 运行中");
      expect(result.state.steps.find((step) => step.id === "S2")?.status).toBe(
        "needs_human_decision",
      );
      expect(result.state.steps.find((step) => step.id === "S3")?.status).toBe(
        "awaiting_product_acceptance",
      );
      expect(sends).toHaveLength(0);
    }),
  );

  itEffect.effect("does not leave a step running when replyEscalation has no child thread", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-reply-orphan";
      const seed = new VelaDispatchStore(stateDir);
      yield* Effect.promise(() =>
        seed.update({ projectRoot: repo, threadId }, (curr) => ({
          ...curr,
          parentThreadId: threadId,
          steps: [makeDispatchStep("S1", "needs_human_decision")],
          runs: {
            S1: makeDispatchRun("S1", {
              workspacePath: repo,
              childThreadId: null,
              status: "needs_human_decision",
            }),
          },
          escalations: [makeEscalation("ESC-orphan", "S1")],
        })),
      );
      const layer = makeDispatchTestLayer(repo, { stateDir, activeShell: true });
      const state = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        return yield* service.replyEscalation({
          projectRoot: repo,
          threadId,
          escalationId: "ESC-orphan",
          decision: "Restart it",
          resolvedBy: "human",
        });
      }).pipe(Effect.provide(layer));

      expect(state.steps.find((step) => step.id === "S1")?.status).toBe("ready");
      expect(state.runs.S1?.status).toBe("ready");
      expect(state.escalations.find((esc) => esc.id === "ESC-orphan")?.status).toBe("resolved");
    }),
  );

  itEffect.effect("does not resurrect a step when clearPlan overlaps launch preparation", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
      let releaseProviders!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProviders = resolve;
      });
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      let deferredProviders = 0;
      let cleared = false;
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        providerGate,
        launchGate,
        onDeferredProvider: () => {
          deferredProviders += 1;
        },
        onLaunch: (input) => {
          launches.push(input);
        },
      });

      const finalState = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-clear-race",
          parentThreadId: "thr-clear-race",
          steps: [
            {
              id: "S1",
              title: "Inspect",
              goal: "Read",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });
        const launchFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-clear-race",
            parentThreadId: "thr-clear-race",
            stepId: "S1",
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => deferredProviders >= 1, "paused launch"));
        const clearFiber = yield* service
          .clearPlan(repo, "thr-clear-race")
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                cleared = true;
              }),
            ),
            Effect.forkChild,
          );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 40)));
        expect(cleared).toBe(false);
        releaseProviders();
        yield* Fiber.join(launchFiber);
        yield* Fiber.join(clearFiber);
        return yield* service.getState(repo, "thr-clear-race");
      }).pipe(Effect.provide(layer));

      expect(finalState.steps).toEqual([]);
      expect(finalState.runs).toEqual({});
      releaseLaunch();
      expect(launches.length).toBeLessThanOrEqual(1);
    }),
  );

  itEffect.effect("keeps a sibling running when completeSelfStep finishes its hard gate", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const started = NodePath.join(repo, "gate-started");
      const release = NodePath.join(repo, "gate-release");
      const command = `touch ${JSON.stringify(started)} && while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done`;
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const launches: string[] = [];
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        launchGate,
        onLaunch: (input) => {
          launches.push(input.title);
        },
      });

      const state = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-self-sibling",
          parentThreadId: "thr-self-sibling",
          steps: [
            {
              id: "S1",
              title: "Self edit",
              goal: "Finish the local edit",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["done"],
              executor: "self",
              hardGates: [command],
            },
            {
              id: "S2",
              title: "Sibling research",
              goal: "Look around",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });
        const selfFiber = yield* service
          .completeSelfStep({
            projectRoot: repo,
            threadId: "thr-self-sibling",
            stepId: "S1",
            summary: "Finished locally",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitUntil(() => NodeFS.existsSync(started), "hard gate started"),
        );
        yield* service.dispatchStep({
          projectRoot: repo,
          threadId: "thr-self-sibling",
          parentThreadId: "thr-self-sibling",
          stepId: "S2",
        });
        NodeFS.writeFileSync(release, "go\n");
        const completed = yield* Fiber.join(selfFiber);
        return completed;
      }).pipe(Effect.provide(layer));

      expect(state.steps.find((step) => step.id === "S1")?.status).toBe("done");
      expect(state.steps.find((step) => step.id === "S2")?.status).toBe("running");
      expect(launches).toHaveLength(1);
      releaseLaunch();
    }),
  );

  itEffect.effect("still launches a step when a dispatch subscriber throws", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const launches: string[] = [];
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        launchGate,
        onLaunch: (input) => {
          launches.push(input.title);
        },
      });

      const subscriberThrows = { count: 0 };
      const state = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        const unsubscribe = service.subscribe(
          repo,
          throwingDispatchSubscriber(subscriberThrows),
          "thr-subscriber",
        );
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-subscriber",
          parentThreadId: "thr-subscriber",
          steps: [
            {
              id: "S1",
              title: "Inspect",
              goal: "Read",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });
        const launched = yield* service.dispatchStep({
          projectRoot: repo,
          threadId: "thr-subscriber",
          parentThreadId: "thr-subscriber",
          stepId: "S1",
        });
        unsubscribe();
        expect(subscriberThrows.count).toBeGreaterThan(0);
        return launched;
      }).pipe(Effect.provide(layer));

      expect(state.steps.find((step) => step.id === "S1")?.status).toBe("running");
      expect(launches).toHaveLength(1);
      releaseLaunch();
    }),
  );

  itEffect.effect("project clearPlan leaves a thread-scoped direct run reserved", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        launchGate,
        onLaunch: () => {},
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-keep",
          parentThreadId: "thr-keep",
          steps: [
            {
              id: "S1",
              title: "Thread edit",
              goal: "Edit in this thread",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["done"],
              executor: { providerInstanceId: "codex" },
              reviewer: null,
            },
          ],
        });
        const running = yield* service.dispatchStep({
          projectRoot: repo,
          threadId: "thr-keep",
          parentThreadId: "thr-keep",
          stepId: "S1",
        });
        yield* service.clearPlan(repo);
        yield* service.publishPlan({
          projectRoot: repo,
          threadId: "thr-other",
          parentThreadId: "thr-other",
          steps: [
            {
              id: "S1",
              title: "Other self edit",
              goal: "Edit in another thread",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["done"],
              executor: "self",
            },
          ],
        });
        const blocked = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId: "thr-other",
            parentThreadId: "thr-other",
            stepId: "S1",
          })
          .pipe(Effect.flip);
        const kept = yield* service.getState(repo, "thr-keep");
        return { running, blocked, kept };
      }).pipe(Effect.provide(layer));

      expect(result.running.runs.S1?.isolation).toBe("direct");
      expect(result.blocked.message).toContain("同一工作区另一对话正在执行当前分支直写");
      expect(result.kept.steps.find((step) => step.id === "S1")?.status).toBe("running");
      releaseLaunch();
    }),
  );

  itEffect.effect("does not append a ghost escalation when clearPlan aborts a hard gate", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const stateDir = createTempStateDir();
      const threadId = "thr-gate-clear";
      const started = NodePath.join(repo, "gate-started");
      const release = NodePath.join(repo, "gate-release");
      const command = `touch ${JSON.stringify(started)} && while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done`;
      const layer = makeDispatchTestLayer(repo, {
        stateDir,
        activeShell: true,
        onLaunch: () => {},
        getThreadProjection: () => null,
      });

      yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          parentThreadId: threadId,
          steps: [
            {
              id: "S1",
              title: "Gated edit",
              goal: "Run a gate",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["done"],
              hardGates: [command],
              reviewer: null,
            },
          ],
        });
        yield* service.dispatchStep({
          projectRoot: repo,
          threadId,
          parentThreadId: threadId,
          stepId: "S1",
        });
        yield* Effect.promise(() => waitUntil(() => NodeFS.existsSync(started), "hard gate started"));
        const cleared = yield* service.clearPlan(repo, threadId);
        NodeFS.writeFileSync(release, "go\n");
        expect(cleared.steps).toEqual([]);
        expect(cleared.escalations).toEqual([]);
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const state = await new VelaDispatchStore(stateDir).read({
              projectRoot: repo,
              threadId,
            });
            if (state.escalations.length > 0) {
              throw new Error(`ghost escalation: ${state.escalations.map((e) => e.kind).join(",")}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  itEffect.effect("does not apply a stale self-complete onto a replacement plan", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const threadId = "thr-replace-self";
      const started = NodePath.join(repo, "gate-started-self");
      const release = NodePath.join(repo, "gate-release-self");
      const command = `touch ${JSON.stringify(started)} && while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done`;
      const layer = makeDispatchTestLayer(repo, { activeShell: true });

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          parentThreadId: threadId,
          planTitle: "Old plan",
          steps: [
            {
              id: "S1",
              title: "Old card",
              goal: "Old goal",
              kind: "change",
              isolation: "direct",
              dependsOn: [],
              acceptanceCriteria: ["done"],
              executor: "self",
              hardGates: [command],
            },
          ],
        });
        const selfFiber = yield* service
          .completeSelfStep({
            projectRoot: repo,
            threadId,
            stepId: "S1",
            summary: "stale completion",
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() =>
          waitUntil(() => NodeFS.existsSync(started), "self gate started"),
        );
        const replaced = yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          parentThreadId: threadId,
          planTitle: "New plan",
          steps: [
            {
              id: "S1",
              title: "Replacement card",
              goal: "New goal",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });
        NodeFS.writeFileSync(release, "go\n");
        const staleError = yield* Fiber.join(selfFiber);
        const latest = yield* service.getState(repo, threadId);
        return { replaced, staleError, latest };
      }).pipe(Effect.provide(layer));

      expect(result.staleError.message).toContain("协作计划已更换或清空");
      expect(result.replaced.planTitle).toBe("New plan");
      expect(result.latest.steps.find((step) => step.id === "S1")?.title).toBe("Replacement card");
      expect(result.latest.steps.find((step) => step.id === "S1")?.status).toBe("ready");
    }),
  );

  itEffect.effect("does not overwrite a replacement plan or run from an overlapping launch", () =>
    Effect.gen(function* () {
      const repo = createTempGitRepo();
      const threadId = "thr-replace-launch";
      const launches: string[] = [];
      let releaseProviders!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProviders = resolve;
      });
      let releaseFirstLaunch!: () => void;
      const firstLaunchGate = new Promise<void>((resolve) => {
        releaseFirstLaunch = resolve;
      });
      let deferredProviders = 0;
      let launchCount = 0;
      const layer = makeDispatchTestLayer(repo, {
        activeShell: true,
        providerGate,
        onDeferredProvider: () => {
          deferredProviders += 1;
        },
        launchGate: firstLaunchGate,
        onLaunch: (input) => {
          launchCount += 1;
          launches.push(input.title);
        },
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* VelaDispatchService;
        yield* service.publishPlan({
          projectRoot: repo,
          threadId,
          parentThreadId: threadId,
          planTitle: "Old plan",
          steps: [
            {
              id: "S1",
              title: "Old card",
              goal: "Old goal",
              kind: "research",
              dependsOn: [],
              reviewer: null,
            },
          ],
        });
        const launchFiber = yield* service
          .dispatchStep({
            projectRoot: repo,
            threadId,
            parentThreadId: threadId,
            stepId: "S1",
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Effect.promise(() => waitUntil(() => deferredProviders >= 1, "paused launch"));
        const replaceFiber = yield* service
          .publishPlan({
            projectRoot: repo,
            threadId,
            parentThreadId: threadId,
            planTitle: "New plan",
            steps: [
              {
                id: "S1",
                title: "Replacement card",
                goal: "New goal",
                kind: "research",
                dependsOn: [],
                reviewer: null,
              },
            ],
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));
        releaseProviders();
        yield* Fiber.join(launchFiber);
        const replaced = yield* Fiber.join(replaceFiber);
        // Release the aborted old launch callback after the replacement plan is active.
        releaseFirstLaunch();
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 40)));
        const latest = yield* service.getState(repo, threadId);
        return { replaced, latest };
      }).pipe(Effect.provide(layer));

      expect(result.replaced.planTitle).toBe("New plan");
      expect(result.latest.planTitle).toBe("New plan");
      expect(result.latest.steps.find((step) => step.id === "S1")?.title).toBe("Replacement card");
      expect(result.latest.steps.find((step) => step.id === "S1")?.status).toBe("ready");
      expect(result.latest.runs).toEqual({});
      expect(launchCount).toBeLessThanOrEqual(1);
    }),
  );
});
