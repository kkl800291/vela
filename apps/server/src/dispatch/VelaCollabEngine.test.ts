// @effect-diagnostics nodeBuiltinImport:off
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as Git from "./VelaCollabGit.ts";
import {
  definition,
  disposeFixtures,
  environmentId,
  eventually,
  fixture,
  git,
  parentThreadId,
  scope,
} from "./VelaCollabEngine.testkit.ts";
import type { VelaCollabProjection } from "./VelaCollabTypes.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await disposeFixtures();
});

describe("Vela Collaboration engine", () => {
  it("runs independent workers concurrently and reviews in freeze order with dedicated run authentication", async () => {
    const f = await fixture([
      definition("first"),
      definition("second"),
      definition("third", { dependsOn: ["first"] }),
    ]);
    const observed: VelaCollabProjection[] = [];
    const unsubscribe = f.engine.subscribe(scope, (value) => observed.push(value));
    await Promise.all([f.worker("first"), f.worker("second")]);
    expect((await f.step("third"))?.status).toBe("locked");
    await f.finish("second", { b: "second" });
    const second = await f.review("second");
    const secondWorker = (await f.step("second"))!;
    await writeFile(join(secondWorker.worktreePath!, "b"), "changed after gates");
    const evidence = {
      environmentId,
      threadId: parentThreadId,
      planId: f.planId,
      evidence: { reviewId: second.reviewId! },
      kind: "file" as const,
      path: "b",
    };
    expect(await Effect.runPromise(f.engine.readEvidence(evidence))).toMatchObject({
      text: "second",
    });
    await expect(
      Effect.runPromise(f.engine.readEvidence({ ...evidence, threadId: "outside" })),
    ).rejects.toThrow(/outside/);
    await expect(
      Effect.runPromise(f.engine.readEvidence({ ...evidence, maxBytes: 70_000 })),
    ).rejects.toThrow(/65,536/);
    await f.finish("first", { a: "first" });
    await f.status("first", (step) => step.status === "queued_for_review");
    expect(f.sends.filter(({ threadId }) => threadId === parentThreadId)).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    const input = f.verdictInput(second);
    await expect(
      Effect.runPromise(f.engine.submitReviewVerdict({ ...input, callerRunId: "other" })),
    ).rejects.toThrow(/dedicated/);
    await expect(
      Effect.runPromise(f.engine.submitReviewVerdict({ ...input, reviewId: "expired" })),
    ).rejects.toThrow(/stale/);
    await expect(
      Effect.runPromise(f.engine.submitReviewVerdict({ ...input, criteriaResults: [] })),
    ).rejects.toThrow(/every acceptance criterion/);
    const receipt = await Effect.runPromise(f.engine.submitReviewVerdict(input));
    expect(await Effect.runPromise(f.engine.submitReviewVerdict(input))).toEqual(receipt);
    await expect(
      Effect.runPromise(f.engine.submitReviewVerdict({ ...input, summary: "changed" })),
    ).rejects.toThrow(/different verdict/);
    f.complete(second.threadRunId!);
    const first = await f.review("first");
    await f.approve(first);
    await f.worker("third");
    expect(observed.some((value) => value.activeInbox?.reviewId === first.reviewId)).toBe(true);
    unsubscribe();
  }, 20000);

  it("retries incomplete reviews at the tail and reuses the same child for two repairs", async () => {
    const f = await fixture([definition("a"), definition("b"), definition("c")]);
    const worker = await f.finish("a", { a: "first" });
    const incomplete = await f.review("a");
    await f.finish("b", { b: "second" });
    await f.status("b", (step) => step.status === "queued_for_review");
    f.complete(incomplete.threadRunId!);
    await f.status("a", (step) => step.attentionReason === "review_incomplete");
    const b = await f.review("b");
    await Effect.runPromise(
      f.engine.retryIncompleteReview({ ...f.command, stepId: "a", reviewId: incomplete.reviewId! }),
    );
    await f.approve(b);
    let review = await f.review("a");
    expect(review.reviewId).toBe(incomplete.reviewId);
    expect(review.threadRunId).not.toBe(incomplete.threadRunId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await Effect.runPromise(
        f.engine.submitReviewVerdict(f.verdictInput(review, "request_changes")),
      );
      if (attempt === 1) {
        await f.finish("c", { c: "independent" });
        await f.status("c", (step) => step.status === "queued_for_review");
      }
      f.complete(review.threadRunId!);
      if (attempt === 3) break;
      const repair = await f.finish("a", { a: `repair ${attempt}` }, attempt + 1);
      expect(repair.childThreadId).toBe(worker.childThreadId);
      expect(repair.phase).toBe("repair");
      if (attempt === 1) {
        const c = await f.review("c");
        await f.status("a", (step) => step.status === "queued_for_review");
        await f.approve(c);
      }
      review = await f.review("a");
    }
    await f.status("a", (step) => step.attentionReason === "repair_limit");
    await f.status("c", (step) => step.status === "integrated");
    expect(f.launched.filter(({ title }) => title === "a")).toHaveLength(1);
  }, 30000);

  it("releases the inbox while integration is pending and requeues a changed effective manifest", async () => {
    const realIntegrate = Git.integrateReviewedStep;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    vi.spyOn(Git, "integrateReviewedStep").mockImplementationOnce(async (input) => {
      started = true;
      await held;
      return realIntegrate(input);
    });
    try {
      const f = await fixture([definition("a"), definition("b")]);
      const original = await readFile(join(f.repo, "shared"), "utf8");
      await f.finish("a", { shared: original.replace("one", "A") });
      const a = await f.review("a");
      await f.finish("b", { shared: original.replace("six", "B") });
      await f.status("b", (step) => step.status === "queued_for_review");
      await f.approve(a);
      await eventually(async () => started, Boolean, "integration began");
      const b = await f.review("b");
      expect((await f.step("a"))?.status).toBe("integrating");
      await f.approve(b);
      release();
      const rereview = await f.inbox(
        (item) => item.kind === "review" && item.stepId === "b" && item.reviewId !== b.reviewId,
      );
      expect(rereview.reviewId).not.toBe(b.reviewId);
      expect((await f.step("b"))?.attempt).toBe(2);
      await f.approve(rereview);
      await f.projection(({ status }) => status === "ready_to_deliver");
    } finally {
      release();
    }
  }, 25000);

  it("preserves the conflicted workspace and moves its original thread to a new conflict worktree", async () => {
    const f = await fixture([definition("a"), definition("b")]);
    const original = await readFile(join(f.repo, "shared"), "utf8");
    await f.finish("a", { shared: original.replace("one", "A") });
    const a = await f.review("a");
    const previous = await f.finish("b", { shared: original.replace("one", "B") });
    await f.status("b", (step) => step.status === "queued_for_review");
    await f.approve(a);
    await f.approve(await f.review("b"));
    const repair = await f.worker("b", 2);
    expect(repair).toMatchObject({ phase: "conflict", childThreadId: previous.childThreadId });
    expect(repair.worktreePath).not.toBe(previous.worktreePath);
    expect(f.switches).toEqual([
      {
        threadId: previous.childThreadId,
        previous: previous.worktreePath,
        path: repair.worktreePath,
      },
    ]);
    expect(await readFile(join(previous.worktreePath!, "shared"), "utf8")).toBe(
      original.replace("one", "B"),
    );
    expect(await readFile(join(repair.worktreePath!, "shared"), "utf8")).toBe(
      original.replace("one", "A"),
    );
    await f.finish("b", { shared: original.replace("one", "A and B") }, 2);
    await f.approve(await f.review("b"));
    await f.status("b", (step) => step.status === "integrated");
  }, 25000);

  it("invalidates only the updated subgraph and batches gates, audit, delivery and reversion", async () => {
    const f = await fixture(
      [
        definition("a", { hardGates: ["test ! -e a || test ! -e b || test -e fix"] }),
        definition("b"),
        definition("cancelled", { dependsOn: ["b"] }),
      ],
      { enableBatchAudit: true },
    );
    const bWorker = await f.worker("b");
    expect(
      await Effect.runPromise(
        f.engine.cancelStep({ ...f.command, expectedPlanVersion: 1, stepId: "cancelled" }),
      ),
    ).toBe(2);
    expect((await f.worker("b")).workerRunId).toBe(bWorker.workerRunId);
    await f.finish("a", { a: "one" });
    await f.finish("b", { b: "two" });
    const first = await f.inbox((item) => item.kind === "review");
    await f.approve(first);
    await f.approve(await f.review(first.stepId === "a" ? "b" : "a"));
    const failed = await f.inbox((item) => item.kind === "batch_verification_failed");
    expect((await Effect.runPromise(f.store.getPlan(f.planId)))?.status).toBe("running");
    f.complete(failed.threadRunId!);
    await Effect.runPromise(
      f.engine.updatePlan({
        ...f.command,
        expectedPlanVersion: 2,
        steps: [definition("fix", { dependsOn: ["a", "b"] })],
      }),
    );
    await f.finish("fix", { fix: "fixed" });
    await f.approve(await f.review("fix"));
    const audit = await eventually(
      async () => f.launched.find(({ title }) => title === "Collaboration batch audit"),
      Boolean,
      "audit launch",
    );
    expect(audit).toMatchObject({ interactionMode: "plan", runtimeMode: "approval-required" });
    expect(audit?.initialMessage?.text).toMatch(/Compare [a-f0-9]+\.\.[a-f0-9]+/);
    f.complete(
      (await Effect.runPromise(f.store.listPendingIntents())).flatMap((intent) => {
        const info = JSON.parse(intent.payloadJson) as { auditRunId?: string };
        return info.auditRunId ? [info.auditRunId] : [];
      })[0] ??
        (await eventually(
          async () =>
            (await Effect.runPromise(f.store.listPendingIntents()))
              .map(
                (intent) => (JSON.parse(intent.payloadJson) as { auditRunId?: string }).auditRunId,
              )
              .find(Boolean),
          Boolean,
          "audit run binding",
        )) ??
        "",
      { summary: "Clear", findings: [] },
    );
    const ready = await f.projection(({ status }) => status === "ready_to_deliver");
    const delivery = (await Effect.runPromise(
      f.store.getRecord(f.planId, "delivery", ready.deliveryId!),
    ))!;
    expect(delivery.batchAuditId).toBeTruthy();
    expect(f.launched.filter(({ title }) => title === "Collaboration batch audit")).toHaveLength(1);
    const index = await readFile(join(f.repo, ".git", "index"));
    expect(
      await Effect.runPromise(
        f.engine.deliverPlan({
          ...f.command,
          deliveryId: delivery.deliveryId,
          expectedTargetState: delivery.expectedTargetState,
        }),
      ),
    ).toMatchObject({ status: "applied" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect(await readFile(join(f.repo, ".git", "index"))).toEqual(index);
    expect(await readFile(join(f.repo, "fix"), "utf8")).toBe("fixed");
    await writeFile(join(f.repo, "user"), "after delivery");
    expect(
      await Effect.runPromise(
        f.engine.revertDelivery({ ...f.command, deliveryId: delivery.deliveryId }),
      ),
    ).toMatchObject({ status: "reverted" });
    expect(await readFile(join(f.repo, "user"), "utf8")).toBe("after delivery");
    await expect(readFile(join(f.repo, "fix"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 35000);

  it("keeps unrelated evidence while invalidating an edited active review and its dependants", async () => {
    const f = await fixture([
      definition("a"),
      definition("b"),
      definition("later", { dependsOn: ["a"] }),
    ]);
    await f.finish("a", { a: "old requirement" });
    const oldA = await f.review("a");
    await f.finish("b", { b: "unrelated" });
    const queuedB = await f.status("b", (step) => step.status === "queued_for_review");
    await Effect.runPromise(
      f.engine.updatePlan({
        ...f.command,
        expectedPlanVersion: 1,
        steps: [definition("a", { objective: "Updated requirement" })],
      }),
    );
    const restarted = await f.worker("a", 2);
    expect(restarted.criteriaVersion).toBe(2);
    expect((await f.step("later"))?.criteriaVersion).toBe(2);
    expect((await f.step("later"))?.status).toBe("locked");
    expect((await f.step("b"))?.reviewId).toBe(queuedB.reviewId);
    await expect(
      Effect.runPromise(f.engine.submitReviewVerdict(f.verdictInput(oldA))),
    ).rejects.toThrow(/stale/);
    expect(f.sends).toHaveLength(1);
    f.complete(oldA.threadRunId!);
    await f.approve(await f.review("b"));
    await f.finish("a", { a: "updated requirement" }, 2);
    const newA = await f.review("a");
    expect(newA.reviewId).not.toBe(oldA.reviewId);
    await f.approve(newA);
    await f.worker("later");
  }, 22000);

  it("invalidates old batch audit and delivery grants when a repair advances the integration OID", async () => {
    const f = await fixture([definition("a")], { enableBatchAudit: true });
    const finishAudit = async (
      ordinal: number,
      findings: Array<{ severity: "blocking"; summary: string }> = [],
    ) => {
      await eventually(
        async () => f.launched.filter(({ title }) => title === "Collaboration batch audit").length,
        (count) => count === ordinal,
        "one audit for the current snapshot",
      );
      const runId = await eventually(
        async () =>
          (await Effect.runPromise(f.store.listPendingIntents()))
            .map(
              ({ payloadJson }) => (JSON.parse(payloadJson) as { auditRunId?: string }).auditRunId,
            )
            .find(Boolean),
        Boolean,
        "audit run",
      );
      f.complete(runId!, { summary: "Audit", findings });
    };
    await f.finish("a", { a: "a" });
    await f.approve(await f.review("a"));
    await finishAudit(1);
    const initial = await f.projection(({ status }) => status === "ready_to_deliver");
    await Effect.runPromise(
      f.engine.updatePlan({
        ...f.command,
        expectedPlanVersion: 1,
        steps: [definition("fix", { dependsOn: ["a"] })],
      }),
    );
    const afterUpdate = await f.projection(({ planVersion }) => planVersion === 2);
    expect(afterUpdate.batchAudit).toBeUndefined();
    expect(afterUpdate.delivery).toBeUndefined();
    await expect(
      Effect.runPromise(
        f.engine.deliverPlan({
          ...f.command,
          deliveryId: initial.delivery!.deliveryId,
          expectedTargetState: initial.delivery!.expectedTargetState,
        }),
      ),
    ).rejects.toThrow(/stale/);
    // If the first delivery notice had already been accepted, let its dedicated turn finish.
    const notice = await Effect.runPromise(f.store.getActiveInbox(scope));
    if (notice?.threadRunId) f.complete(notice.threadRunId);
    await f.finish("fix", { fix: "fix" });
    await f.approve(await f.review("fix"));
    await finishAudit(2, [{ severity: "blocking", summary: "Review the combined behavior." }]);
    const blocked = await f.inbox(({ kind }) => kind === "batch_verification_failed");
    const snapshot = await f.projection(
      ({ status, batchAudit }) => status === "running" && !!batchAudit,
    );
    expect(snapshot.batchAudit?.auditId).not.toBe(initial.batchAudit?.auditId);
    expect(snapshot.batchAudit?.integrationOid).not.toBe(initial.batchAudit?.integrationOid);
    const request = {
      ...f.command,
      expectedPlanVersion: 2,
      auditId: snapshot.batchAudit!.auditId,
      callerRunId: blocked.threadRunId!,
    };
    await expect(
      Effect.runPromise(f.engine.acceptBatchAudit({ ...request, callerRunId: "stale" })),
    ).rejects.toThrow(/dedicated/);
    await Effect.runPromise(f.engine.acceptBatchAudit(request));
    f.complete(blocked.threadRunId!);
    const ready = await f.projection(({ status }) => status === "ready_to_deliver");
    expect(ready.deliveryId).not.toBe(initial.deliveryId);
  }, 40000);

  it("reconciles a moved integration ref before unlocking dependencies after restart", async () => {
    const synchronize = vi
      .spyOn(Git, "synchronizeIntegrationWorktree")
      .mockRejectedValueOnce(new Error("simulated loss after integration ref CAS"));
    const f = await fixture([definition("a"), definition("dependent", { dependsOn: ["a"] })]);
    await f.finish("a", { a: "first" });
    await f.approve(await f.review("a"));
    const interrupted = await eventually(
      () => Effect.runPromise(f.store.getPlan(f.planId)),
      (plan) => !!plan?.attentionDetail?.includes("after integration ref CAS"),
      "CAS journal",
    );
    expect((await f.step("dependent"))?.status).toBe("locked");
    expect(git(f.repo, "rev-parse", Git.planRefs(f.planId).integration)).not.toBe(
      interrupted?.integrationOid,
    );
    synchronize.mockRestore();
    await f.restart();
    await f.status("a", (step) => step.status === "integrated");
    await f.worker("dependent");
  }, 20000);

  it("continues a journalled partial delivery once after restart", async () => {
    const apply = Git.preflightAndApplyDelivery;
    vi.spyOn(Git, "preflightAndApplyDelivery").mockImplementationOnce((input) =>
      apply({
        ...input,
        persistRecovery: async (recovery) => {
          await input.persistRecovery(recovery);
          await writeFile(join(recovery.canonicalTargetWorktree, "a"), "first");
          throw new Error("simulated loss during delivery writes");
        },
      }),
    );
    const f = await fixture([definition("apply")]);
    await f.finish("apply", { a: "first", b: "second" });
    await f.approve(await f.review("apply"));
    const ready = await f.projection(({ status }) => status === "ready_to_deliver");
    const delivery = (await Effect.runPromise(
      f.store.getRecord(f.planId, "delivery", ready.deliveryId!),
    ))!;
    const request = {
      ...f.command,
      deliveryId: delivery.deliveryId,
      expectedTargetState: delivery.expectedTargetState,
    };
    await expect(Effect.runPromise(f.engine.deliverPlan(request))).rejects.toThrow(
      /during delivery writes/,
    );
    const recovery = await Effect.runPromise(f.store.scanRecovery(Number.MAX_SAFE_INTEGER));
    expect(recovery.deliveries[0]?.recovery?.writes.map(({ path }) => path)).toEqual(["a", "b"]);
    await expect(readFile(join(f.repo, "b"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.restart();
    await f.projection(({ status }) => status === "delivered");
    expect(await readFile(join(f.repo, "a"), "utf8")).toBe("first");
    expect(await readFile(join(f.repo, "b"), "utf8")).toBe("second");
    await expect(Effect.runPromise(f.engine.deliverPlan(request))).rejects.toThrow(/confirmation/);
  }, 22000);

  it("replays pending wake receipts after restart and resumes a dispatched inbox without duplicate delivery", async () => {
    let hold = true;
    const f = await fixture([definition("a"), definition("b")], {
      beforeSend: (input) =>
        input.threadId === parentThreadId && hold ? Effect.never : Effect.void,
    });
    await f.finish("a", { a: "a" });
    await eventually(
      async () => Effect.runPromise(f.store.getActiveInbox(scope)),
      (item) => item?.status === "pending" && f.sends.length === 1,
      "delivered before SQLite binding",
    );
    hold = false;
    await f.restart();
    const a = await f.review("a");
    expect(f.sends).toHaveLength(1);
    await f.finish("b", { b: "b" });
    await f.status("b", (step) => step.status === "queued_for_review");
    await f.restart();
    expect((await f.review("a")).threadRunId).toBe(a.threadRunId);
    expect(f.sends).toHaveLength(1);
    await f.approve(a);
    await f.approve(await f.review("b"));
    expect(f.sends.filter(({ text }) => text.includes("[Vela collaboration review]"))).toHaveLength(
      2,
    );
  }, 25000);
});
