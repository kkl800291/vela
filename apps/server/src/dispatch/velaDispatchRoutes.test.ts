// @effect-diagnostics nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import { VelaCollabEngine } from "./VelaCollabEngine.ts";
import {
  definition,
  disposeFixtures,
  eventually,
  fixture,
  parentThreadId,
} from "./VelaCollabEngine.testkit.ts";
import { VelaDispatchService } from "./VelaDispatchService.ts";
import { createEmptyDispatchState } from "./VelaDispatchStore.ts";
import type { DispatchAttentionItem, VelaDispatchState } from "./VelaDispatchTypes.ts";
import { layer } from "./velaDispatchRoutes.ts";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  await disposeFixtures();
});

function routes(f: Awaited<ReturnType<typeof fixture>>) {
  let legacy = createEmptyDispatchState(f.repo, parentThreadId);
  const legacyItem: DispatchAttentionItem = {
    id: "legacy",
    kind: "decision",
    projectRoot: f.repo,
    threadId: "legacy-thread",
    planTitle: "Legacy",
    stepId: "legacy-step",
    stepTitle: "Legacy step",
    summary: "Waiting",
    blockedStepTitles: [],
    updatedAt: legacy.updatedAt,
  };
  const stateListeners = new Set<(state: VelaDispatchState) => void>();
  const attentionListeners = new Set<(state: VelaDispatchState) => void>();
  const subscribe = (
    listeners: Set<(state: VelaDispatchState) => void>,
    listener: (state: VelaDispatchState) => void,
  ) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const app = HttpRouter.toWebHandler(
    layer.pipe(
      Layer.provideMerge(f.dependencies),
      Layer.provideMerge(Layer.succeed(VelaCollabEngine, f.engine)),
      Layer.provideMerge(
        Layer.mock(VelaDispatchService)({
          getState: () => Effect.sync(() => legacy),
          listAttentionItems: () =>
            Effect.sync(() => [{ ...legacyItem, summary: legacy.planTitle ?? "Waiting" }]),
          subscribe: (_root, listener) => subscribe(stateListeners, listener),
          subscribeAll: (listener) => subscribe(attentionListeners, listener),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth)({
          authenticateHttpRequest: (req) => {
            const auth = req.headers.authorization;
            if (!auth) return Effect.fail(new ServerAuthMissingCredentialError({}));
            return Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "user",
              method: "bearer-access-token",
              scopes:
                auth === "Bearer read"
                  ? [AuthOrchestrationReadScope]
                  : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            });
          },
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(app.dispose);

  const request = (path: string, body?: object, auth = "operator") =>
    app.handler(
      new Request(`http://vela.test/api/vela/dispatch/${path}`, {
        ...(auth
          ? { headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" } }
          : {}),
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      }),
    );

  const statePath = (stream = false) =>
    `${stream ? "stream" : "state"}?${new URLSearchParams({
      threadId: parentThreadId,
      projectRoot: f.repo,
    })}`;

  return {
    request,
    statePath,
    setLegacyTitle: (title: string) => {
      legacy = { ...legacy, planTitle: title };
      for (const listener of [...stateListeners, ...attentionListeners]) listener(legacy);
    },
  };
}

async function streamReader(response: Response) {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  disposers.unshift(() => reader.cancel());
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (frame.startsWith("data: ")) {
          const value: unknown = JSON.parse(frame.slice(6));
          return value;
        }
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error("Dispatch stream ended before sending a projection.");
        buffer += decoder.decode(value, { stream: true });
      }
    }
  };
}

describe("Vela dispatch HTTP and SSE", () => {
  it("merges v1 and v2 state and attention and refreshes both streams", async () => {
    const f = await fixture([
      definition("choose", {
        kind: "decision",
        decisionOptions: ["One", "Two"],
      }),
    ]);
    await f.status("choose", (step) => step.attentionReason === "decision");
    const api = routes(f);
    expect((await api.request(api.statePath(), undefined, "")).status).toBe(401);
    expect(await (await api.request(api.statePath(), undefined, "read")).json()).toMatchObject({
      version: 1,
      collab: { planId: f.planId, steps: [{ decisionOptions: ["One", "Two"] }] },
    });
    const initialAttention = await (await api.request("attention")).json();
    expect(initialAttention).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: "legacy" }),
        expect.objectContaining({
          engineVersion: 2,
          planId: f.planId,
          attentionReason: "decision",
        }),
      ]),
    });

    const state = await streamReader(await api.request(api.statePath(true)));
    const attention = await streamReader(await api.request("attention/stream"));
    expect(await state()).toMatchObject({
      collab: { planId: f.planId, config: { enableBatchAudit: false } },
    });
    expect(await attention()).toEqual(initialAttention);
    const plan = { planId: f.planId, threadId: parentThreadId };
    const config = {
      ...plan,
      defaultDevAgent: { providerInstanceId: "codex", model: "test-model" },
    };
    expect((await api.request("v2/config", config, "read")).status).toBe(403);
    expect(await (await api.request("v2/config", config)).json()).toMatchObject({
      config: { defaultDevAgent: { model: "test-model" } },
    });
    expect(await state()).toMatchObject({
      collab: { config: { defaultDevAgent: { model: "test-model" } } },
    });
    await attention();

    api.setLegacyTitle("Updated legacy");
    expect(await state()).toMatchObject({
      planTitle: "Updated legacy",
      collab: { planId: f.planId },
    });
    expect(await attention()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: "legacy", summary: "Updated legacy" }),
      ]),
    });

    const decision = { ...plan, stepId: "choose", resolution: "human_decision", response: "One" };
    expect((await api.request("v2/step/resolve", decision, "read")).status).toBe(403);
    expect((await api.request("v2/step/resolve", decision)).status).toBe(200);
    await f.status("choose", (step) => step.status === "done");
    expect(await (await api.request("attention")).json()).toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({ attentionReason: "decision", engineVersion: 2 }),
      ]),
    });
  }, 15000);

  it("publishes, updates, starts and cancels a v2 plan from the client", async () => {
    const f = await fixture([definition("original")]);
    const api = routes(f);
    const draft = {
      threadId: parentThreadId,
      autoStart: false,
      planTitle: "Client plan",
      steps: [
        {
          stepId: "choose",
          title: "Choose",
          goal: "Select an option",
          kind: "decision",
          decisionOptions: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ],
        },
      ],
    };
    expect((await api.request("v2/plan", draft, "read")).status).toBe(403);
    expect(
      (await api.request("clear", { projectRoot: f.repo, threadId: parentThreadId })).status,
    ).toBe(200);
    expect(await (await api.request("v2/plan", draft)).json()).toMatchObject({
      status: "draft",
      title: "Client plan",
      planVersion: 1,
    });
    const plan = await eventually(
      () => Effect.runPromise(f.store.findActivePlan(f.command)),
      (value) => value?.baseOid !== undefined,
      "draft initialization",
    );
    const ids = { threadId: parentThreadId, planId: plan!.planId };
    expect(
      await (
        await api.request("v2/plan", {
          ...ids,
          action: "update",
          planTitle: "Updated client plan",
          expectedPlanVersion: 1,
        })
      ).json(),
    ).toMatchObject({ status: "draft", title: "Updated client plan", planVersion: 2 });
    expect(
      (await api.request("v2/plan", { ...ids, action: "start", expectedPlanVersion: 1 })).status,
    ).toBe(400);
    expect(
      await (
        await api.request("v2/plan", {
          ...ids,
          action: "start",
          expectedPlanVersion: 2,
        })
      ).json(),
    ).toMatchObject({ status: "running" });
    expect(await (await api.request("v2/plan", { ...ids, action: "cancel" })).json()).toMatchObject(
      { status: "cancelled" },
    );
  }, 15000);

  it("reads bounded evidence and applies and reverts the confirmed delivery", async () => {
    const f = await fixture([
      definition("change", {
        executor: { providerInstanceId: "codex", model: "explicit-model" },
      }),
    ]);
    const api = routes(f);
    const plan = { planId: f.planId, threadId: parentThreadId };
    await api.request("v2/config", {
      ...plan,
      defaultDevAgent: { providerInstanceId: "codex", model: "new-default" },
    });
    expect((await f.step("change"))?.executor?.model).toBe("explicit-model");
    await f.finish("change", { evidence: "original snapshot\n", " exact path ": "literal path\n" });
    const review = await f.review("change");
    const evidencePath = (entries: Record<string, string>) =>
      `v2/evidence?${new URLSearchParams({ ...plan, ...entries })}`;
    expect(
      (
        await api.request(
          evidencePath({ reviewId: review.reviewId!, view: "manifest" }),
          undefined,
          "",
        )
      ).status,
    ).toBe(401);
    expect(
      await (
        await api.request(
          evidencePath({ reviewId: review.reviewId!, view: "file", path: "evidence" }),
          undefined,
          "read",
        )
      ).json(),
    ).toMatchObject({ kind: "lines", text: "original snapshot\n" });
    expect(
      await (
        await api.request(
          evidencePath({ reviewId: review.reviewId!, view: "diff", path: " exact path " }),
          undefined,
          "read",
        )
      ).json(),
    ).toMatchObject({ kind: "patch", file: { path: " exact path " } });
    expect(
      (
        await api.request(
          evidencePath({ reviewId: review.reviewId!, view: "manifest", threadId: "other" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request(
          evidencePath({ reviewId: review.reviewId!, view: "manifest", maxBytes: "70000" }),
        )
      ).status,
    ).toBe(400);
    await Effect.runPromise(
      f.engine.submitReviewVerdict({
        ...f.verdictInput(review),
        criteriaResults: [{ criterionId: "works", result: "manual_check" }],
      }),
    );
    f.complete(review.threadRunId!);
    await f.status("change", (step) => step.attentionReason === "manual_check_required");
    expect(await (await api.request(api.statePath())).json()).toMatchObject({
      collab: {
        steps: [
          {
            status: "needs_attention",
            childThreadId: expect.any(String),
            latestVerdict: { reviewId: review.reviewId, verdict: "approve" },
            manualChecks: [{ id: "works", text: "The change meets the requirement." }],
          },
        ],
      },
    });
    const manual = {
      ...plan,
      stepId: "change",
      resolution: "human_manual_check",
      response: "Verified",
    };
    expect((await api.request("v2/step/resolve", { ...manual, reviewId: "stale" })).status).toBe(
      400,
    );
    expect(
      (await api.request("v2/step/resolve", { ...manual, reviewId: review.reviewId })).status,
    ).toBe(200);

    const ready = await f.projection(({ status }) => status === "ready_to_deliver");
    expect(
      await (
        await api.request("v2/config", {
          ...plan,
          enableBatchAudit: true,
          batchAuditAgent: { providerInstanceId: "codex", model: "audit-model" },
        })
      ).json(),
    ).toMatchObject({
      config: { enableBatchAudit: true, batchAuditAgent: { model: "audit-model" } },
    });
    expect(
      (
        await api.request("v2/deliver", {
          ...plan,
          deliveryId: ready.deliveryId,
          expectedTargetState: ready.delivery!.expectedTargetState,
        })
      ).status,
    ).toBe(400);

    await api.request("v2/config", { ...plan, enableBatchAudit: false });
    const confirmed = await f.projection(({ status }) => status === "ready_to_deliver");
    expect(confirmed.deliveryId).not.toBe(ready.deliveryId);
    const delivery = { ...plan, deliveryId: confirmed.delivery!.deliveryId };
    expect(await (await api.request("attention")).json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ attentionReason: "ready_to_deliver" }),
      ]),
    });
    expect(
      await (
        await api.request(evidencePath({ deliveryId: delivery.deliveryId, view: "manifest" }))
      ).json(),
    ).toMatchObject({
      kind: "manifest",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "evidence" }),
        expect.objectContaining({ path: " exact path " }),
      ]),
    });
    const apply = { ...delivery, expectedTargetState: confirmed.delivery!.expectedTargetState };
    expect((await api.request("v2/deliver", apply, "read")).status).toBe(403);
    expect(
      (await api.request("v2/deliver", { ...apply, expectedTargetState: "stale" })).status,
    ).toBe(400);
    expect(await (await api.request("v2/deliver", apply)).json()).toMatchObject({
      status: "applied",
    });
    expect(await readFile(join(f.repo, "evidence"), "utf8")).toBe("original snapshot\n");
    expect(await (await api.request(api.statePath())).json()).toMatchObject({
      collab: { status: "delivered", appliedDelivery: { deliveryId: delivery.deliveryId } },
    });
    expect((await api.request("v2/revert-delivery", delivery, "read")).status).toBe(403);
    expect(await (await api.request("v2/revert-delivery", delivery)).json()).toMatchObject({
      status: "reverted",
    });
    await expect(readFile(join(f.repo, "evidence"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await (await api.request(api.statePath())).json()).toMatchObject({
      collab: { appliedDelivery: { revertedAt: expect.any(String) } },
    });
  }, 20000);
});
