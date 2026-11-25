import { describe, expect, it } from "vite-plus/test";

import { lintDispatchPlan } from "./VelaDispatchPlanLint.ts";
import type { DispatchTaskCard } from "./VelaDispatchTypes.ts";

function makeStep(overrides: Partial<DispatchTaskCard> & { readonly id: string }): DispatchTaskCard {
  return {
    order: 1,
    title: overrides.id,
    goal: `Goal for ${overrides.id}`,
    isolation: "direct",
    premisesToVerify: [],
    contextFiles: [],
    acceptanceCriteria: ["Verify output"],
    allowedGlobs: ["apps/server/src/dispatch/**"],
    forbiddenGlobs: [],
    sensitiveGlobs: [],
    hardGates: ["vp run --filter t3 typecheck"],
    executor: { providerInstanceId: "codex" },
    status: "locked",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("lintDispatchPlan", () => {
  it("passes a valid mixed DAG plan without errors or warnings", () => {
    const result = lintDispatchPlan([
      makeStep({
        id: "S1",
        order: 1,
        kind: "research",
        dependsOn: [],
        acceptanceCriteria: [],
        allowedGlobs: [],
        hardGates: [],
      }),
      makeStep({
        id: "S2",
        order: 2,
        kind: "decision",
        dependsOn: ["S1"],
        acceptanceCriteria: [],
        allowedGlobs: [],
        hardGates: [],
        decisionOptions: [
          { id: "A", label: "Option A" },
          { id: "B", label: "Option B" },
        ],
      }),
      makeStep({
        id: "S3",
        order: 3,
        kind: "change",
        dependsOn: ["S2"],
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warningsByStep).toEqual({});
  });

  it("reports duplicate IDs, missing dependsOn targets, self-dependency, and cycles", () => {
    const result = lintDispatchPlan([
      makeStep({ id: "S1", order: 1, dependsOn: ["S1", "S99"] }),
      makeStep({ id: "S1", order: 2, dependsOn: [] }),
      makeStep({ id: "S2", order: 3, dependsOn: ["S3"] }),
      makeStep({ id: "S3", order: 4, dependsOn: ["S2"] }),
    ]);

    expect(result.errors.some((e) => e.includes("重复") && e.includes("S1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("依赖自身") && e.includes("S1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不存在") && e.includes("S99"))).toBe(true);
    expect(result.errors.some((e) => e.includes("循环依赖") && e.includes("S2") && e.includes("S3"))).toBe(
      true,
    );
  });

  it("requires acceptanceCriteria on change cards and >=2 options when decisionOptions is provided", () => {
    const result = lintDispatchPlan([
      makeStep({
        id: "S1",
        order: 1,
        kind: "change",
        acceptanceCriteria: [],
      }),
      makeStep({
        id: "S2",
        order: 2,
        kind: "decision",
        decisionOptions: [{ id: "A", label: "Only one" }],
      }),
      makeStep({
        id: "S3",
        order: 3,
        kind: "decision",
      }),
    ]);

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("S1");
    expect(result.errors[1]).toContain("S2");
  });

  it("emits warnings for missing allowedGlobs/hardGates and overlapping concurrent change cards only", () => {
    const result = lintDispatchPlan([
      makeStep({
        id: "S1",
        order: 1,
        dependsOn: [],
        allowedGlobs: ["apps/server/src/dispatch/*.ts"],
        hardGates: [],
      }),
      makeStep({
        id: "S2",
        order: 2,
        dependsOn: [],
        allowedGlobs: ["apps/server/src/**"],
      }),
      makeStep({
        id: "S3",
        order: 3,
        dependsOn: ["S1"],
        allowedGlobs: ["apps/server/src/dispatch/VelaDispatchTypes.ts"],
      }),
      makeStep({
        id: "S4",
        order: 4,
        dependsOn: ["S2"],
        allowedGlobs: [],
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warningsByStep.S1).toContain("未配置 hardGates，改完后不会自动运行校验命令");
    expect(result.warningsByStep.S1).toContain("与 S2 可能改同一批文件");
    expect(result.warningsByStep.S2).toContain("与 S1 可能改同一批文件");
    // S3 transitively depends on S1, so no overlap warning between S1 and S3; S3 is concurrent with S2 though.
    expect(result.warningsByStep.S1).not.toContain("与 S3 可能改同一批文件");
    expect(result.warningsByStep.S3).toContain("与 S2 可能改同一批文件");
    expect(result.warningsByStep.S4).toContain("未限定改动范围，越界检查不会生效");
  });
});
