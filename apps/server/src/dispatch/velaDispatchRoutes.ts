// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimersInEffect:off
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as VelaDispatchService from "./VelaDispatchService.ts";
import type {
  DispatchAcceptanceItem,
  DispatchAgentTarget,
  DispatchEscalationOption,
  DispatchIsolationMode,
  DispatchStepKind,
  DispatchTaskSpecPatch,
  PublishDispatchStepInput,
} from "./VelaDispatchTypes.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(message: string, status = 400) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status });
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseAgentOptions(
  value: unknown,
): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined {
  if (Array.isArray(value)) {
    const out: Array<{ readonly id: string; readonly value: string | boolean }> = [];
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) continue;
      if (typeof item.value === "string" && item.value.trim()) {
        out.push({ id, value: item.value.trim() });
      } else if (typeof item.value === "boolean") {
        out.push({ id, value: item.value });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (isPlainObject(value)) {
    const out: Array<{ readonly id: string; readonly value: string | boolean }> = [];
    for (const [rawKey, rawVal] of Object.entries(value)) {
      const id = rawKey.trim();
      if (!id) continue;
      if (typeof rawVal === "string" && rawVal.trim()) {
        out.push({ id, value: rawVal.trim() });
      } else if (typeof rawVal === "boolean") {
        out.push({ id, value: rawVal });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function parseAgentTarget(value: unknown): DispatchAgentTarget | undefined {
  if (!isPlainObject(value)) return undefined;
  const providerInstanceId =
    typeof value.providerInstanceId === "string" ? value.providerInstanceId.trim() : "";
  if (!providerInstanceId) return undefined;
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  const effort =
    typeof value.effort === "string" && value.effort.trim() ? value.effort.trim() : undefined;
  const options = parseAgentOptions(value.options);
  return {
    providerInstanceId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(options ? { options } : {}),
  };
}

function parseExecutor(value: unknown): "self" | DispatchAgentTarget | undefined {
  if (value === "self") return "self";
  return parseAgentTarget(value);
}

function parseOptionalThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseIsolation(value: unknown): DispatchIsolationMode | undefined {
  return value === "direct" || value === "worktree" ? value : undefined;
}

function parseStepKind(value: unknown): DispatchStepKind | undefined {
  return value === "research" || value === "decision" || value === "change" ? value : undefined;
}

function parseDecisionOptions(value: unknown): DispatchEscalationOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: DispatchEscalationOption[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!id || !label) continue;
    const description =
      typeof item.description === "string" && item.description.trim()
        ? item.description.trim()
        : undefined;
    parsed.push({ id, label, ...(description ? { description } : {}) });
  }
  return parsed;
}

function parseStepPatch(value: unknown): DispatchTaskSpecPatch {
  if (!isPlainObject(value)) return {};
  const patch: Record<string, unknown> = {};
  if (typeof value.title === "string" && value.title.trim()) patch.title = value.title.trim();
  const kind = parseStepKind(value.kind);
  if (kind) patch.kind = kind;
  const decisionOptions = parseDecisionOptions(value.decisionOptions);
  if (decisionOptions !== undefined) patch.decisionOptions = decisionOptions;
  if (typeof value.goal === "string") patch.goal = value.goal;
  if (typeof value.contractNote === "string") patch.contractNote = value.contractNote;
  const premises = parseStringArray(value.premisesToVerify);
  if (premises) patch.premisesToVerify = premises;
  const allowed = parseStringArray(value.allowedGlobs);
  if (allowed) patch.allowedGlobs = allowed;
  const forbidden = parseStringArray(value.forbiddenGlobs);
  if (forbidden) patch.forbiddenGlobs = forbidden;
  const gates = parseStringArray(value.hardGates);
  if (gates) patch.hardGates = gates;
  const criteria = parseStringArray(value.acceptanceCriteria);
  if (criteria) patch.acceptanceCriteria = criteria;
  const isolation = parseIsolation(value.isolation);
  if (isolation) patch.isolation = isolation;
  const dependsOn = parseStringArray(value.dependsOn);
  if (dependsOn) patch.dependsOn = dependsOn;
  const executor = parseExecutor(value.executor);
  if (executor) patch.executor = executor;
  if (value.reviewer === null) {
    patch.reviewer = null;
  } else {
    const reviewer = parseAgentTarget(value.reviewer);
    if (reviewer) patch.reviewer = reviewer;
  }
  if (typeof value.skipProductAcceptance === "boolean") {
    patch.skipProductAcceptance = value.skipProductAcceptance;
  }
  return patch as DispatchTaskSpecPatch;
}

function parsePublishStep(raw: unknown): PublishDispatchStepInput | null {
  if (!isPlainObject(raw)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (!title || !goal) return null;
  const kind = parseStepKind(raw.kind);
  const decisionOptions = parseDecisionOptions(raw.decisionOptions);
  return {
    ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim() } : {}),
    ...(typeof raw.order === "number" ? { order: raw.order } : {}),
    title,
    goal,
    ...(kind ? { kind } : {}),
    ...(decisionOptions !== undefined ? { decisionOptions } : {}),
    ...(parseIsolation(raw.isolation) ? { isolation: parseIsolation(raw.isolation) } : {}),
    dependsOn: parseStringArray(raw.dependsOn),
    ...(typeof raw.parallelGroup === "string" && raw.parallelGroup.trim()
      ? { parallelGroup: raw.parallelGroup.trim() }
      : {}),
    premisesToVerify: parseStringArray(raw.premisesToVerify),
    contextFiles: parseStringArray(raw.contextFiles),
    ...(typeof raw.contractNote === "string" ? { contractNote: raw.contractNote } : {}),
    ...(typeof raw.prdSource === "string" ? { prdSource: raw.prdSource } : {}),
    acceptanceCriteria: parseStringArray(raw.acceptanceCriteria),
    allowedGlobs: parseStringArray(raw.allowedGlobs),
    forbiddenGlobs: parseStringArray(raw.forbiddenGlobs),
    sensitiveGlobs: parseStringArray(raw.sensitiveGlobs),
    hardGates: parseStringArray(raw.hardGates),
    executor: parseExecutor(raw.executor),
    reviewer: raw.reviewer === null ? null : parseAgentTarget(raw.reviewer),
    ...(typeof raw.skipProductAcceptance === "boolean"
      ? { skipProductAcceptance: raw.skipProductAcceptance }
      : {}),
  };
}

const handleAuthErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const respondResult = <A>(effect: Effect.Effect<A, Error>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => jsonError(error.message, 400),
      onSuccess: (data) => HttpServerResponse.jsonUnsafe(data),
    }),
  );

const layerGetStateRoute = HttpRouter.add(
  "GET",
  "/api/vela/dispatch/state",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const reqUrl = new URL(request.url, "http://127.0.0.1");
    const projectRoot = reqUrl.searchParams.get("projectRoot")?.trim() ?? "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const threadId = parseOptionalThreadId(reqUrl.searchParams.get("threadId"));
    const service = yield* VelaDispatchService.VelaDispatchService;
    const state = yield* service.getState(projectRoot, threadId);
    return HttpServerResponse.jsonUnsafe(state);
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStreamStateRoute = HttpRouter.add(
  "GET",
  "/api/vela/dispatch/stream",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const reqUrl = new URL(request.url, "http://127.0.0.1");
    const projectRoot = reqUrl.searchParams.get("projectRoot")?.trim() ?? "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const threadId = parseOptionalThreadId(reqUrl.searchParams.get("threadId"));

    const service = yield* VelaDispatchService.VelaDispatchService;
    const initial = yield* service.getState(projectRoot, threadId);
    const encoder = new TextEncoder();

    const sseStream = Stream.callback<Uint8Array>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const push = (payload: unknown) => {
            Queue.offerUnsafe(queue, encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          };
          push(initial);
          const unsub = service.subscribe(projectRoot, (next) => push(next), threadId);
          const heartbeat = setInterval(() => {
            Queue.offerUnsafe(queue, encoder.encode(": keepalive\n\n"));
          }, 20_000);
          return () => {
            clearInterval(heartbeat);
            unsub();
          };
        }),
        (cleanup) => Effect.sync(cleanup),
      ).pipe(Effect.andThen(Effect.never)),
    );

    return HttpServerResponse.stream(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerListProvidersRoute = HttpRouter.add(
  "GET",
  "/api/vela/dispatch/providers",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const service = yield* VelaDispatchService.VelaDispatchService;
    const providers = yield* service.listProviders();
    return HttpServerResponse.jsonUnsafe({ providers });
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerBlindCheckRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/blind-check",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const rawUserInput = typeof body.rawUserInput === "string" ? body.rawUserInput.trim() : "";
    if (!projectRoot || !rawUserInput) {
      return jsonError("projectRoot and rawUserInput are required", 400);
    }
    const service = yield* VelaDispatchService.VelaDispatchService;
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    return yield* respondResult(
      service.startBlindCheck({
        projectRoot,
        threadId,
        parentThreadId: parseOptionalThreadId(body.parentThreadId),
        rawUserInput,
        background: typeof body.background === "string" ? body.background : undefined,
        orchestratorProposal:
          typeof body.orchestratorProposal === "string" ? body.orchestratorProposal : undefined,
        checker: parseAgentTarget(body.checker),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerBlindSynthesizeRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/blind-check/synthesize",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const synthesis = typeof body.synthesis === "string" ? body.synthesis.trim() : "";
    if (!projectRoot || !synthesis) return jsonError("projectRoot and synthesis are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.saveBlindSynthesis({
        projectRoot,
        threadId,
        synthesis,
        approve: body.approve === true,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerPublishRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/publish",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const rawSteps = Array.isArray(body.steps) ? body.steps : [];
    const steps = rawSteps
      .map(parsePublishStep)
      .filter((s): s is PublishDispatchStepInput => s !== null);
    if (!projectRoot || steps.length === 0) {
      return jsonError("projectRoot and at least one step are required", 400);
    }
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.publishPlan({
        projectRoot,
        threadId,
        parentThreadId: parseOptionalThreadId(body.parentThreadId),
        planTitle: typeof body.planTitle === "string" ? body.planTitle : undefined,
        mode: body.mode === "strict" ? "strict" : "fast",
        prdSource: typeof body.prdSource === "string" ? body.prdSource : undefined,
        sharedContract: typeof body.sharedContract === "string" ? body.sharedContract : undefined,
        requirementSummary:
          typeof body.requirementSummary === "string" ? body.requirementSummary : undefined,
        requireProductAcceptance:
          typeof body.requireProductAcceptance === "boolean"
            ? body.requireProductAcceptance
            : undefined,
        append: body.append === true,
        steps,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepRunRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/run",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.dispatchStep({
        projectRoot,
        threadId,
        stepId,
        skipPremiseCheck: body.skipPremiseCheck === true,
        parentThreadId: parseOptionalThreadId(body.parentThreadId),
        forceUnlock: body.forceUnlock === true,
        forceWorktree: body.forceWorktree === true,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepsRunParallelRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/steps/run-parallel",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const stepIds = parseStringArray(body.stepIds);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.dispatchStepsParallel({
        projectRoot,
        threadId,
        ...(stepIds ? { stepIds } : {}),
        parentThreadId: parseOptionalThreadId(body.parentThreadId),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepsUnlockAllRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/steps/unlock-all",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.unlockAllSteps(projectRoot, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepCancelRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/cancel",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.cancelStep(projectRoot, stepId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepUpdateRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/update",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.updateStep({
        projectRoot,
        threadId,
        stepId,
        patch: parseStepPatch(body.patch),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepAcceptRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/accept",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.acceptStep(projectRoot, stepId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepDecideRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/decide",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const selectedOptionId =
      typeof body.selectedOptionId === "string" && body.selectedOptionId.trim()
        ? body.selectedOptionId.trim()
        : undefined;
    const decision = typeof body.decision === "string" ? body.decision : undefined;
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.decideStep({
        projectRoot,
        threadId,
        stepId,
        selectedOptionId,
        decision,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepDeleteRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/delete",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.deleteStep(projectRoot, stepId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepRevertRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/revert",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.revertStep(projectRoot, stepId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepSkipAcceptanceRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/skip-acceptance",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    if (!projectRoot || !stepId) return jsonError("projectRoot and stepId are required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.skipAcceptance(projectRoot, stepId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerStepAcceptanceSubmitRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/step/acceptance",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const stepId = typeof body.stepId === "string" ? body.stepId.trim() : "";
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    const items = Array.isArray(body.items) ? (body.items as DispatchAcceptanceItem[]) : [];
    if (!projectRoot || !stepId || !summary) {
      return jsonError("projectRoot, stepId and summary are required", 400);
    }
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.submitAcceptance({ projectRoot, threadId, stepId, summary, items }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerEscalationReplyRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/escalation/reply",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const escalationId = typeof body.escalationId === "string" ? body.escalationId.trim() : "";
    const decision = typeof body.decision === "string" ? body.decision.trim() : "";
    if (!projectRoot || !escalationId || !decision) {
      return jsonError("projectRoot, escalationId and decision are required", 400);
    }
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.replyEscalation({
        projectRoot,
        threadId,
        escalationId,
        decision,
        resolvedBy: body.resolvedBy === "orchestrator" ? "orchestrator" : "human",
        selectedOptionId:
          typeof body.selectedOptionId === "string" ? body.selectedOptionId : undefined,
        taskSpecPatch: isPlainObject(body.taskSpecPatch)
          ? parseStepPatch(body.taskSpecPatch)
          : undefined,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerEscalationHumanRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/escalation/escalate-human",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const escalationId = typeof body.escalationId === "string" ? body.escalationId.trim() : "";
    if (!projectRoot || !escalationId) {
      return jsonError("projectRoot and escalationId are required", 400);
    }
    const options = Array.isArray(body.options) ? (body.options as DispatchEscalationOption[]) : undefined;
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.escalateToHuman({
        projectRoot,
        threadId,
        escalationId,
        analysis: typeof body.analysis === "string" ? body.analysis : "",
        humanPrompt: typeof body.humanPrompt === "string" ? body.humanPrompt : "请拍板决定",
        options,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerClearPlanRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/clear",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    const cleared = yield* service.clearPlan(projectRoot, threadId);
    return HttpServerResponse.jsonUnsafe(cleared);
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerDeleteHistoryRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/history/delete",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const archiveId = typeof body.archiveId === "string" ? body.archiveId.trim() : "";
    if (!projectRoot || !archiveId) {
      return jsonError("projectRoot and archiveId are required", 400);
    }
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(service.deleteArchivedPlan(projectRoot, archiveId, threadId));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerKickoffPlanRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/kickoff",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
    if (!projectRoot || !threadId) {
      return jsonError("projectRoot and threadId are required", 400);
    }
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.kickoffPlan({
        projectRoot,
        threadId,
        requirement: typeof body.requirement === "string" ? body.requirement : undefined,
        mode: body.mode === "strict" ? "strict" : "fast",
        deliver: body.deliver === "client" ? "client" : "server",
        ...("defaultAgent" in body
          ? {
              defaultAgent:
                body.defaultAgent === null ? null : parseAgentTarget(body.defaultAgent) ?? null,
            }
          : {}),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerUpdateConfigRoute = HttpRouter.add(
  "POST",
  "/api/vela/dispatch/config",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!isPlainObject(body)) return jsonError("JSON object required", 400);
    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    if (!projectRoot) return jsonError("projectRoot is required", 400);
    const threadId =
      parseOptionalThreadId(body.threadId) ?? parseOptionalThreadId(body.parentThreadId);
    const service = yield* VelaDispatchService.VelaDispatchService;
    return yield* respondResult(
      service.updateConfig({
        projectRoot,
        threadId,
        ...("defaultAgent" in body
          ? {
              defaultAgent:
                body.defaultAgent === null ? null : parseAgentTarget(body.defaultAgent) ?? null,
            }
          : {}),
        applyToPendingSteps: body.applyToPendingSteps === true,
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

export const layer = Layer.mergeAll(
  layerGetStateRoute,
  layerStreamStateRoute,
  layerListProvidersRoute,
  layerBlindCheckRoute,
  layerBlindSynthesizeRoute,
  layerPublishRoute,
  layerStepRunRoute,
  layerStepsRunParallelRoute,
  layerStepsUnlockAllRoute,
  layerStepCancelRoute,
  layerStepUpdateRoute,
  layerStepAcceptRoute,
  layerStepDecideRoute,
  layerStepDeleteRoute,
  layerStepRevertRoute,
  layerStepSkipAcceptanceRoute,
  layerStepAcceptanceSubmitRoute,
  layerEscalationReplyRoute,
  layerEscalationHumanRoute,
  layerClearPlanRoute,
  layerDeleteHistoryRoute,
  layerKickoffPlanRoute,
  layerUpdateConfigRoute,
);
