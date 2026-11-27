import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CollabDeliveryRecovery,
  CollabInboxItem,
  CollabInboxWake,
  CollabOperationLease,
  CollabOutboxIntent,
  CollabPlan,
  CollabRecord,
  CollabRecordMap,
  CollabScope,
  CollabStep,
  VelaCollabProjection,
} from "./VelaCollabTypes.ts";

import type { DispatchAttentionItem } from "./VelaDispatchTypes.ts";

export class CollabStoreConflict extends Schema.TaggedError<
  CollabStoreConflict,
  { readonly brand: unique symbol }
>()("CollabStoreConflict", {
  message: Schema.String,
}) {}

type NewOutboxIntent = Omit<
  CollabOutboxIntent,
  "sequence" | "status" | "receiptJson" | "recovery" | "kind"
> & {
  readonly kind: Exclude<CollabOutboxIntent["kind"], "enqueue_inbox">;
};

interface OutboxSettlement {
  readonly operationId: string;
  readonly status: "completed" | "invalidated";
  readonly receiptJson: string;
}

type InboxChange =
  | {
      readonly action: "bind";
      readonly inboxItemId: string;
      readonly commandId: string;
      readonly messageId: string;
      readonly threadRunId: string;
      readonly receiptJson: string;
      readonly acceptedBeforeEdit?: boolean;
    }
  | {
      readonly action: "complete";
      readonly inboxItemId: string;
      readonly threadRunId: string;
      readonly receiptJson: string;
    }
  | {
      readonly action: "invalidate";
      readonly inboxItemId: string;
      readonly receiptJson: string;
    };

export interface CollabTransition {
  readonly plan: CollabPlan;
  readonly expectedRevision: number | null;
  readonly command: {
    readonly commandId: string;
    readonly requestKey: string;
    readonly receiptJson: string;
  };
  readonly steps?: ReadonlyArray<CollabStep>;
  readonly records?: ReadonlyArray<CollabRecord>;
  readonly wakes?: ReadonlyArray<CollabInboxWake>;
  readonly outbox?: ReadonlyArray<NewOutboxIntent>;
  readonly outboxSettlements?: ReadonlyArray<OutboxSettlement>;
  readonly inbox?: InboxChange;
  readonly rebasePending?: boolean;
  readonly integration?: {
    readonly stepId: string;
    readonly intent: NewOutboxIntent & { readonly kind: "update_integration" };
  };
}

interface PayloadRow {
  readonly payloadJson: string;
}
interface StepRow extends PayloadRow {
  readonly reviewSequence: number | null;
  readonly integrationSequence: number | null;
}
type InboxRow = Omit<CollabInboxItem, "stepId" | "reviewId" | "threadRunId"> & {
  readonly stepId: string | null;
  readonly reviewId: string | null;
  readonly threadRunId: string | null;
};
type OutboxRow = Omit<CollabOutboxIntent, "recovery"> & { readonly recoveryJson: string | null };

const decode = <T>(payload: string): T => JSON.parse(payload) as T;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encode = (value: object) =>
  encodeJson(value).pipe(
    Effect.mapError(
      () => new CollabStoreConflict({ message: "Collaboration state cannot be serialized." }),
    ),
  );

function decodeStep({ payloadJson, reviewSequence, integrationSequence }: StepRow): CollabStep {
  return {
    ...decode<CollabStep>(payloadJson),
    ...(reviewSequence === null ? {} : { reviewQueueSequence: reviewSequence }),
    ...(integrationSequence === null ? {} : { integrationQueueSequence: integrationSequence }),
  };
}

function decodeInbox({ stepId, reviewId, threadRunId, ...row }: InboxRow): CollabInboxItem {
  return {
    ...row,
    ...(stepId === null ? {} : { stepId }),
    ...(reviewId === null ? {} : { reviewId }),
    ...(threadRunId === null ? {} : { threadRunId }),
  };
}

function decodeOutbox({ recoveryJson, ...row }: OutboxRow): CollabOutboxIntent {
  return {
    ...row,
    ...(recoveryJson === null ? {} : { recovery: decode<CollabDeliveryRecovery>(recoveryJson) }),
  };
}

const conflict = (reason: string) => Effect.fail(new CollabStoreConflict({ message: reason }));
const sameScope = (left: CollabScope, right: CollabScope) =>
  left.environmentId === right.environmentId && left.parentThreadId === right.parentThreadId;

export const targetWorktreeLeaseResource = (
  environmentId: string,
  canonicalTargetWorktree: string,
) => JSON.stringify([environmentId, canonicalTargetWorktree]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inboxColumns = sql.literal(`
    inbox_item_id AS inboxItemId, environment_id AS environmentId, parent_thread_id AS parentThreadId,
    plan_id AS planId, kind, step_id AS stepId, review_id AS reviewId, command_id AS commandId,
    message_id AS messageId, thread_run_id AS threadRunId, status, payload_json AS payloadJson,
    receipt_json AS receiptJson
  `);
  const outboxColumns = sql.literal(`
    sequence, operation_id AS operationId, plan_id AS planId, kind, expected_plan_version AS expectedPlanVersion,
    status, payload_json AS payloadJson, created_at AS createdAt, receipt_json AS receiptJson,
    recovery_json AS recoveryJson
  `);
  const stepColumns = sql.literal(`
    payload_json AS payloadJson, review_sequence AS reviewSequence, integration_sequence AS integrationSequence
  `);
  const leaseColumns = sql.literal(`
    kind, resource_id AS resourceId, operation_id AS operationId, owner_id AS ownerId, token, expires_at AS expiresAt
  `);

  const getPlan = Effect.fn("VelaCollabStore.getPlan")(function* (planId: string) {
    const [row] = yield* sql<PayloadRow>`
      SELECT payload_json AS payloadJson FROM vela_collab_plans WHERE plan_id = ${planId}
    `;
    return row ? decode<CollabPlan>(row.payloadJson) : null;
  });

  const listActivePlans = Effect.fn("VelaCollabStore.listActivePlans")(function* () {
    return (yield* sql<PayloadRow>`
      SELECT payload_json AS payloadJson FROM vela_collab_plans
      WHERE status IN ('draft', 'running', 'batch_verifying', 'ready_to_deliver')
    `).map((row) => decode<CollabPlan>(row.payloadJson));
  });

  const listSteps = Effect.fn("VelaCollabStore.listSteps")(function* (planId: string) {
    return (yield* sql<StepRow>`
      SELECT ${stepColumns} FROM vela_collab_steps WHERE plan_id = ${planId}
      ORDER BY position, step_id
    `).map(decodeStep);
  });

  const updateIntentPayload = Effect.fn("VelaCollabStore.updateIntentPayload")(function* (
    intent: CollabOutboxIntent,
    payload: object,
  ) {
    const [row] = yield* sql`
      UPDATE vela_collab_outbox SET payload_json = ${yield* encode(payload)}
      WHERE operation_id = ${intent.operationId} AND status = 'pending'
        AND payload_json = ${intent.payloadJson}
      RETURNING operation_id
    `;
    if (!row) return yield* conflict("The collaboration intent has changed.");
  });

  const findActivePlan = Effect.fn("VelaCollabStore.findActivePlan")(function* (
    scope: CollabScope,
  ) {
    const [row] = yield* sql<PayloadRow>`
      SELECT payload_json AS payloadJson FROM vela_collab_plans
      WHERE environment_id = ${scope.environmentId} AND parent_thread_id = ${scope.parentThreadId}
        AND status IN ('draft', 'running', 'batch_verifying', 'ready_to_deliver')
    `;
    return row ? decode<CollabPlan>(row.payloadJson) : null;
  });

  const findLatestPlan = Effect.fn("VelaCollabStore.findLatestPlan")(function* (
    scope: CollabScope,
  ) {
    const [row] = yield* sql<PayloadRow>`
      SELECT payload_json AS payloadJson FROM vela_collab_plans
      WHERE environment_id = ${scope.environmentId} AND parent_thread_id = ${scope.parentThreadId}
      ORDER BY rowid DESC LIMIT 1
    `;
    return row ? decode<CollabPlan>(row.payloadJson) : null;
  });

  const listAttentionItems = Effect.fn("VelaCollabStore.listAttentionItems")(function* (
    environmentId: string,
  ) {
    const rows = yield* sql<{
      readonly planJson: string;
      readonly stepJson: string | null;
    }>`
      SELECT p.payload_json AS planJson, s.payload_json AS stepJson
      FROM vela_collab_plans p
      JOIN vela_collab_steps s ON s.plan_id = p.plan_id AND s.status = 'needs_attention'
      WHERE p.environment_id = ${environmentId}
        AND p.status IN ('draft', 'running', 'batch_verifying', 'ready_to_deliver')
      UNION ALL
      SELECT payload_json AS planJson, NULL AS stepJson FROM vela_collab_plans
      WHERE environment_id = ${environmentId} AND status = 'ready_to_deliver'
    `;
    return rows.map(({ planJson, stepJson }): DispatchAttentionItem => {
      const plan = decode<CollabPlan>(planJson);
      const step = stepJson === null ? null : decode<CollabStep>(stepJson);
      const reason = step ? step.attentionReason : "ready_to_deliver";
      return {
        id: `v2:${plan.planId}:${step ? `step:${step.stepId}` : "delivery"}`,
        engineVersion: 2,
        planId: plan.planId,
        ...(reason === undefined ? {} : { attentionReason: reason }),
        kind:
          !step || reason === "manual_check_required"
            ? "accept"
            : reason === "decision"
              ? "decision"
              : "escalation",
        projectRoot: plan.canonicalTargetWorktree,
        threadId: plan.parentThreadId,
        planTitle: plan.title.slice(0, 300),
        stepId: step?.stepId ?? "delivery",
        stepTitle: step?.title.slice(0, 300) ?? plan.title.slice(0, 300),
        summary: (step?.attentionDetail ?? reason ?? "Collaboration needs attention").slice(0, 600),
        blockedStepTitles: [],
        updatedAt: plan.updatedAt,
      };
    });
  });

  const getStep = Effect.fn("VelaCollabStore.getStep")(function* (planId: string, stepId: string) {
    const [row] = yield* sql<StepRow>`
      SELECT ${stepColumns} FROM vela_collab_steps WHERE plan_id = ${planId} AND step_id = ${stepId}
    `;
    return row ? decodeStep(row) : null;
  });

  const listQueuedSteps = Effect.fn("VelaCollabStore.listQueuedSteps")(function* (planId: string) {
    return (yield* sql<StepRow>`
      SELECT ${stepColumns} FROM vela_collab_steps WHERE plan_id = ${planId}
        AND status = 'queued_for_review' AND review_sequence IS NOT NULL ORDER BY review_sequence
    `).map(decodeStep);
  });

  const listIntegratingSteps = Effect.fn("VelaCollabStore.listIntegratingSteps")(function* (
    planId: string,
  ) {
    return (yield* sql<StepRow>`
      SELECT ${stepColumns} FROM vela_collab_steps WHERE plan_id = ${planId}
        AND status = 'integrating' AND integration_sequence IS NOT NULL ORDER BY integration_sequence
    `).map(decodeStep);
  });

  const getActiveInbox = Effect.fn("VelaCollabStore.getActiveInbox")(function* (
    scope: CollabScope,
  ) {
    const [row] = yield* sql<InboxRow>`
      SELECT ${inboxColumns} FROM vela_collab_inbox
      WHERE environment_id = ${scope.environmentId} AND parent_thread_id = ${scope.parentThreadId}
        AND status IN ('pending', 'dispatched')
    `;
    return row ? decodeInbox(row) : null;
  });

  const getRecord = Effect.fn("VelaCollabStore.getRecord")(function* <
    Kind extends keyof CollabRecordMap,
  >(planId: string, kind: Kind, id: string) {
    const [row] = yield* sql<PayloadRow>`
      SELECT payload_json AS payloadJson FROM vela_collab_records
      WHERE plan_id = ${planId} AND kind = ${kind} AND record_id = ${id}
    `;
    return row ? decode<CollabRecordMap[Kind]>(row.payloadJson) : null;
  });

  const getOutbox = Effect.fn("VelaCollabStore.getOutbox")(function* (operationId: string) {
    const [row] = yield* sql<OutboxRow>`
      SELECT ${outboxColumns} FROM vela_collab_outbox WHERE operation_id = ${operationId}
    `;
    return row ? decodeOutbox(row) : null;
  });

  const insertIntent = Effect.fn("VelaCollabStore.insertIntent")(function* (
    intent: Omit<CollabOutboxIntent, "sequence" | "status" | "receiptJson" | "recovery">,
  ) {
    if (intent.kind !== "send_thread") {
      const [reserved] = yield* sql`
        SELECT operation_id FROM vela_collab_outbox WHERE kind = 'enqueue_inbox'
          AND json_extract(payload_json, '$.commandId') = ${intent.operationId}
      `;
      if (reserved)
        return yield* conflict("Outbox operation ID belongs to a queued thread command.");
    }
    const [row] = yield* sql<{ readonly sequence: number }>`
      INSERT INTO vela_collab_outbox (operation_id, plan_id, kind, expected_plan_version, payload_json, created_at)
      VALUES (${intent.operationId}, ${intent.planId}, ${intent.kind}, ${intent.expectedPlanVersion},
        ${intent.payloadJson}, ${intent.createdAt})
      RETURNING sequence
    `;
    if (!row) return yield* conflict("Outbox intent was not created.");
    return row.sequence;
  });

  const settleOutbox = Effect.fn("VelaCollabStore.settleOutbox")(function* (
    planId: string,
    settlement: OutboxSettlement,
  ) {
    const [row] = yield* sql`
      UPDATE vela_collab_outbox SET status = ${settlement.status}, receipt_json = ${settlement.receiptJson}
      WHERE operation_id = ${settlement.operationId} AND plan_id = ${planId} AND status = 'pending'
      RETURNING operation_id
    `;
    if (row) return;
    const current = yield* getOutbox(settlement.operationId);
    if (
      current?.planId !== planId ||
      current.status !== settlement.status ||
      current.receiptJson !== settlement.receiptJson
    ) {
      return yield* conflict("Outbox settlement does not match the stored operation.");
    }
  });

  const persistStep = Effect.fn("VelaCollabStore.persistStep")(function* (step: CollabStep) {
    const {
      reviewQueueSequence: _review,
      integrationQueueSequence: _integration,
      ...payload
    } = step;
    yield* sql`
      INSERT INTO vela_collab_steps (plan_id, step_id, position, status, review_id, payload_json)
      VALUES (${step.planId}, ${step.stepId}, ${step.order}, ${step.status}, ${step.reviewId ?? null}, ${yield* encode(payload)})
      ON CONFLICT(plan_id, step_id) DO UPDATE SET
        position = excluded.position, status = excluded.status, review_id = excluded.review_id,
        review_sequence = CASE WHEN vela_collab_steps.review_id IS excluded.review_id
          AND NOT (excluded.status = 'queued_for_review' AND vela_collab_steps.status = 'needs_attention')
          THEN vela_collab_steps.review_sequence ELSE NULL END,
        integration_sequence = CASE WHEN excluded.status = 'integrating' AND vela_collab_steps.review_id IS excluded.review_id
          THEN vela_collab_steps.integration_sequence ELSE NULL END,
        payload_json = excluded.payload_json
    `;
  });

  const persistWake = Effect.fn("VelaCollabStore.persistWake")(function* (
    plan: CollabPlan,
    wake: CollabInboxWake,
  ) {
    if (!sameScope(plan, wake) || plan.planId !== wake.planId)
      return yield* conflict("Wake is outside the plan scope.");
    if (
      !wake.inboxItemId ||
      !wake.commandId ||
      !wake.messageId ||
      wake.inboxItemId === wake.commandId
    ) {
      return yield* conflict(
        "Inbox, command and message IDs are required and must identify separate operations.",
      );
    }
    const existingSend = yield* getOutbox(wake.commandId);
    if (existingSend)
      return yield* conflict("Wake command ID is already used by an outbox operation.");
    const sequence = yield* insertIntent({
      operationId: wake.inboxItemId,
      planId: wake.planId,
      kind: "enqueue_inbox",
      expectedPlanVersion: plan.planVersion,
      createdAt: plan.updatedAt,
      payloadJson: yield* encode(wake),
    });
    if (wake.kind !== "review") return;
    if (!wake.stepId || !wake.reviewId)
      return yield* conflict("Review wake requires frozen evidence.");
    const [step, evidence] = yield* Effect.all([
      getStep(wake.planId, wake.stepId),
      getRecord(wake.planId, "review", wake.reviewId),
    ]);
    if (
      step?.status !== "queued_for_review" ||
      step.reviewId !== wake.reviewId ||
      !evidence ||
      evidence.stepId !== step.stepId ||
      evidence.attempt !== step.attempt ||
      evidence.criteriaVersion !== step.criteriaVersion ||
      evidence.stepBaseOid !== step.stepBaseOid ||
      !evidence.gateSummary.passed ||
      step.reviewQueueSequence !== undefined
    ) {
      return yield* conflict("Review wake does not match a new frozen step snapshot.");
    }
    yield* sql`
      UPDATE vela_collab_steps SET review_sequence = ${sequence}
      WHERE plan_id = ${wake.planId} AND step_id = ${wake.stepId}
    `;
  });

  const changeInbox = Effect.fn("VelaCollabStore.changeInbox")(function* (
    plan: CollabPlan,
    change: InboxChange,
  ) {
    const item = yield* getActiveInbox(plan);
    if (!item || item.inboxItemId !== change.inboxItemId || item.planId !== plan.planId) {
      return yield* conflict("The collaboration inbox item is stale.");
    }
    if (change.action === "bind") {
      if (item.kind === "review" && !change.acceptedBeforeEdit) {
        const step = item.stepId ? yield* getStep(plan.planId, item.stepId) : null;
        if (
          !step ||
          step.reviewId !== item.reviewId ||
          (step.status !== "queued_for_review" && step.status !== "reviewing")
        ) {
          return yield* conflict("The review no longer matches the active step.");
        }
      }
      if (
        item.status !== "pending" ||
        item.commandId !== change.commandId ||
        item.messageId !== change.messageId ||
        !change.threadRunId.trim()
      ) {
        return yield* conflict("The run does not match the pending collaboration message.");
      }
      yield* sql`
        UPDATE vela_collab_inbox SET status = 'dispatched', thread_run_id = ${change.threadRunId},
          receipt_json = ${change.receiptJson} WHERE inbox_item_id = ${item.inboxItemId}
      `;
      yield* settleOutbox(plan.planId, {
        operationId: item.commandId,
        status: "completed",
        receiptJson: change.receiptJson,
      });
      return;
    }
    if (
      change.action === "complete" &&
      (item.status !== "dispatched" || item.threadRunId !== change.threadRunId)
    ) {
      return yield* conflict("Only the bound collaboration run can complete this inbox item.");
    }
    yield* sql`
      UPDATE vela_collab_inbox SET status = ${change.action === "complete" ? "completed" : "invalidated"},
        receipt_json = ${change.receiptJson} WHERE inbox_item_id = ${item.inboxItemId}
    `;
    if (change.action === "invalidate" && item.status === "pending") {
      yield* settleOutbox(plan.planId, {
        operationId: item.commandId,
        status: "invalidated",
        receiptJson: change.receiptJson,
      });
    }
  });

  const commitTransition = Effect.fn("VelaCollabStore.commitTransition")(
    (transition: CollabTransition) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { plan, command } = transition;
          const [receipt] = yield* sql<{
            readonly planId: string;
            readonly requestKey: string;
            readonly receiptJson: string;
          }>`
        SELECT plan_id AS planId, request_key AS requestKey, receipt_json AS receiptJson
        FROM vela_collab_receipts WHERE command_id = ${command.commandId}
      `;
          if (receipt) {
            if (receipt.planId !== plan.planId || receipt.requestKey !== command.requestKey) {
              return yield* conflict(
                "This command ID was already used for a different collaboration request.",
              );
            }
            return { receiptJson: receipt.receiptJson, replayed: true };
          }

          const previous = yield* getPlan(plan.planId);
          const expected = transition.expectedRevision;
          if (previous) {
            if (
              expected !== previous.revision ||
              plan.revision !== previous.revision + 1 ||
              !sameScope(previous, plan) ||
              previous.canonicalTargetWorktree !== plan.canonicalTargetWorktree ||
              previous.gitCommonDir !== plan.gitCommonDir ||
              plan.planVersion < previous.planVersion ||
              plan.planVersion > previous.planVersion + 1
            ) {
              return yield* conflict(
                "Collaboration plan revision or repository binding has changed.",
              );
            }
            const [row] = yield* sql`
          UPDATE vela_collab_plans SET plan_version = ${plan.planVersion}, revision = ${plan.revision},
            status = ${plan.status}, payload_json = ${yield* encode(plan)}
          WHERE plan_id = ${plan.planId} AND revision = ${expected} RETURNING plan_id
        `;
            if (!row) return yield* conflict("Collaboration plan revision has changed.");
          } else {
            if (expected !== null || plan.revision !== 1 || plan.planVersion !== 1) {
              return yield* conflict(
                "The collaboration plan does not exist at the requested revision.",
              );
            }
            yield* sql`
          INSERT INTO vela_collab_plans
            (plan_id, environment_id, parent_thread_id, target_worktree, git_common_dir, plan_version, revision, status, payload_json)
          VALUES (${plan.planId}, ${plan.environmentId}, ${plan.parentThreadId},
            ${plan.canonicalTargetWorktree}, ${plan.gitCommonDir}, ${plan.planVersion}, ${plan.revision},
            ${plan.status}, ${yield* encode(plan)})
        `;
          }

          for (const step of transition.steps ?? []) {
            if (step.planId !== plan.planId)
              return yield* conflict("Step is outside the transition plan.");
            if (plan.gitCommonDir === null && step.kind === "change")
              return yield* conflict("Change steps require a Git worktree.");
            yield* persistStep(step);
          }
          for (const record of transition.records ?? []) {
            if (record.kind === "review" && record.id !== record.value.reviewId) {
              return yield* conflict("Review ID must match the frozen evidence.");
            }
            if (record.kind === "verdict") {
              const item = yield* getActiveInbox(plan);
              if (
                item?.planId !== plan.planId ||
                item.kind !== "review" ||
                item.status !== "dispatched" ||
                item.reviewId !== record.id ||
                record.value.reviewId !== record.id ||
                item.threadRunId !== record.value.reviewerRunId
              ) {
                return yield* conflict(
                  "Verdict does not match the active review and its dedicated run.",
                );
              }
              const evidence = yield* getRecord(plan.planId, "review", record.id);
              const step = item.stepId ? yield* getStep(plan.planId, item.stepId) : null;
              if (
                !step ||
                step.reviewId !== record.id ||
                evidence?.criteriaVersion !== step.criteriaVersion ||
                evidence?.attempt !== step.attempt ||
                evidence?.stepId !== step.stepId
              ) {
                return yield* conflict("Verdict is for stale collaboration evidence.");
              }
              const criteria = new Set(step.criteria.map(({ id }) => id));
              const results = record.value.criteriaResults;
              if (
                results.length !== criteria.size ||
                results.some(({ criterionId }) => !criteria.delete(criterionId))
              ) {
                return yield* conflict(
                  "Verdict must include a result for every acceptance criterion.",
                );
              }
              if (
                record.value.verdict === "approve" &&
                (results.some(({ result }) => result === "fail") ||
                  record.value.findings.some(({ severity }) => severity === "blocking"))
              ) {
                return yield* conflict(
                  "Approval requires passing criteria and no blocking findings.",
                );
              }
            }
            yield* sql`
          INSERT INTO vela_collab_records (plan_id, kind, record_id, payload_json)
          VALUES (${plan.planId}, ${record.kind}, ${record.id}, ${yield* encode(record.value)})
        `;
          }
          if (transition.inbox) yield* changeInbox(plan, transition.inbox);
          for (const wake of transition.wakes ?? []) yield* persistWake(plan, wake);
          for (const intent of [
            ...(transition.outbox ?? []),
            ...(transition.integration ? [transition.integration.intent] : []),
          ]) {
            if (intent.planId !== plan.planId || intent.expectedPlanVersion !== plan.planVersion) {
              return yield* conflict("Outbox intent is bound to a different plan version.");
            }
            const sequence = yield* insertIntent(intent);
            if (transition.integration?.intent === intent) {
              const current = yield* getStep(plan.planId, transition.integration.stepId);
              const verdict = current?.reviewId
                ? yield* getRecord(plan.planId, "verdict", current.reviewId)
                : null;
              if (current?.kind !== "change" || verdict?.verdict !== "approve") {
                return yield* conflict("Integration requires an approved change snapshot.");
              }
              const [step] = yield* sql`
            UPDATE vela_collab_steps SET integration_sequence = ${sequence}
            WHERE plan_id = ${plan.planId} AND step_id = ${transition.integration.stepId}
              AND status = 'integrating' AND integration_sequence IS NULL
            RETURNING step_id
          `;
              if (!step)
                return yield* conflict("Step is already queued or is not ready for integration.");
            }
          }
          for (const settlement of transition.outboxSettlements ?? [])
            yield* settleOutbox(plan.planId, settlement);
          if (transition.rebasePending && previous && previous.planVersion !== plan.planVersion) {
            yield* sql`
              UPDATE vela_collab_outbox SET expected_plan_version = ${plan.planVersion}
              WHERE plan_id = ${plan.planId} AND status = 'pending'
                AND expected_plan_version = ${previous.planVersion}
            `;
          }
          yield* sql`
        INSERT INTO vela_collab_receipts (command_id, plan_id, request_key, receipt_json)
        VALUES (${command.commandId}, ${plan.planId}, ${command.requestKey}, ${command.receiptJson})
      `;
          return { receiptJson: command.receiptJson, replayed: false };
        }),
      ),
  );

  const claimNextInbox = Effect.fn("VelaCollabStore.claimNextInbox")((scope: CollabScope) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (yield* getActiveInbox(scope)) return null;
        while (true) {
          const [intent] = yield* sql<OutboxRow>`
          SELECT ${outboxColumns} FROM vela_collab_outbox
          WHERE plan_id IN (SELECT plan_id FROM vela_collab_plans
            WHERE environment_id = ${scope.environmentId} AND parent_thread_id = ${scope.parentThreadId})
            AND kind = 'enqueue_inbox' AND status = 'pending'
          ORDER BY sequence LIMIT 1
        `;
          if (!intent) return null;
          const wake = decode<CollabInboxWake>(intent.payloadJson);
          const plan = yield* getPlan(wake.planId);
          const step = wake.stepId ? yield* getStep(wake.planId, wake.stepId) : null;
          const invalid =
            !plan ||
            plan.status === "cancelled" ||
            plan.status === "failed" ||
            (wake.kind === "delivery_ready" &&
              (plan.status !== "ready_to_deliver" ||
                intent.expectedPlanVersion !== plan.planVersion)) ||
            (wake.kind === "batch_verification_failed" &&
              intent.expectedPlanVersion !== plan.planVersion) ||
            (wake.kind === "review" &&
              (step?.status !== "queued_for_review" ||
                step.reviewId !== wake.reviewId ||
                step.reviewQueueSequence !== intent.sequence));
          if (invalid) {
            yield* settleOutbox(wake.planId, {
              operationId: intent.operationId,
              status: "invalidated",
              receiptJson: '{"reason":"stale"}',
            });
            continue;
          }
          yield* sql`
          INSERT INTO vela_collab_inbox (inbox_item_id, environment_id, parent_thread_id, plan_id, kind,
            step_id, review_id, command_id, message_id, status, payload_json)
          VALUES (${wake.inboxItemId}, ${wake.environmentId}, ${wake.parentThreadId}, ${wake.planId}, ${wake.kind},
            ${wake.stepId ?? null}, ${wake.reviewId ?? null}, ${wake.commandId}, ${wake.messageId}, 'pending', ${wake.payloadJson})
        `;
          yield* insertIntent({
            operationId: wake.commandId,
            planId: wake.planId,
            kind: "send_thread",
            expectedPlanVersion: plan.planVersion,
            createdAt: intent.createdAt,
            payloadJson: yield* encode({ ...wake, mode: "queue" }),
          });
          yield* settleOutbox(wake.planId, {
            operationId: intent.operationId,
            status: "completed",
            receiptJson: yield* encode({ inboxItemId: wake.inboxItemId }),
          });
          return { ...wake, status: "pending", receiptJson: null } satisfies CollabInboxItem;
        }
      }),
    ),
  );

  const listPendingIntents = Effect.fn("VelaCollabStore.listPendingIntents")(function* () {
    return (yield* sql<OutboxRow>`
      SELECT ${outboxColumns} FROM vela_collab_outbox WHERE status = 'pending' ORDER BY sequence
    `).map(decodeOutbox);
  });

  const acquireLease = Effect.fn("VelaCollabStore.acquireLease")(function* (
    lease: CollabOperationLease,
    now: number,
  ) {
    if (
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= now ||
      !lease.token ||
      !lease.ownerId
    ) {
      return yield* conflict("Invalid collaboration lease expiration or identity.");
    }
    const [row] = yield* sql<CollabOperationLease>`
      INSERT INTO vela_collab_leases (kind, resource_id, operation_id, owner_id, token, expires_at)
      SELECT ${lease.kind}, ${lease.resourceId}, o.operation_id, ${lease.ownerId}, ${lease.token}, ${lease.expiresAt}
      FROM vela_collab_outbox o JOIN vela_collab_plans p ON p.plan_id = o.plan_id
      WHERE o.operation_id = ${lease.operationId} AND o.status = 'pending'
        AND o.expected_plan_version = p.plan_version
        AND ((${lease.kind} = 'integration' AND o.kind = 'update_integration' AND p.plan_id = ${lease.resourceId}
            AND NOT EXISTS (
              SELECT 1 FROM vela_collab_outbox prior
              WHERE prior.plan_id = o.plan_id AND prior.kind = 'update_integration'
                AND prior.status = 'pending' AND prior.expected_plan_version = p.plan_version
                AND prior.sequence < o.sequence
            ))
          OR (${lease.kind} = 'target_worktree' AND o.kind IN ('apply_delivery', 'revert_delivery')
            AND json_array(p.environment_id, p.target_worktree) = ${lease.resourceId}
            AND NOT EXISTS (
              SELECT 1 FROM vela_collab_outbox recovery
              JOIN vela_collab_plans recovered_plan ON recovered_plan.plan_id = recovery.plan_id
              WHERE recovery.status = 'pending' AND recovery.recovery_json IS NOT NULL
                AND recovery.operation_id <> o.operation_id
                AND recovered_plan.environment_id = p.environment_id
                AND recovered_plan.target_worktree = p.target_worktree
            )))
      ON CONFLICT(kind, resource_id) DO NOTHING
      RETURNING ${leaseColumns}
    `;
    return row ?? null;
  });

  const releaseLease = Effect.fn("VelaCollabStore.releaseLease")(function* (
    lease: CollabOperationLease,
  ) {
    const [row] = yield* sql`
      DELETE FROM vela_collab_leases WHERE kind = ${lease.kind} AND resource_id = ${lease.resourceId}
        AND operation_id = ${lease.operationId} AND owner_id = ${lease.ownerId} AND token = ${lease.token}
        AND expires_at = ${lease.expiresAt}
      RETURNING resource_id
    `;
    return row !== undefined;
  });

  // Expiry makes a lease eligible for reconciliation. It never grants a new writer by itself.
  const reconcileExpiredLease = Effect.fn("VelaCollabStore.reconcileExpiredLease")(
    (lease: CollabOperationLease, now: number, settlement?: OutboxSettlement) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (lease.expiresAt > now) return false;
          if (!(yield* releaseLease(lease))) return false;
          if (settlement) {
            const intent = yield* getOutbox(lease.operationId);
            if (!intent || settlement.operationId !== lease.operationId) {
              return yield* conflict("Reconciliation does not match the expired operation.");
            }
            yield* settleOutbox(intent.planId, settlement);
          }
          return true;
        }),
      ),
  );

  const recordDeliveryRecovery = Effect.fn("VelaCollabStore.recordDeliveryRecovery")(
    (lease: CollabOperationLease, record: CollabDeliveryRecovery, now: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (lease.kind !== "target_worktree" || lease.operationId !== record.operationId) {
            return yield* conflict(
              "Delivery recovery does not match the leased operation or worktree.",
            );
          }
          const encoded = yield* encode(record);
          const [row] = yield* sql`
          UPDATE vela_collab_outbox SET recovery_json = ${encoded}
          WHERE operation_id = ${record.operationId} AND kind IN ('apply_delivery', 'revert_delivery')
            AND status = 'pending' AND (recovery_json IS NULL OR recovery_json = ${encoded})
            AND EXISTS (
              SELECT 1 FROM vela_collab_leases l JOIN vela_collab_plans p ON p.plan_id = vela_collab_outbox.plan_id
              WHERE l.kind = ${lease.kind} AND l.resource_id = ${lease.resourceId}
                AND l.operation_id = ${lease.operationId} AND l.owner_id = ${lease.ownerId}
                AND l.token = ${lease.token} AND l.expires_at = ${lease.expiresAt} AND l.expires_at > ${now}
                AND p.plan_id = ${record.planId} AND p.target_worktree = ${record.canonicalTargetWorktree} AND p.git_common_dir = ${record.gitCommonDir}
                AND json_array(p.environment_id, p.target_worktree) = l.resource_id
                AND p.plan_version = vela_collab_outbox.expected_plan_version
            )
          RETURNING operation_id
        `;
          if (!row)
            return yield* conflict(
              "Delivery recovery is stale or the operation is no longer leased.",
            );
        }),
      ),
  );

  const scanRecovery = Effect.fn("VelaCollabStore.scanRecovery")((now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const outbox = (yield* sql<OutboxRow>`
        SELECT ${outboxColumns} FROM vela_collab_outbox WHERE status = 'pending' ORDER BY sequence
      `).map(decodeOutbox);
        const inbox = (yield* sql<InboxRow>`
        SELECT ${inboxColumns} FROM vela_collab_inbox WHERE status IN ('pending', 'dispatched') ORDER BY rowid
      `).map(decodeInbox);
        const expiredLeases = yield* sql<CollabOperationLease>`
        SELECT ${leaseColumns} FROM vela_collab_leases WHERE expires_at <= ${now} ORDER BY expires_at, resource_id
      `;
        return {
          outbox,
          inbox,
          expiredLeases,
          deliveries: outbox.filter(
            (intent) => intent.kind === "apply_delivery" || intent.kind === "revert_delivery",
          ),
        };
      }),
    ),
  );

  const buildProjection = Effect.fn("VelaCollabStore.buildProjection")((planId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const plan = yield* getPlan(planId);
        if (!plan) return null;
        const [totals] = yield* sql<{
          readonly size: number;
          readonly attention: number | null;
          readonly runnable: number | null;
        }>`
          SELECT COUNT(*) AS size, SUM(status = 'needs_attention') AS attention,
            SUM(status IN ('ready', 'developing', 'verifying_gates', 'queued_for_review', 'reviewing', 'integrating')) AS runnable
          FROM vela_collab_steps WHERE plan_id = ${planId}
        `;
        const verdicts = yield* sql<PayloadRow & { readonly stepId: string }>`
          SELECT stepId, payloadJson FROM (
            SELECT json_extract(r.payload_json, '$.stepId') AS stepId, v.payload_json AS payloadJson,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(r.payload_json, '$.stepId')
                ORDER BY v.rowid DESC
              ) AS position
            FROM vela_collab_records v
            JOIN vela_collab_records r ON r.plan_id = v.plan_id AND r.record_id = v.record_id
              AND r.kind = 'review'
            WHERE v.plan_id = ${planId} AND v.kind = 'verdict'
          ) WHERE position = 1
        `;
        const verdictByStep = new Map(
          verdicts.map(
            ({ stepId, payloadJson }) =>
              [stepId, decode<CollabRecordMap["verdict"]>(payloadJson)] as const,
          ),
        );
        const reviews = yield* sql<PayloadRow & { readonly stepId: string }>`
          SELECT stepId, payloadJson FROM (
            SELECT json_extract(r.payload_json, '$.stepId') AS stepId, r.payload_json AS payloadJson,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(r.payload_json, '$.stepId')
                ORDER BY r.rowid DESC
              ) AS position
            FROM vela_collab_records r
            WHERE r.plan_id = ${planId} AND r.kind = 'review'
          ) WHERE position = 1
        `;
        const reviewByStep = new Map(
          reviews.map(
            ({ stepId, payloadJson }) =>
              [stepId, decode<CollabRecordMap["review"]>(payloadJson)] as const,
          ),
        );
        const opinions = yield* sql<PayloadRow>`
          SELECT r.payload_json AS payloadJson FROM vela_collab_steps s
          JOIN vela_collab_records r ON r.plan_id = s.plan_id
            AND r.kind = 'batch_audit' AND r.record_id = 'second-opinion-' || s.review_id
          WHERE s.plan_id = ${planId}
        `;
        const opinionByReview = new Map(
          opinions.map(({ payloadJson }) => {
            const opinion = decode<CollabRecordMap["batch_audit"]>(payloadJson);
            return [opinion.reviewId, opinion] as const;
          }),
        );
        const steps = (yield* sql<StepRow & { readonly queuePosition: number | null }>`
        SELECT ${stepColumns}, CASE WHEN s.status = 'queued_for_review' AND s.review_sequence IS NOT NULL THEN (
          SELECT COUNT(*) FROM vela_collab_steps q WHERE q.plan_id = s.plan_id
            AND q.status = 'queued_for_review' AND q.review_sequence <= s.review_sequence
        ) END AS queuePosition
        FROM vela_collab_steps s WHERE plan_id = ${planId} ORDER BY position, step_id LIMIT 100
      `).map((row) => {
          const step = decodeStep(row);
          const verdict = verdictByStep.get(step.stepId);
          const reviewEvidence = reviewByStep.get(step.stepId);
          const opinion = opinionByReview.get(step.reviewId);
          const manualIds =
            step.attentionReason === "manual_check_required"
              ? new Set(
                  verdict?.criteriaResults
                    .filter(({ result }) => result === "manual_check")
                    .map(({ criterionId }) => criterionId),
                )
              : null;
          const reviewSummary = reviewEvidence
            ? {
                fileCount: reviewEvidence.changedFiles.length,
                additions: reviewEvidence.changedFiles.reduce(
                  (sum, file) => sum + (file.additions ?? 0),
                  0,
                ),
                deletions: reviewEvidence.changedFiles.reduce(
                  (sum, file) => sum + (file.deletions ?? 0),
                  0,
                ),
                gateResults: reviewEvidence.gateSummary.results.slice(0, 8).map((item) => ({
                  command: item.command.slice(0, 120),
                  passed: item.exitCode === 0,
                })),
              }
            : undefined;
          return {
            stepId: step.stepId,
            kind: step.kind,
            status: step.status,
            title: step.title.slice(0, 300),
            phase: step.phase,
            attempt: step.attempt,
            ...(step.dependsOn.length > 0 ? { dependsOn: step.dependsOn } : {}),
            ...(step.hardGates.length > 0
              ? { hardGates: step.hardGates.slice(0, 8).map((cmd) => cmd.slice(0, 120)) }
              : {}),
            ...(step.criteria.length > 0
              ? {
                  criteria: step.criteria
                    .slice(0, 12)
                    .map(({ id, text }) => ({ id, text: text.slice(0, 200) })),
                }
              : {}),
            ...(step.executor ? { executor: step.executor } : {}),
            ...(step.attentionReason === undefined
              ? {}
              : { attentionReason: step.attentionReason }),
            ...(step.attentionDetail && step.status === "needs_attention"
              ? { attentionDetail: step.attentionDetail.slice(0, 600) }
              : {}),
            ...(step.decisionOptions?.length
              ? {
                  decisionOptions: step.decisionOptions
                    .slice(0, 10)
                    .map((option) => option.slice(0, 250)),
                }
              : {}),
            ...(step.reviewId === undefined ? {} : { reviewId: step.reviewId }),
            ...(reviewSummary === undefined ? {} : { reviewSummary }),
            ...(step.childThreadId === undefined ? {} : { childThreadId: step.childThreadId }),
            ...(verdict
              ? {
                  latestVerdict: {
                    reviewId: verdict.reviewId,
                    verdict: verdict.verdict,
                    summary: verdict.summary.slice(0, 600),
                    decidedAt: verdict.decidedAt,
                  },
                }
              : {}),
            ...(manualIds?.size
              ? {
                  manualChecks: step.criteria
                    .filter(({ id }) => manualIds.has(id))
                    .map(({ id, text }) => ({ id, text: text.slice(0, 200) })),
                }
              : {}),
            ...(row.queuePosition === null ? {} : { queuePosition: row.queuePosition }),
            ...(opinion?.reviewId
              ? {
                  secondOpinion: {
                    reviewId: opinion.reviewId,
                    childThreadId: opinion.auditId,
                    summary: opinion.summary.slice(0, 600),
                    blockingFindings: opinion.findings.filter(
                      ({ severity }) => severity === "blocking",
                    ).length,
                  },
                }
              : {}),
          };
        });
        const delivery = plan.deliveryId
          ? yield* getRecord(planId, "delivery", plan.deliveryId)
          : null;
        const audit = plan.batchAuditId
          ? yield* getRecord(planId, "batch_audit", plan.batchAuditId)
          : null;
        const applied = plan.deliveryId
          ? yield* getRecord(planId, "applied", plan.deliveryId)
          : null;
        const reverted = applied ? yield* getRecord(planId, "reverted", applied.deliveryId) : null;
        const item = yield* getActiveInbox(plan);
        const activeInbox =
          item?.planId === planId
            ? {
                inboxItemId: item.inboxItemId,
                kind: item.kind,
                status: item.status,
                ...(item.stepId === undefined ? {} : { stepId: item.stepId }),
                ...(item.reviewId === undefined ? {} : { reviewId: item.reviewId }),
                ...(item.threadRunId === undefined ? {} : { threadRunId: item.threadRunId }),
              }
            : undefined;
        return {
          engineVersion: 2,
          planId,
          planVersion: plan.planVersion,
          revision: plan.revision,
          title: plan.title.slice(0, 300),
          status: plan.status,
          stepCount: totals?.size ?? 0,
          blocked:
            plan.status === "running" && (totals?.attention ?? 0) > 0 && totals?.runnable === 0,
          steps,
          ...(plan.integrationOid === undefined ? {} : { integrationOid: plan.integrationOid }),
          config: {
            enableBatchAudit: plan.enableBatchAudit === true,
            ...(plan.defaultDevAgent && "providerInstanceId" in plan.defaultDevAgent
              ? { defaultDevAgent: plan.defaultDevAgent }
              : {}),
            ...(plan.batchAuditAgent === undefined
              ? {}
              : { batchAuditAgent: plan.batchAuditAgent }),
          },
          ...(plan.batchGates.length > 0
            ? { batchGates: plan.batchGates.slice(0, 8).map((cmd) => cmd.slice(0, 120)) }
            : {}),
          ...(plan.batchGateSummary
            ? {
                batchGateSummary: {
                  passed: plan.batchGateSummary.passed,
                  commands: plan.batchGateSummary.results.slice(0, 8).map((item) => ({
                    command: item.command.slice(0, 120),
                    passed: item.exitCode === 0,
                  })),
                },
              }
            : {}),
          ...(applied
            ? {
                appliedDelivery: {
                  deliveryId: applied.deliveryId,
                  operationId: applied.operationId,
                  appliedAt: applied.appliedAt,
                  ...(reverted ? { revertedAt: reverted.revertedAt } : {}),
                },
              }
            : {}),
          ...(activeInbox === undefined ? {} : { activeInbox }),
          ...(plan.status === "running" && plan.batchGateSummary?.passed === false
            ? { canRetryBatch: true }
            : {}),
          ...(plan.attentionDetail ? { attentionDetail: plan.attentionDetail.slice(0, 1200) } : {}),
          ...(delivery
            ? {
                delivery: {
                  deliveryId: delivery.deliveryId,
                  expectedTargetState: delivery.expectedTargetState,
                  deliveryOid: delivery.deliveryOid,
                },
              }
            : {}),
          ...(audit
            ? {
                batchAudit: {
                  auditId: audit.auditId,
                  integrationOid: audit.integrationOid,
                  childThreadId: audit.auditId,
                  summary: audit.summary.slice(0, 1200),
                  blockingFindings: audit.findings.filter(({ severity }) => severity === "blocking")
                    .length,
                },
              }
            : {}),
          ...(plan.deliveryId === undefined ? {} : { deliveryId: plan.deliveryId }),
        } satisfies VelaCollabProjection;
      }),
    ),
  );

  return {
    getPlan,
    findActivePlan,
    findLatestPlan,
    listAttentionItems,
    listActivePlans,
    listSteps,
    listPendingIntents,
    updateIntentPayload,
    getStep,
    listQueuedSteps,
    listIntegratingSteps,
    getActiveInbox,
    getRecord,
    getOutbox,
    commitTransition,
    claimNextInbox,
    acquireLease,
    releaseLease,
    reconcileExpiredLease,
    recordDeliveryRecovery,
    scanRecovery,
    buildProjection,
  };
});

export class VelaCollabStore extends Context.Service<
  VelaCollabStore,
  Effect.Success<typeof make>
>()("t3/dispatch/VelaCollabStore") {}

export const layer = Layer.effect(VelaCollabStore, make);
