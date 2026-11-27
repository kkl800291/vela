// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { CommandId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import {
  isTerminalRunStatus,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Git from "./VelaCollabGit.ts";
import { resolveTree, type GitBinding } from "./VelaCollabGitObjects.ts";
import {
  affectedSteps,
  auditOutputSchema,
  clearStepEvidence,
  type CollabStepInput,
  defineStep,
  gateSummaryForWake,
  readAuditOutput,
  readWorkerOutput,
  reviewWakePayload,
  stepComplete,
  topologicalSteps,
  unlockSteps,
  workerOutputSchema,
  workerPrompt,
} from "./VelaCollabScheduling.ts";
import {
  type CollabTransition,
  targetWorktreeLeaseResource,
  VelaCollabStore,
} from "./VelaCollabStore.ts";
import type {
  BatchAuditRecord,
  CollabAttentionReason,
  CollabGateSummary,
  CollabDeliveryDrift,
  CollabInboxItem,
  CollabInboxWake,
  CollabOperationLease,
  CollabOutboxIntent,
  CollabPlan,
  CollabRecord,
  CollabReviewEvidence,
  CollabReviewVerdict,
  CollabScope,
  CollabStep,
  DeliveryRecord,
  VelaCollabProjection,
} from "./VelaCollabTypes.ts";
import { toModelSelection } from "./VelaDispatchService.ts";
import type { DispatchAgentTarget } from "./VelaDispatchTypes.ts";
import { hasDirectWorkspaceWriter, withWorkspaceAdmission } from "./workspaceAdmission.ts";

export class VelaCollabError extends Schema.TaggedError<
  VelaCollabError,
  { readonly brand: unique symbol }
>()("VelaCollabError", {
  message: Schema.String,
}) {}

type PlanOptions = Pick<
  CollabPlan,
  | "title"
  | "requirement"
  | "batchGates"
  | "defaultDevAgent"
  | "enableBatchAudit"
  | "batchAuditAgent"
>;

export interface CreateCollabPlanInput extends CollabScope {
  readonly projectId: string;
  readonly targetWorktree?: string;
  readonly autoStart?: boolean;
  readonly title: string;
  readonly requirement: string;
  readonly batchGates?: PlanOptions["batchGates"];
  readonly defaultDevAgent?: PlanOptions["defaultDevAgent"];
  readonly enableBatchAudit?: boolean;
  readonly batchAuditAgent?: PlanOptions["batchAuditAgent"];
  readonly steps: ReadonlyArray<CollabStepInput>;
}

interface PlanCommand extends CollabScope {
  readonly planId: string;
}

interface VersionedPlanCommand extends PlanCommand {
  readonly expectedPlanVersion: number;
}

interface ReviewInput
  extends PlanCommand, Omit<CollabReviewVerdict, "reviewerRunId" | "decidedAt"> {
  readonly stepId: string;
  readonly callerRunId: string;
}

interface DeliveryInput extends PlanCommand {
  readonly deliveryId: string;
  readonly expectedTargetState: string;
}

export type EvidenceInput = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly planId: string;
  readonly repositoryPath?: string;
  readonly evidence: { readonly reviewId: string } | { readonly deliveryId: string };
  readonly maxBytes?: number;
} & (
  | { readonly kind: "manifest"; readonly offset?: number }
  | { readonly kind: "diff"; readonly path: string; readonly offset?: number }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly startLine?: number;
      readonly endLine?: number;
      readonly side?: "base" | "snapshot";
    }
);

type Intent = NonNullable<CollabTransition["outbox"]>[number];
type Transition = Omit<CollabTransition, "plan" | "expectedRevision" | "command">;
type Settlement = NonNullable<Transition["outboxSettlements"]>[number];

interface StepOperation {
  readonly stepId: string;
  readonly attempt: number;
  readonly detail?: string;
  readonly previousWorktreePath?: string;
  readonly preparedWorktreePath?: string;
  readonly commitOid?: string | undefined;
}

interface IntegrationOperation extends StepOperation {
  readonly reviewId: string;
  readonly merge?: { readonly from: string; readonly to: string };
}

interface BatchOperation {
  readonly integrationOid?: string | undefined;
  readonly summary?: CollabGateSummary;
  readonly auditRunId?: string;
  readonly secondOpinion?: {
    readonly reviewId: string;
    readonly brief: string;
    readonly target?: DispatchAgentTarget;
  };
  readonly drift?: CollabDeliveryDrift;
}

interface DeliveryOperation {
  readonly deliveryId: string;
}

interface StopWorkerOperation {
  readonly action: "interrupt_worker";
  readonly threadId: string;
  readonly runId: string;
}

const id = () => NodeCrypto.randomUUID() as string;
const now = () => new Date().toISOString();
const error = (message: string) => new VelaCollabError({ message });
const fail = (message: string) => Effect.fail(error(message));
const detailOf = (cause: unknown) =>
  String(cause instanceof Error ? cause.message : cause).slice(0, 2000);
const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => error(detailOf(cause)) });
const checked = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => error(detailOf(cause)) });
const encode = (value: unknown) => JSON.stringify(value);
const payload = <A>(intent: { readonly payloadJson: string }) =>
  JSON.parse(intent.payloadJson) as A;
const scopeKey = (scope: CollabScope) => encode([scope.environmentId, scope.parentThreadId]);
const isCurrent = (step: CollabStep | null, operation: StepOperation): step is CollabStep =>
  step?.attempt === operation.attempt && step.stepId === operation.stepId;
const target = (plan: CollabPlan) => plan.canonicalTargetWorktree;
const binding = (plan: CollabPlan): GitBinding => {
  if (!plan.gitCommonDir) throw error("This collaboration has no Git repository.");
  return { canonicalTargetWorktree: target(plan), gitCommonDir: plan.gitCommonDir };
};
const integrationWorktree = (plan: CollabPlan): Git.ManagedCollabWorktree => {
  if (!plan.integrationWorktreePath || !plan.integrationWorktreeGitDir) {
    throw error("The managed integration worktree is missing.");
  }
  return {
    ...binding(plan),
    path: plan.integrationWorktreePath,
    gitDir: plan.integrationWorktreeGitDir,
  };
};
const sameScope = (a: CollabScope, b: CollabScope) => scopeKey(a) === scopeKey(b);
const settled = (
  intent: CollabOutboxIntent,
  receipt: object = {},
  invalidated = false,
): Settlement => ({
  operationId: intent.operationId,
  status: invalidated ? "invalidated" : "completed",
  receiptJson: encode(receipt),
});
const attention = (
  step: CollabStep,
  attentionReason: CollabAttentionReason,
  attentionDetail: string,
): CollabStep => ({
  ...step,
  status: "needs_attention",
  attentionReason,
  attentionDetail: attentionDetail.slice(0, 2000),
});
const planThread = (plan: CollabPlan) => ThreadId.make(plan.parentThreadId);
const projectId = (plan: CollabPlan) => ProjectId.make(plan.projectId ?? "");
const messageId = (operationId: string) => MessageId.make(`vela-collab:${operationId}`);
const commandId = (operationId: string) => CommandId.make(`vela-collab:${operationId}`);
const childId = (operationId: string) => ThreadId.make(operationId);
const MAX_REVISION_STEPS = 100;
const MAX_CRITERIA = 24;
const MAX_MANIFEST_BYTES = 64 * 1024;

function intent(plan: CollabPlan, kind: Intent["kind"], data: object, operationId = id()): Intent {
  return {
    planId: plan.planId,
    expectedPlanVersion: plan.planVersion,
    kind,
    operationId,
    createdAt: now(),
    payloadJson: encode(data),
  };
}

function wake(
  plan: CollabPlan,
  kind: CollabInboxWake["kind"],
  data: object,
  step?: CollabStep,
): CollabInboxWake {
  const inboxItemId = id();
  return {
    environmentId: plan.environmentId,
    parentThreadId: plan.parentThreadId,
    planId: plan.planId,
    kind,
    inboxItemId,
    commandId: commandId(inboxItemId),
    messageId: messageId(inboxItemId),
    ...(step ? { stepId: step.stepId } : {}),
    ...(kind === "review" && step?.reviewId ? { reviewId: step.reviewId } : {}),
    payloadJson: encode(data),
  };
}

const createWorkIntent = (
  plan: CollabPlan,
  step: CollabStep,
  extra: Omit<StepOperation, "stepId" | "attempt"> = {},
) =>
  intent(plan, "create_worktree", {
    stepId: step.stepId,
    attempt: step.attempt,
    ...extra,
  } satisfies StepOperation);

const verifyIntent = (plan: CollabPlan, step: CollabStep, commitOid?: string) =>
  intent(plan, "verify_step_gates", {
    stepId: step.stepId,
    attempt: step.attempt,
    commitOid,
  } satisfies StepOperation);

function interruptWorkerIntent(plan: CollabPlan, threadId: string, runId: string) {
  return intent(plan, "send_thread", {
    action: "interrupt_worker",
    threadId,
    runId,
  } satisfies StopWorkerOperation);
}

function interruptAudits(plan: CollabPlan, operations: ReadonlyArray<CollabOutboxIntent>) {
  return operations.flatMap((operation) => {
    if (operation.kind !== "verify_batch_gates") return [];
    const { auditRunId } = payload<BatchOperation>(operation);
    return auditRunId
      ? [interruptWorkerIntent(plan, childId(operation.operationId), auditRunId)]
      : [];
  });
}

const batchIntent = (plan: CollabPlan, extra: Omit<BatchOperation, "integrationOid"> = {}) =>
  intent(plan, "verify_batch_gates", {
    integrationOid: plan.integrationOid,
    ...extra,
  } satisfies BatchOperation);

function validateSteps(steps: ReadonlyArray<CollabStep>) {
  if (
    !steps.length ||
    steps.length > MAX_REVISION_STEPS ||
    steps.some(
      ({ criteria }) =>
        criteria.length > MAX_CRITERIA || criteria.some(({ id }) => id.length > 100),
    )
  ) {
    throw error("Collaboration requires 1–100 steps and at most 24 short acceptance IDs per step.");
  }
  return topologicalSteps(steps);
}

const make = Effect.gen(function* () {
  const store = yield* VelaCollabStore;
  const launch = yield* ThreadLaunchService;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const providers = yield* ProviderRegistry;
  const environment = yield* ServerEnvironment;
  const config = yield* ServerConfig;
  const layerScope = yield* Scope.Scope;
  const environmentId = yield* environment.getEnvironmentId;
  const managedRoot = NodePath.join(config.stateDir, "collaboration", "worktrees");
  const ownerId = id();
  const writes = yield* Semaphore.make(1);
  const scanLock = yield* Semaphore.make(1);
  const signal = yield* Queue.sliding<void>(1);
  const processing = new Set<string>();
  const suppressed = new Set<string>();
  const planLocks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
  const listeners = new Map<string, Set<(projection: VelaCollabProjection) => void>>();
  const allListeners = new Set<() => void>();
  const kick = Queue.offer(signal, undefined).pipe(Effect.asVoid);

  function withPlanLock<A, E>(planId: string, work: Effect.Effect<A, E>) {
    return Effect.suspend(() => {
      const entry = planLocks.get(planId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
      entry.users++;
      planLocks.set(planId, entry);
      return entry.lock
        .withPermits(1)(work)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--entry.users === 0) planLocks.delete(planId);
            }),
          ),
        );
    });
  }

  const publish = Effect.fn("VelaCollabEngine.publish")(function* (plan: CollabPlan) {
    for (const listener of allListeners) {
      yield* checked(listener).pipe(Effect.ignore);
    }
    const subscribers = listeners.get(scopeKey(plan));
    if (!subscribers?.size) return;
    const projection = yield* store.buildProjection(plan.planId);
    if (projection) {
      for (const subscriber of subscribers) {
        yield* checked(() => subscriber(projection)).pipe(Effect.ignore);
      }
    }
  });

  const transition = Effect.fn("VelaCollabEngine.transition")(function* (
    previous: CollabPlan | null,
    plan: CollabPlan,
    changes: Transition,
  ) {
    const command = id();
    yield* store.commitTransition({
      ...changes,
      plan: { ...plan, revision: (previous?.revision ?? 0) + 1, updatedAt: now() },
      expectedRevision: previous?.revision ?? null,
      command: { commandId: command, requestKey: command, receiptJson: "{}" },
    });
    yield* kick;
    if (allListeners.size || listeners.has(scopeKey(plan))) {
      yield* publish(plan).pipe(Effect.ignore, Effect.forkIn(layerScope));
    }
  });

  const requirePlan = Effect.fn("VelaCollabEngine.requirePlan")(function* (input: PlanCommand) {
    const plan = yield* store.getPlan(input.planId);
    if (!plan || plan.environmentId !== environmentId || !sameScope(plan, input)) {
      return yield* fail("Collaboration plan is outside the caller's scope.");
    }
    return plan;
  });

  const currentIntent = Effect.fn("VelaCollabEngine.currentIntent")(function* (
    operationId: string,
  ) {
    const operation = yield* store.getOutbox(operationId);
    if (operation?.status !== "pending") return null;
    const plan = yield* store.getPlan(operation.planId);
    if (
      !plan ||
      plan.environmentId !== environmentId ||
      operation.expectedPlanVersion !== plan.planVersion
    )
      return null;
    return { plan, operation };
  });

  const observeRun = (plan: CollabPlan, threadId: string, runId: string) =>
    threads
      .getProjectThreadRecords(
        { projectId: projectId(plan), threadId: ThreadId.make(threadId) },
        ["runs"],
        { runIds: [RunId.make(runId)] },
      )
      .pipe(
        Effect.map(({ thread, runs }) => ({
          unreachable: thread.archivedAt !== null || thread.deletedAt !== null,
          run: runs.find(({ id }) => id === runId),
        })),
        Effect.catchTags({
          ThreadManagementProjectionLoadError: (cause) =>
            threads
              .getThreadShell(ThreadId.make(threadId))
              .pipe(
                Effect.flatMap((shell) =>
                  shell === null || shell.deletedAt !== null || shell.archivedAt !== null
                    ? Effect.succeed({ unreachable: true, run: undefined })
                    : Effect.fail(cause),
                ),
              ),
        }),
      );

  const createAndStartPlan = Effect.fn("VelaCollabEngine.createAndStartPlan")(function* (
    input: CreateCollabPlanInput,
  ) {
    if (input.environmentId !== environmentId)
      return yield* fail("Collaboration must run in the local environment.");
    const project = yield* projects.getById(ProjectId.make(input.projectId));
    if (Option.isNone(project)) return yield* fail("Collaboration project is unavailable.");
    const { thread } = yield* threads.getProjectThreadRecords(
      {
        projectId: project.value.id,
        threadId: ThreadId.make(input.parentThreadId),
      },
      [],
    );
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      return yield* fail("Collaboration parent thread is unavailable.");
    }
    const reportedPath = thread.worktreePath ?? project.value.workspaceRoot;
    const repository = yield* io(() => Git.probeRepository(reportedPath));
    if (input.targetWorktree !== undefined) {
      const requested = yield* io(() => Git.probeRepository(input.targetWorktree!));
      if (requested.canonicalTargetWorktree !== repository.canonicalTargetWorktree) {
        return yield* fail("Collaboration target must be the parent thread's workspace.");
      }
    }
    const planId = id();
    const steps = input.steps.map((step, order) => defineStep(planId, step, order));
    yield* checked(() => validateSteps(steps));
    if (repository.kind === "non_git" && steps.some(({ kind }) => kind === "change")) {
      return yield* fail("A Git worktree is required for collaboration change steps.");
    }
    const {
      steps: _steps,
      autoStart,
      targetWorktree: _target,
      defaultDevAgent,
      batchAuditAgent,
      ...options
    } = input;
    const plan: CollabPlan = {
      ...options,
      engineVersion: 2,
      planId,
      planVersion: 1,
      revision: 1,
      status: "draft",
      canonicalTargetWorktree: repository.canonicalTargetWorktree,
      gitCommonDir: repository.gitCommonDir,
      ...(defaultDevAgent === undefined ? {} : { defaultDevAgent }),
      ...(batchAuditAgent === undefined ? {} : { batchAuditAgent }),
      batchGates: input.batchGates ?? [],
      createdAt: now(),
      updatedAt: now(),
    };
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if (yield* store.findActivePlan(input))
          return yield* fail("This thread already has an active collaboration.");
        yield* transition(null, plan, {
          steps,
          outbox: [intent(plan, "initialize_plan", { autoStart: autoStart !== false })],
        });
      }),
    );
    return planId;
  });

  const initializePlan = Effect.fn("VelaCollabEngine.initializePlan")(function* (
    plan: CollabPlan,
    operation: CollabOutboxIntent,
  ) {
    const initialized =
      plan.gitCommonDir === null
        ? undefined
        : yield* io(() =>
            withWorkspaceAdmission(target(plan), async () => {
              if (hasDirectWorkspaceWriter(target(plan))) {
                throw error("A legacy collaboration is writing to the target workspace.");
              }
              const snapshot = await Git.initializeCollabPlan(target(plan), plan.planId);
              if (snapshot.repository.gitCommonDir !== plan.gitCommonDir)
                throw error("Collaboration repository binding changed.");
              const worker = await Git.createManagedWorktree(
                target(plan),
                managedRoot,
                snapshot.commitOid,
                operation.operationId,
              );
              return {
                baseOid: snapshot.commitOid,
                integrationOid: snapshot.commitOid,
                integrationWorktreePath: worker.path,
                integrationWorktreeGitDir: worker.gitDir,
              };
            }),
          );
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* currentIntent(operation.operationId);
        if (current)
          yield* transition(
            current.plan,
            {
              ...current.plan,
              ...initialized,
              status: payload<{ autoStart: boolean }>(operation).autoStart ? "running" : "draft",
            },
            { outboxSettlements: [settled(operation)] },
          );
      }),
    );
  });

  const startPlan = Effect.fn("VelaCollabEngine.startPlan")((input: VersionedPlanCommand) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const plan = yield* requirePlan(input);
        if (plan.status !== "draft" || input.expectedPlanVersion !== plan.planVersion) {
          return yield* fail("Collaboration plan is no longer a matching draft.");
        }
        const pending = yield* store.listPendingIntents();
        if (
          pending.some((item) => item.planId === plan.planId && item.kind === "initialize_plan")
        ) {
          return yield* fail("Collaboration initialization is still in progress.");
        }
        yield* transition(plan, { ...plan, status: "running" }, {});
      }),
    ),
  );

  const selectWorker = Effect.fn("VelaCollabEngine.selectWorker")(function* (
    plan: CollabPlan,
    agent: CollabPlan["defaultDevAgent"],
  ) {
    const { thread } = yield* threads.getProjectThreadRecords(
      {
        projectId: projectId(plan),
        threadId: planThread(plan),
      },
      [],
    );
    const selection =
      agent === undefined
        ? thread.modelSelection
        : toModelSelection(
            "providerInstanceId" in agent
              ? agent
              : {
                  providerInstanceId: agent.provider,
                  ...(agent.model === undefined ? {} : { model: agent.model }),
                },
            yield* providers.getProviders,
          );
    return { selection, runtimeMode: thread.runtimeMode };
  });

  const launchWorker = Effect.fn("VelaCollabEngine.launchWorker")(function* (
    plan: CollabPlan,
    operation: CollabOutboxIntent,
  ) {
    const data = payload<StepOperation>(operation);
    const step = yield* store.getStep(plan.planId, data.stepId);
    if (!isCurrent(step, data) || step.status !== "developing") return;
    const readOnly = step.kind !== "change";
    const worker = data.preparedWorktreePath
      ? { path: data.preparedWorktreePath }
      : data.previousWorktreePath === undefined && step.worktreePath
        ? { path: step.worktreePath }
        : step.stepBaseOid
          ? yield* io(async () => {
              await Git.freezeStepBase(
                target(plan),
                plan.planId,
                step.stepId,
                step.attempt,
                step.stepBaseOid!,
              );
              return Git.createManagedWorktree(
                target(plan),
                managedRoot,
                step.stepBaseOid!,
                operation.operationId,
              );
            })
          : undefined;
    if (
      step.stepBaseOid &&
      (data.preparedWorktreePath || (step.worktreePath && data.previousWorktreePath === undefined))
    ) {
      yield* io(() =>
        Git.freezeStepBase(target(plan), plan.planId, step.stepId, step.attempt, step.stepBaseOid!),
      );
    }
    const worktreePath = worker?.path;
    const text = workerPrompt(step, data.detail ?? "");
    const threadId = step.childThreadId
      ? ThreadId.make(step.childThreadId)
      : childId(operation.operationId);
    const run = yield* Effect.gen(function* () {
      if (!step.childThreadId) {
        const { selection, runtimeMode } = yield* selectWorker(
          plan,
          step.executor ?? plan.defaultDevAgent,
        );
        const started = yield* launch.launch({
          commandId: commandId(operation.operationId),
          threadId,
          projectId: projectId(plan),
          title: step.title,
          generateTitle: false,
          titleRenamed: true,
          modelSelection: selection,
          runtimeMode: readOnly ? "approval-required" : runtimeMode,
          interactionMode: readOnly ? "plan" : "default",
          workspaceStrategy: worktreePath
            ? { type: "existing_worktree", worktreePath }
            : { type: "root" },
          initialMessage: {
            messageId: messageId(operation.operationId),
            text,
            attachments: [],
            outputSchema: workerOutputSchema,
          },
          createdBy: "system",
          creationSource: "server",
          subagentParentThreadId: planThread(plan),
        });
        return started.projection.runs.find(
          ({ userMessageId }) => userMessageId === messageId(operation.operationId),
        );
      }
      if (data.previousWorktreePath !== undefined && worktreePath !== undefined) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: commandId(`${operation.operationId}:workspace`),
          threadId,
          expectedWorktreePath: data.previousWorktreePath,
          worktreePath,
          branch: null,
        });
      }
      const sent = yield* threads.sendToThread({
        projectId: projectId(plan),
        threadId,
        commandId: commandId(operation.operationId),
        messageId: messageId(operation.operationId),
        mode: "queue",
        text,
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        outputSchema: workerOutputSchema,
      });
      return sent.run.userMessageId === messageId(operation.operationId) ? sent.run : undefined;
    });
    if (!run || run.threadId !== threadId)
      return yield* fail("Worker launch did not bind the expected message to a run.");
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* currentIntent(operation.operationId);
        if (!current) return;
        const fresh = yield* store.getStep(plan.planId, step.stepId);
        if (!isCurrent(fresh, data) || fresh.status !== "developing") return;
        yield* transition(current.plan, current.plan, {
          steps: [
            {
              ...fresh,
              childThreadId: threadId,
              workerRunId: run.id,
              ...(worktreePath ? { worktreePath } : {}),
            },
          ],
          outboxSettlements: [settled(operation, { threadId, runId: run.id, worktreePath })],
        });
      }),
    );
  });

  const finishWorker = Effect.fn("VelaCollabEngine.finishWorker")(function* (
    plan: CollabPlan,
    step: CollabStep,
  ) {
    if (!step.childThreadId || !step.workerRunId) return;
    const observed = yield* observeRun(plan, step.childThreadId, step.workerRunId).pipe(
      Effect.catchTags({
        ThreadManagementThreadNotFoundError: () =>
          Effect.succeed({ unreachable: true, run: undefined }),
      }),
    );
    if (!observed.unreachable && observed.run && !isTerminalRunStatus(observed.run.status)) return;
    if (observed.run?.status === "completed" && !observed.unreachable) {
      const settled = yield* threads.waitForThread({
        projectId: projectId(plan),
        threadId: ThreadId.make(step.childThreadId),
        runId: RunId.make(step.workerRunId),
        timeoutMs: 50,
        untilDelegatedWorkSettled: true,
      });
      if (settled.timedOut) return;
    }
    const output = readWorkerOutput(observed.run?.output?.value);
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const fresh = yield* store.getStep(plan.planId, step.stepId);
        const current = yield* store.getPlan(plan.planId);
        if (!current || fresh?.status !== "developing" || fresh.workerRunId !== step.workerRunId)
          return;
        if (
          fresh.kind === "decision" &&
          observed.run?.status === "completed" &&
          output?.options.length
        ) {
          yield* transition(current, current, {
            steps: [
              attention({ ...fresh, decisionOptions: output.options }, "decision", output.summary),
            ],
          });
          return;
        }
        if (
          observed.unreachable ||
          observed.run?.status !== "completed" ||
          !output ||
          output.outcome !== "complete" ||
          fresh.kind === "decision"
        ) {
          const reason = observed.unreachable
            ? "The worker thread is unavailable."
            : output?.summary ||
              `The worker ended with ${observed.run?.status ?? "no recorded run"} and no usable result.`;
          yield* transition(current, current, {
            steps: [attention(fresh, "escalation", reason)],
            wakes: [
              wake(
                current,
                "orchestrator_escalation",
                {
                  attempt: fresh.attempt,
                  objective: fresh.objective.slice(0, 600),
                  detail: reason.slice(0, 1200),
                },
                fresh,
              ),
            ],
          });
          return;
        }
        yield* transition(current, current, {
          steps: [
            {
              ...fresh,
              status: "verifying_gates",
              ...(fresh.kind === "research" ? { attentionDetail: output.summary } : {}),
            },
          ],
          outbox: [verifyIntent(current, fresh)],
        });
      }),
    );
  });

  const verifyStep = Effect.fn("VelaCollabEngine.verifyStep")(function* (
    plan: CollabPlan,
    operation: CollabOutboxIntent,
  ) {
    const data = payload<StepOperation>(operation);
    const step = yield* store.getStep(plan.planId, data.stepId);
    if (!isCurrent(step, data) || step.status !== "verifying_gates") return;
    const reviewId = operation.operationId;
    let reviewWorktreePath: string | undefined;
    const evidence = yield* Effect.gen(function* () {
      if (step.kind === "research") {
        return {
          reviewId,
          stepId: step.stepId,
          attempt: step.attempt,
          stepBaseOid: step.stepBaseOid ?? "",
          reviewedOid: step.stepBaseOid ?? "",
          criteriaVersion: step.criteriaVersion,
          changedFiles: [],
          gateSummary: { passed: true, results: [] },
          createdAt: operation.createdAt,
          ...(step.attentionDetail ? { summary: step.attentionDetail } : {}),
        } satisfies CollabReviewEvidence;
      }
      if (!step.stepBaseOid || (!data.commitOid && !step.worktreePath)) {
        return yield* fail("The step has no pinned execution snapshot.");
      }
      const result = yield* io(async (signal) => {
        await Git.freezeStepBase(
          target(plan),
          plan.planId,
          step.stepId,
          step.attempt,
          step.stepBaseOid!,
        );
        const prepared = data.commitOid
          ? await Git.createManagedWorktree(
              target(plan),
              managedRoot,
              data.commitOid,
              operation.operationId,
            )
          : undefined;
        reviewWorktreePath = prepared?.path;
        return Git.captureAndVerifyStepCandidate({
          repoDir: target(plan),
          ...step,
          stepBaseOid: step.stepBaseOid!,
          reviewId,
          createdAt: operation.createdAt,
          signal,
          candidate: data.commitOid
            ? { commitOid: data.commitOid }
            : { worktreePath: step.worktreePath! },
          executionWorktreePath: prepared?.path ?? step.worktreePath!,
        });
      });
      if (result.status !== "verified") {
        return {
          reason: "gate_failed" as const,
          detail:
            result.status === "boundary_violation"
              ? `Path boundary violation: ${result.violations.join(", ")}`
              : result.gateSummary.results
                  .map(
                    ({ command, exitCode, output }) => `${command} (${exitCode})\n${output ?? ""}`,
                  )
                  .join("\n"),
        };
      }
      return result.evidence;
    });
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* currentIntent(operation.operationId);
        if (!current) return;
        const fresh = yield* store.getStep(plan.planId, step.stepId);
        if (!isCurrent(fresh, data) || fresh.status !== "verifying_gates") return;
        if ("reason" in evidence) {
          yield* transition(current.plan, current.plan, {
            steps: [attention(fresh, evidence.reason, evidence.detail)],
            outboxSettlements: [settled(operation, evidence)],
          });
          return;
        }
        const queued: CollabStep = {
          ...fresh,
          status: "queued_for_review",
          reviewId,
          stepBaseOid: evidence.stepBaseOid,
          ...(reviewWorktreePath ? { reviewWorktreePath } : {}),
        };
        yield* transition(current.plan, current.plan, {
          steps: [queued],
          records: [{ kind: "review", id: reviewId, value: evidence }],
          wakes: [wake(current.plan, "review", reviewWakePayload(queued, evidence), queued)],
          outboxSettlements: [settled(operation, { reviewId })],
        });
      }),
    );
  });

  const rejectInbox = Effect.fn("VelaCollabEngine.rejectInbox")(function* (
    plan: CollabPlan,
    item: CollabInboxItem,
    reason: string,
  ) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const [active, current] = yield* Effect.all([
          store.getActiveInbox(plan),
          store.getPlan(plan.planId),
        ]);
        if (!current || active?.inboxItemId !== item.inboxItemId) return;
        const step = item.stepId ? yield* store.getStep(plan.planId, item.stepId) : null;
        const matches =
          step?.reviewId === item.reviewId &&
          (step?.status === "queued_for_review" || step?.status === "reviewing");
        const existingVerdict = item.reviewId
          ? yield* store.getRecord(plan.planId, "verdict", item.reviewId)
          : null;
        yield* transition(
          current,
          { ...current, attentionDetail: reason },
          {
            ...(matches && step && !existingVerdict
              ? { steps: [attention(step, "review_incomplete", reason)] }
              : {}),
            inbox: {
              action: "invalidate",
              inboxItemId: item.inboxItemId,
              receiptJson: encode({ reason }),
            },
          },
        );
      }),
    );
  });

  const recoverInboxRun = Effect.fn("VelaCollabEngine.recoverInboxRun")(function* (
    plan: CollabPlan,
    item: CollabInboxItem,
  ) {
    if (!(yield* threads.hasReceipt(CommandId.make(item.commandId)))) return undefined;
    const threadId = planThread(plan);
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [MessageId.make(item.messageId)],
    });
    const message = messages.find(({ id }) => id === item.messageId);
    if (!message?.runId || message.createdBy !== "system" || message.creationSource !== "server") {
      return yield* fail("The accepted collaboration message is unavailable.");
    }
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
      runIds: [message.runId],
    });
    const run = runs.find(
      ({ id, userMessageId }) => id === message.runId && userMessageId === message.id,
    );
    if (!run || run.threadId !== threadId)
      return yield* fail("The accepted wake has no verified run binding.");
    return run.id;
  });

  const dispatchInbox = Effect.fn("VelaCollabEngine.dispatchInbox")(function* (
    plan: CollabPlan,
    item: CollabInboxItem,
  ) {
    const recoveredRunId = yield* recoverInboxRun(plan, item);
    const step = item.stepId ? yield* store.getStep(plan.planId, item.stepId) : null;
    const notice = payload<{
      deliveryId?: string;
      planVersion?: number;
      integrationOid?: string;
      attempt?: number;
      reviewId?: string;
    }>(item);
    if (
      !recoveredRunId &&
      ((item.kind === "review" &&
        (step?.reviewId !== item.reviewId || step?.status !== "queued_for_review")) ||
        (item.kind === "delivery_ready" &&
          (plan.status !== "ready_to_deliver" || notice.deliveryId !== plan.deliveryId)) ||
        (item.kind === "batch_verification_failed" &&
          (plan.status !== "running" ||
            notice.planVersion !== plan.planVersion ||
            notice.integrationOid !== plan.integrationOid)) ||
        (item.kind === "orchestrator_escalation" &&
          item.stepId &&
          (notice.reviewId
            ? step?.reviewId !== notice.reviewId
            : step?.attentionReason !== "escalation" || step.attempt !== notice.attempt)))
    ) {
      yield* rejectInbox(plan, item, "The pending collaboration wake became stale.");
      return;
    }
    const runId =
      recoveredRunId ??
      (yield* threads
        .sendToThread({
          projectId: projectId(plan),
          threadId: planThread(plan),
          commandId: CommandId.make(item.commandId),
          messageId: MessageId.make(item.messageId),
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
          attachments: [],
          text: `[Vela collaboration ${item.kind}]\n${encode({
            planId: item.planId,
            stepId: item.stepId,
            reviewId: item.reviewId,
            ...payload<Record<string, unknown>>(item),
          })}`,
        })
        .pipe(
          Effect.flatMap((sent) =>
            sent.run.threadId === planThread(plan) &&
            sent.run.userMessageId === item.messageId &&
            sent.message.id === item.messageId &&
            sent.message.runId === sent.run.id &&
            (sent.delivery === "queued" || sent.delivery === "started")
              ? Effect.succeed(sent.run.id)
              : fail(
                  "The collaboration wake did not receive a dedicated run for its exact message.",
                ),
          ),
          Effect.catch((cause) =>
            recoverInboxRun(plan, item).pipe(
              Effect.filterOrFail(
                (bound): bound is RunId => bound !== undefined,
                () => cause,
              ),
            ),
          ),
        ));
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const [active, current] = yield* Effect.all([
          store.getActiveInbox(plan),
          store.getPlan(plan.planId),
        ]);
        if (!current || active?.inboxItemId !== item.inboxItemId || active.status !== "pending")
          return;
        const fresh = item.stepId ? yield* store.getStep(plan.planId, item.stepId) : null;
        yield* transition(current, current, {
          ...(item.kind === "review" &&
          fresh?.reviewId === item.reviewId &&
          fresh?.status === "queued_for_review"
            ? { steps: [{ ...fresh, status: "reviewing" }] }
            : {}),
          inbox: {
            action: "bind",
            inboxItemId: item.inboxItemId,
            commandId: item.commandId,
            messageId: item.messageId,
            threadRunId: runId,
            acceptedBeforeEdit: item.kind === "review" && fresh?.reviewId !== item.reviewId,
            receiptJson: encode({ runId }),
          },
        });
      }),
    );
  });

  const finishInbox = Effect.fn("VelaCollabEngine.finishInbox")(function* (
    plan: CollabPlan,
    item: CollabInboxItem,
  ) {
    if (!item.threadRunId) return;
    const observed = yield* observeRun(plan, plan.parentThreadId, item.threadRunId).pipe(
      Effect.catchTags({
        ThreadManagementThreadNotFoundError: () =>
          Effect.succeed({ unreachable: true, run: undefined }),
      }),
    );
    if (!observed.unreachable && observed.run && !isTerminalRunStatus(observed.run.status)) return;
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const [active, current] = yield* Effect.all([
          store.getActiveInbox(plan),
          store.getPlan(plan.planId),
        ]);
        if (
          !current ||
          active?.inboxItemId !== item.inboxItemId ||
          active.threadRunId !== item.threadRunId
        )
          return;
        const step = item.stepId ? yield* store.getStep(plan.planId, item.stepId) : null;
        const verdict = item.reviewId
          ? yield* store.getRecord(plan.planId, "verdict", item.reviewId)
          : null;
        const inbox: Transition["inbox"] = {
          action: "complete",
          inboxItemId: item.inboxItemId,
          threadRunId: item.threadRunId!,
          receiptJson: encode({
            verdict: verdict?.verdict,
            status: observed.run?.status,
            unreachable: observed.unreachable,
          }),
        };
        const reason = observed.unreachable
          ? "The collaboration parent thread is unavailable."
          : "The dedicated review run ended without submitting a verdict.";
        if (
          item.kind !== "review" ||
          !step ||
          step.reviewId !== item.reviewId ||
          step.status !== "reviewing"
        ) {
          yield* transition(
            current,
            observed.unreachable ? { ...current, attentionDetail: reason } : current,
            { inbox },
          );
          return;
        }
        if (!verdict || verdict.verdict !== "request_changes") {
          yield* transition(current, current, {
            inbox,
            steps: [attention(step, "review_incomplete", reason)],
          });
          return;
        }
        if ((step.repairCount ?? 0) >= 2) {
          yield* transition(current, current, {
            inbox,
            steps: [
              attention(
                step,
                "repair_limit",
                "The step exhausted its two automatic repair attempts.",
              ),
            ],
          });
          return;
        }
        const repairing: CollabStep = {
          ...clearStepEvidence(step),
          phase: "repair",
          status: "developing",
          attempt: step.attempt + 1,
          repairCount: (step.repairCount ?? 0) + 1,
          ...(step.stepBaseOid ? { stepBaseOid: step.stepBaseOid } : {}),
        };
        yield* transition(current, current, {
          inbox,
          steps: [repairing],
          outbox: [
            createWorkIntent(current, repairing, {
              ...(step.reviewWorktreePath && step.worktreePath
                ? {
                    previousWorktreePath: step.worktreePath,
                    preparedWorktreePath: step.reviewWorktreePath,
                  }
                : {}),
              detail: [
                `Repair review ${verdict.reviewId}: ${verdict.summary}`,
                ...verdict.findings.map(({ severity, summary }) => `${severity}: ${summary}`),
                ...verdict.criteriaResults
                  .filter(({ result }) => result !== "pass")
                  .map(
                    ({ criterionId, result, summary }) =>
                      `[${criterionId}] ${result}: ${summary ?? ""}`,
                  ),
              ].join("\n"),
            }),
          ],
        });
      }),
    );
  });

  const submitReviewVerdict = Effect.fn("VelaCollabEngine.submitReviewVerdict")(
    (input: ReviewInput) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const [step, item, previous] = yield* Effect.all([
            store.getStep(plan.planId, input.stepId),
            store.getActiveInbox(plan),
            store.getRecord(plan.planId, "verdict", input.reviewId),
          ]);
          if (!step || step.reviewId !== input.reviewId || !input.callerRunId.trim()) {
            return yield* fail("Review evidence is stale or the authenticated run is missing.");
          }
          const value: CollabReviewVerdict = {
            reviewId: input.reviewId,
            reviewerRunId: input.callerRunId,
            verdict: input.verdict,
            summary: input.summary,
            findings: input.findings,
            criteriaResults: input.criteriaResults,
            decidedAt: previous?.decidedAt ?? now(),
          };
          if (previous) {
            if (NodeUtil.isDeepStrictEqual(previous, value)) return previous;
            return yield* fail("A different verdict or reviewer run already settled this review.");
          }
          if (
            step.status !== "reviewing" ||
            item?.kind !== "review" ||
            item.status !== "dispatched" ||
            item.planId !== plan.planId ||
            item.stepId !== input.stepId ||
            item.reviewId !== input.reviewId ||
            item.threadRunId !== input.callerRunId
          ) {
            return yield* fail(
              "Only the dedicated active collaboration run can submit this review verdict.",
            );
          }
          let changes: Transition = {};
          if (input.verdict === "approve") {
            if (input.criteriaResults.some(({ result }) => result === "manual_check")) {
              changes = {
                steps: [
                  attention(
                    step,
                    "manual_check_required",
                    "The approved review requires manual checks.",
                  ),
                ],
              };
            } else if (step.kind === "change") {
              changes = {
                steps: [{ ...step, status: "integrating" }],
                integration: {
                  stepId: step.stepId,
                  intent: {
                    ...intent(plan, "update_integration", {
                      stepId: step.stepId,
                      attempt: step.attempt,
                      reviewId: input.reviewId,
                    } satisfies IntegrationOperation),
                    kind: "update_integration",
                  },
                },
              };
            } else {
              changes = { steps: [{ ...step, status: "done" }] };
            }
          }
          yield* transition(plan, plan, {
            ...changes,
            records: [{ kind: "verdict", id: input.reviewId, value }],
          });
          return value;
        }),
      ),
  );

  const retryIncompleteReview = Effect.fn("VelaCollabEngine.retryIncompleteReview")(
    (
      input: PlanCommand & {
        readonly stepId: string;
        readonly reviewId: string;
      },
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const [step, evidence] = yield* Effect.all([
            store.getStep(plan.planId, input.stepId),
            store.getRecord(plan.planId, "review", input.reviewId),
          ]);
          if (
            !step ||
            step.reviewId !== input.reviewId ||
            step.status !== "needs_attention" ||
            step.attentionReason !== "review_incomplete" ||
            !evidence
          ) {
            return yield* fail("The review is no longer eligible for retry.");
          }
          const { attentionReason: _reason, attentionDetail: _detail, ...rest } = step;
          const queued = { ...rest, status: "queued_for_review" as const };
          yield* transition(plan, plan, {
            steps: [queued],
            wakes: [wake(plan, "review", reviewWakePayload(queued, evidence), queued)],
          });
        }),
      ),
  );

  const resolveStepAttention = Effect.fn("VelaCollabEngine.resolveStepAttention")(
    (
      input: PlanCommand & {
        readonly stepId: string;
        readonly response: string;
        readonly callerRunId?: string;
        readonly reviewId?: string;
        readonly decisionOptions?: ReadonlyArray<string>;
        readonly resolution:
          | "human_decision"
          | "human_manual_check"
          | "resume_worker"
          | "ask_human";
      },
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const step = yield* store.getStep(plan.planId, input.stepId);
          if (step?.status !== "needs_attention" || !input.response.trim()) {
            return yield* fail("The step has no matching collaboration attention item.");
          }
          if (input.resolution === "human_decision" && step.attentionReason === "decision") {
            if (step.kind === "decision") {
              yield* transition(plan, plan, {
                steps: [{ ...step, status: "done", attentionDetail: input.response }],
              });
            } else {
              const next: CollabStep = {
                ...clearStepEvidence(step),
                status: "developing",
                attempt: step.attempt + 1,
                ...(step.stepBaseOid ? { stepBaseOid: step.stepBaseOid } : {}),
              };
              yield* transition(plan, plan, {
                steps: [next],
                outbox: [createWorkIntent(plan, next, { detail: input.response })],
              });
            }
            return;
          }
          if (
            input.resolution === "human_manual_check" &&
            step.attentionReason === "manual_check_required" &&
            step.reviewId
          ) {
            const reviewId = step.reviewId;
            if (input.reviewId !== undefined && input.reviewId !== reviewId)
              return yield* fail("The manual check is for stale review evidence.");
            const verdict = yield* store.getRecord(plan.planId, "verdict", reviewId);
            if (verdict?.verdict !== "approve")
              return yield* fail("The manual check has no approved review.");
            yield* transition(
              plan,
              plan,
              step.kind === "change"
                ? {
                    steps: [{ ...step, status: "integrating", attentionDetail: input.response }],
                    integration: {
                      stepId: step.stepId,
                      intent: {
                        ...intent(plan, "update_integration", {
                          stepId: step.stepId,
                          attempt: step.attempt,
                          reviewId,
                        } satisfies IntegrationOperation),
                        kind: "update_integration",
                      },
                    },
                  }
                : { steps: [{ ...step, status: "done", attentionDetail: input.response }] },
            );
            return;
          }
          const active = yield* store.getActiveInbox(plan);
          if (
            step.attentionReason !== "escalation" ||
            active?.kind !== "orchestrator_escalation" ||
            active.planId !== plan.planId ||
            active.stepId !== step.stepId ||
            !active.threadRunId ||
            active.threadRunId !== input.callerRunId
          ) {
            return yield* fail(
              "Only the dedicated escalation run can resolve this worker escalation.",
            );
          }
          if (input.resolution === "ask_human") {
            yield* transition(plan, plan, {
              steps: [
                attention(
                  {
                    ...step,
                    ...(input.decisionOptions === undefined
                      ? {}
                      : {
                          decisionOptions: input.decisionOptions
                            .slice(0, 10)
                            .map((label) => label.slice(0, 250)),
                        }),
                  },
                  "decision",
                  input.response,
                ),
              ],
            });
            return;
          }
          const next: CollabStep = {
            ...clearStepEvidence(step),
            status: "developing",
            attempt: step.attempt + 1,
            ...(step.stepBaseOid ? { stepBaseOid: step.stepBaseOid } : {}),
          };
          yield* transition(plan, plan, {
            steps: [next],
            outbox: [createWorkIntent(plan, next, { detail: input.response })],
          });
        }),
      ),
  );

  const withLease = Effect.fn("VelaCollabEngine.withLease")(function* <A, E>(
    plan: CollabPlan,
    operation: CollabOutboxIntent,
    kind: CollabOperationLease["kind"],
    work: (lease: CollabOperationLease) => Effect.Effect<A, E>,
  ) {
    const timestamp = yield* Clock.currentTimeMillis;
    const lease = yield* store.acquireLease(
      {
        kind,
        resourceId:
          kind === "integration"
            ? plan.planId
            : targetWorktreeLeaseResource(plan.environmentId, target(plan)),
        operationId: operation.operationId,
        ownerId,
        token: id(),
        expiresAt: timestamp + 300_000,
      },
      timestamp,
    );
    if (lease)
      return yield* work(lease).pipe(
        Effect.ensuring(store.releaseLease(lease).pipe(Effect.ignore)),
      );
  });

  const integrate = Effect.fn("VelaCollabEngine.integrate")(function* (
    initial: CollabPlan,
    requested: CollabOutboxIntent,
  ) {
    yield* withPlanLock(
      initial.planId,
      Effect.gen(function* () {
        const current = yield* currentIntent(requested.operationId);
        if (!current) return;
        const { plan, operation } = current;
        yield* withLease(plan, operation, "integration", () =>
          Effect.gen(function* () {
            const data = payload<IntegrationOperation>(operation);
            const [step, evidence] = yield* Effect.all([
              store.getStep(plan.planId, data.stepId),
              store.getRecord(plan.planId, "review", data.reviewId),
            ]);
            const previousOid = plan.integrationOid;
            if (
              !isCurrent(step, data) ||
              step.status !== "integrating" ||
              step.reviewId !== data.reviewId ||
              !evidence ||
              !previousOid
            )
              return yield* fail("The approved integration snapshot is stale.");
            const result =
              data.merge === undefined
                ? yield* io(() =>
                    Git.integrateReviewedStep({
                      repoDir: target(plan),
                      integrationOid: previousOid,
                      stepBaseOid: evidence.stepBaseOid,
                      reviewedOid: evidence.reviewedOid,
                    }),
                  )
                : { status: "clean" as const, mergedCommitOid: data.merge.to };
            if (result.status === "clean") {
              const merged = result.mergedCommitOid;
              if (!data.merge)
                yield* store.updateIntentPayload(operation, {
                  ...data,
                  merge: { from: previousOid, to: merged },
                });
              else if (data.merge.from !== previousOid)
                return yield* fail("The pending integration base changed.");
              yield* io(async () => {
                const worktree = integrationWorktree(plan);
                const ref = Git.planRefs(plan.planId).integration;
                if ((await Git.readCollabRef(target(plan), ref)) !== merged) {
                  await Git.compareAndSwapCollabRef(target(plan), ref, merged, previousOid);
                }
                await Git.synchronizeIntegrationWorktree(worktree, previousOid, merged);
              });
              yield* writes.withPermits(1)(
                Effect.gen(function* () {
                  const fresh = yield* store.getPlan(plan.planId);
                  if (!fresh || fresh.integrationOid !== previousOid)
                    return yield* fail("Integration state changed during reconciliation.");
                  const integrated: CollabStep = { ...step, status: "integrated" };
                  const steps = (yield* store.listSteps(plan.planId)).map((candidate) =>
                    candidate.stepId === step.stepId ? integrated : candidate,
                  );
                  yield* transition(
                    fresh,
                    { ...fresh, integrationOid: merged },
                    {
                      steps: [integrated, ...unlockSteps(steps)],
                      outboxSettlements: [settled(operation, { integratedOid: merged })],
                    },
                  );
                }),
              );
              return;
            }
            yield* writes.withPermits(1)(
              Effect.gen(function* () {
                const fresh = yield* store.getPlan(plan.planId);
                if (!fresh) return;
                const next = {
                  ...clearStepEvidence(step),
                  attempt: step.attempt + 1,
                  stepBaseOid: previousOid,
                };
                const settlement = [settled(operation, result)];
                if (result.status === "manifest_changed") {
                  const verifying = { ...next, status: "verifying_gates" as const };
                  yield* transition(fresh, fresh, {
                    steps: [verifying],
                    outbox: [verifyIntent(fresh, verifying, result.mergedCandidateCommitOid)],
                    outboxSettlements: settlement,
                  });
                  return;
                }
                const conflictDetail = `Integration conflicts: ${result.conflictFiles.join(", ")}.`;
                const conflictCount = step.conflictCount ?? 0;
                if (conflictCount >= 2 || !step.worktreePath || !step.childThreadId) {
                  yield* transition(fresh, fresh, {
                    steps: [attention(step, "conflict_limit", conflictDetail)],
                    outboxSettlements: settlement,
                  });
                  return;
                }
                const repairing: CollabStep = {
                  ...next,
                  status: "developing",
                  phase: "conflict",
                  conflictCount: conflictCount + 1,
                };
                yield* transition(fresh, fresh, {
                  steps: [repairing],
                  outbox: [
                    createWorkIntent(fresh, repairing, {
                      previousWorktreePath: step.worktreePath,
                      detail: `${conflictDetail}\nIntegrate the approved intent onto the new frozen base ${previousOid}.\nPrevious worktree retained at ${step.worktreePath}.\nPrevious review snapshot ${evidence.reviewedOid} against ${evidence.stepBaseOid}.`,
                    }),
                  ],
                  outboxSettlements: settlement,
                });
              }),
            );
          }),
        );
      }),
    );
  });

  const auditRun = Effect.fn("VelaCollabEngine.auditRun")(
    (
      plan: CollabPlan,
      operation: CollabOutboxIntent,
      data: BatchOperation,
      baseOid: string,
      snapshotOid: string,
    ) =>
      withPlanLock(
        plan.planId,
        Effect.gen(function* () {
          if (!(yield* currentIntent(operation.operationId))) return;
          const threadId = childId(operation.operationId);
          if (data.auditRunId) {
            const observed = yield* observeRun(plan, threadId, data.auditRunId);
            if (!observed.unreachable && observed.run && !isTerminalRunStatus(observed.run.status))
              return undefined;
            const report = readAuditOutput(observed.run?.output?.value);
            return {
              auditId: operation.operationId,
              planVersion: plan.planVersion,
              baseOid,
              integrationOid: snapshotOid,
              auditorRunId: data.auditRunId,
              completedAt: now(),
              ...(data.secondOpinion ? { reviewId: data.secondOpinion.reviewId } : {}),
              ...(observed.run?.status === "completed" && report
                ? report
                : {
                    summary: "The audit ended without a valid report.",
                    findings: [
                      {
                        severity: "blocking" as const,
                        summary: "No usable audit report was returned.",
                      },
                    ],
                  }),
            } satisfies BatchAuditRecord;
          }
          const { selection } = yield* selectWorker(
            plan,
            data.secondOpinion ? data.secondOpinion.target : (plan.batchAuditAgent ?? undefined),
          );
          const worktree = yield* io(() =>
            Git.createManagedWorktree(
              target(plan),
              managedRoot,
              snapshotOid,
              operation.operationId,
            ),
          );
          const launched = yield* launch.launch({
            commandId: commandId(operation.operationId),
            threadId,
            projectId: projectId(plan),
            title: data.secondOpinion
              ? "Collaboration second opinion"
              : "Collaboration batch audit",
            generateTitle: false,
            titleRenamed: true,
            modelSelection: selection,
            interactionMode: "plan",
            runtimeMode: "approval-required",
            workspaceStrategy: { type: "existing_worktree", worktreePath: worktree.path },
            subagentParentThreadId: planThread(plan),
            createdBy: "system",
            creationSource: "server",
            initialMessage: {
              messageId: messageId(operation.operationId),
              attachments: [],
              outputSchema: auditOutputSchema,
              text: [
                "Review only the frozen Git snapshot. Use read-only commands and submit the structured report.",
                `Compare ${baseOid}..${snapshotOid}.`,
                data.secondOpinion?.brief ?? plan.requirement,
              ].join("\n"),
            },
          });
          const run = launched.projection.runs.find(
            ({ userMessageId }) => userMessageId === messageId(operation.operationId),
          );
          if (run?.threadId !== threadId)
            return yield* fail("Audit launch did not bind to its expected run.");
          yield* writes.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* currentIntent(operation.operationId);
              if (current)
                yield* store.updateIntentPayload(current.operation, {
                  ...data,
                  auditRunId: run.id,
                });
            }),
          );
          return undefined;
        }),
      ),
  );

  const verifyBatch = Effect.fn("VelaCollabEngine.verifyBatch")(function* (
    plan: CollabPlan,
    operation: CollabOutboxIntent,
  ) {
    const data = payload<BatchOperation>(operation);
    if (!data.secondOpinion && data.integrationOid !== plan.integrationOid) return;
    if (data.secondOpinion) {
      const reviewId = data.secondOpinion.reviewId;
      const evidence = yield* store.getRecord(plan.planId, "review", reviewId);
      if (!evidence?.reviewedOid)
        return yield* fail("The second opinion has no frozen review snapshot.");
      const step = yield* store.getStep(plan.planId, evidence.stepId);
      if (step?.reviewId !== reviewId)
        return yield* fail("The second opinion is for stale evidence.");
      const audit = yield* auditRun(
        plan,
        operation,
        data,
        evidence.stepBaseOid,
        evidence.reviewedOid,
      );
      if (!audit) return;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* currentIntent(operation.operationId);
          if (!current) return;
          const step = yield* store.getStep(plan.planId, evidence.stepId);
          if (step?.reviewId !== reviewId || step.attempt !== evidence.attempt) {
            yield* transition(current.plan, current.plan, {
              outboxSettlements: [settled(operation, { reason: "stale review" }, true)],
            });
            return;
          }
          yield* transition(current.plan, current.plan, {
            records: [{ kind: "batch_audit", id: audit.auditId, value: audit }],
            wakes: [
              wake(
                current.plan,
                "orchestrator_escalation",
                {
                  reviewId,
                  auditId: audit.auditId,
                  summary: audit.summary.slice(0, 1200),
                  blockingFindings: audit.findings.filter(({ severity }) => severity === "blocking")
                    .length,
                },
                step,
              ),
            ],
            outboxSettlements: [settled(operation, { auditId: audit.auditId })],
          });
        }),
      );
      return;
    }
    if (plan.status !== "batch_verifying") return;
    const steps = yield* store.listSteps(plan.planId);
    const commands = [
      ...new Set(
        [
          ...topologicalSteps(steps)
            .filter(stepComplete)
            .flatMap(({ hardGates }) => hardGates),
          ...plan.batchGates,
        ]
          .map((command) => command.trim())
          .filter(Boolean),
      ),
    ];
    const snapshotOid = data.drift?.mergedCandidateCommitOid ?? data.integrationOid;
    const baseOid = plan.baseOid;
    let summary = data.summary;
    if (!summary) {
      summary = yield* withPlanLock(
        plan.planId,
        Effect.gen(function* () {
          if (!(yield* currentIntent(operation.operationId))) return { passed: false, results: [] };
          return yield* io(async (signal) => {
            if (!snapshotOid) return { passed: commands.length === 0, results: [] };
            const worktree = data.drift
              ? await Git.createManagedWorktree(
                  target(plan),
                  managedRoot,
                  snapshotOid,
                  `${operation.operationId}-drift`,
                )
              : integrationWorktree(plan);
            return Git.verifySnapshotGates(target(plan), snapshotOid, commands, {
              executionWorktreePath: worktree.path,
              signal,
            });
          });
        }),
      );
      if (summary.passed && plan.enableBatchAudit && baseOid && snapshotOid) {
        const verified = summary;
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* currentIntent(operation.operationId);
            if (current)
              yield* store.updateIntentPayload(current.operation, { ...data, summary: verified });
          }),
        );
        return;
      }
    }
    const audit =
      summary.passed && plan.enableBatchAudit && baseOid && snapshotOid
        ? yield* auditRun(plan, operation, data, baseOid, snapshotOid)
        : undefined;
    if (summary.passed && plan.enableBatchAudit && baseOid && snapshotOid && !audit) return;
    const gateSummary = summary;
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* currentIntent(operation.operationId);
        if (!current || current.plan.status !== "batch_verifying") return;
        const fresh = current.plan;
        const blocked = audit?.findings.some(({ severity }) => severity === "blocking");
        const records: ReadonlyArray<CollabRecord> = audit
          ? [{ kind: "batch_audit", id: audit.auditId, value: audit }]
          : [];
        const settlement = [
          settled(operation, { passed: gateSummary.passed, auditId: audit?.auditId }),
        ];
        const next: CollabPlan = {
          ...fresh,
          batchGateSummary: gateSummary,
          ...(audit ? { batchAuditId: audit.auditId } : {}),
        };
        if (!gateSummary.passed || blocked) {
          const reason = blocked
            ? "The batch audit reported blocking findings."
            : "The combined batch gates failed.";
          yield* transition(
            fresh,
            { ...next, status: "running", attentionDetail: reason },
            {
              records,
              outboxSettlements: settlement,
              wakes: [
                wake(fresh, "batch_verification_failed", {
                  planVersion: fresh.planVersion,
                  integrationOid: fresh.integrationOid,
                  auditId: audit?.auditId,
                  reason,
                  gateSummary: gateSummaryForWake(gateSummary),
                }),
              ],
            },
          );
        } else if (!baseOid || !snapshotOid) {
          yield* transition(
            fresh,
            { ...next, status: "delivered" },
            { records, outboxSettlements: settlement },
          );
        } else {
          yield* transition(fresh, next, {
            records,
            outboxSettlements: settlement,
            outbox: [intent(fresh, "freeze_delivery", { ...data, snapshotOid })],
          });
        }
      }),
    );
  });

  const publishDelivery = Effect.fn("VelaCollabEngine.publishDelivery")(function* (
    initial: CollabPlan,
    requested: CollabOutboxIntent,
  ) {
    yield* withPlanLock(
      initial.planId,
      Effect.gen(function* () {
        const current = yield* currentIntent(requested.operationId);
        if (!current) return;
        const { plan, operation } = current;
        const data = payload<BatchOperation & { snapshotOid: string }>(operation);
        if (
          plan.status !== "batch_verifying" ||
          !plan.baseOid ||
          data.integrationOid !== plan.integrationOid ||
          !plan.batchGateSummary?.passed
        ) {
          return yield* fail("The prepared delivery is no longer current.");
        }
        const repo = target(plan);
        const expectedTargetState =
          data.drift?.expectedTargetState ?? (yield* io(() => resolveTree(repo, plan.baseOid!)));
        yield* io(async () => {
          const previous = await Git.readCollabRef(repo, Git.planRefs(plan.planId).delivery);
          await Git.freezeDelivery(repo, plan.planId, data.snapshotOid, previous);
        });
        const record: DeliveryRecord = {
          deliveryId: operation.operationId,
          planVersion: plan.planVersion,
          baseOid: plan.baseOid,
          deliveryOid: data.snapshotOid,
          expectedTargetState,
          ...(data.drift ? { applicationBaseOid: data.drift.expectedTargetState } : {}),
          batchGateSummary: plan.batchGateSummary,
          ...(plan.batchAuditId ? { batchAuditId: plan.batchAuditId } : {}),
          createdAt: operation.createdAt,
        };
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const fresh = yield* store.getPlan(plan.planId);
            if (!fresh) return;
            const { attentionDetail: _detail, ...clean } = fresh;
            yield* transition(
              fresh,
              { ...clean, status: "ready_to_deliver", deliveryId: record.deliveryId },
              {
                records: [{ kind: "delivery", id: record.deliveryId, value: record }],
                wakes: [
                  wake(fresh, "delivery_ready", {
                    deliveryId: record.deliveryId,
                    planVersion: record.planVersion,
                    deliveryOid: record.deliveryOid,
                    gateSummary: gateSummaryForWake(record.batchGateSummary),
                    batchAuditId: record.batchAuditId,
                  }),
                ],
                outboxSettlements: [settled(operation, { deliveryId: record.deliveryId })],
              },
            );
          }),
        );
      }),
    );
  });

  const retryBatchVerification = Effect.fn("VelaCollabEngine.retryBatchVerification")(
    (
      input: VersionedPlanCommand & {
        readonly integrationOid?: string | undefined;
      },
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          if (
            plan.status !== "running" ||
            plan.planVersion !== input.expectedPlanVersion ||
            plan.integrationOid !== input.integrationOid ||
            plan.batchGateSummary?.passed !== false
          ) {
            return yield* fail("Batch verification retry is stale.");
          }
          const { attentionDetail: _detail, batchGateSummary: _summary, ...rest } = plan;
          yield* transition(
            plan,
            { ...rest, status: "batch_verifying" },
            {
              outbox: [
                batchIntent(plan, plan.batchTargetDrift ? { drift: plan.batchTargetDrift } : {}),
              ],
            },
          );
        }),
      ),
  );

  const acceptBatchAudit = Effect.fn("VelaCollabEngine.acceptBatchAudit")(
    (
      input: VersionedPlanCommand & {
        readonly auditId: string;
        readonly callerRunId: string;
      },
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const [item, audit] = yield* Effect.all([
            store.getActiveInbox(plan),
            store.getRecord(plan.planId, "batch_audit", input.auditId),
          ]);
          if (
            plan.status !== "running" ||
            plan.planVersion !== input.expectedPlanVersion ||
            plan.batchAuditId !== input.auditId ||
            audit?.planVersion !== plan.planVersion ||
            audit.integrationOid !==
              (plan.batchTargetDrift?.mergedCandidateCommitOid ?? plan.integrationOid) ||
            !plan.batchGateSummary?.passed ||
            item?.planId !== plan.planId ||
            item.kind !== "batch_verification_failed" ||
            payload<{ auditId?: string }>(item).auditId !== input.auditId ||
            item.threadRunId !== input.callerRunId ||
            !input.callerRunId
          )
            return yield* fail("Only the dedicated batch escalation run can accept this audit.");
          yield* transition(
            plan,
            { ...plan, status: "batch_verifying" },
            {
              outbox: [
                intent(plan, "freeze_delivery", {
                  integrationOid: plan.integrationOid,
                  snapshotOid: audit.integrationOid,
                  ...(plan.batchTargetDrift ? { drift: plan.batchTargetDrift } : {}),
                }),
              ],
            },
          );
        }),
      ),
  );

  const requestSecondOpinion = Effect.fn("VelaCollabEngine.requestSecondOpinion")(
    (
      input: PlanCommand & {
        readonly stepId: string;
        readonly reviewId: string;
        readonly brief: string;
        readonly target?: DispatchAgentTarget;
      },
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const [step, evidence] = yield* Effect.all([
            store.getStep(plan.planId, input.stepId),
            store.getRecord(plan.planId, "review", input.reviewId),
          ]);
          if (
            step?.reviewId !== input.reviewId ||
            !evidence?.reviewedOid ||
            !plan.gitCommonDir ||
            (plan.status !== "running" && plan.status !== "batch_verifying")
          ) {
            return yield* fail(
              "The requested second opinion is for stale or unavailable evidence.",
            );
          }
          const operation = intent(
            plan,
            "verify_batch_gates",
            {
              secondOpinion: {
                reviewId: input.reviewId,
                brief: input.brief.slice(0, 8000),
                ...(input.target === undefined ? {} : { target: input.target }),
              },
            } satisfies BatchOperation,
            `second-opinion-${input.reviewId}`,
          );
          if (yield* store.getOutbox(operation.operationId)) return operation.operationId;
          yield* transition(plan, plan, { outbox: [operation] });
          return operation.operationId;
        }),
      ),
  );

  const runDelivery = Effect.fn("VelaCollabEngine.runDelivery")(function* (
    initial: CollabPlan,
    requested: CollabOutboxIntent,
  ) {
    return yield* withPlanLock(
      initial.planId,
      Effect.gen(function* () {
        const current = yield* currentIntent(requested.operationId);
        if (!current) return;
        const { plan, operation } = current;
        const { deliveryId } = payload<DeliveryOperation>(operation);
        const applying = operation.kind === "apply_delivery";
        const [delivery, applied] = yield* Effect.all([
          store.getRecord(plan.planId, "delivery", deliveryId),
          store.getRecord(plan.planId, "applied", deliveryId),
        ]);
        if (
          plan.deliveryId !== deliveryId ||
          delivery?.planVersion !== plan.planVersion ||
          (applying ? plan.status !== "ready_to_deliver" : plan.status !== "delivered" || !applied)
        ) {
          return yield* fail("Delivery authorization is no longer current.");
        }
        const context = yield* Effect.context<never>();
        const runPromise = Effect.runPromiseWith(context);
        return yield* withLease(plan, operation, "target_worktree", (lease) =>
          Effect.gen(function* () {
            const result = yield* io(() =>
              withWorkspaceAdmission(target(plan), async () => {
                if (hasDirectWorkspaceWriter(target(plan))) {
                  if (operation.recovery)
                    throw error("A legacy collaboration is writing to the target workspace.");
                  return { status: "target_busy" as const };
                }
                const gitBinding = binding(plan);
                if (operation.recovery)
                  return Git.reconcileInterruptedDelivery(gitBinding, operation.recovery);
                const request = {
                  binding: gitBinding,
                  planId: plan.planId,
                  operationId: operation.operationId,
                  persistRecovery: (
                    record: import("./VelaCollabTypes.ts").CollabDeliveryRecovery,
                  ) =>
                    runPromise(
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((time) => store.recordDeliveryRecovery(lease, record, time)),
                      ),
                    ),
                };
                if (applying)
                  return Git.preflightAndApplyDelivery({
                    ...request,
                    baseOid: delivery.applicationBaseOid ?? delivery.baseOid,
                    deliveryOid: delivery.deliveryOid,
                    expectedTargetState: delivery.expectedTargetState,
                  });
                return Git.revertDeliverySafely({
                  ...request,
                  appliedBaseTree: applied!.appliedBaseTree,
                  appliedResultTree: applied!.appliedResultTree,
                });
              }),
            );
            yield* writes.withPermits(1)(
              Effect.gen(function* () {
                const fresh = yield* store.getPlan(plan.planId);
                if (!fresh) return;
                const settlement = [settled(operation, result)];
                if (result.status === "drifted_needs_reverify") {
                  const {
                    deliveryId: _deliveryId,
                    batchGateSummary: _summary,
                    batchAuditId: _audit,
                    ...clean
                  } = fresh;
                  yield* transition(
                    fresh,
                    { ...clean, status: "batch_verifying", batchTargetDrift: result },
                    {
                      outboxSettlements: settlement,
                      outbox: [batchIntent(fresh, { drift: result })],
                    },
                  );
                  return;
                }
                if (result.status === "applied" || (applying && result.status === "reconciled")) {
                  yield* transition(
                    fresh,
                    { ...fresh, status: "delivered" },
                    {
                      outboxSettlements: settlement,
                      records: [
                        {
                          kind: "applied",
                          id: deliveryId,
                          value: {
                            deliveryId,
                            operationId: operation.operationId,
                            appliedAt: now(),
                            appliedBaseTree:
                              result.status === "applied"
                                ? result.appliedBaseTree
                                : result.baseTree,
                            appliedResultTree:
                              result.status === "applied"
                                ? result.appliedResultTree
                                : result.resultTree,
                          },
                        },
                      ],
                    },
                  );
                  return;
                }
                if (result.status === "reverted" || result.status === "reconciled") {
                  yield* transition(fresh, fresh, {
                    outboxSettlements: settlement,
                    records: [
                      {
                        kind: "reverted",
                        id: deliveryId,
                        value: {
                          deliveryId,
                          operationId: operation.operationId,
                          revertedAt: now(),
                          revertedBaseTree:
                            result.status === "reverted"
                              ? result.revertedBaseTree
                              : result.baseTree,
                          revertedResultTree:
                            result.status === "reverted"
                              ? result.revertedResultTree
                              : result.resultTree,
                        },
                      },
                    ],
                  });
                  return;
                }
                const reason =
                  result.status === "conflict"
                    ? `Target conflicts: ${result.conflictFiles.join(", ")}`
                    : "A legacy collaboration is writing to the target workspace.";
                yield* transition(
                  fresh,
                  { ...fresh, attentionDetail: reason },
                  { outboxSettlements: settlement },
                );
              }),
            );
            return result;
          }),
        );
      }),
    );
  });

  const requestDelivery = Effect.fn("VelaCollabEngine.requestDelivery")(function* (
    input: DeliveryInput | (PlanCommand & { readonly deliveryId: string }),
    applying: boolean,
  ) {
    const request = yield* withPlanLock(
      input.planId,
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan(input);
          const delivery = yield* store.getRecord(plan.planId, "delivery", input.deliveryId);
          if (
            !delivery ||
            plan.deliveryId !== input.deliveryId ||
            delivery.planVersion !== plan.planVersion
          ) {
            return yield* fail("Delivery authorization is stale.");
          }
          if (applying) {
            if (
              plan.status !== "ready_to_deliver" ||
              !("expectedTargetState" in input) ||
              input.expectedTargetState !== delivery.expectedTargetState
            ) {
              return yield* fail(
                "This delivery requires confirmation of its current target state.",
              );
            }
          } else if (
            plan.status !== "delivered" ||
            !(yield* store.getRecord(plan.planId, "applied", input.deliveryId)) ||
            (yield* store.getRecord(plan.planId, "reverted", input.deliveryId))
          ) {
            return yield* fail("The delivery is not eligible for reversion.");
          }
          if (
            (yield* store.listPendingIntents()).some(
              (op) =>
                op.planId === plan.planId &&
                (op.kind === "apply_delivery" || op.kind === "revert_delivery"),
            )
          ) {
            return yield* fail("A delivery operation is already awaiting reconciliation.");
          }
          const pending = intent(plan, applying ? "apply_delivery" : "revert_delivery", {
            deliveryId: input.deliveryId,
          });
          // This caller owns the first execution. Recovery uses the same persisted operation.
          processing.add(pending.operationId);
          yield* transition(plan, plan, { outbox: [pending] }).pipe(
            Effect.onError(() => Effect.sync(() => processing.delete(pending.operationId))),
          );
          return { plan, id: pending.operationId };
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const operation = yield* store.getOutbox(request.id);
      if (!operation) return yield* fail("The recorded delivery operation is missing.");
      return (
        (yield* runDelivery(request.plan, operation).pipe(
          Effect.tapError((cause) => recordOperationFailure(operation, cause)),
        )) ?? {
          status: "pending" as const,
          operationId: request.id,
        }
      );
    }).pipe(Effect.ensuring(Effect.sync(() => processing.delete(request.id))));
  });

  const deliverPlan = (input: DeliveryInput) => requestDelivery(input, true);
  const revertDelivery = (input: PlanCommand & { readonly deliveryId: string }) =>
    requestDelivery(input, false);

  const updatePlan = Effect.fn("VelaCollabEngine.updatePlan")(
    (
      input: VersionedPlanCommand & {
        readonly options?: Partial<PlanOptions>;
        readonly steps?: ReadonlyArray<CollabStepInput>;
        readonly cancelStepIds?: ReadonlyArray<string>;
      },
    ) =>
      withPlanLock(
        input.planId,
        writes.withPermits(1)(
          Effect.gen(function* () {
            const plan = yield* requirePlan(input);
            if (
              plan.planVersion !== input.expectedPlanVersion ||
              (plan.status !== "draft" &&
                plan.status !== "running" &&
                plan.status !== "batch_verifying" &&
                plan.status !== "ready_to_deliver")
            ) {
              return yield* fail("Collaboration plan version is stale or no longer editable.");
            }
            const [oldSteps, pending] = yield* Effect.all([
              store.listSteps(plan.planId),
              store.listPendingIntents(),
            ]);
            const planOps = pending.filter((item) => item.planId === plan.planId);
            if (
              planOps.some(
                (item) =>
                  item.kind === "initialize_plan" ||
                  item.kind === "apply_delivery" ||
                  item.kind === "revert_delivery" ||
                  (item.kind === "update_integration" &&
                    payload<IntegrationOperation>(item).merge !== undefined),
              )
            ) {
              return yield* fail(
                "A pending Git operation must reconcile before editing this collaboration.",
              );
            }
            const old = new Map(oldSteps.map((step) => [step.stepId, step]));
            const changed = new Set<string>();
            const cancel = new Set(input.cancelStepIds ?? []);
            for (const id of cancel) {
              const step = old.get(id);
              if (!step || stepComplete(step))
                return yield* fail("Completed steps require a compensating step.");
            }
            const definitions = (input.steps ?? []).map((step, order) =>
              defineStep(plan.planId, step, order),
            );
            if (new Set(definitions.map(({ stepId }) => stepId)).size !== definitions.length) {
              return yield* fail("Duplicate collaboration step definitions.");
            }
            const patches = new Map(definitions.map((step) => [step.stepId, step]));
            const comparable = (step: CollabStep) => {
              const {
                planId,
                order,
                stepId,
                kind,
                title,
                objective,
                dependsOn,
                criteria,
                executor,
                allowedPaths,
                allowedGlobs,
                forbiddenPaths,
                forbiddenGlobs,
                sensitivePaths,
                hardGates,
                decisionOptions,
                contextFiles,
                contractNote,
              } = step;
              return {
                planId,
                order,
                stepId,
                kind,
                title,
                objective,
                dependsOn,
                criteria,
                executor,
                allowedPaths,
                allowedGlobs,
                forbiddenPaths,
                forbiddenGlobs,
                sensitivePaths,
                hardGates,
                decisionOptions,
                contextFiles,
                contractNote,
              };
            };
            const merged = oldSteps.map((step) => {
              const patch = patches.get(step.stepId);
              if (!patch) return step;
              patches.delete(step.stepId);
              const definition = { ...patch, order: step.order };
              if (NodeUtil.isDeepStrictEqual(comparable(definition), comparable(step))) return step;
              changed.add(step.stepId);
              return {
                ...definition,
                attempt: step.attempt,
                criteriaVersion: step.criteriaVersion,
                status: step.status,
              };
            });
            const existing = new Set(old.keys());
            for (const definition of patches.values()) {
              merged.push({ ...definition, order: merged.length });
              changed.add(definition.stepId);
            }
            if (
              input.options?.requirement !== undefined &&
              input.options.requirement !== plan.requirement
            ) {
              for (const step of oldSteps)
                if (!stepComplete(step) && step.status !== "cancelled") changed.add(step.stepId);
            }
            // Model defaults are read for subsequent launches. Explicitly edited steps restart.
            for (const id of changed) {
              const previous = old.get(id);
              if (previous && stepComplete(previous))
                return yield* fail("Completed steps require a compensating step.");
            }
            if (plan.gitCommonDir === null && merged.some(({ kind }) => kind === "change")) {
              return yield* fail("A Git worktree is required for collaboration change steps.");
            }
            const ordered = yield* checked(() => validateSteps(merged));
            const cancelledSteps = affectedSteps(ordered, cancel);
            const affected = affectedSteps(ordered, new Set([...changed, ...cancelledSteps]));
            const revised = merged.map((step): CollabStep => {
              if (!affected.has(step.stepId)) return step;
              const {
                childThreadId: _thread,
                worktreePath: _path,
                ...rest
              } = clearStepEvidence(step);
              return {
                ...rest,
                phase: "initial",
                status: cancelledSteps.has(step.stepId) ? "cancelled" : "locked",
                criteriaVersion: step.criteriaVersion + (existing.has(step.stepId) ? 1 : 0),
              };
            });
            const {
              deliveryId: _delivery,
              batchGateSummary: _batch,
              batchAuditId: _audit,
              batchTargetDrift: _drift,
              attentionDetail: _detail,
              ...base
            } = plan;
            const next: CollabPlan = {
              ...base,
              ...input.options,
              planVersion: plan.planVersion + 1,
              status: plan.status === "draft" ? "draft" : "running",
            };
            const invalid = planOps.filter((operation) => {
              if (operation.kind === "enqueue_inbox") {
                const item = payload<CollabInboxWake>(operation);
                return (
                  item.kind === "delivery_ready" ||
                  item.kind === "batch_verification_failed" ||
                  (item.stepId !== undefined && affected.has(item.stepId))
                );
              }
              if (operation.kind === "verify_batch_gates") {
                const opinion = payload<BatchOperation>(operation).secondOpinion;
                return (
                  !opinion ||
                  oldSteps.some(
                    (step) => step.reviewId === opinion.reviewId && affected.has(step.stepId),
                  )
                );
              }
              if (operation.kind === "freeze_delivery") return true;
              return (
                ["create_worktree", "verify_step_gates", "update_integration"].includes(
                  operation.kind,
                ) && affected.has(payload<StepOperation>(operation).stepId)
              );
            });
            const interruptions = oldSteps.flatMap(
              ({ stepId, status, childThreadId, workerRunId }) =>
                affected.has(stepId) && status === "developing" && childThreadId && workerRunId
                  ? [interruptWorkerIntent(next, childThreadId, workerRunId)]
                  : [],
            );
            yield* transition(plan, next, {
              steps: revised.filter((step) => affected.has(step.stepId)),
              rebasePending: true,
              outbox: [...interruptions, ...interruptAudits(next, invalid)],
              outboxSettlements: invalid.map((operation) =>
                settled(operation, { reason: "plan updated" }, true),
              ),
            });
            return next.planVersion;
          }),
        ),
      ),
  );

  const cancelStep = (input: VersionedPlanCommand & { readonly stepId: string }) =>
    updatePlan({ ...input, cancelStepIds: [input.stepId] });

  const setStepExecutor = Effect.fn("VelaCollabEngine.setStepExecutor")(
    (
      input: VersionedPlanCommand & {
        readonly stepId: string;
        readonly executor: DispatchAgentTarget | null;
      },
    ) =>
      withPlanLock(
        input.planId,
        writes.withPermits(1)(
          Effect.gen(function* () {
            const plan = yield* requirePlan(input);
            if (
              plan.planVersion !== input.expectedPlanVersion ||
              (plan.status !== "draft" && plan.status !== "running")
            ) {
              return yield* fail("Collaboration plan version is stale or no longer editable.");
            }
            const step = yield* store.getStep(plan.planId, input.stepId);
            if (!step) return yield* fail(`Unknown collaboration step: ${input.stepId}`);
            if (step.status !== "locked" && step.status !== "ready") {
              return yield* fail("Only pending steps can change execution model.");
            }
            const { executor: _oldExecutor, ...stepRest } = step;
            const nextStep: CollabStep = {
              ...stepRest,
              ...(input.executor === null ? {} : { executor: input.executor }),
            };
            const nextPlan: CollabPlan = { ...plan, planVersion: plan.planVersion + 1 };
            yield* transition(plan, nextPlan, { steps: [nextStep] });
            return nextPlan.planVersion;
          }),
        ),
      ),
  );

  const cancelPlan = Effect.fn("VelaCollabEngine.cancelPlan")(
    (scope: CollabScope, planId: string) =>
      withPlanLock(
        planId,
        writes.withPermits(1)(
          Effect.gen(function* () {
            const plan = yield* requirePlan({ ...scope, planId });
            if (plan.status === "cancelled") return;
            if (plan.status === "delivered" || plan.status === "failed")
              return yield* fail("This collaboration is already complete.");
            const [steps, pending, inbox] = yield* Effect.all([
              store.listSteps(planId),
              store.listPendingIntents(),
              store.getActiveInbox(scope),
            ]);
            const operations = pending.filter((item) => item.planId === planId);
            if (
              operations.some(
                (item) =>
                  item.kind === "apply_delivery" ||
                  (item.kind === "update_integration" &&
                    payload<IntegrationOperation>(item).merge !== undefined),
              )
            )
              return yield* fail("A pending Git operation must reconcile before cancellation.");

            const active = inbox?.planId === planId ? inbox : null;
            const receipt = { reason: "plan cancelled" };
            const next = { ...plan, status: "cancelled" as const };
            yield* transition(plan, next, {
              steps: steps
                .filter((step) => !stepComplete(step))
                .map((step) => ({ ...clearStepEvidence(step), status: "cancelled" })),
              ...(active
                ? {
                    inbox: {
                      action: "invalidate",
                      inboxItemId: active.inboxItemId,
                      receiptJson: encode(receipt),
                    },
                  }
                : {}),
              outbox: [
                ...steps.flatMap(({ status, childThreadId, workerRunId }) =>
                  status === "developing" && childThreadId && workerRunId
                    ? [interruptWorkerIntent(next, childThreadId, workerRunId)]
                    : [],
                ),
                ...interruptAudits(next, operations),
              ],
              outboxSettlements: operations
                .filter(
                  ({ operationId }) =>
                    operationId !== active?.commandId && operationId !== active?.inboxItemId,
                )
                .map((operation) => settled(operation, receipt, true)),
            });
          }),
        ),
      ),
  );

  const updateConfig = Effect.fn("VelaCollabEngine.updateConfig")(function* (
    scope: CollabScope,
    config: {
      readonly planId?: string | undefined;
      readonly defaultDevAgent?: DispatchAgentTarget | null | undefined;
      readonly enableBatchAudit?: boolean | undefined;
      readonly batchAuditAgent?: DispatchAgentTarget | null | undefined;
    },
  ) {
    const active = config.planId ?? (yield* store.findActivePlan(scope))?.planId;
    if (!active) return yield* fail("This thread has no active collaboration.");
    yield* withPlanLock(
      active,
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* requirePlan({ ...scope, planId: active });
          if (
            plan.status === "delivered" ||
            plan.status === "cancelled" ||
            plan.status === "failed"
          )
            return yield* fail("This collaboration is already complete.");

          const { defaultDevAgent, ...rest } = plan;
          const devAgent =
            config.defaultDevAgent === undefined ? defaultDevAgent : config.defaultDevAgent;
          const next: CollabPlan = {
            ...rest,
            ...(devAgent == null ? {} : { defaultDevAgent: devAgent }),
            ...(config.enableBatchAudit === undefined
              ? {}
              : { enableBatchAudit: config.enableBatchAudit }),
            ...(config.batchAuditAgent === undefined
              ? {}
              : { batchAuditAgent: config.batchAuditAgent }),
          };
          const auditChanged =
            !!next.enableBatchAudit !== !!plan.enableBatchAudit ||
            (next.enableBatchAudit &&
              encode(next.batchAuditAgent ?? null) !== encode(plan.batchAuditAgent ?? null));
          if (
            !auditChanged ||
            (plan.status !== "batch_verifying" &&
              plan.status !== "ready_to_deliver" &&
              !plan.batchGateSummary?.passed)
          ) {
            yield* transition(plan, next, {});
            return;
          }

          const [pending, inbox] = yield* Effect.all([
            store.listPendingIntents(),
            store.getActiveInbox(scope),
          ]);
          const operations = pending.filter(({ planId }) => planId === active);
          if (operations.some(({ kind }) => kind === "apply_delivery"))
            return yield* fail("A pending delivery must reconcile before changing audit settings.");
          const receipt = { reason: "batch audit settings changed" };
          const isBatchWake = ({ kind }: { readonly kind: string }) =>
            kind === "batch_verification_failed" || kind === "delivery_ready";
          const staleInbox = inbox?.planId === active && isBatchWake(inbox) ? inbox : null;
          const {
            batchAuditId: _audit,
            deliveryId: _delivery,
            batchGateSummary: _gates,
            attentionDetail: _detail,
            ...base
          } = next;
          const obsolete = operations.filter(
            (operation) =>
              operation.kind === "freeze_delivery" ||
              (operation.kind === "verify_batch_gates" &&
                !payload<BatchOperation>(operation).secondOpinion) ||
              (operation.kind === "enqueue_inbox" &&
                operation.operationId !== staleInbox?.inboxItemId &&
                isBatchWake(payload<CollabInboxWake>(operation))),
          );
          yield* transition(
            plan,
            { ...base, status: "batch_verifying" },
            {
              ...(staleInbox
                ? {
                    inbox: {
                      action: "invalidate",
                      inboxItemId: staleInbox.inboxItemId,
                      receiptJson: encode(receipt),
                    },
                  }
                : {}),
              outboxSettlements: obsolete.map((operation) => settled(operation, receipt, true)),
              outbox: [
                ...interruptAudits(next, obsolete),
                batchIntent(next, plan.batchTargetDrift ? { drift: plan.batchTargetDrift } : {}),
              ],
            },
          );
        }),
      ),
    );
    return yield* store.buildProjection(active);
  });

  const readEvidence = Effect.fn("VelaCollabEngine.readEvidence")(function* (input: EvidenceInput) {
    const plan = yield* requirePlan({ ...input, parentThreadId: input.threadId });
    const repo = target(plan);
    const source = yield* io(() => Git.probeRepository(input.repositoryPath ?? repo));
    if (source.gitCommonDir !== plan.gitCommonDir || source.canonicalTargetWorktree !== repo)
      return yield* fail("Evidence repository binding no longer matches.");
    const limit = input.maxBytes ?? MAX_MANIFEST_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MANIFEST_BYTES) {
      return yield* fail("Evidence byte limit must be between 1 and 65,536.");
    }
    const selected = input.evidence;
    if (source.kind === "non_git") {
      if (input.kind !== "manifest" || !("reviewId" in selected) || (input.offset ?? 0) !== 0) {
        return yield* fail("This research evidence has no Git diff or file snapshot.");
      }
      const report = yield* store.getRecord(plan.planId, "review", selected.reviewId);
      if (!report || report.reviewedOid || report.stepBaseOid) {
        return yield* fail("The frozen research report is unavailable.");
      }
      const summary = report.summary ?? "";
      if (Buffer.byteLength(encode(summary)) + 2 > limit) {
        return yield* fail("The byte limit is too small for the research report.");
      }
      return { kind: "manifest" as const, files: [], offset: 0, nextOffset: null, summary };
    }
    const snapshots = yield* Effect.gen(function* () {
      if ("reviewId" in selected) {
        const record = yield* store.getRecord(plan.planId, "review", selected.reviewId);
        if (!record?.reviewedOid || !record.stepBaseOid)
          return yield* fail("Frozen review evidence is unavailable.");
        return yield* io(async () => {
          if (record.stepBaseOid !== record.reviewedOid) {
            const refs = Git.stepRefs(plan.planId, record.stepId, record.attempt);
            if (
              (await Git.readCollabRef(repo, refs.reviewed)) !== record.reviewedOid ||
              (await Git.readCollabRef(repo, refs.base)) !== record.stepBaseOid
            ) {
              throw error("Frozen review evidence no longer matches its references.");
            }
          }
          return {
            base: record.stepBaseOid,
            snapshot: record.reviewedOid,
            summary: record.summary,
          };
        });
      }
      const delivery = yield* store.getRecord(plan.planId, "delivery", selected.deliveryId);
      if (plan.deliveryId !== selected.deliveryId || delivery?.planVersion !== plan.planVersion) {
        return yield* fail("Frozen delivery evidence is stale.");
      }
      return yield* io(async () => {
        if (
          (await Git.readCollabRef(repo, Git.planRefs(plan.planId).delivery)) !==
          delivery.deliveryOid
        ) {
          throw error("Frozen delivery evidence no longer matches its reference.");
        }
        return { base: delivery.baseOid, snapshot: delivery.deliveryOid, summary: undefined };
      });
    });
    if (input.kind === "diff")
      return yield* io(() =>
        Git.readSnapshotFileDiff(repo, snapshots.base, snapshots.snapshot, input.path, {
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          maxBytes: limit,
        }),
      );
    if (input.kind === "file")
      return yield* io(() =>
        Git.readSnapshotFileLines(
          repo,
          input.side === "base" ? snapshots.base : snapshots.snapshot,
          input.path,
          {
            ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
            ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
            maxBytes: limit,
          },
        ),
      );
    const files = yield* io(() =>
      Git.readSnapshotManifest(repo, snapshots.base, snapshots.snapshot),
    );
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > files.length)
      return yield* fail("Invalid manifest offset.");
    if (limit < 2) return yield* fail("The byte limit is too small for the manifest.");
    const page: (typeof files)[number][] = [];
    let bytes = 2;
    for (const file of files.slice(offset)) {
      const size = Buffer.byteLength(encode(file)) + Number(page.length > 0);
      if (bytes + size > limit) break;
      bytes += size;
      page.push(file);
    }
    if (!page.length && offset < files.length)
      return yield* fail("The byte limit is too small for a manifest entry.");
    const summary = snapshots.summary;
    return {
      kind: "manifest" as const,
      files: page,
      offset,
      nextOffset: offset + page.length < files.length ? offset + page.length : null,
      ...(summary && Buffer.byteLength(summary) + bytes <= limit ? { summary } : {}),
    };
  });

  const queueReadySteps = Effect.fn("VelaCollabEngine.queueReadySteps")((planId: string) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const plan = yield* store.getPlan(planId);
        if (plan?.status !== "running") return;
        const original = yield* store.listSteps(planId);
        const newlyReady = unlockSteps(original);
        const ready = [...original.filter(({ status }) => status === "ready"), ...newlyReady];
        if (!ready.length) {
          if (
            !plan.batchGateSummary &&
            original.length &&
            original.every((step) => stepComplete(step) || step.status === "cancelled")
          ) {
            yield* transition(
              plan,
              { ...plan, status: "batch_verifying" },
              { outbox: [batchIntent(plan)] },
            );
          }
          return;
        }
        const steps = ready.map((step): CollabStep =>
          step.kind === "decision" && step.decisionOptions?.length
            ? attention(step, "decision", "Choose one of the proposed options.")
            : {
                ...step,
                status: "developing",
                attempt: step.attempt + 1,
                ...(plan.integrationOid ? { stepBaseOid: plan.integrationOid } : {}),
              },
        );
        yield* transition(plan, plan, {
          steps,
          outbox: steps
            .filter(({ status }) => status === "developing")
            .map((step) => createWorkIntent(plan, step)),
        });
      }),
    ),
  );

  const recordOperationFailure = Effect.fn("VelaCollabEngine.recordOperationFailure")(function* (
    requested: CollabOutboxIntent,
    cause: unknown,
  ) {
    const reason = detailOf(cause);
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* currentIntent(requested.operationId);
        if (!current) return;
        const { plan, operation } = current;
        if (operation.kind === "apply_delivery" || operation.kind === "revert_delivery") {
          if (operation.recovery) {
            // Leave the journal available for recovery after external drift is resolved.
            suppressed.add(operation.operationId);
            yield* transition(plan, { ...plan, attentionDetail: reason }, {});
          } else {
            yield* transition(
              plan,
              { ...plan, attentionDetail: reason },
              { outboxSettlements: [settled(operation, { reason }, true)] },
            );
          }
          return;
        }
        if (
          operation.kind === "update_integration" &&
          payload<IntegrationOperation>(operation).merge
        ) {
          suppressed.add(operation.operationId);
          yield* transition(plan, { ...plan, attentionDetail: reason }, {});
          return;
        }
        const data = payload<Partial<StepOperation> & BatchOperation>(operation);
        const step = data.stepId ? yield* store.getStep(plan.planId, data.stepId) : null;
        const settlement = { outboxSettlements: [settled(operation, { reason }, true)] };
        if (step && step.attempt === data.attempt) {
          yield* transition(plan, plan, {
            ...settlement,
            steps: [attention(step, "evidence_error", reason)],
          });
        } else if (operation.kind === "verify_batch_gates" && !data.secondOpinion) {
          const summary = { passed: false, results: [] };
          yield* transition(
            plan,
            { ...plan, status: "running", batchGateSummary: summary, attentionDetail: reason },
            {
              ...settlement,
              wakes: [
                wake(plan, "batch_verification_failed", {
                  reason,
                  integrationOid: plan.integrationOid,
                  planVersion: plan.planVersion,
                }),
              ],
            },
          );
        } else {
          yield* transition(
            plan,
            {
              ...plan,
              attentionDetail: reason,
              ...(operation.kind === "initialize_plan" || operation.kind === "freeze_delivery"
                ? { status: "failed" as const }
                : {}),
            },
            settlement,
          );
        }
      }),
    );
  });

  const execute = Effect.fn("VelaCollabEngine.execute")(function* (requested: CollabOutboxIntent) {
    const current = yield* currentIntent(requested.operationId);
    if (!current) return;
    const { plan, operation } = current;
    if (operation.kind === "send_thread") {
      const stop = payload<StopWorkerOperation>(operation);
      if (stop.action !== "interrupt_worker") return;
      yield* threads.interruptThread({
        projectId: projectId(plan),
        commandId: commandId(operation.operationId),
        threadId: ThreadId.make(stop.threadId),
        runId: RunId.make(stop.runId),
        reason: "The collaboration step changed.",
      });
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* currentIntent(operation.operationId);
          if (latest)
            yield* transition(latest.plan, latest.plan, {
              outboxSettlements: [settled(operation)],
            });
        }),
      );
      return;
    }
    if (plan.gitCommonDir) {
      const actual = yield* io(() => Git.probeRepository(target(plan)));
      if (
        actual.gitCommonDir !== plan.gitCommonDir ||
        actual.canonicalTargetWorktree !== target(plan)
      ) {
        return yield* fail("Collaboration repository binding changed.");
      }
    }
    switch (operation.kind) {
      case "initialize_plan":
      case "create_worktree":
        return yield* withPlanLock(
          plan.planId,
          Effect.gen(function* () {
            const fresh = yield* currentIntent(operation.operationId);
            if (!fresh) return;
            return yield* operation.kind === "initialize_plan"
              ? initializePlan(fresh.plan, fresh.operation)
              : launchWorker(fresh.plan, fresh.operation);
          }),
        );
      case "verify_step_gates":
        return yield* verifyStep(plan, operation);
      case "update_integration":
        return yield* integrate(plan, operation);
      case "verify_batch_gates":
        return yield* verifyBatch(plan, operation);
      case "freeze_delivery":
        return yield* publishDelivery(plan, operation);
      case "apply_delivery":
      case "revert_delivery":
        yield* runDelivery(plan, operation);
        return;
      default:
        return;
    }
  });

  const forkUnique = Effect.fn("VelaCollabEngine.forkUnique")(function* <E>(
    key: string,
    work: Effect.Effect<unknown, E>,
  ) {
    if (processing.has(key) || suppressed.has(key)) return;
    processing.add(key);
    yield* work.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Effect.sync(() => processing.delete(key))),
      Effect.forkIn(layerScope),
    );
  });

  const processInbox = Effect.fn("VelaCollabEngine.processInbox")(function* (scope: CollabScope) {
    const { item, claimed } = yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const active = yield* store.getActiveInbox(scope);
        return active
          ? { item: active, claimed: false }
          : { item: yield* store.claimNextInbox(scope), claimed: true };
      }),
    );
    if (!item) return;
    const plan = yield* store.getPlan(item.planId);
    if (!plan || plan.environmentId !== environmentId) return;
    if (claimed) yield* publish(plan);
    if (item.status === "pending") {
      yield* dispatchInbox(plan, item).pipe(
        Effect.catch((cause) => rejectInbox(plan, item, detailOf(cause))),
      );
    } else {
      yield* finishInbox(plan, item);
    }
  });

  const reconcileOnStartup = Effect.fn("VelaCollabEngine.reconcileOnStartup")(() =>
    scanLock.withPermits(1)(
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        const recovery = yield* store.scanRecovery(timestamp);
        for (const lease of recovery.expiredLeases) {
          if (!processing.has(lease.operationId))
            yield* store.reconcileExpiredLease(lease, timestamp);
        }
        const plans = (yield* store.listActivePlans()).filter(
          (plan) => plan.environmentId === environmentId,
        );
        const owners = new Map<string, CollabScope>(plans.map((plan) => [scopeKey(plan), plan]));
        for (const item of recovery.inbox) {
          if (item.environmentId === environmentId) owners.set(scopeKey(item), item);
        }
        for (const [key, scope] of owners) yield* forkUnique(`inbox:${key}`, processInbox(scope));
        const integrationPlans = new Set<string>();
        for (const operation of recovery.outbox) {
          if (
            operation.kind === "enqueue_inbox" ||
            (operation.kind === "send_thread" &&
              payload<StopWorkerOperation>(operation).action !== "interrupt_worker")
          )
            continue;
          if (operation.kind === "update_integration") {
            if (integrationPlans.has(operation.planId)) continue;
            integrationPlans.add(operation.planId);
          }
          yield* forkUnique(
            operation.operationId,
            execute(operation).pipe(
              Effect.catch((cause) => recordOperationFailure(operation, cause)),
            ),
          );
        }
        for (const plan of plans) {
          if (plan.status !== "running") continue;
          yield* queueReadySteps(plan.planId);
          for (const step of yield* store.listSteps(plan.planId)) {
            if (step.status === "developing" && step.workerRunId) {
              yield* forkUnique(`worker:${step.workerRunId}`, finishWorker(plan, step));
            }
          }
        }
      }),
    ),
  );

  const subscribe = (scope: CollabScope, listener: (projection: VelaCollabProjection) => void) => {
    const key = scopeKey(scope);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size && listeners.get(key) === set) listeners.delete(key);
    };
  };

  yield* threads.streamStoredEvents.pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "run.updated" ||
        event.type === "run.output-submitted" ||
        event.type === "thread.deleted" ||
        event.type === "thread.archived",
    ),
    Stream.runForEach(() => kick),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* reconcileOnStartup().pipe(Effect.ignoreCause({ log: true }));
      yield* Queue.take(signal).pipe(Effect.timeoutOption("500 millis"));
    }),
  ).pipe(Effect.forkScoped);

  const getActiveProjection = Effect.fn("VelaCollabEngine.getActiveProjection")(function* (
    scope: CollabScope,
    options?: { readonly includeLatest?: boolean },
  ) {
    if (scope.environmentId !== environmentId)
      return yield* fail("Collaboration must run in the local environment.");
    const active = yield* store.findActivePlan(scope);
    const plan = active ?? (options?.includeLatest ? yield* store.findLatestPlan(scope) : null);
    return plan ? yield* store.buildProjection(plan.planId) : null;
  });

  return {
    createAndStartPlan,
    startPlan,
    updatePlan,
    cancelStep,
    setStepExecutor,
    cancelPlan,
    updateConfig,
    submitReviewVerdict,
    retryIncompleteReview,
    resolveStepAttention,
    retryBatchVerification,
    acceptBatchAudit,
    requestSecondOpinion,
    deliverPlan,
    revertDelivery,
    readEvidence,
    reconcileOnStartup,
    subscribe,
    subscribeAll: (listener: () => void) => {
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
      };
    },
    listAttentionItems: () => store.listAttentionItems(environmentId),
    getActiveProjection,
    getProjection: (input: PlanCommand) =>
      requirePlan(input).pipe(Effect.flatMap((plan) => store.buildProjection(plan.planId))),
  };
});

export class VelaCollabEngine extends Context.Service<
  VelaCollabEngine,
  Effect.Success<typeof make>
>()("t3/dispatch/VelaCollabEngine") {}

export const layer = Layer.effect(VelaCollabEngine, make);
