import type { VelaCollabProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collabPlanLabel,
  decodeCollabDiffPages,
  formatByteSize,
  parseNumberedUnifiedDiff,
  partitionCollabSteps,
  summarizeCollabBanner,
} from "./collabModel";

function makeProjection(overrides: Partial<VelaCollabProjection> = {}): VelaCollabProjection {
  return {
    engineVersion: 2,
    planId: "plan-1",
    planVersion: 1,
    revision: 3,
    title: "Mobile collab test",
    status: "running",
    stepCount: 3,
    blocked: false,
    config: { enableBatchAudit: false },
    steps: [
      {
        stepId: "s1",
        title: "Core API",
        kind: "change",
        status: "integrated",
        phase: "initial",
        attempt: 1,
      },
      {
        stepId: "s2",
        title: "Review step",
        kind: "change",
        status: "queued_for_review",
        phase: "initial",
        attempt: 1,
        queuePosition: 2,
      },
      {
        stepId: "s3",
        title: "Decision step",
        kind: "decision",
        status: "needs_attention",
        phase: "initial",
        attempt: 1,
        attentionReason: "decision",
      },
    ],
    ...overrides,
  };
}

describe("mobile collabModel", () => {
  it("summarizes banner counts and attention state", () => {
    const summary = summarizeCollabBanner(makeProjection());
    expect(summary.completedCount).toBe(1);
    expect(summary.totalCount).toBe(3);
    expect(summary.attentionCount).toBe(1);
    expect(summary.compactLine).toBe("进行中 · 1/3 · 1 项待处理");
  });

  it("highlights ready_to_deliver and reverted states", () => {
    const ready = summarizeCollabBanner(
      makeProjection({
        status: "ready_to_deliver",
        deliveryId: "del-1",
        delivery: {
          deliveryId: "del-1",
          expectedTargetState: "abc",
          deliveryOid: "def",
        },
        steps: [
          {
            stepId: "s1",
            title: "Done",
            kind: "change",
            status: "integrated",
            phase: "initial",
            attempt: 1,
          },
        ],
      }),
    );
    expect(ready.readyToDeliver).toBe(true);
    expect(ready.compactLine).toBe("待确认应用 · 1/1 · 可应用交付");

    const reverted = collabPlanLabel(
      makeProjection({
        status: "delivered",
        appliedDelivery: {
          deliveryId: "del-1",
          operationId: "op-1",
          appliedAt: "2026-11-26T00:00:00.000Z",
          revertedAt: "2026-11-26T00:05:00.000Z",
        },
      }),
    );
    expect(reverted).toBe("已撤回");
  });

  it("partitions steps and orders reviewing ahead of queued steps", () => {
    const plan = makeProjection({
      steps: [
        {
          stepId: "s-q",
          title: "Queued",
          kind: "change",
          status: "queued_for_review",
          phase: "initial",
          attempt: 1,
          queuePosition: 1,
        },
        {
          stepId: "s-r",
          title: "Reviewing",
          kind: "change",
          status: "reviewing",
          phase: "initial",
          attempt: 1,
          queuePosition: 2,
        },
        {
          stepId: "s-d",
          title: "Dev",
          kind: "change",
          status: "developing",
          phase: "repair",
          attempt: 2,
        },
      ],
    });
    const groups = partitionCollabSteps(plan);
    expect(groups.reviewQueue.map((s) => s.stepId)).toEqual(["s-r", "s-q"]);
    expect(groups.developing.map((s) => s.stepId)).toEqual(["s-d"]);
  });

  it("parses numbered unified diffs and decodes base64 chunk boundaries", () => {
    const lines = parseNumberedUnifiedDiff(
      "diff --git a/a.ts b/a.ts\n@@ -10,2 +10,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n",
    );
    expect(lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ["meta", null, null],
      ["hunk", null, null],
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
    ]);

    // Split a 3-byte UTF-8 character across two base64 pages ("中" = E4 B8 AD)
    const decoded = decodeCollabDiffPages([
      { kind: "patch", encoding: "base64", dataBase64: "5Lg=", nextOffset: 2 },
      { kind: "patch", encoding: "base64", dataBase64: "rQ==", nextOffset: null },
    ]);
    expect(decoded).toBe("中");
    expect(formatByteSize(1536)).toBe("1.5 KB");
  });
});
