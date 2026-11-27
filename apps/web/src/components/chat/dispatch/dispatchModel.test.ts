import { describe, expect, it } from "vite-plus/test";
import type { VelaCollabProjection } from "@t3tools/contracts";

import type {
  DispatchProviderSummary,
  DispatchStepStatus,
  DispatchTaskCard,
} from "~/state/velaDispatch";
import {
  applyFallbackEffortChange,
  applyTargetOptionChange,
  buildTargetForModelSelection,
  computeBatches,
  computeBlockedDownstreamSteps,
  computeTopCompletedRunCount,
  COLLAB_ATTENTION_LABEL,
  COLLAB_STEP_LABEL,
  collabAttentionLabel,
  collabPlanLabel,
  findCollabStepDependents,
  formatAgentTarget,
  formatCollabDependsOn,
  formatDecisionOptionsText,
  formatElapsedDuration,
  isStepAwaitingDecision,
  normalizeDispatchTargetOptions,
  parseDecisionOptionsText,
  parseUnifiedDiffLines,
  partitionCollabSteps,
  progressSegmentTone,
  resolveAgentEffortLabel,
  resolveAgentTargetDisplay,
  resolveGatePipelinePercent,
  resolveGateStages,
  resolveStepKind,
  stripMarkdownPreview,
  summarizeStepVerification,
} from "./dispatchModel";

describe("collaboration projection", () => {
  it("keeps attention separate and sorts reviews by the active inbox and FIFO position", () => {
    const plan = {
      engineVersion: 2,
      planId: "plan",
      planVersion: 1,
      revision: 1,
      title: "Collaboration",
      status: "running",
      stepCount: 11,
      blocked: false,
      config: { enableBatchAudit: false },
      steps: (
        [
          { stepId: "third", status: "queued_for_review", queuePosition: 3 },
          { stepId: "develop", status: "developing" },
          { stepId: "second", status: "queued_for_review", queuePosition: 2 },
          { stepId: "gate", status: "verifying_gates" },
          { stepId: "active", status: "queued_for_review", queuePosition: 4 },
          { stepId: "first", status: "queued_for_review", queuePosition: 1 },
          { stepId: "decide", status: "needs_attention" },
          { stepId: "integrate", status: "integrating" },
          { stepId: "integrated", status: "integrated" },
          { stepId: "done", status: "done" },
          { stepId: "locked", status: "locked" },
        ] as const
      ).map((step): VelaCollabProjection["steps"][number] => ({
        ...step,
        title: step.stepId,
        kind: "change",
        phase: "initial",
        attempt: 1,
      })),
      activeInbox: { inboxItemId: "inbox", kind: "review", stepId: "active", status: "dispatched" },
    } satisfies VelaCollabProjection;
    const sections = partitionCollabSteps(plan);
    expect(sections.developing.map(({ stepId }) => stepId)).toEqual(["develop", "gate", "locked"]);
    expect(sections.reviewQueue.map(({ stepId }) => stepId)).toEqual([
      "active",
      "first",
      "second",
      "third",
    ]);
    expect(sections.attention.map(({ stepId }) => stepId)).toEqual(["decide"]);
    expect(sections.integrationAndDelivery.map(({ stepId }) => stepId)).toEqual([
      "integrate",
      "integrated",
      "done",
    ]);
    expect(collabPlanLabel(plan)).toBe("执行中");
    expect(collabPlanLabel({ ...plan, status: "ready_to_deliver" })).toBe("待应用");
    expect(collabPlanLabel({ ...plan, blocked: true })).toBe("有待处理项");
    expect(collabPlanLabel({ ...plan, canRetryBatch: true })).toBe("有待处理项");
    expect(Object.values(COLLAB_STEP_LABEL)).toHaveLength(11);
    expect(COLLAB_STEP_LABEL.reviewing).toBe("审查中");
  });

  it("labels delivery and step attention while keeping legacy entries on the legacy path", () => {
    expect(collabAttentionLabel({ engineVersion: 2, attentionReason: "ready_to_deliver" })).toBe(
      "已完成，待应用",
    );
    expect(collabAttentionLabel({ engineVersion: 2, attentionReason: "review_incomplete" })).toBe(
      "审查未完成",
    );
    expect(
      collabAttentionLabel({ engineVersion: 2, attentionReason: "manual_check_required" }),
    ).toBe("待人工确认");
    expect(Object.values(COLLAB_ATTENTION_LABEL)).toHaveLength(9);
    expect(collabAttentionLabel({})).toBeUndefined();
  });

  it("folds only top contiguous completed steps when total > 6 and formats dependencies", () => {
    const mk = (id: string, status: VelaCollabProjection["steps"][number]["status"], dependsOn?: string[]) => ({
      stepId: id,
      title: `Step ${id}`,
      kind: "change" as const,
      status,
      phase: "initial" as const,
      attempt: 1,
      ...(dependsOn ? { dependsOn } : {}),
    });
    const sixSteps = [
      mk("s1", "integrated"),
      mk("s2", "done"),
      mk("s3", "developing"),
      mk("s4", "locked"),
      mk("s5", "locked"),
      mk("s6", "locked"),
    ];
    expect(computeTopCompletedRunCount(sixSteps)).toBe(0);

    const sevenSteps = [
      mk("s1", "integrated"),
      mk("s2", "done"),
      mk("s3", "developing", ["s1"]),
      mk("s4", "integrated"),
      mk("s5", "locked", ["s1", "s3"]),
      mk("s6", "locked", ["s1", "s2", "s3"]),
      mk("s7", "locked"),
    ];
    expect(computeTopCompletedRunCount(sevenSteps)).toBe(2);

    const plan: VelaCollabProjection = {
      engineVersion: 2,
      planId: "p1",
      planVersion: 1,
      revision: 1,
      title: "Test",
      status: "draft",
      stepCount: sevenSteps.length,
      blocked: false,
      config: { enableBatchAudit: false },
      steps: sevenSteps,
    };
    expect(formatCollabDependsOn(plan, ["s1"], "draft")).toBe("依赖第 1 步");
    expect(formatCollabDependsOn(plan, ["s1", "s3"], "locked")).toBe("等待第 1、3 步");
    expect(formatCollabDependsOn(plan, ["s1", "s2", "s3"], "draft")).toBe("依赖第 1 步等 3 项");
    expect(findCollabStepDependents(plan, "s1").map((d) => d.number)).toEqual([3, 5, 6]);
    expect(findCollabStepDependents(plan, "s7")).toEqual([]);
  });
});

function makeCard(
  id: string,
  order: number,
  overrides: Partial<DispatchTaskCard> = {},
): DispatchTaskCard {
  return {
    id,
    order,
    title: `Step ${id}`,
    goal: `Goal for ${id}`,
    isolation: "direct",
    premisesToVerify: [],
    contextFiles: [],
    acceptanceCriteria: ["Passes check"],
    allowedGlobs: [],
    forbiddenGlobs: [],
    sensitiveGlobs: [],
    hardGates: [],
    executor: { providerInstanceId: "codex" },
    status: "ready",
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
    ...overrides,
  };
}

describe("computeBatches", () => {
  it("returns empty array when no steps exist", () => {
    expect(computeBatches([])).toEqual([]);
  });

  it("places one card per batch ordered by order when DAG is unused", () => {
    const s2 = makeCard("S2", 2);
    const s1 = makeCard("S1", 1);
    const s3 = makeCard("S3", 3);

    const batches = computeBatches([s2, s1, s3]);
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => [b.batchNumber, b.steps.map((s) => s.id)])).toEqual([
      [1, ["S1"]],
      [2, ["S2"]],
      [3, ["S3"]],
    ]);
  });

  it("groups steps by DAG dependency depth", () => {
    const s1 = makeCard("S1", 1, { dependsOn: [] });
    const s2 = makeCard("S2", 2, { dependsOn: [] });
    const s3 = makeCard("S3", 3, { dependsOn: ["S1"] });
    const s4 = makeCard("S4", 4, { dependsOn: ["S1", "S2"] });
    const s5 = makeCard("S5", 5, { dependsOn: ["S3", "S4"] });

    const batches = computeBatches([s5, s3, s1, s4, s2]);
    expect(batches.map((b) => [b.batchNumber, b.steps.map((s) => s.id)])).toEqual([
      [1, ["S1", "S2"]],
      [2, ["S3", "S4"]],
      [3, ["S5"]],
    ]);
  });

  it("handles mixed undefined and defined dependsOn safely without crashing on cycles", () => {
    const s1 = makeCard("S1", 1, { dependsOn: ["S2"] });
    const s2 = makeCard("S2", 2, { dependsOn: ["S1"] });
    const s3 = makeCard("S3", 3);

    const batches = computeBatches([s1, s2, s3]);
    expect(batches.flatMap((b) => b.steps.map((s) => s.id)).toSorted()).toEqual(["S1", "S2", "S3"]);
  });
});

describe("resolveGateStages", () => {
  it("marks review skipped when reviewer is null", () => {
    const card = makeCard("S1", 1, { status: "ready_to_accept", reviewer: null });
    const stages = resolveGateStages(card);

    expect(stages.map((s) => [s.key, s.status])).toEqual([
      ["execute", "passed"],
      ["scope_and_gate", "passed"],
      ["review", "skipped"],
      ["acceptance", "passed"],
    ]);
    expect(resolveGatePipelinePercent(stages)).toBe(100);
  });

  it("marks acceptance skipped when executor is self or skipProductAcceptance is true", () => {
    const selfCard = makeCard("S1", 1, { status: "reviewing", executor: "self" });
    expect(resolveGateStages(selfCard).map((s) => [s.key, s.status])).toEqual([
      ["execute", "passed"],
      ["scope_and_gate", "passed"],
      ["review", "active"],
      ["acceptance", "skipped"],
    ]);

    const skippedCard = makeCard("S2", 2, {
      status: "running",
      skipProductAcceptance: true,
    });
    expect(resolveGateStages(skippedCard).map((s) => [s.key, s.status])).toEqual([
      ["execute", "active"],
      ["scope_and_gate", "pending"],
      ["review", "pending"],
      ["acceptance", "skipped"],
    ]);
  });

  it("maps failure statuses to the corresponding gate stage", () => {
    const boundaryFail = makeCard("S1", 1, { status: "boundary_violation" });
    expect(resolveGateStages(boundaryFail).map((s) => s.status)).toEqual([
      "passed",
      "failed",
      "pending",
      "pending",
    ]);

    const reviewLimit = makeCard("S2", 2, { status: "needs_human_decision" });
    const stages = resolveGateStages(reviewLimit, {
      boundaryAudit: null,
      hardGate: null,
      reviews: [
        {
          round: 2,
          verdict: "fail",
          summary: "Still failing",
          issues: [],
          reviewedAt: "2026-11-25T00:00:00Z",
        },
      ],
      acceptanceReports: [],
    });
    expect(stages.map((s) => s.status)).toEqual(["passed", "passed", "failed", "pending"]);
  });

  it("maps research steps across 3 stages and respects reviewer === null", () => {
    expect(
      resolveGateStages(makeCard("R1", 1, { kind: "research", status: "running" })).map((s) => [
        s.key,
        s.label,
        s.status,
      ]),
    ).toEqual([
      ["execute", "只读调研", "active"],
      ["review", "独立复查", "pending"],
      ["acceptance", "确认结论", "pending"],
    ]);

    expect(
      resolveGateStages(
        makeCard("R2", 2, { kind: "research", status: "ready_to_accept", reviewer: null }),
      ).map((s) => [s.key, s.status]),
    ).toEqual([
      ["execute", "passed"],
      ["review", "skipped"],
      ["acceptance", "active"],
    ]);

    expect(
      resolveGateStages(makeCard("R3", 3, { kind: "research", status: "fixing_review" })).map(
        (s) => s.status,
      ),
    ).toEqual(["passed", "active", "pending"]);

    expect(
      resolveGateStages(makeCard("R4", 4, { kind: "research", status: "done" })).map(
        (s) => s.status,
      ),
    ).toEqual(["passed", "passed", "passed"]);

    expect(
      resolveGateStages(makeCard("R5", 5, { kind: "research", status: "premise_failed" })).map(
        (s) => s.status,
      ),
    ).toEqual(["failed", "pending", "pending"]);

    expect(
      resolveGateStages(makeCard("R6", 6, { kind: "research", status: "ready" })).map(
        (s) => s.status,
      ),
    ).toEqual(["pending", "pending", "pending"]);
  });

  it("maps decision steps across 2 stages", () => {
    expect(
      resolveGateStages(makeCard("D1", 1, { kind: "decision", status: "running" })).map((s) => [
        s.key,
        s.label,
        s.status,
      ]),
    ).toEqual([
      ["execute", "整理选项", "active"],
      ["acceptance", "等你拍板", "pending"],
    ]);

    expect(
      resolveGateStages(
        makeCard("D2", 2, {
          kind: "decision",
          status: "ready",
          decisionOptions: [{ id: "A", label: "方案 A" }],
        }),
      ).map((s) => s.status),
    ).toEqual(["passed", "active"]);

    expect(
      resolveGateStages(
        makeCard("D3", 3, { kind: "decision", status: "awaiting_decision" }),
      ).map((s) => s.status),
    ).toEqual(["passed", "active"]);

    expect(
      resolveGateStages(makeCard("D4", 4, { kind: "decision", status: "done" })).map(
        (s) => s.status,
      ),
    ).toEqual(["passed", "passed"]);

    expect(
      resolveGateStages(
        makeCard("D5", 5, { kind: "decision", status: "needs_human_decision" }),
      ).map((s) => s.status),
    ).toEqual(["failed", "pending"]);

    expect(
      resolveGateStages(makeCard("D6", 6, { kind: "decision", status: "ready" })).map(
        (s) => s.status,
      ),
    ).toEqual(["pending", "pending"]);
  });
});

describe("progressSegmentTone", () => {
  it("assigns expected tones and sweep flags for all dispatch statuses", () => {
    const expectations: Array<[DispatchStepStatus, string, boolean]> = [
      ["done", "bg-foreground/85", false],
      ["needs_human_decision", "bg-warning", false],
      ["awaiting_decision", "bg-warning", false],
      ["ready_to_accept", "bg-success", false],
      ["running", "bg-foreground/35", true],
      ["reviewing", "bg-foreground/35", true],
      ["fixing_review", "bg-foreground/35", true],
      ["fixing_acceptance", "bg-foreground/35", true],
      ["awaiting_product_acceptance", "bg-foreground/35", true],
      ["waiting_orchestrator", "bg-foreground/35", true],
      ["premise_failed", "bg-destructive/80", false],
      ["boundary_violation", "bg-destructive/80", false],
      ["hard_gate_failed", "bg-destructive/80", false],
      ["ready", "bg-info/60", false],
      ["locked", "bg-muted", false],
      ["cancelled", "bg-muted-foreground/30", false],
    ];

    for (const [status, expectedClass, expectedSweep] of expectations) {
      const result = progressSegmentTone(status);
      expect(result.className).toBe(expectedClass);
      expect(result.sweep).toBe(expectedSweep);
    }
  });
});

describe("step kind & decision option helpers", () => {
  it("defaults undefined kind to change and detects awaiting decision steps", () => {
    expect(resolveStepKind(makeCard("S1", 1))).toBe("change");
    expect(resolveStepKind(makeCard("S2", 2, { kind: "research" }))).toBe("research");

    expect(
      isStepAwaitingDecision(makeCard("S3", 3, { kind: "decision", status: "awaiting_decision" })),
    ).toBe(true);
    expect(
      isStepAwaitingDecision(
        makeCard("S4", 4, {
          kind: "decision",
          status: "ready",
          decisionOptions: [{ id: "A", label: "Option A" }],
        }),
      ),
    ).toBe(true);
    expect(
      isStepAwaitingDecision(makeCard("S5", 5, { kind: "decision", status: "ready" })),
    ).toBe(false);
  });

  it("roundtrips decision option text lines", () => {
    const parsed = parseDecisionOptionsText("A: 方案一 - 更快上线\nB: 方案二");
    expect(parsed).toEqual([
      { id: "A", label: "方案一", description: "更快上线" },
      { id: "B", label: "方案二" },
    ]);
    expect(formatDecisionOptionsText(parsed)).toBe("A: 方案一 - 更快上线\nB: 方案二");
  });
});

describe("formatElapsedDuration", () => {
  it("returns empty string for missing or invalid timestamps", () => {
    expect(formatElapsedDuration(undefined, 1_000_000)).toBe("");
    expect(formatElapsedDuration("not-a-date", 1_000_000)).toBe("");
  });

  it("formats elapsed seconds as zero-padded MM:SS or HH:MM:SS", () => {
    const start = "2026-11-25T08:00:00.000Z";
    const startMs = Date.parse(start);
    expect(formatElapsedDuration(start, startMs - 5_000)).toBe("00:00");
    expect(formatElapsedDuration(start, startMs + 24_000)).toBe("00:24");
    expect(formatElapsedDuration(start, startMs + 125_000)).toBe("02:05");
    expect(formatElapsedDuration(start, startMs + 3_665_000)).toBe("01:01:05");
  });
});

describe("stripMarkdownPreview", () => {
  it("strips headings, emphasis, backticks, links, and compresses whitespace", () => {
    const raw =
      "## 调研结论\n\n查看了 [velaDispatch.ts](file:///foo/bar.ts) 中的 **SSE 连接**、`useSyncExternalStore` 与 __foo_bar__。";
    expect(stripMarkdownPreview(raw)).toBe(
      "调研结论 查看了 velaDispatch.ts 中的 SSE 连接、useSyncExternalStore 与 foo_bar。",
    );
  });

  it("truncates long text with ellipsis", () => {
    const longText = "# 标题\n\n" + "a".repeat(200);
    const result = stripMarkdownPreview(longText, 20);
    expect(result).toBe("标题 " + "a".repeat(17) + "...");
  });
});

describe("formatAgentTarget & effort formatting", () => {
  const providers: ReadonlyArray<DispatchProviderSummary> = [
    {
      instanceId: "codex",
      provider: "codex",
      name: "Codex",
      status: "ready",
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
    },
  ];

  it("displays reasoning effort from options array, object record, or effort field", () => {
    expect(
      formatAgentTarget(
        {
          providerInstanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        providers,
      ),
    ).toBe("Codex · GPT-5.4 · xhigh");

    expect(
      formatAgentTarget(
        { providerInstanceId: "codex", model: "gpt-5.4", effort: "high" },
        providers,
      ),
    ).toBe("Codex · GPT-5.4 · high");

    expect(
      resolveAgentEffortLabel({
        providerInstanceId: "codex",
        options: { effort: "max" },
      }),
    ).toBe("max");
  });

  it("resolves descriptor-backed reasoning effort, fastMode, and option updates across harnesses", () => {
    const richProviders: ReadonlyArray<DispatchProviderSummary> = [
      {
        instanceId: "codex",
        provider: "codex",
        name: "Codex",
        status: "ready",
        models: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            optionDescriptors: [
              {
                type: "select",
                id: "reasoningEffort",
                label: "Reasoning",
                role: "reasoning",
                currentValue: "medium",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                ],
              },
              {
                type: "boolean",
                id: "fastMode",
                label: "Fast",
                currentValue: false,
              },
            ],
          },
        ],
      },
      {
        instanceId: "claude",
        provider: "claudeAgent",
        name: "Claude Code",
        status: "ready",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            optionDescriptors: [
              {
                type: "select",
                id: "effort",
                label: "Effort",
                role: "reasoning",
                currentValue: "high",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
              {
                type: "boolean",
                id: "fastMode",
                label: "Fast",
                currentValue: false,
              },
            ],
          },
        ],
      },
    ];

    const codexDescriptors = richProviders[0]!.models[0]!.optionDescriptors!;
    const initial = { providerInstanceId: "codex", model: "gpt-5.4" };

    // Falls back to descriptor default level for transparent display
    const initialDisplay = resolveAgentTargetDisplay(initial, richProviders);
    expect(initialDisplay.effortLabel).toBe("Medium");
    expect(initialDisplay.isFast).toBe(false);
    expect(initialDisplay.fullLabel).toBe("Codex · GPT-5.4 · Medium");

    // Updating reasoning effort + fastMode produces clean normalized options + effort
    const withHigh = applyTargetOptionChange(
      initial,
      codexDescriptors[0]!,
      "high",
      codexDescriptors,
    );
    const withFast = applyTargetOptionChange(
      withHigh,
      codexDescriptors[1]!,
      true,
      codexDescriptors,
    );
    expect(withFast.effort).toBe("high");
    expect(normalizeDispatchTargetOptions(withFast)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const fastDisplay = resolveAgentTargetDisplay(withFast, richProviders);
    expect(fastDisplay.effortLabel).toBe("High");
    expect(fastDisplay.isFast).toBe(true);
    expect(formatAgentTarget(withFast, richProviders)).toBe("Codex · GPT-5.4 · High");

    // Switching from Codex -> Claude remaps reasoningEffort ("high") to Claude's "effort" and keeps fastMode
    const switched = buildTargetForModelSelection(
      withFast,
      richProviders[1]!,
      "claude-opus-4-6",
    );
    expect(switched).toEqual({
      providerInstanceId: "claude",
      model: "claude-opus-4-6",
      effort: "high",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    // Fallback effort helper replaces stale reasoning option ids cleanly
    const fallback = applyFallbackEffortChange(
      {
        providerInstanceId: "custom",
        model: "m1",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ],
      },
      "xhigh",
    );
    expect(fallback).toEqual({
      providerInstanceId: "custom",
      model: "m1",
      effort: "xhigh",
      options: [{ id: "fastMode", value: true }],
    });
  });
});

describe("summarizeStepVerification", () => {
  it("reports 未运行检查命令 when hardGate results are empty", () => {
    const card = makeCard("S1", 1, {
      goal: "Fix export encoding",
      reviewer: null,
      isolation: "direct",
    });
    const summary = summarizeStepVerification(
      card,
      {
        isolation: "direct",
        diffSummary: { changedFiles: ["src/export.ts"], patch: "+utf8", truncated: false },
        hardGate: { ok: true, results: [], logText: "" },
        reviews: [],
        acceptanceReports: [],
      },
      "main",
    );

    expect(summary.checkLabel).toBe("未运行检查命令");
    expect(summary.reviewLabel).toBe("未启用独立复查");
    expect(summary.targetBranchLabel).toContain("当前分支（main）未提交列表");
    expect(summary.hasPatch).toBe(true);
    expect(summary.changedFiles).toEqual(["src/export.ts"]);
    expect(summary.summaryText).toBe("Fix export encoding");
  });

  it("summarizes passed/failed checks, review status, and worktree merge target", () => {
    const card = makeCard("S2", 2, {
      isolation: "worktree",
      reviewer: { providerInstanceId: "codex" },
    });
    const summary = summarizeStepVerification(
      card,
      {
        isolation: "worktree",
        diffSummary: { changedFiles: ["a.ts", "b.ts"], patch: "", truncated: false },
        hardGate: {
          ok: true,
          results: [
            { command: "vp test run", ok: true, exitCode: 0, durationMs: 120, output: "" },
            { command: "vp check", ok: true, exitCode: 0, durationMs: 80, output: "" },
          ],
          logText: "",
        },
        reviews: [
          {
            round: 1,
            verdict: "pass",
            summary: "Code looks clean",
            issues: [],
            reviewedAt: "2026-11-25T00:00:00Z",
          },
        ],
        acceptanceReports: [],
        deliverable: {
          kind: "change_summary",
          text: "## 完成导出\n支持 **BOM** UTF-8 导出。",
          producedAt: "2026-11-25T00:00:00Z",
        },
      },
      "feat/export",
    );

    expect(summary.checkLabel).toBe("已运行 2 项检查，全部通过");
    expect(summary.reviewLabel).toBe("独立复查通过");
    expect(summary.targetBranchLabel).toContain("合并 Worktree 改动到当前分支（feat/export）未提交列表");
    expect(summary.summaryText).toBe("完成导出 支持 BOM UTF-8 导出。");
    expect(summary.hasPatch).toBe(false);
  });
});

describe("computeBlockedDownstreamSteps", () => {
  it("finds blocked locked steps in DAG mode and linear mode", () => {
    const dag = [
      makeCard("S1", 1, { status: "ready_to_accept", dependsOn: [] }),
      makeCard("S2", 2, { status: "locked", dependsOn: ["S1"] }),
      makeCard("S3", 3, { status: "ready", dependsOn: [] }),
      makeCard("S4", 4, { status: "locked", dependsOn: ["S1", "S2"] }),
    ];
    expect(computeBlockedDownstreamSteps(dag, "S1").map((s) => s.id)).toEqual(["S2", "S4"]);

    const linear = [
      makeCard("S1", 1, { status: "done" }),
      makeCard("S2", 2, { status: "ready_to_accept" }),
      makeCard("S3", 3, { status: "locked" }),
      makeCard("S4", 4, { status: "locked" }),
    ];
    expect(computeBlockedDownstreamSteps(linear, "S2").map((s) => s.id)).toEqual(["S3", "S4"]);
  });
});

describe("parseUnifiedDiffLines", () => {
  it("classifies deleted SQL comments (--- ) and added +++ lines inside hunks as del/add, not meta", () => {
    const patch = [
      "diff --git a/migrations/001.sql b/migrations/001.sql",
      "index 1111111..2222222 100644",
      "--- a/migrations/001.sql",
      "+++ b/migrations/001.sql",
      "@@ -1,3 +1,3 @@",
      " SELECT 1;",
      "--- old comment",
      "+++ new note",
      "\\ No newline at end of file",
      'diff --git "a/docs/my notes.md" "b/docs/my notes.md"',
      "--- a/docs/my notes.md",
      "+++ b/docs/my notes.md",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");

    const lines = parseUnifiedDiffLines(patch);
    expect(lines.map((l) => [l.kind, l.text, l.filePath])).toEqual([
      ["meta", "diff --git a/migrations/001.sql b/migrations/001.sql", "migrations/001.sql"],
      ["meta", "index 1111111..2222222 100644", undefined],
      ["meta", "--- a/migrations/001.sql", undefined],
      ["meta", "+++ b/migrations/001.sql", undefined],
      ["hunk", "@@ -1,3 +1,3 @@", undefined],
      ["context", " SELECT 1;", undefined],
      ["del", "--- old comment", undefined],
      ["add", "+++ new note", undefined],
      ["meta", "\\ No newline at end of file", undefined],
      ["meta", 'diff --git "a/docs/my notes.md" "b/docs/my notes.md"', "docs/my notes.md"],
      ["meta", "--- a/docs/my notes.md", undefined],
      ["meta", "+++ b/docs/my notes.md", undefined],
      ["hunk", "@@ -1 +1 @@", undefined],
      ["del", "-before", undefined],
      ["add", "+after", undefined],
    ]);
  });

  it("handles empty patch strings", () => {
    expect(parseUnifiedDiffLines("")).toEqual([]);
  });
});
