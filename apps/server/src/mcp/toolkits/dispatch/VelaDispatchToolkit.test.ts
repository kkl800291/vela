import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { McpSchema, McpServer } from "effect/ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { VelaCollabEngine } from "../../../dispatch/VelaCollabEngine.ts";
import {
  definition,
  disposeFixtures,
  environmentId,
  eventually,
  fixture,
  parentThreadId,
  scope,
} from "../../../dispatch/VelaCollabEngine.testkit.ts";
import { VelaDispatchService } from "../../../dispatch/VelaDispatchService.ts";
import { createEmptyDispatchState } from "../../../dispatch/VelaDispatchStore.ts";
import { layerInProcessMcpServer, layerVelaDispatchToolkit } from "../../McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";

const invocation: McpInvocationScope = {
  environmentId,
  requestNamespace: "dispatch-fixture",
  issuedAt: 1,
  thread: {
    threadId: parentThreadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session",
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "dispatch-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dispatch-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const runtimes: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of runtimes.splice(0)) await dispose();
  await disposeFixtures();
});

function toolkit(f: Awaited<ReturnType<typeof fixture>>) {
  const empty = createEmptyDispatchState(f.repo, parentThreadId);
  let legacy = empty;
  const publish = vi.fn<VelaDispatchService["Service"]["publishPlan"]>((input) => {
    legacy = {
      ...empty,
      planTitle: input.planTitle ?? "Legacy plan",
      steps: [
        {
          id: "S1",
          order: 1,
          title: "Legacy work",
          goal: "Legacy",
          status: "ready",
          isolation: "direct",
          executor: "self",
          premisesToVerify: [],
          contextFiles: [],
          acceptanceCriteria: [],
          allowedGlobs: [],
          forbiddenGlobs: [],
          sensitiveGlobs: [],
          hardGates: [],
          createdAt: empty.updatedAt,
          updatedAt: empty.updatedAt,
        },
      ],
    };
    return Effect.succeed(legacy);
  });
  const submit = vi.fn<VelaDispatchService["Service"]["submitAcceptance"]>(() =>
    Effect.succeed(legacy),
  );
  const runtime = ManagedRuntime.make(
    layerVelaDispatchToolkit.pipe(
      Layer.provideMerge(layerInProcessMcpServer),
      Layer.provide(f.dependencies),
      Layer.provide(Layer.succeed(VelaCollabEngine, f.engine)),
      Layer.provide(
        Layer.mock(VelaDispatchService)({
          getState: () => Effect.sync(() => legacy),
          publishPlan: publish,
          submitAcceptance: submit,
          subscribe: () => () => {},
          subscribeAll: () => () => {},
        }),
      ),
    ),
  );
  runtimes.push(() => runtime.dispose());

  const call = async (
    name: string,
    args: Record<string, unknown>,
    runId?: string,
    threadId = parentThreadId,
  ) => {
    const result = await runtime.runPromise(
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name, arguments: args })),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext, {
          ...invocation,
          thread: {
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "session",
            ...(runId === undefined ? {} : { runId: RunId.make(runId) }),
          },
        }),
      ),
    );
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const data: unknown = JSON.parse(text);
    return { data, isError: result.isError === true };
  };

  return { call, publish, submit };
}

describe("Vela dispatch MCP toolkit", () => {
  it("publishes and starts v2, preserves legacy criteria IDs, updates and clears the active plan", async () => {
    const f = await fixture([definition("original")]);
    await Effect.runPromise(f.engine.cancelPlan(scope, f.planId));
    const mcp = toolkit(f);
    const published = await mcp.call("vela_dispatch_plan", {
      action: "publish",
      planTitle: "Next collaboration",
      steps: [
        {
          id: "legacy-criteria",
          title: "Implement",
          goal: "Make changes",
          acceptanceCriteria: ["Works", "Covered"],
        },
        {
          id: "stable-criteria",
          title: "Follow up",
          goal: "Make other changes",
          dependsOn: ["legacy-criteria"],
          criteria: [{ id: "stable", text: "Verify it" }],
        },
      ],
    });
    expect(published).toMatchObject({ isError: false, data: { engineVersion: 2, planVersion: 1 } });
    const active = await eventually(
      () => Effect.runPromise(f.engine.getActiveProjection(scope)),
      (value) => value?.status === "running",
      "published plan starts",
    );
    expect(
      await Effect.runPromise(f.store.getStep(active!.planId, "legacy-criteria")),
    ).toMatchObject({
      criteria: [
        { id: "c1", text: "Works" },
        { id: "c2", text: "Covered" },
      ],
    });
    expect(
      await mcp.call("vela_dispatch_plan", {
        action: "update",
        planId: active!.planId,
        expectedPlanVersion: 1,
        planTitle: "Revised",
      }),
    ).toMatchObject({ isError: false, data: { planVersion: 2, title: "Revised" } });
    expect(await mcp.call("vela_dispatch_status", {})).toMatchObject({
      isError: false,
      data: { planId: active!.planId, title: "Revised" },
    });
    expect(await mcp.call("vela_dispatch_plan", { action: "clear" })).toMatchObject({
      isError: false,
      data: { status: "cancelled" },
    });
    expect(mcp.publish).not.toHaveBeenCalled();

    const plan = { action: "publish", steps: [{ title: "Legacy", goal: "Legacy" }] };
    await mcp.call("vela_dispatch_plan", { ...plan, engineVersion: 1 });
    await mcp.call("vela_dispatch_plan", { ...plan, append: true });
    expect(mcp.publish).toHaveBeenCalledTimes(2);
    expect(await mcp.call("vela_dispatch_status", {})).toMatchObject({
      isError: false,
      data: { version: 1, planTitle: "Legacy plan" },
    });
    expect(
      await mcp.call("vela_dispatch_acceptance", { stepId: "S1", summary: "Ok", items: [] }),
    ).toMatchObject({ isError: false });
    expect(mcp.submit).toHaveBeenCalledTimes(1);
  }, 15000);

  it("bounds frozen review and delivery reads and authenticates verdicts against the dedicated run", async () => {
    const f = await fixture([definition("change")]);
    const mcp = toolkit(f);
    await f.finish("change", { evidence: "first\nsecond\n" });
    const old = await f.review("change");
    f.complete(old.threadRunId!);
    await f.status("change", (step) => step.attentionReason === "review_incomplete");

    const ids = { planId: f.planId, stepId: "change", reviewId: old.reviewId! };
    expect(await mcp.call("vela_dispatch_step", { ...ids, action: "retry_review" })).toMatchObject({
      isError: false,
    });
    const queued = await f.review("change");
    expect(queued.threadRunId).not.toBe(old.threadRunId);
    expect(
      await mcp.call("vela_dispatch_step", {
        planId: ids.planId,
        reviewId: ids.reviewId,
        action: "second_opinion",
        question: "Check the new file",
      }),
    ).toMatchObject({ isError: false, data: { operationId: expect.any(String) } });

    const query = { planId: f.planId, reviewId: old.reviewId };
    expect(await mcp.call("vela_dispatch_status", { ...query, view: "manifest" })).toMatchObject({
      isError: false,
      data: { kind: "manifest", files: [{ path: "evidence" }] },
    });
    expect(
      await mcp.call("vela_dispatch_status", {
        ...query,
        view: "diff",
        path: "evidence",
        maxBytes: 12,
      }),
    ).toMatchObject({ isError: false, data: { kind: "patch", byteLength: 12, nextOffset: 12 } });
    expect(
      await mcp.call("vela_dispatch_status", {
        ...query,
        view: "file",
        path: "evidence",
        startLine: 2,
        endLine: 2,
      }),
    ).toMatchObject({ isError: false, data: { kind: "lines", text: "second\n" } });
    expect(
      await mcp.call("vela_dispatch_status", { ...query, view: "manifest", maxBytes: 70_000 }),
    ).toMatchObject({ isError: true, data: { message: expect.stringContaining("65,536") } });
    expect(
      await mcp.call(
        "vela_dispatch_status",
        { ...query, view: "manifest" },
        undefined,
        ThreadId.make("outside"),
      ),
    ).toMatchObject({ isError: true, data: { message: expect.stringContaining("outside") } });

    expect(
      await mcp.call("vela_dispatch_status", {
        ...query,
        view: "manifest",
        projectRoot: `${f.repo}/..`,
      }),
    ).toMatchObject({ isError: true, data: { message: expect.stringContaining("binding") } });

    const verdict = {
      ...ids,
      verdict: "approve",
      summary: "Checked",
      findings: [],
      criteriaResults: [{ criterionId: "works", result: "pass" }],
    };
    await expect(
      mcp.call("vela_dispatch_acceptance", { ...verdict, callerRunId: queued.threadRunId }),
    ).rejects.toThrow(/Unknown argument "callerRunId"/);
    expect(await mcp.call("vela_dispatch_acceptance", verdict)).toMatchObject({
      isError: true,
      data: { message: expect.stringContaining("caller run") },
    });
    expect(await mcp.call("vela_dispatch_acceptance", verdict, old.threadRunId)).toMatchObject({
      isError: true,
      data: { message: expect.stringContaining("dedicated") },
    });
    const approved = await mcp.call("vela_dispatch_acceptance", verdict, queued.threadRunId);
    expect(approved.isError).toBe(false);
    expect(await mcp.call("vela_dispatch_acceptance", verdict, queued.threadRunId)).toEqual(
      approved,
    );
    f.complete(queued.threadRunId!);

    const ready = await f.projection(({ status }) => status === "ready_to_deliver");
    const delivery = { planId: f.planId, deliveryId: ready.deliveryId };
    for (const [view, kind] of [
      ["manifest", "manifest"],
      ["diff", "patch"],
      ["file", "lines"],
    ]) {
      expect(
        await mcp.call("vela_dispatch_status", { ...delivery, view, path: "evidence" }),
      ).toMatchObject({ isError: false, data: { kind } });
    }
    for (const action of ["deliver", "revert_delivery"]) {
      await expect(mcp.call("vela_dispatch_step", { planId: f.planId, action })).rejects.toThrow(
        /Invalid parameters/,
      );
    }
  }, 20000);
});
