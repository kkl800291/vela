// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import {
  type ThreadLaunchInput,
  type ThreadLaunchResult,
  ThreadLaunchService,
} from "../orchestration-v2/ThreadLaunchService.ts";
import {
  type ThreadManagementSendInput,
  type ThreadManagementSendResult,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { layer as engineLayer, VelaCollabEngine } from "./VelaCollabEngine.ts";
import type { CollabStepInput } from "./VelaCollabScheduling.ts";
import { layer as storeLayer, VelaCollabStore } from "./VelaCollabStore.ts";
import type { CollabInboxItem, CollabStep, VelaCollabProjection } from "./VelaCollabTypes.ts";

export const environmentId = EnvironmentId.make("collab-engine-test");
export const projectId = ProjectId.make("test-project");
export const parentThreadId = ThreadId.make("orchestrator");
export const scope = { environmentId, parentThreadId };
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "default" };
const cleanup: Array<() => Promise<void>> = [];

export const git = (directory: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

export const definition = (
  stepId: string,
  overrides: Partial<CollabStepInput> = {},
): CollabStepInput => ({
  stepId,
  title: stepId,
  objective: `Implement ${stepId}`,
  kind: "change",
  criteria: [{ id: "works", text: "The change meets the requirement." }],
  ...overrides,
});

export async function disposeFixtures() {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
}

export async function eventually<A>(
  read: () => Promise<A>,
  accept: (value: A) => boolean,
  label: string,
) {
  let value: A | undefined;
  await expect
    .poll(
      async () => {
        value = await read();
        return accept(value);
      },
      { interval: 30, timeout: 9000, message: label },
    )
    .toBe(true);
  return value!;
}

export async function fixture(
  steps: ReadonlyArray<CollabStepInput>,
  options: {
    readonly batchGates?: ReadonlyArray<string>;
    readonly enableBatchAudit?: boolean;
    readonly beforeSend?: (input: ThreadManagementSendInput) => Effect.Effect<void>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vela-collab-engine-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "shared"), "one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix\n");
  await writeFile(join(repo, "user"), "opening\n");
  git(repo, "add", ".");
  git(
    repo,
    "update-ref",
    "HEAD",
    git(repo, "commit-tree", git(repo, "write-tree"), "-m", "fixture"),
  );
  const baseHead = git(repo, "rev-parse", "HEAD");

  const launched: ThreadLaunchInput[] = [];
  const sends: ThreadManagementSendInput[] = [];
  const switches: Array<{
    threadId: ThreadId;
    previous: string | null | undefined;
    path: string | null | undefined;
  }> = [];
  const paths = new Map<ThreadId, string | null>([[parentThreadId, null]]);
  const runs = new Map<RunId, OrchestrationV2Run>();
  const sendReceipts = new Map<string, ThreadManagementSendResult>();
  const launchReceipts = new Map<string, ThreadLaunchResult>();
  const runFor = (threadId: ThreadId, userMessageId: OrchestrationV2Run["userMessageId"]) => {
    const run = {
      id: RunId.make(`run-${runs.size + 1}`),
      threadId,
      userMessageId,
      status: "running",
    } as OrchestrationV2Run;
    runs.set(run.id, run);
    return run;
  };
  const complete = (runId: string, value?: NonNullable<OrchestrationV2Run["output"]>["value"]) => {
    const run = runs.get(RunId.make(runId));
    if (!run) throw new Error(`Unknown fixture run ${runId}`);
    runs.set(run.id, {
      ...run,
      status: "completed",
      ...(value === undefined
        ? {}
        : {
            output: { submittedAt: "2026-11-26T00:00:00.000Z", value },
          }),
    });
  };
  const database = ManagedRuntime.make(storeLayer.pipe(Layer.provide(layerMemory)));
  cleanup.push(() => database.dispose());
  const store = await database.runPromise(VelaCollabStore);
  const dependencies = Layer.mergeAll(
    Layer.succeed(VelaCollabStore, store),
    Layer.mock(ServerConfig)({ stateDir: root } as ServerConfig["Service"]),
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Fixture",
          workspaceRoot: repo,
          defaultModelSelection: null,
          scripts: [],
          deletedAt: null,
          createdAt: "2026-11-26T00:00:00.000Z",
          updatedAt: "2026-11-26T00:00:00.000Z",
        }),
    }),
    Layer.mock(ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const previous = launchReceipts.get(input.commandId);
          if (previous) return { ...previous, resumed: true };
          launched.push(input);
          const threadId = input.threadId!;
          paths.set(
            threadId,
            input.workspaceStrategy.type === "existing_worktree"
              ? input.workspaceStrategy.worktreePath
              : null,
          );
          const run = runFor(threadId, input.initialMessage!.messageId!);
          const result = {
            threadId,
            resumed: false,
            projection: { runs: [run] },
          } as unknown as ThreadLaunchResult;
          launchReceipts.set(input.commandId, result);
          return result;
        }),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed({ ...liveThreadShell(threadId), projectId }),
      hasReceipt: (id) => Effect.sync(() => sendReceipts.has(id)),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.sync(() => ({
          runs: [...runs.values()].filter((run) => run.threadId === threadId),
          messages: [...sendReceipts.values()]
            .filter(({ run }) => run.threadId === threadId)
            .map(({ message }) => ({ ...message, createdBy: "system", creationSource: "server" })),
        }))) as ThreadManagementService["Service"]["getThreadRecords"],
      streamStoredEvents: Stream.empty,
      waitForThread: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          run: input.runId ? (runs.get(input.runId) ?? null) : null,
          timedOut: false,
        }),
      getProjectThreadRecords: ((input: { threadId: ThreadId }) =>
        Effect.sync(() => ({
          thread: {
            id: input.threadId,
            projectId,
            archivedAt: null,
            deletedAt: null,
            modelSelection,
            runtimeMode: "auto",
            worktreePath: paths.get(input.threadId),
          },
          runs: Array.from(runs.values()).filter(({ threadId }) => threadId === input.threadId),
        }))) as ThreadManagementService["Service"]["getProjectThreadRecords"],
      sendToThread: (input) =>
        Effect.gen(function* () {
          const previous = sendReceipts.get(input.commandId);
          if (previous) return previous;
          sends.push(input);
          const run = runFor(input.threadId, input.messageId);
          const result = {
            run,
            delivery: "queued",
            message: { id: input.messageId, runId: run.id },
          } as unknown as ThreadManagementSendResult;
          sendReceipts.set(input.commandId, result);
          if (options.beforeSend) yield* options.beforeSend(input);
          return result;
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "thread.metadata.update") throw new Error("Unexpected command");
          expect(paths.get(command.threadId)).toBe(command.expectedWorktreePath);
          paths.set(command.threadId, command.worktreePath ?? null);
          switches.push({
            threadId: command.threadId,
            previous: command.expectedWorktreePath,
            path: command.worktreePath,
          });
          return {} as Effect.Success<ReturnType<ThreadManagementService["Service"]["dispatch"]>>;
        }),
      interruptThread: () => Effect.succeed({ type: "no_active_run" }),
    }),
  );
  let runtime = ManagedRuntime.make(engineLayer.pipe(Layer.provide(dependencies)));
  cleanup.push(() => runtime.dispose());
  let engine = await runtime.runPromise(VelaCollabEngine);
  const planId = await Effect.runPromise(
    engine.createAndStartPlan({
      ...scope,
      projectId,
      title: "Collaboration",
      requirement: "Deliver an immutable batch",
      steps,
      ...(options.batchGates ? { batchGates: options.batchGates } : {}),
      ...(options.enableBatchAudit === undefined
        ? {}
        : { enableBatchAudit: options.enableBatchAudit }),
    }),
  );
  const command = { ...scope, planId };
  const step = (id: string) => Effect.runPromise(store.getStep(planId, id));
  const status = (id: string, condition: (step: CollabStep) => boolean) =>
    eventually(
      () => step(id),
      (value) => !!value && condition(value),
      `step ${id}`,
    ) as Promise<CollabStep>;
  const worker = (id: string, attempt = 1) =>
    status(
      id,
      (value) => value.status === "developing" && value.attempt === attempt && !!value.workerRunId,
    );
  const finish = async (id: string, files: Record<string, string>, attempt = 1) => {
    const current = await worker(id, attempt);
    for (const [path, contents] of Object.entries(files))
      await writeFile(join(current.worktreePath!, path), contents);
    complete(current.workerRunId!, { outcome: "complete", summary: "Implemented" });
    return current;
  };
  const inbox = (condition: (item: CollabInboxItem) => boolean) =>
    eventually(
      () => Effect.runPromise(store.getActiveInbox(scope)),
      (item) => item?.status === "dispatched" && condition(item),
      "active inbox",
    ) as Promise<CollabInboxItem>;
  const review = (id: string) => inbox((item) => item.kind === "review" && item.stepId === id);
  const projection = (condition: (projection: VelaCollabProjection) => boolean) =>
    eventually(
      () => Effect.runPromise(engine.getProjection(command)),
      (value) => !!value && condition(value),
      "plan projection",
    ) as Promise<VelaCollabProjection>;
  const verdictInput = (
    item: CollabInboxItem,
    verdict: "approve" | "request_changes" = "approve",
  ) => ({
    ...command,
    stepId: item.stepId!,
    reviewId: item.reviewId!,
    callerRunId: item.threadRunId!,
    verdict,
    summary: "Reviewed",
    findings: [],
    criteriaResults: [{ criterionId: "works", result: "pass" as const }],
  });
  const approve = async (item: CollabInboxItem) => {
    await Effect.runPromise(engine.submitReviewVerdict(verdictInput(item)));
    complete(item.threadRunId!);
  };
  const restart = async () => {
    await runtime.dispose();
    runtime = ManagedRuntime.make(engineLayer.pipe(Layer.provide(dependencies)));
    engine = await runtime.runPromise(VelaCollabEngine);
  };
  return {
    dependencies,
    repo,
    store,
    planId,
    command,
    baseHead,
    step,
    status,
    worker,
    finish,
    review,
    inbox,
    approve,
    complete,
    launched,
    sends,
    switches,
    verdictInput,
    projection,
    restart,
    get engine() {
      return engine;
    },
  };
}
