/* oxlint-disable t3code/no-untranslated-copy -- Vela mobile collaboration UI keeps inline Chinese copy aligned with desktop */
import type {
  CollabAttentionReason,
  CollabPlanStatus,
  CollabStepPhase,
  CollabStepStatus,
  VelaCollabProjection,
} from "@t3tools/contracts";

export type CollabStep = VelaCollabProjection["steps"][number];

export const COLLAB_STEP_LABEL: Record<CollabStepStatus, string> = {
  locked: "等待前置",
  ready: "待启动",
  developing: "开发中",
  verifying_gates: "门禁验证中",
  queued_for_review: "排队待审",
  reviewing: "主控审查中",
  integrating: "集成中",
  integrated: "已集成",
  done: "已完成",
  needs_attention: "待处理",
  cancelled: "已取消",
};

export const COLLAB_PHASE_LABEL: Record<CollabStepPhase, string> = {
  initial: "初版",
  repair: "返修",
  conflict: "解冲突",
};

export const COLLAB_ATTENTION_LABEL: Record<CollabAttentionReason | "ready_to_deliver", string> = {
  decision: "待你拍板",
  escalation: "升级待裁决",
  gate_failed: "门禁失败",
  repair_limit: "达返修上限",
  conflict_limit: "达冲突上限",
  review_incomplete: "审查未完成",
  evidence_error: "快照异常",
  manual_check_required: "待人工核验",
  ready_to_deliver: "可应用交付",
};

const COLLAB_PLAN_LABEL: Record<CollabPlanStatus, string> = {
  draft: "待启动",
  running: "进行中",
  batch_verifying: "整批验证中",
  ready_to_deliver: "待确认应用",
  delivered: "已应用",
  cancelled: "已取消",
  failed: "计划失败",
};

export function collabPlanLabel(collab: VelaCollabProjection): string {
  if (collab.appliedDelivery?.revertedAt) return "已撤回";
  if (
    collab.status === "running" &&
    (collab.blocked || collab.canRetryBatch || (collab.batchAudit?.blockingFindings ?? 0) > 0)
  ) {
    return "阻塞待处理";
  }
  return COLLAB_PLAN_LABEL[collab.status];
}

export function isActiveCollabPlan(status: CollabPlanStatus): boolean {
  return (
    status === "draft" ||
    status === "running" ||
    status === "batch_verifying" ||
    status === "ready_to_deliver"
  );
}

export function compareCollabReviewQueue(a: CollabStep, b: CollabStep): number {
  if ((a.status === "reviewing") !== (b.status === "reviewing")) {
    return a.status === "reviewing" ? -1 : 1;
  }
  return (
    (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER)
  );
}

export function partitionCollabSteps(collab: VelaCollabProjection) {
  const attention: CollabStep[] = [];
  const reviewQueue: CollabStep[] = [];
  const developing: CollabStep[] = [];
  const completed: CollabStep[] = [];
  for (const step of collab.steps) {
    switch (step.status) {
      case "needs_attention":
        attention.push(step);
        break;
      case "queued_for_review":
      case "reviewing":
        reviewQueue.push(step);
        break;
      case "locked":
      case "ready":
      case "developing":
      case "verifying_gates":
      case "integrating":
        developing.push(step);
        break;
      case "integrated":
      case "done":
      case "cancelled":
        completed.push(step);
        break;
    }
  }
  reviewQueue.sort(compareCollabReviewQueue);
  return { attention, reviewQueue, developing, completed };
}

export interface CollabBannerSummary {
  readonly statusLabel: string;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly attentionCount: number;
  readonly readyToDeliver: boolean;
  readonly compactLine: string;
}

export function summarizeCollabBanner(collab: VelaCollabProjection): CollabBannerSummary {
  const statusLabel = collabPlanLabel(collab);
  const completedCount = collab.steps.filter(
    (step) => step.status === "integrated" || step.status === "done",
  ).length;
  const totalCount = collab.steps.length;
  const attentionCount = collab.steps.filter((step) => step.status === "needs_attention").length;
  const readyToDeliver = collab.status === "ready_to_deliver" && Boolean(collab.delivery);

  const parts = [statusLabel, `${completedCount}/${totalCount}`];
  if (readyToDeliver) {
    parts.push("可应用交付");
  } else if (attentionCount > 0) {
    parts.push(`${attentionCount} 项待处理`);
  } else if (collab.blocked || collab.canRetryBatch) {
    parts.push("待人工介入");
  }
  return {
    statusLabel,
    completedCount,
    totalCount,
    attentionCount,
    readyToDeliver,
    compactLine: parts.join(" · "),
  };
}

export type UnifiedDiffLineKind = "hunk" | "add" | "del" | "meta" | "context";

export interface NumberedDiffLine {
  readonly kind: UnifiedDiffLineKind;
  readonly text: string;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
}

export function parseNumberedUnifiedDiff(patch: string): ReadonlyArray<NumberedDiffLine> {
  if (!patch) return [];
  const trimmed = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  let oldLine = 0;
  let newLine = 0;
  return trimmed.split(/\r?\n/).map((line) => {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      return { kind: "hunk", text: line, oldNumber: null, newNumber: null };
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\ No newline")
    ) {
      return { kind: "meta", text: line, oldNumber: null, newNumber: null };
    }
    if (line.startsWith("+")) {
      const newNumber = newLine > 0 ? newLine++ : null;
      return { kind: "add", text: line, oldNumber: null, newNumber };
    }
    if (line.startsWith("-")) {
      const oldNumber = oldLine > 0 ? oldLine++ : null;
      return { kind: "del", text: line, oldNumber, newNumber: null };
    }
    const oldNumber = oldLine > 0 ? oldLine++ : null;
    const newNumber = newLine > 0 ? newLine++ : null;
    return { kind: "context", text: line, oldNumber, newNumber };
  });
}

function decodeBase64Bytes(base64: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const output: number[] = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const a = alphabet.indexOf(cleaned[i] ?? "");
    const b = alphabet.indexOf(cleaned[i + 1] ?? "");
    const c = cleaned[i + 2] === "=" ? -1 : alphabet.indexOf(cleaned[i + 2] ?? "");
    const d = cleaned[i + 3] === "=" ? -1 : alphabet.indexOf(cleaned[i + 3] ?? "");
    if (a < 0 || b < 0) break;
    output.push((a << 2) | (b >> 4));
    if (c >= 0) output.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) output.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(output);
}

export type CollabDiffPage =
  | {
      readonly kind: "patch";
      readonly encoding: "utf8";
      readonly text: string;
      readonly nextOffset: number | null;
    }
  | {
      readonly kind: "patch";
      readonly encoding: "base64";
      readonly dataBase64: string;
      readonly nextOffset: number | null;
    }
  | { readonly kind: "binary" };

export function decodeCollabDiffPages(pages: ReadonlyArray<CollabDiffPage>): string {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const encoder = new TextEncoder();
  return pages
    .map((page) => {
      if (page.kind !== "patch") return "";
      const bytes =
        page.encoding === "utf8" ? encoder.encode(page.text) : decodeBase64Bytes(page.dataBase64);
      return decoder.decode(bytes, { stream: page.nextOffset !== null });
    })
    .join("");
}

export function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
