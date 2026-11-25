import { describe, expect, it } from "vite-plus/test";

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
  formatAgentTarget,
  formatDecisionOptionsText,
  formatElapsedDuration,
  isStepAwaitingDecision,
  normalizeDispatchTargetOptions,
  parseDecisionOptionsText,
  progressSegmentTone,
  resolveAgentEffortLabel,
  resolveAgentTargetDisplay,
  resolveGatePipelinePercent,
  resolveGateStages,
  resolveStepKind,
  stripMarkdownPreview,
} from "./dispatchModel";

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
      ["done", "bg-foreground/80", false],
      ["needs_human_decision", "bg-warning", false],
      ["awaiting_decision", "bg-warning", false],
      ["ready_to_accept", "bg-foreground/50", false],
      ["running", "bg-foreground/30", true],
      ["reviewing", "bg-foreground/30", true],
      ["fixing_review", "bg-foreground/30", true],
      ["fixing_acceptance", "bg-foreground/30", true],
      ["awaiting_product_acceptance", "bg-foreground/30", true],
      ["waiting_orchestrator", "bg-foreground/30", true],
      ["premise_failed", "bg-destructive/70", false],
      ["boundary_violation", "bg-destructive/70", false],
      ["hard_gate_failed", "bg-destructive/70", false],
      ["locked", "bg-muted", false],
      ["ready", "bg-muted", false],
      ["cancelled", "bg-muted", false],
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
