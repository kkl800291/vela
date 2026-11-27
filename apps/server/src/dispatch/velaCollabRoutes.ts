import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { VelaCollabEngine, VelaCollabError } from "./VelaCollabEngine.ts";
import {
  AgentTargetSchema,
  EvidenceQuerySchema,
  PlanVersionSchema,
  StepInputSchema,
  collabPlanOptions,
  collabSteps,
  evidenceInput,
  planOptionsFields,
} from "./VelaCollabInputs.ts";
import type { CollabScope } from "./VelaCollabTypes.ts";

const handleAuthErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const jsonError = (error: Error) =>
  HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });

const invalid = (message: string) => Effect.fail(new VelaCollabError({ message }));

const respond = <A, E extends Error, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: jsonError,
      onSuccess: (result) => HttpServerResponse.jsonUnsafe(result ?? { ok: true }),
    }),
  );

const readScope = Effect.fn("velaDispatch.readScope")(function* (parentThreadId: string) {
  const environment = yield* ServerEnvironment;
  return { environmentId: yield* environment.getEnvironmentId, parentThreadId };
});

const post = <S extends Schema.Decoder<{ readonly threadId: string }>, A, E extends Error, R>(
  path: `/api/vela/dispatch/v2/${string}`,
  schema: S,
  run: (
    body: S["Type"],
    scope: CollabScope,
    engine: VelaCollabEngine["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const engine = yield* VelaCollabEngine;
      return yield* respond(
        Effect.gen(function* () {
          const body = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
          return yield* run(body, yield* readScope(body.threadId), engine);
        }),
      );
    }).pipe(Effect.catchTags(handleAuthErrors)),
  );

const planFields = { threadId: TrimmedNonEmptyString, planId: TrimmedNonEmptyString };
const stepFields = { ...planFields, stepId: TrimmedNonEmptyString };
const reviewStepFields = { ...stepFields, reviewId: TrimmedNonEmptyString };
const versionedFields = { expectedPlanVersion: PlanVersionSchema };
const deliveryFields = { ...planFields, deliveryId: TrimmedNonEmptyString };
const decodeTrimmedNonEmptyString = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeEvidenceQuery = Schema.decodeUnknownEffect(EvidenceQuerySchema);

const layerEvidenceRoute = HttpRouter.add(
  "GET",
  "/api/vela/dispatch/v2/evidence",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { searchParams } = new URL(request.url, "http://127.0.0.1");
    const engine = yield* VelaCollabEngine;
    return yield* respond(
      Effect.gen(function* () {
        const threadId = yield* decodeTrimmedNonEmptyString(searchParams.get("threadId"));
        const repositoryPath =
          searchParams.get("repositoryPath") ?? searchParams.get("projectRoot");
        const fields: Record<string, string | number> = Object.fromEntries(searchParams);
        for (const key of ["offset", "startLine", "endLine", "maxBytes"]) {
          const value = searchParams.get(key);
          if (value !== null) fields[key] = /^\d+$/.test(value) ? Number(value) : value;
        }
        const query = yield* decodeEvidenceQuery(fields as unknown);
        const { environmentId } = yield* readScope(threadId);
        const input = yield* evidenceInput(query, {
          threadId,
          environmentId,
          ...(repositoryPath === null ? {} : { repositoryPath }),
        });
        return yield* engine.readEvidence(input);
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerPlanRoute = post(
  "/api/vela/dispatch/v2/plan",
  Schema.Struct({
    ...planOptionsFields,
    threadId: TrimmedNonEmptyString,
    action: Schema.optional(Schema.Literals(["publish", "update", "start", "cancel"])),
    planId: Schema.optional(TrimmedNonEmptyString),
    expectedPlanVersion: Schema.optional(PlanVersionSchema),
    targetWorktree: Schema.optional(TrimmedNonEmptyString),
    autoStart: Schema.optional(Schema.Boolean),
    steps: Schema.optional(Schema.Array(StepInputSchema)),
    cancelStepIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  (body, scope, engine) =>
    Effect.gen(function* () {
      const options = collabPlanOptions(body);
      if (!body.action || body.action === "publish") {
        if (!body.steps?.length) return yield* invalid("publish requires steps.");
        const threads = yield* ThreadManagementService;
        const thread = yield* threads.getThreadShell(ThreadId.make(scope.parentThreadId));
        if (!thread) return yield* invalid("The collaboration parent thread is unavailable.");
        const steps = yield* collabSteps(body.steps);
        const planId = yield* engine.createAndStartPlan({
          ...scope,
          ...options,
          title: options.title?.trim() || "Collaboration",
          requirement: options.requirement?.trim() || "",
          projectId: thread.projectId,
          ...(body.autoStart === undefined ? {} : { autoStart: body.autoStart }),
          ...(body.targetWorktree === undefined ? {} : { targetWorktree: body.targetWorktree }),
          steps,
        });
        return yield* engine.getProjection({ ...scope, planId });
      }
      const { planId, expectedPlanVersion } = body;
      if (!planId) return yield* invalid(`${body.action} requires planId.`);
      const plan = { ...scope, planId };
      if (body.action === "cancel") {
        yield* engine.cancelPlan(scope, planId);
      } else {
        if (expectedPlanVersion === undefined)
          return yield* invalid(`${body.action} requires expectedPlanVersion.`);
        const versioned = { ...plan, expectedPlanVersion };
        if (body.action === "start") {
          yield* engine.startPlan(versioned);
        } else {
          const steps = body.steps === undefined ? undefined : yield* collabSteps(body.steps, true);
          yield* engine.updatePlan({
            ...versioned,
            options,
            ...(steps === undefined ? {} : { steps }),
            ...(body.cancelStepIds === undefined ? {} : { cancelStepIds: body.cancelStepIds }),
          });
        }
      }
      return yield* engine.getProjection(plan);
    }),
);

const layerConfigRoute = post(
  "/api/vela/dispatch/v2/config",
  Schema.Struct({
    threadId: TrimmedNonEmptyString,
    planId: Schema.optional(TrimmedNonEmptyString),
    defaultDevAgent: Schema.optional(Schema.NullOr(AgentTargetSchema)),
    enableBatchAudit: Schema.optional(Schema.Boolean),
    batchAuditAgent: Schema.optional(Schema.NullOr(AgentTargetSchema)),
  }),
  ({ threadId: _threadId, ...config }, scope, engine) => engine.updateConfig(scope, config),
);

const layerCancelStepRoute = post(
  "/api/vela/dispatch/v2/step/cancel",
  Schema.Struct({ ...stepFields, ...versionedFields }),
  ({ threadId: _threadId, ...body }, scope, engine) => engine.cancelStep({ ...scope, ...body }),
);

const layerStepExecutorRoute = post(
  "/api/vela/dispatch/v2/step/executor",
  Schema.Struct({
    ...stepFields,
    ...versionedFields,
    executor: Schema.NullOr(AgentTargetSchema),
  }),
  ({ threadId: _threadId, ...body }, scope, engine) => engine.setStepExecutor({ ...scope, ...body }),
);

const layerRetryReviewRoute = post(
  "/api/vela/dispatch/v2/step/retry-review",
  Schema.Struct(reviewStepFields),
  ({ threadId: _threadId, ...body }, scope, engine) =>
    engine.retryIncompleteReview({ ...scope, ...body }),
);

const layerSecondOpinionRoute = post(
  "/api/vela/dispatch/v2/step/second-opinion",
  Schema.Struct({
    ...reviewStepFields,
    brief: Schema.optional(TrimmedNonEmptyString),
    question: Schema.optional(TrimmedNonEmptyString),
    target: Schema.optional(AgentTargetSchema),
  }),
  ({ threadId: _threadId, brief, question, target, ...body }, scope, engine) =>
    Effect.gen(function* () {
      const prompt = brief ?? question;
      if (!prompt) return yield* invalid("A brief or question is required.");
      const operationId = yield* engine.requestSecondOpinion({
        ...scope,
        ...body,
        brief: prompt,
        ...(target === undefined ? {} : { target }),
      });
      return { operationId };
    }),
);

const layerResolveStepRoute = post(
  "/api/vela/dispatch/v2/step/resolve",
  Schema.Union([
    Schema.Struct({
      ...stepFields,
      resolution: Schema.Literal("human_decision"),
      response: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      ...reviewStepFields,
      resolution: Schema.Literal("human_manual_check"),
      response: TrimmedNonEmptyString,
    }),
  ]),
  ({ threadId: _threadId, ...body }, scope, engine) =>
    engine.resolveStepAttention({ ...scope, ...body }),
);

const layerDeliverRoute = post(
  "/api/vela/dispatch/v2/deliver",
  Schema.Struct({ ...deliveryFields, expectedTargetState: TrimmedNonEmptyString }),
  ({ threadId: _threadId, ...body }, scope, engine) => engine.deliverPlan({ ...scope, ...body }),
);

const layerRevertDeliveryRoute = post(
  "/api/vela/dispatch/v2/revert-delivery",
  Schema.Struct(deliveryFields),
  ({ threadId: _threadId, ...body }, scope, engine) => engine.revertDelivery({ ...scope, ...body }),
);

const layerRetryBatchRoute = post(
  "/api/vela/dispatch/v2/batch/retry",
  Schema.Struct({
    ...planFields,
    ...versionedFields,
    integrationOid: Schema.optional(TrimmedNonEmptyString),
  }),
  ({ threadId: _threadId, ...body }, scope, engine) =>
    engine.retryBatchVerification({ ...scope, ...body }),
);

export const layer = Layer.mergeAll(
  layerEvidenceRoute,
  layerPlanRoute,
  layerConfigRoute,
  layerCancelStepRoute,
  layerStepExecutorRoute,
  layerRetryReviewRoute,
  layerSecondOpinionRoute,
  layerResolveStepRoute,
  layerDeliverRoute,
  layerRevertDeliveryRoute,
  layerRetryBatchRoute,
);
