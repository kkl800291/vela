import { describe, expect, it } from "vite-plus/test";

import {
  buildResearchReviewPrompt,
  buildTaskExecutionPrompt,
  parseDecisionOptions,
} from "./VelaDispatchPrompts.ts";
import type { DispatchTaskCard } from "./VelaDispatchTypes.ts";

function makeCard(overrides?: Partial<DispatchTaskCard>): DispatchTaskCard {
  return {
    id: "S1",
    order: 1,
    title: "Investigate auth flow",
    goal: "Trace token refresh and report edge cases",
    kind: "research",
    isolation: "direct",
    premisesToVerify: [],
    contextFiles: [],
    acceptanceCriteria: [],
    allowedGlobs: [],
    forbiddenGlobs: [],
    sensitiveGlobs: [],
    hardGates: [],
    executor: { providerInstanceId: "codex" },
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("VelaDispatchPrompts", () => {
  it("renders read-only research ending and upstream deliverables section", () => {
    const prompt = buildTaskExecutionPrompt({
      task: makeCard({ id: "S2", title: "Implement refresh", kind: "research" }),
      upstream: [
        {
          stepId: "S1",
          title: "Token audit",
          kind: "research",
          text: "Found token expiry race in src/auth.ts:42",
        },
        {
          stepId: "S1b",
          title: "Retry policy choice",
          kind: "decision",
          text: "选择：指数退避",
        },
      ],
    });

    expect(prompt).toContain("## 前置步骤产出（请基于这些结论执行）");
    expect(prompt).toContain("### S1 Token audit（调研）");
    expect(prompt).toContain("Found token expiry race in src/auth.ts:42");
    expect(prompt).toContain("### S1b Retry policy choice（决策）");
    expect(prompt).toContain(
      "本步为只读调研/排查，严禁修改任何文件；最终输出结论报告：结论、证据（文件:行号/命令输出）、未决问题",
    );
  });

  it("renders decision ending and parses DECISION_OPTIONS JSON", () => {
    const prompt = buildTaskExecutionPrompt({
      task: makeCard({ id: "S2", title: "Choose storage", kind: "decision" }),
    });
    expect(prompt).toContain("只读分析后给出 2~4 个选项");
    expect(prompt).toContain('"status":"DECISION_OPTIONS"');

    const parsed = parseDecisionOptions(
      [
        "调研完成，建议选 A。",
        "```json",
        '{"status":"DECISION_OPTIONS","question":"选用哪种存储？","analysis":"SQLite 更轻量","recommendation":"A","options":[{"id":"A","label":"SQLite","description":"本地零依赖"},{"id":"B","label":"Postgres","description":"适合多节点"}]}',
        "```",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      question: "选用哪种存储？",
      analysis: "SQLite 更轻量",
      recommendation: "A",
      options: [
        { id: "A", label: "SQLite", description: "本地零依赖" },
        { id: "B", label: "Postgres", description: "适合多节点" },
      ],
    });

    expect(
      parseDecisionOptions('```json\n{"status":"DECISION_OPTIONS","options":[{"id":"A","label":"Only one"}]}\n```'),
    ).toBeNull();
  });

  it("builds research review prompt with requirementSummary", () => {
    const review = buildResearchReviewPrompt({
      task: makeCard(),
      report: "结论：发现竞态。证据：src/auth.ts:42。",
      requirementSummary: "只调查 refresh token，不改登录页。",
      round: 1,
    });
    expect(review).toContain("需求范围摘要");
    expect(review).toContain("只调查 refresh token，不改登录页。");
    expect(review).toContain("结论是否回答了目标、证据是否充分可信");
    expect(review).toContain("结论：发现竞态。证据：src/auth.ts:42。");
  });
});
