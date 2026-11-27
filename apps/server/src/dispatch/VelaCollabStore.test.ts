import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  layer,
  targetWorktreeLeaseResource,
  VelaCollabStore,
  type CollabTransition,
} from "./VelaCollabStore.ts";
import type {
  CollabDeliveryRecovery,
  CollabInboxWake,
  CollabOperationLease,
  CollabPlan,
  CollabRecord,
  CollabStep,
} from "./VelaCollabTypes.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = layer.pipe(Layer.provideMerge(sqlite));
const scope = { environmentId: "env", parentThreadId: "parent" };
const time = "2026-11-26T01:00:00.000Z";
const plan: CollabPlan = {
  ...scope,
  engineVersion: 2,
  planId: "plan",
  revision: 1,
  planVersion: 1,
  title: "Build it",
  requirement: "Long requirement",
  status: "running",
  canonicalTargetWorktree: "/worktree",
  gitCommonDir: "/worktree/.git",
  createdAt: time,
  updatedAt: time,
  batchGates: [],
};

const step = (
  stepId: string,
  order: number,
  state: CollabStep["status"] = "queued_for_review",
): CollabStep => ({
  planId: plan.planId,
  stepId,
  order,
  kind: "change",
  status: state,
  title: stepId,
  objective: "objective",
  dependsOn: [],
  criteria: [{ id: "c1", text: "works" }],
  criteriaVersion: 1,
  allowedPaths: ["."],
  hardGates: [],
  phase: "initial",
  attempt: 1,
  stepBaseOid: "base",
  ...(state === "queued_for_review" ? { reviewId: "review-" + stepId } : {}),
});
const wake = (stepId: string): CollabInboxWake => ({
  ...scope,
  planId: plan.planId,
  inboxItemId: "inbox-" + stepId,
  kind: "review",
  stepId,
  reviewId: "review-" + stepId,
  commandId: "send-" + stepId,
  messageId: "message-" + stepId,
  payloadJson: "{}",
});
const evidence = (stepId: string): CollabRecord => ({
  kind: "review",
  id: "review-" + stepId,
  value: {
    reviewId: "review-" + stepId,
    stepId,
    attempt: 1,
    criteriaVersion: 1,
    stepBaseOid: "base",
    reviewedOid: "oid-" + stepId,
    gateSummary: { passed: true, results: [] },
    changedFiles: [],
    createdAt: time,
  },
});
const transition = (
  revision: number,
  options: Partial<CollabTransition> = {},
): CollabTransition => ({
  plan: { ...plan, revision },
  expectedRevision: revision === 1 ? null : revision - 1,
  command: {
    commandId: "command-" + revision,
    requestKey: "request-" + revision,
    receiptJson: '{"ok":true}',
  },
  ...options,
});

describe("Vela Collaboration SQLite", () => {
  it.effect(
    "registers migration 117 and enforces one pending or dispatched inbox per thread in SQLite",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* VelaCollabStore;
        yield* runMigrations({ toMigrationInclusive: 116 });
        assert.deepStrictEqual(yield* runMigrations(), [[117, "VelaCollaborationV2"]]);
        assert.equal(BUILD_MIGRATION_HEAD, 117);
        yield* store.commitTransition(transition(1));
        const insert = (id: string, status: string, environmentId = scope.environmentId) => sql`
        INSERT INTO vela_collab_inbox (inbox_item_id, environment_id, parent_thread_id, plan_id, kind,
          command_id, message_id, status, payload_json)
        VALUES (${id}, ${environmentId}, ${scope.parentThreadId}, ${plan.planId}, 'delivery_ready',
          ${"command-" + id}, ${"message-" + id}, ${status}, '{}')
      `;
        yield* insert("first", "pending");
        yield* Effect.flip(insert("second", "dispatched"));
        yield* insert("other-environment", "pending", "other");
        yield* sql`UPDATE vela_collab_inbox SET status = 'completed' WHERE inbox_item_id = 'first'`;
        yield* insert("second", "dispatched");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rolls back plan, steps, records, wake intents and receipt together on transactional failure",
    () =>
      Effect.gen(function* () {
        const store = yield* VelaCollabStore;
        yield* runMigrations();
        yield* Effect.flip(
          store.commitTransition(transition(1, { steps: [step("a", 0)], wakes: [wake("a")] })),
        );
        assert.isNull(yield* store.getPlan(plan.planId));
        assert.isNull(yield* store.getStep(plan.planId, "a"));
        assert.isNull(yield* store.getOutbox("inbox-a"));

        const correct = transition(1, {
          steps: [step("a", 0)],
          wakes: [wake("a")],
          records: [evidence("a")],
        });
        assert.deepStrictEqual(yield* store.commitTransition(correct), {
          receiptJson: '{"ok":true}',
          replayed: false,
        });
        const duplicateRecord = transition(2, { steps: [step("b", 1)], records: [evidence("a")] });
        yield* Effect.flip(store.commitTransition(duplicateRecord));
        assert.equal((yield* store.getPlan(plan.planId))?.revision, 1);
        assert.isNull(yield* store.getStep(plan.planId, "b"));
        assert.deepStrictEqual(yield* store.commitTransition(transition(2)), {
          receiptJson: '{"ok":true}',
          replayed: false,
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "claims wakes in durable FIFO order, binds exact run IDs, and keeps the inbox active after a verdict",
    () =>
      Effect.gen(function* () {
        const store = yield* VelaCollabStore;
        yield* runMigrations();
        yield* store.commitTransition(
          transition(1, {
            steps: [step("later", 0), step("first", 1)],
            wakes: [wake("first"), wake("later")],
            records: [evidence("later"), evidence("first")],
          }),
        );
        assert.deepStrictEqual(
          (yield* store.listQueuedSteps(plan.planId)).map(({ stepId }) => stepId),
          ["first", "later"],
        );
        const claims = yield* Effect.all(
          [store.claimNextInbox(scope), store.claimNextInbox(scope)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(
          claims.flatMap((item) => item?.inboxItemId ?? []),
          ["inbox-first"],
        );
        const sent = yield* store.getOutbox("send-first");
        assert.equal(sent?.kind, "send_thread");
        assert.match(sent?.payloadJson ?? "", /"mode":"queue"/);
        assert.isNull(yield* store.claimNextInbox(scope));
        const binding = {
          action: "bind",
          inboxItemId: "inbox-first",
          commandId: "send-first",
          messageId: "message-first",
          threadRunId: "dedicated-run",
          receiptJson: "{}",
        } as const;
        yield* Effect.flip(
          store.commitTransition(
            transition(2, { inbox: { ...binding, messageId: "wrong-message" } }),
          ),
        );
        yield* store.commitTransition(
          transition(2, { inbox: binding, steps: [{ ...step("first", 1), status: "reviewing" }] }),
        );
        assert.equal((yield* store.getOutbox("send-first"))?.status, "completed");
        const verdict = (run: string): CollabRecord => ({
          kind: "verdict",
          id: "review-first",
          value: {
            reviewId: "review-first",
            verdict: "approve",
            summary: "approved",
            findings: [],
            criteriaResults: [{ criterionId: "c1", result: "pass" }],
            reviewerRunId: run,
            decidedAt: time,
          },
        });
        yield* Effect.flip(
          store.commitTransition(transition(3, { records: [verdict("unrelated-run")] })),
        );
        yield* store.commitTransition(transition(3, { records: [verdict("dedicated-run")] }));
        assert.isNull(yield* store.claimNextInbox(scope));
        yield* store.commitTransition(
          transition(4, {
            inbox: {
              action: "complete",
              inboxItemId: "inbox-first",
              threadRunId: "dedicated-run",
              receiptJson: "{}",
            },
            steps: [{ ...step("first", 1), status: "integrating" }],
            integration: {
              stepId: "first",
              intent: {
                kind: "update_integration",
                planId: plan.planId,
                operationId: "integrate-first",
                expectedPlanVersion: 1,
                createdAt: time,
                payloadJson: "{}",
              },
            },
          }),
        );
        assert.equal((yield* store.listIntegratingSteps(plan.planId))[0]?.stepId, "first");
        assert.equal((yield* store.claimNextInbox(scope))?.inboxItemId, "inbox-later");
        assert.equal(
          (yield* store.getRecord(plan.planId, "verdict", "review-first"))?.reviewerRunId,
          "dedicated-run",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "replays matching command receipts and returns a bounded projection without evidence payloads",
    () =>
      Effect.gen(function* () {
        const store = yield* VelaCollabStore;
        yield* runMigrations();
        const input = transition(1, {
          steps: [step("b", 0), step("a", 1)],
          records: [evidence("a"), evidence("b")],
          wakes: [wake("a"), wake("b")],
        });
        yield* store.commitTransition(input);
        yield* store.commitTransition(transition(2));
        assert.deepStrictEqual(yield* store.commitTransition(input), {
          replayed: true,
          receiptJson: '{"ok":true}',
        });
        yield* Effect.flip(
          store.commitTransition({ ...input, command: { ...input.command, requestKey: "other" } }),
        );
        assert.equal((yield* store.findActivePlan(scope))?.revision, 2);
        assert.isNull(yield* store.findActivePlan({ ...scope, environmentId: "other" }));
        const projection = yield* store.buildProjection(plan.planId);
        assert.deepStrictEqual(
          projection?.steps.map(({ stepId, queuePosition }) => [stepId, queuePosition]),
          [
            ["b", 2],
            ["a", 1],
          ],
        );
        assert.equal(projection?.stepCount, 2);
        assert.notMatch(
          JSON.stringify(projection),
          /changedFiles|payloadJson|objective|requirement/,
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps both lease lanes exclusive and exposes durable recovery until expiration is reconciled",
    () =>
      Effect.gen(function* () {
        const store = yield* VelaCollabStore;
        yield* runMigrations();
        const intent = {
          planId: plan.planId,
          expectedPlanVersion: 1,
          createdAt: time,
          payloadJson: "{}",
        };
        yield* store.commitTransition(
          transition(1, {
            outbox: [
              { ...intent, operationId: "apply", kind: "apply_delivery" },
              { ...intent, operationId: "revert", kind: "revert_delivery" },
              { ...intent, operationId: "integrate", kind: "update_integration" },
              { ...intent, operationId: "integrate-other", kind: "update_integration" },
            ],
          }),
        );
        const apply: CollabOperationLease = {
          resourceId: targetWorktreeLeaseResource(
            scope.environmentId,
            plan.canonicalTargetWorktree,
          ),
          kind: "target_worktree",
          ownerId: "process",
          token: "apply-token",
          operationId: "apply",
          expiresAt: 30,
        };
        const integration: CollabOperationLease = {
          ...apply,
          resourceId: plan.planId,
          kind: "integration",
          token: "integration-token",
          operationId: "integrate",
          expiresAt: 40,
        };
        const second = { ...apply, operationId: "revert", token: "revert-token", expiresAt: 100 };
        assert.deepStrictEqual(yield* store.acquireLease(apply, 1), apply);
        assert.deepStrictEqual(yield* store.acquireLease(integration, 1), integration);
        assert.isNull(
          yield* store.acquireLease({ ...integration, operationId: "integrate-other" }, 1),
        );
        assert.isNull(yield* store.acquireLease(second, 31));
        assert.isFalse(yield* store.releaseLease({ ...apply, token: "stale" }));
        const recovery: CollabDeliveryRecovery = {
          planId: plan.planId,
          operationId: "apply",
          canonicalTargetWorktree: plan.canonicalTargetWorktree,
          gitCommonDir: plan.gitCommonDir,
          baseTree: "old-tree",
          resultTree: "new-tree",
          writes: [],
        };
        yield* store.recordDeliveryRecovery(apply, recovery, 21);
        yield* store.recordDeliveryRecovery(apply, recovery, 21);
        yield* Effect.flip(
          store.recordDeliveryRecovery(apply, { ...recovery, resultTree: "different" }, 21),
        );
        const recoveryScan = yield* store.scanRecovery(31);
        assert.deepStrictEqual(recoveryScan.expiredLeases, [apply]);
        assert.deepStrictEqual(
          recoveryScan.deliveries.map(({ operationId }) => operationId),
          ["apply", "revert"],
        );
        assert.deepStrictEqual(recoveryScan.deliveries[0]?.recovery, recovery);
        assert.isFalse(yield* store.reconcileExpiredLease(apply, 29));
        assert.isTrue(
          yield* store.reconcileExpiredLease(apply, 31, {
            operationId: "apply",
            status: "completed",
            receiptJson: '{"applied":true}',
          }),
        );
        assert.deepStrictEqual(yield* store.acquireLease(second, 32), second);
        assert.deepStrictEqual(
          (yield* store.scanRecovery(32)).deliveries.map(({ operationId }) => operationId),
          ["revert"],
        );
        assert.isTrue(yield* store.releaseLease(integration));
      }).pipe(Effect.provide(testLayer)),
  );
});
