import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

const handlers = {
  vela_dispatch_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projectRoot, parentThreadId } = yield* resolveCallerProjectRoot(input.projectRoot);
      const service = yield* VelaDispatchService.VelaDispatchService;
      return yield* service.getState(projectRoot, parentThreadId);
    }),
  ),

  vela_dispatch_plan: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
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
        case "clear": {
          return yield* service.clearPlan(projectRoot, parentThreadId);
        }
      }
    }),
  ),

  vela_dispatch_step: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
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
      }
    }),
  ),

  vela_dispatch_escalation: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
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
            escalationId: input.escalationId,
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
          escalationId: input.escalationId,
          analysis: input.analysis?.trim() || "需要用户拍板确认",
          humanPrompt: input.humanPrompt?.trim() || input.decision?.trim() || "请选择处理方案",
          options: input.options,
        })
        .pipe(Effect.mapError(dispatchFailure));
    }),
  ),

  vela_dispatch_acceptance: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
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
