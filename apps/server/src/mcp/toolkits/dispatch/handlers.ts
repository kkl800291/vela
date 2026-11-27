import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { VelaCollabEngine } from "../../../dispatch/VelaCollabEngine.ts";
import {
  collabPlanOptions,
  collabSteps,
  evidenceInput,
} from "../../../dispatch/VelaCollabInputs.ts";
import * as VelaDispatchService from "../../../dispatch/VelaDispatchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VelaDispatchToolkit } from "./tools.ts";

function dispatchFailure(error: unknown): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

const resolveCallerProjectRoot = Effect.fn("dispatch.resolveCallerProjectRoot")(function* (
  explicitProjectRoot: string | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const parentThreadId = scope.thread?.threadId;
  if (explicitProjectRoot) {
    return { projectRoot: explicitProjectRoot, parentThreadId };
  }
  if (!parentThreadId) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "请提供 projectRoot，或在具体项目线程中调用此工具。",
    });
  }
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const shell = yield* threads
    .getThreadShell(parentThreadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (!shell) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "无法解析当前线程所属项目，请显式传入 projectRoot。",
    });
  }
  const project = yield* projects
    .getById(shell.projectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "未找到当前线程所属项目的工作区路径，请显式传入 projectRoot。",
    });
  }
  return { projectRoot: project.value.workspaceRoot, parentThreadId };
});

const v2Scope = (scope: McpInvocationContext.McpThreadInvocationScope) => ({
  environmentId: scope.environmentId,
  parentThreadId: scope.thread.threadId,
});

const getCollab = Effect.fn("dispatch.getCollab")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
  planId: string | undefined,
) {
  const engine = yield* VelaCollabEngine;
  if (planId) {
    const caller = yield* McpInvocationContext.requireThreadScope(invocation, "Vela collaboration");
    return yield* engine
      .getProjection({ ...v2Scope(caller), planId })
      .pipe(Effect.mapError(dispatchFailure));
  }
  if (!invocation.thread) return null;
  return yield* engine
    .getActiveProjection({
      environmentId: invocation.environmentId,
      parentThreadId: invocation.thread.threadId,
    })
    .pipe(Effect.mapError(dispatchFailure));
});

const requireCallerRun = Effect.fn("dispatch.requireCallerRun")(function* (
  scope: McpInvocationContext.McpThreadInvocationScope,
) {
  const runId = scope.thread.runId;
  if (!runId) return yield* dispatchFailure("A dedicated collaboration caller run is required.");
  return runId;
});

const handlers = {
  vela_dispatch_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (
        input.view ||
        input.reviewId ||
        input.deliveryId ||
        input.path ||
        input.offset !== undefined ||
        input.startLine !== undefined ||
        input.endLine !== undefined ||
        input.side ||
        input.maxBytes !== undefined
      ) {
        const caller = yield* McpInvocationContext.requireThreadScope(
          invocation,
          "Read collaboration evidence",
        );
        const engine = yield* VelaCollabEngine;
        return yield* evidenceInput(input, {
          environmentId: caller.environmentId,
          threadId: caller.thread.threadId,
          ...(input.projectRoot === undefined ? {} : { repositoryPath: input.projectRoot }),
        }).pipe(Effect.flatMap(engine.readEvidence), Effect.mapError(dispatchFailure));
      }
      const collab = yield* getCollab(invocation, input.planId);
      if (collab) return collab;
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;
      return yield* service.getState(projectRoot, parentThreadId);
    }),
  ),

  vela_dispatch_plan: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "Manage collaboration",
      );
      const scope = v2Scope(caller);
      const engine = yield* VelaCollabEngine;
      if (input.action === "update" || input.action === "clear") {
        const collab = yield* getCollab(caller, input.planId);
        if (input.action === "update") {
          if (!collab || !input.expectedPlanVersion) {
            return yield* dispatchFailure("update requires a v2 plan and expectedPlanVersion.");
          }
          const steps =
            input.steps === undefined
              ? undefined
              : yield* collabSteps(input.steps, true).pipe(Effect.mapError(dispatchFailure));
          yield* engine
            .updatePlan({
              ...scope,
              planId: collab.planId,
              expectedPlanVersion: input.expectedPlanVersion,
              options: collabPlanOptions(input),
              ...(steps === undefined ? {} : { steps }),
              ...(input.cancelStepIds === undefined ? {} : { cancelStepIds: input.cancelStepIds }),
            })
            .pipe(Effect.mapError(dispatchFailure));
          return yield* engine
            .getProjection({ ...scope, planId: collab.planId })
            .pipe(Effect.mapError(dispatchFailure));
        }
        if (collab) {
          yield* engine.cancelPlan(scope, collab.planId).pipe(Effect.mapError(dispatchFailure));
          return yield* engine
            .getProjection({ ...scope, planId: collab.planId })
            .pipe(Effect.mapError(dispatchFailure));
        }
      }
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;

      switch (input.action) {
        case "blind_check": {
          if (!input.rawUserInput?.trim()) {
            return yield* dispatchFailure("blind_check 需要传入 rawUserInput");
          }
          return yield* service
            .startBlindCheck({
              projectRoot,
              threadId: parentThreadId,
              parentThreadId,
              rawUserInput: input.rawUserInput,
              background: input.background,
              orchestratorProposal: input.orchestratorProposal,
              checker: input.checker,
            })
            .pipe(Effect.mapError(dispatchFailure));
        }
        case "save_synthesis": {
          if (!input.synthesis?.trim()) {
            return yield* dispatchFailure("save_synthesis 需要传入 synthesis");
          }
          return yield* service
            .saveBlindSynthesis({
              projectRoot,
              threadId: parentThreadId,
              synthesis: input.synthesis,
              approve: input.approve,
            })
            .pipe(Effect.mapError(dispatchFailure));
        }
        case "publish": {
          if (!input.steps || input.steps.length === 0) {
            return yield* dispatchFailure("publish 需要至少传入 1 张任务卡 (steps)");
          }
          const legacy = yield* service.getState(projectRoot, parentThreadId);
          const hasLegacyPlan = legacy.steps.some(
            ({ status }) => status !== "done" && status !== "cancelled",
          );
          const continuingBlindCheck =
            !legacy.steps.length && legacy.blindCheck && legacy.blindCheck.status !== "failed";
          const useLegacy =
            input.engineVersion === 1 ||
            (input.engineVersion !== 2 &&
              ((input.append && hasLegacyPlan) || continuingBlindCheck));
          if (!useLegacy) {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const thread = yield* threads
              .getThreadShell(caller.thread.threadId)
              .pipe(Effect.mapError(dispatchFailure));
            if (!thread)
              return yield* dispatchFailure("The collaboration parent thread is unavailable.");
            const options = collabPlanOptions(input);
            const legacyDefault = legacy.config.defaultAgent;
            const steps = yield* collabSteps(input.steps).pipe(Effect.mapError(dispatchFailure));
            const planId = yield* engine
              .createAndStartPlan({
                ...scope,
                ...options,
                projectId: thread.projectId,
                title: options.title?.trim() || "Collaboration",
                requirement:
                  options.requirement?.trim() ||
                  legacy.requirement?.summary ||
                  legacy.requirement?.userInput ||
                  "",
                ...(options.defaultDevAgent || !legacyDefault
                  ? {}
                  : { defaultDevAgent: legacyDefault }),
                ...(options.enableBatchAudit === undefined &&
                legacy.config.enableBatchAudit !== undefined
                  ? { enableBatchAudit: legacy.config.enableBatchAudit }
                  : {}),
                ...(input.autoStart === undefined ? {} : { autoStart: input.autoStart }),
                steps,
              })
              .pipe(Effect.mapError(dispatchFailure));
            return yield* engine
              .getProjection({ ...scope, planId })
              .pipe(Effect.mapError(dispatchFailure));
          }
          return yield* service
            .publishPlan({
              projectRoot,
              threadId: parentThreadId,
              parentThreadId,
              planTitle: input.planTitle,
              mode: input.mode,
              prdSource: input.prdSource,
              sharedContract: input.sharedContract,
              requirementSummary: input.requirementSummary,
              requireProductAcceptance: input.requireProductAcceptance,
              append: input.append,
              steps: input.steps,
            })
            .pipe(Effect.mapError(dispatchFailure));
        }
        case "clear":
          return yield* service.clearPlan(projectRoot, parentThreadId);
      }
    }),
  ),

  vela_dispatch_step: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "Control collaboration",
      );
      const usesCollab =
        input.planId ||
        input.action === "cancel" ||
        input.action === "start" ||
        input.action === "retry_review" ||
        input.action === "second_opinion" ||
        input.action === "retry_batch" ||
        input.action === "accept_batch_audit";
      const collab = usesCollab ? yield* getCollab(caller, input.planId) : null;
      const legacyCancel =
        !input.planId &&
        input.action === "cancel" &&
        input.stepId &&
        !collab?.steps.some(({ stepId }) => stepId === input.stepId);
      if (collab && !legacyCancel) {
        const engine = yield* VelaCollabEngine;
        const scope = { ...v2Scope(caller), planId: collab.planId };
        const versioned = {
          ...scope,
          expectedPlanVersion: input.expectedPlanVersion ?? collab.planVersion,
        };
        const stepId = input.stepId;
        const reviewId = input.reviewId;
        switch (input.action) {
          case "start":
            yield* engine.startPlan(versioned).pipe(Effect.mapError(dispatchFailure));
            break;
          case "cancel":
            if (!stepId) return yield* dispatchFailure("cancel requires stepId.");
            yield* engine
              .cancelStep({ ...versioned, stepId })
              .pipe(Effect.mapError(dispatchFailure));
            break;
          case "retry_review":
            if (!stepId || !reviewId)
              return yield* dispatchFailure("retry_review requires stepId and reviewId.");
            yield* engine
              .retryIncompleteReview({ ...scope, stepId, reviewId })
              .pipe(Effect.mapError(dispatchFailure));
            break;
          case "second_opinion": {
            const brief = input.brief ?? input.question;
            const reviewStepId =
              stepId ?? collab.steps.find((step) => step.reviewId === reviewId)?.stepId;
            if (!reviewStepId || !reviewId || !brief)
              return yield* dispatchFailure(
                "second_opinion requires a current reviewId and brief or question.",
              );
            const operationId = yield* engine
              .requestSecondOpinion({
                ...scope,
                stepId: reviewStepId,
                reviewId,
                brief,
                ...(input.target === undefined ? {} : { target: input.target }),
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { operationId };
          }
          case "retry_batch":
            yield* engine
              .retryBatchVerification({
                ...versioned,
                integrationOid: input.integrationOid ?? collab.integrationOid,
              })
              .pipe(Effect.mapError(dispatchFailure));
            break;
          case "accept_batch_audit": {
            if (!input.auditId)
              return yield* dispatchFailure("accept_batch_audit requires auditId.");
            const callerRunId = yield* requireCallerRun(caller);
            yield* engine
              .acceptBatchAudit({ ...versioned, auditId: input.auditId, callerRunId })
              .pipe(Effect.mapError(dispatchFailure));
            break;
          }
          default:
            return yield* dispatchFailure(
              `Action ${input.action} is unavailable for collaboration v2.`,
            );
        }
        return yield* engine.getProjection(scope).pipe(Effect.mapError(dispatchFailure));
      }
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;

      switch (input.action) {
        case "run_parallel":
          return yield* service
            .dispatchStepsParallel({
              projectRoot,
              threadId: parentThreadId,
              stepIds: input.stepIds,
              parentThreadId,
            })
            .pipe(Effect.mapError(dispatchFailure));
        case "unlock_all":
          return yield* service
            .unlockAllSteps(projectRoot, parentThreadId)
            .pipe(Effect.mapError(dispatchFailure));
        case "run":
          if (!input.stepId) return yield* dispatchFailure("run 需要传入 stepId");
          return yield* service
            .dispatchStep({
              projectRoot,
              threadId: parentThreadId,
              stepId: input.stepId,
              skipPremiseCheck: input.skipPremiseCheck,
              parentThreadId,
              forceUnlock: input.forceUnlock,
              forceWorktree: input.forceWorktree,
            })
            .pipe(Effect.mapError(dispatchFailure));
        case "cancel":
          if (!input.stepId) return yield* dispatchFailure("cancel 需要传入 stepId");
          return yield* service
            .cancelStep(projectRoot, input.stepId, parentThreadId)
            .pipe(Effect.mapError(dispatchFailure));
        case "accept":
          if (!input.stepId) return yield* dispatchFailure("accept 需要传入 stepId");
          return yield* service
            .acceptStep(projectRoot, input.stepId, parentThreadId)
            .pipe(Effect.mapError(dispatchFailure));
        case "revert":
          if (!input.stepId) return yield* dispatchFailure("revert 需要传入 stepId");
          return yield* service
            .revertStep(projectRoot, input.stepId, parentThreadId)
            .pipe(Effect.mapError(dispatchFailure));
        case "complete_self":
          if (!input.stepId) return yield* dispatchFailure("complete_self 需要传入 stepId");
          return yield* service
            .completeSelfStep({
              projectRoot,
              threadId: parentThreadId,
              stepId: input.stepId,
              summary: input.summary?.trim() || "主控已完成本步修改",
            })
            .pipe(Effect.mapError(dispatchFailure));
        case "update":
          if (!input.stepId) return yield* dispatchFailure("update 需要传入 stepId");
          if (!input.patch) {
            return yield* dispatchFailure("update 需要传入 patch");
          }
          return yield* service
            .updateStep({
              projectRoot,
              threadId: parentThreadId,
              stepId: input.stepId,
              patch: input.patch,
            })
            .pipe(Effect.mapError(dispatchFailure));
        default:
          return yield* dispatchFailure(`Action ${input.action} requires a v2 collaboration plan.`);
      }
    }),
  ),

  vela_dispatch_escalation: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "Resolve escalation",
      );
      const collab = yield* getCollab(caller, input.planId);
      const stepId = input.stepId ?? input.escalationId;
      const escalated = collab?.steps.find(
        (step) =>
          step.stepId === stepId &&
          step.status === "needs_attention" &&
          step.attentionReason === "escalation",
      );
      if (collab && escalated) {
        const engine = yield* VelaCollabEngine;
        const callerRunId = yield* requireCallerRun(caller);
        const response =
          input.action === "reply"
            ? input.decision?.trim()
            : [input.analysis, input.humanPrompt ?? input.decision]
                .filter(Boolean)
                .join("\n")
                .trim();
        if (!response) return yield* dispatchFailure("A response to this escalation is required.");
        const scope = { ...v2Scope(caller), planId: collab.planId };
        yield* engine
          .resolveStepAttention({
            ...scope,
            stepId: escalated.stepId,
            response,
            callerRunId,
            resolution: input.action === "reply" ? "resume_worker" : "ask_human",
            ...(input.action === "escalate_human" && input.options
              ? { decisionOptions: input.options.map(({ label }) => label) }
              : {}),
          })
          .pipe(Effect.mapError(dispatchFailure));
        return yield* engine.getProjection(scope).pipe(Effect.mapError(dispatchFailure));
      }
      if (!input.escalationId || input.planId)
        return yield* dispatchFailure("The escalation is unavailable for this plan.");
      const escalationId = input.escalationId;
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;

      if (input.action === "reply") {
        if (!input.decision?.trim()) {
          return yield* dispatchFailure("reply 需要传入 decision");
        }
        return yield* service
          .replyEscalation({
            projectRoot,
            threadId: parentThreadId,
            escalationId,
            decision: input.decision,
            resolvedBy: "orchestrator",
            taskSpecPatch: input.taskSpecPatch,
          })
          .pipe(Effect.mapError(dispatchFailure));
      }

      return yield* service
        .escalateToHuman({
          projectRoot,
          threadId: parentThreadId,
          escalationId,
          analysis: input.analysis?.trim() || "需要用户拍板确认",
          humanPrompt: input.humanPrompt?.trim() || input.decision?.trim() || "请选择处理方案",
          options: input.options,
        })
        .pipe(Effect.mapError(dispatchFailure));
    }),
  ),

  vela_dispatch_acceptance: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "Submit collaboration verdict",
      );
      if (
        input.planId ||
        input.reviewId ||
        input.verdict ||
        input.findings ||
        input.criteriaResults
      ) {
        const { planId, stepId, reviewId, verdict, summary, findings, criteriaResults } = input;
        if (!planId || !reviewId || !verdict || !findings || !criteriaResults) {
          return yield* dispatchFailure(
            "V2 acceptance requires planId, stepId, reviewId, verdict, summary, findings and criteriaResults.",
          );
        }
        const callerRunId = yield* requireCallerRun(caller);
        const engine = yield* VelaCollabEngine;
        return yield* engine
          .submitReviewVerdict({
            ...v2Scope(caller),
            planId,
            stepId,
            reviewId,
            verdict,
            summary,
            callerRunId,
            findings: findings.map(({ path, line, ...finding }) => ({
              ...finding,
              ...(path === undefined ? {} : { path }),
              ...(line === undefined ? {} : { line }),
            })),
            criteriaResults: criteriaResults.map(({ summary, ...result }) => ({
              ...result,
              ...(summary === undefined ? {} : { summary }),
            })),
          })
          .pipe(Effect.mapError(dispatchFailure));
      }
      if (!input.items)
        return yield* dispatchFailure(
          "V1 acceptance requires items. V2 acceptance requires planId and the frozen review verdict.",
        );
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;
      return yield* service
        .submitAcceptance({
          projectRoot,
          threadId: parentThreadId,
          stepId: input.stepId,
          summary: input.summary,
          items: input.items,
        })
        .pipe(Effect.mapError(dispatchFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof VelaDispatchToolkit.tools>;

export const layer = McpToolAccess.toLayer(VelaDispatchToolkit, handlers);
