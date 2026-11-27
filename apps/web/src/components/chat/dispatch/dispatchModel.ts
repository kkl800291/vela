/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { isReasoningControl, isReasoningSelect, selectableProviderOptionChoices } from "@t3tools/client-runtime/model-traits";
import {
  ProviderDriverKind,
  type CollabAttentionReason,
  type CollabPlanStatus,
  type CollabStepPhase,
  type CollabStepStatus,
  type ProviderOptionDescriptor,
  type VelaCollabProjection,
} from "@t3tools/contracts";
import type {
  DispatchAgentOptionSelection,
  DispatchAgentTarget,
  DispatchAttentionItem,
  DispatchEscalationOption,
  DispatchProviderSummary,
  DispatchStepKind,
  DispatchStepRun,
  DispatchStepStatus,
  DispatchTaskCard,
} from "~/state/velaDispatch";

export const COLLAB_STEP_LABEL: Record<CollabStepStatus, string> = {
  locked: "待执行",
  ready: "待执行",
  developing: "执行中",
  verifying_gates: "自动检查中",
  queued_for_review: "待审查",
  reviewing: "审查中",
  integrating: "汇总改动中",
  integrated: "已完成",
  done: "已完成",
  needs_attention: "待处理",
  cancelled: "已取消",
};

export const COLLAB_PHASE_LABEL: Record<CollabStepPhase, string> = {
  initial: "执行中",
  repair: "修改中",
  conflict: "解决冲突中",
};

export const COLLAB_ATTENTION_LABEL: Record<CollabAttentionReason | "ready_to_deliver", string> = {
  decision: "待决定",
  escalation: "待回复问题",
  gate_failed: "检查未通过",
  repair_limit: "多次修改未通过",
  conflict_limit: "代码冲突未解决",
  review_incomplete: "审查未完成",
  evidence_error: "改动读取异常",
  manual_check_required: "待人工确认",
  ready_to_deliver: "已完成，待应用",
};

export function collabAttentionLabel(
  item: Pick<DispatchAttentionItem, "engineVersion" | "attentionReason">,
): string | undefined {
  if (item.engineVersion !== 2) return undefined;
  return item.attentionReason ? COLLAB_ATTENTION_LABEL[item.attentionReason] : "待处理";
}

const COLLAB_PLAN_LABEL: Record<CollabPlanStatus, string> = {
  draft: "待开始",
  running: "执行中",
  batch_verifying: "整体验证中",
  ready_to_deliver: "待应用",
  delivered: "已应用",
  cancelled: "已取消",
  failed: "执行失败",
};

export function collabPlanLabel(collab: VelaCollabProjection): string {
  if (collab.appliedDelivery?.revertedAt) return "已撤回";
  if (
    collab.status === "running" &&
    (collab.blocked || collab.canRetryBatch || (collab.batchAudit?.blockingFindings ?? 0) > 0)
  ) {
    return "有待处理项";
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

export type CollabStep = VelaCollabProjection["steps"][number];

export function isCollabStepDone(status: CollabStepStatus): boolean {
  return status === "integrated" || status === "done";
}

export function isCollabStepActive(status: CollabStepStatus): boolean {
  return (
    status === "developing" ||
    status === "verifying_gates" ||
    status === "reviewing" ||
    status === "integrating"
  );
}

export function collabStepIndexMap(collab: VelaCollabProjection): ReadonlyMap<string, number> {
  return new Map(collab.steps.map((step, index) => [step.stepId, index + 1] as const));
}

export function formatCollabDependsOn(
  collab: VelaCollabProjection,
  dependsOn: ReadonlyArray<string> | undefined,
  mode: "draft" | "locked" = "draft",
): string | null {
  if (!dependsOn?.length) return null;
  const indexMap = collabStepIndexMap(collab);
  const nums = dependsOn
    .map((id) => indexMap.get(id))
    .filter((n): n is number => n !== undefined)
    .toSorted((a, b) => a - b);
  if (nums.length === 0) return null;
  const verb = mode === "draft" ? "依赖" : "等待";
  if (nums.length === 1) return `${verb}第 ${nums[0]} 步`;
  if (nums.length === 2) return `${verb}第 ${nums[0]}、${nums[1]} 步`;
  return `${verb}第 ${nums[0]} 步等 ${nums.length} 项`;
}

export function findCollabStepDependents(
  collab: VelaCollabProjection,
  stepId: string,
): ReadonlyArray<{ readonly stepId: string; readonly number: number }> {
  const result: Array<{ readonly stepId: string; readonly number: number }> = [];
  collab.steps.forEach((step, index) => {
    if (step.status === "cancelled") return;
    if (step.dependsOn?.includes(stepId)) {
      result.push({ stepId: step.stepId, number: index + 1 });
    }
  });
  return result;
}

/**
 * Opus 5.5 Rule A3: only collapse the top contiguous completed run when total > 6 and >= 2 top steps are completed.
 */
export function computeTopCompletedRunCount(steps: ReadonlyArray<CollabStep>): number {
  if (steps.length <= 6) return 0;
  let count = 0;
  for (const step of steps) {
    if (isCollabStepDone(step.status)) {
      count += 1;
    } else {
      break;
    }
  }
  return count >= 2 ? count : 0;
}

export function formatCollabAttentionShort(step: CollabStep): string {
  switch (step.attentionReason) {
    case "decision":
      return "待决定";
    case "escalation":
      return "待回复问题";
    case "gate_failed":
      return "检查未通过";
    case "repair_limit":
      return step.attempt > 1 ? `${step.attempt} 轮修改未通过` : "多次修改未通过";
    case "conflict_limit":
      return "代码冲突未解决";
    case "review_incomplete":
      return "审查未完成";
    case "evidence_error":
      return "改动读取异常";
    case "manual_check_required": {
      const count = step.manualChecks?.length ?? 0;
      return count > 0 ? `待确认 ${count} 项` : "待人工确认";
    }
    default:
      return "待处理";
  }
}

export function formatCollabStepModelShort(
  target: DispatchAgentTarget | undefined,
  providers: ReadonlyArray<DispatchProviderSummary>,
): string | null {
  if (!target) return null;
  const display = resolveAgentTargetDisplay(target, providers);
  return display.modelName || display.providerLabel || null;
}

export function formatCollabStepStatusText(
  step: CollabStep,
  collab: VelaCollabProjection,
  providers: ReadonlyArray<DispatchProviderSummary>,
  isReviewing: boolean,
): { readonly primary: string; readonly modelSuffix?: string } {
  if (isReviewing || step.status === "reviewing") {
    return {
      primary: step.attempt > 1 ? `审查中 · 第 ${step.attempt} 轮` : "审查中",
    };
  }
  switch (step.status) {
    case "locked":
      return {
        primary: formatCollabDependsOn(collab, step.dependsOn, "locked") ?? "待执行",
      };
    case "ready":
      return { primary: "待执行" };
    case "developing": {
      const effectiveTarget = step.executor ?? collab.config.defaultDevAgent;
      const modelShort = formatCollabStepModelShort(effectiveTarget, providers) ?? undefined;
      if (step.phase === "conflict") {
        return { primary: "解决冲突中", ...(modelShort ? { modelSuffix: modelShort } : {}) };
      }
      if (step.phase === "repair") {
        return {
          primary: `修改中 · 第 ${Math.max(2, step.attempt)} 轮`,
          ...(modelShort ? { modelSuffix: modelShort } : {}),
        };
      }
      return { primary: "执行中", ...(modelShort ? { modelSuffix: modelShort } : {}) };
    }
    case "verifying_gates":
      return { primary: "自动检查中" };
    case "queued_for_review":
      return {
        primary:
          step.queuePosition !== undefined ? `待审查 · 第 ${step.queuePosition} 位` : "待审查",
      };
    case "integrating":
      return { primary: "汇总改动中" };
    case "integrated":
    case "done":
      return { primary: "已完成" };
    case "needs_attention":
      return { primary: formatCollabAttentionShort(step) };
    case "cancelled":
      return { primary: "已取消" };
  }
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
  const developing: CollabStep[] = [];
  const reviewQueue: CollabStep[] = [];
  const integrationAndDelivery: CollabStep[] = [];
  const attention: CollabStep[] = [];
  for (const step of collab.steps) {
    switch (step.status) {
      case "locked":
      case "ready":
      case "developing":
      case "verifying_gates":
        developing.push(step);
        break;
      case "queued_for_review":
      case "reviewing":
        reviewQueue.push(step);
        break;
      case "needs_attention":
        attention.push(step);
        break;
      case "integrating":
      case "integrated":
      case "done":
      case "cancelled":
        integrationAndDelivery.push(step);
        break;
    }
  }
  const activeReview = collab.activeInbox?.kind === "review" ? collab.activeInbox : undefined;
  reviewQueue.sort((a, b) => {
    const activeOrder =
      Number(activeReview?.stepId === b.stepId) - Number(activeReview?.stepId === a.stepId);
    return activeOrder || compareCollabReviewQueue(a, b);
  });
  return { developing, reviewQueue, integrationAndDelivery, attention };
}

export const STATUS_LABEL: Record<DispatchStepStatus, string> = {
  locked: "待前序完成后解锁",
  ready: "已解锁 · 待派发",
  running: "子线程执行中",
  premise_failed: "前提不符 · 已暂停",
  waiting_orchestrator: "等待主控核查",
  awaiting_decision: "暂停 · 等你拍板",
  needs_human_decision: "暂停 · 等你拍板",
  boundary_violation: "路径越界 · 已拦截",
  hard_gate_failed: "检查未通过 · 已拦截",
  reviewing: "独立 AI 复查中",
  fixing_review: "按复查意见返修中",
  awaiting_product_acceptance: "主控对照需求验收中",
  fixing_acceptance: "按验收意见返修中",
  ready_to_accept: "检查通过 · 待你确认",
  done: "已验收完成",
  cancelled: "已手动中止",
};

export type DispatchStatusTone =
  | "done"
  | "attention"
  | "ready_to_accept"
  | "busy"
  | "failed"
  | "muted";

export interface DispatchKindMeta {
  readonly kind: DispatchStepKind;
  readonly label: string;
  readonly description: string;
}

export const KIND_META: Record<DispatchStepKind, DispatchKindMeta> = {
  research: {
    kind: "research",
    label: "调研",
    description: "只读排查代码或资料，输出调研结论报告",
  },
  decision: {
    kind: "decision",
    label: "决策",
    description: "对比方案与可选路径，由你拍板定方向",
  },
  change: {
    kind: "change",
    label: "改动",
    description: "修改代码或文档，自动过范围、检查、复查与验收",
  },
};

export function resolveStepKind(step: Pick<DispatchTaskCard, "kind">): DispatchStepKind {
  return step.kind ?? "change";
}

export function isBusyStatus(status: DispatchStepStatus): boolean {
  return (
    status === "running" ||
    status === "reviewing" ||
    status === "fixing_review" ||
    status === "fixing_acceptance"
  );
}

export function isActiveProgressStatus(status: DispatchStepStatus): boolean {
  return (
    isBusyStatus(status) ||
    status === "awaiting_product_acceptance" ||
    status === "waiting_orchestrator"
  );
}

export function isCanRunStatus(status: DispatchStepStatus): boolean {
  return (
    status === "ready" ||
    status === "cancelled" ||
    status === "premise_failed" ||
    status === "boundary_violation" ||
    status === "hard_gate_failed"
  );
}

export function isStepAwaitingDecision(
  step: Pick<DispatchTaskCard, "kind" | "status" | "decisionOptions">,
): boolean {
  if (step.status === "awaiting_decision") return true;
  return (
    resolveStepKind(step) === "decision" &&
    step.status === "ready" &&
    (step.decisionOptions?.length ?? 0) > 0
  );
}

export function getStatusMeta(status: DispatchStepStatus): {
  readonly label: string;
  readonly tone: DispatchStatusTone;
  readonly busy: boolean;
} {
  return {
    label: STATUS_LABEL[status],
    tone: progressSegmentTone(status).tone,
    busy: isBusyStatus(status),
  };
}

export interface ProgressSegmentToneInfo {
  readonly tone: DispatchStatusTone;
  readonly className: string;
  readonly sweep: boolean;
}

export function progressSegmentTone(status: DispatchStepStatus): ProgressSegmentToneInfo {
  switch (status) {
    case "done":
      return { tone: "done", className: "bg-foreground/85", sweep: false };
    case "needs_human_decision":
    case "awaiting_decision":
      return { tone: "attention", className: "bg-warning", sweep: false };
    case "ready_to_accept":
      return { tone: "ready_to_accept", className: "bg-success", sweep: false };
    case "running":
    case "reviewing":
    case "fixing_review":
    case "fixing_acceptance":
    case "awaiting_product_acceptance":
    case "waiting_orchestrator":
      return { tone: "busy", className: "bg-foreground/35", sweep: true };
    case "premise_failed":
    case "boundary_violation":
    case "hard_gate_failed":
      return { tone: "failed", className: "bg-destructive/80", sweep: false };
    case "ready":
      return { tone: "muted", className: "bg-info/60", sweep: false };
    case "locked":
      return { tone: "muted", className: "bg-muted", sweep: false };
    case "cancelled":
      return { tone: "muted", className: "bg-muted-foreground/30", sweep: false };
  }
}

export interface DispatchBatch {
  readonly batchNumber: number;
  readonly steps: ReadonlyArray<DispatchTaskCard>;
}

/**
 * Groups steps into sequential execution batches:
 * - In DAG mode (any step declares `dependsOn`), groups by topological dependency depth.
 * - Otherwise preserves linear order with one card per batch.
 */
export function computeBatches(steps: ReadonlyArray<DispatchTaskCard>): ReadonlyArray<DispatchBatch> {
  if (steps.length === 0) return [];
  const ordered = [...steps].toSorted((a, b) => a.order - b.order);
  const usesDag = ordered.some((step) => step.dependsOn !== undefined);

  if (!usesDag) {
    return ordered.map((step, index) => ({
      batchNumber: index + 1,
      steps: [step],
    }));
  }

  const byId = new Map(ordered.map((step) => [step.id, step]));
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (stepId: string): number => {
    const cached = depthMemo.get(stepId);
    if (cached !== undefined) return cached;
    if (visiting.has(stepId)) return 0;

    visiting.add(stepId);
    const step = byId.get(stepId);
    let maxDepDepth = -1;
    if (step?.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!byId.has(depId) || depId === stepId) continue;
        const depDepth = computeDepth(depId);
        if (depDepth > maxDepDepth) {
          maxDepDepth = depDepth;
        }
      }
    }
    visiting.delete(stepId);

    const depth = maxDepDepth + 1;
    depthMemo.set(stepId, depth);
    return depth;
  };

  const groups = new Map<number, DispatchTaskCard[]>();
  for (const step of ordered) {
    const depth = computeDepth(step.id);
    const bucket = groups.get(depth);
    if (bucket) {
      bucket.push(step);
    } else {
      groups.set(depth, [step]);
    }
  }

  return [...groups.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, batchSteps], index) => ({
      batchNumber: index + 1,
      steps: batchSteps,
    }));
}

export type DispatchGateStageKey = "execute" | "scope_and_gate" | "review" | "acceptance";
export type DispatchGateStageStatus = "pending" | "active" | "passed" | "failed" | "skipped";

export interface DispatchGateStage {
  readonly key: DispatchGateStageKey;
  readonly label: string;
  readonly status: DispatchGateStageStatus;
}

export function resolveGateStages(
  step: Pick<
    DispatchTaskCard,
    "status" | "executor" | "reviewer" | "skipProductAcceptance" | "kind" | "decisionOptions"
  >,
  run?: Pick<DispatchStepRun, "boundaryAudit" | "hardGate" | "reviews" | "acceptanceReports">,
): ReadonlyArray<DispatchGateStage> {
  const kind = resolveStepKind(step);
  const reviewSkipped = step.reviewer === null;
  const reviewOrSkipped = (status: Exclude<DispatchGateStageStatus, "skipped">) =>
    reviewSkipped ? "skipped" : status;

  if (kind === "research") {
    let researchStatuses: [
      DispatchGateStageStatus,
      DispatchGateStageStatus,
      DispatchGateStageStatus,
    ];
    switch (step.status) {
      case "running":
      case "waiting_orchestrator":
        researchStatuses = ["active", reviewOrSkipped("pending"), "pending"];
        break;
      case "reviewing":
      case "fixing_review":
        researchStatuses = ["passed", reviewOrSkipped("active"), "pending"];
        break;
      case "ready_to_accept":
        researchStatuses = ["passed", reviewOrSkipped("passed"), "active"];
        break;
      case "done":
        researchStatuses = ["passed", reviewOrSkipped("passed"), "passed"];
        break;
      case "premise_failed":
      case "boundary_violation":
      case "hard_gate_failed":
        researchStatuses = ["failed", reviewOrSkipped("pending"), "pending"];
        break;
      default:
        researchStatuses = ["pending", reviewOrSkipped("pending"), "pending"];
        break;
    }
    return [
      { key: "execute", label: "只读调研", status: researchStatuses[0] },
      { key: "review", label: "独立复查", status: researchStatuses[1] },
      { key: "acceptance", label: "确认结论", status: researchStatuses[2] },
    ];
  }

  if (kind === "decision") {
    let decisionStatuses: [DispatchGateStageStatus, DispatchGateStageStatus];
    if (step.status === "running" || step.status === "waiting_orchestrator") {
      decisionStatuses = ["active", "pending"];
    } else if (isStepAwaitingDecision(step)) {
      decisionStatuses = ["passed", "active"];
    } else if (step.status === "done") {
      decisionStatuses = ["passed", "passed"];
    } else if (
      step.status === "needs_human_decision" ||
      step.status === "premise_failed" ||
      step.status === "hard_gate_failed"
    ) {
      decisionStatuses = ["failed", "pending"];
    } else {
      decisionStatuses = ["pending", "pending"];
    }
    return [
      { key: "execute", label: "整理选项", status: decisionStatuses[0] },
      { key: "acceptance", label: "等你拍板", status: decisionStatuses[1] },
    ];
  }

  const acceptanceSkipped =
    (step.executor === "self" || Boolean(step.skipProductAcceptance)) &&
    step.status !== "awaiting_product_acceptance" &&
    step.status !== "fixing_acceptance";

  const acceptanceOrSkipped = (status: Exclude<DispatchGateStageStatus, "skipped">) =>
    acceptanceSkipped ? "skipped" : status;

  let statuses: [
    DispatchGateStageStatus,
    DispatchGateStageStatus,
    DispatchGateStageStatus,
    DispatchGateStageStatus,
  ];

  switch (step.status) {
    case "running":
    case "waiting_orchestrator":
      statuses = ["active", "pending", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      break;
    case "premise_failed":
      statuses = ["failed", "pending", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      break;
    case "boundary_violation":
    case "hard_gate_failed":
      statuses = ["passed", "failed", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      break;
    case "reviewing":
    case "fixing_review":
      statuses = ["passed", "passed", reviewOrSkipped("active"), acceptanceOrSkipped("pending")];
      break;
    case "awaiting_product_acceptance":
    case "fixing_acceptance":
      statuses = ["passed", "passed", reviewOrSkipped("passed"), acceptanceOrSkipped("active")];
      break;
    case "ready_to_accept":
    case "done":
      statuses = ["passed", "passed", reviewOrSkipped("passed"), acceptanceOrSkipped("passed")];
      break;
    case "needs_human_decision":
    case "awaiting_decision": {
      const lastAcceptance = run?.acceptanceReports.at(-1);
      const lastReview = run?.reviews.at(-1);
      const scopeFailed = run?.boundaryAudit?.ok === false || run?.hardGate?.ok === false;
      if (lastAcceptance && !lastAcceptance.passed) {
        statuses = ["passed", "passed", reviewOrSkipped("passed"), acceptanceOrSkipped("failed")];
      } else if (lastReview && lastReview.verdict === "fail") {
        statuses = ["passed", "passed", reviewOrSkipped("failed"), acceptanceOrSkipped("pending")];
      } else if (scopeFailed) {
        statuses = ["passed", "failed", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      } else {
        statuses = ["active", "pending", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      }
      break;
    }
    case "locked":
    case "ready":
    case "cancelled":
      statuses = ["pending", "pending", reviewOrSkipped("pending"), acceptanceOrSkipped("pending")];
      break;
  }

  return [
    { key: "execute", label: "执行", status: statuses[0] },
    { key: "scope_and_gate", label: "范围检查", status: statuses[1] },
    { key: "review", label: "独立复查", status: statuses[2] },
    { key: "acceptance", label: "需求验收", status: statuses[3] },
  ];
}

export function resolveGatePipelinePercent(stages: ReadonlyArray<DispatchGateStage>): number {
  if (stages.length <= 1) return 0;
  let reachedIndex = 0;
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    if (!stage) continue;
    if (stage.status === "passed" || stage.status === "active" || stage.status === "failed") {
      reachedIndex = i;
    }
  }
  const hasAnyStarted = stages.some(
    (stage) => stage.status === "passed" || stage.status === "active" || stage.status === "failed",
  );
  if (!hasAnyStarted) return 0;
  const allComplete = stages.every(
    (stage) => stage.status === "passed" || stage.status === "skipped",
  );
  if (allComplete) return 100;
  return Math.round((reachedIndex / (stages.length - 1)) * 100);
}

export function providerLabelOf(p: DispatchProviderSummary): string {
  return p.name?.trim() || p.provider?.trim() || p.instanceId;
}

const EFFORT_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "thinkingLevel",
  "reasoning_effort",
  "thought_level",
  "thinking",
]);

export const FALLBACK_EFFORT_CHOICES = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
] as const;

export function normalizeDispatchTargetOptions(
  target: DispatchAgentTarget | null | undefined,
): ReadonlyArray<DispatchAgentOptionSelection> {
  if (!target?.options) return [];
  const entries = new Map<string, string | boolean>();
  if (Array.isArray(target.options)) {
    for (const opt of target.options) {
      if (!opt || typeof opt !== "object") continue;
      const id = typeof opt.id === "string" ? opt.id.trim() : "";
      if (!id) continue;
      if (typeof opt.value === "string" && opt.value.trim()) {
        entries.set(id, opt.value.trim());
      } else if (typeof opt.value === "boolean") {
        entries.set(id, opt.value);
      }
    }
  } else if (typeof target.options === "object") {
    for (const [rawId, val] of Object.entries(target.options)) {
      const id = rawId.trim();
      if (!id) continue;
      if (typeof val === "string" && val.trim()) {
        entries.set(id, val.trim());
      } else if (typeof val === "boolean") {
        entries.set(id, val);
      }
    }
  }
  return [...entries.entries()].map(([id, value]) => ({ id, value }));
}

export function resolveAgentEffortLabel(
  target: DispatchAgentTarget | null | undefined,
): string | null {
  if (!target) return null;
  const normalized = normalizeDispatchTargetOptions(target);
  for (const opt of normalized) {
    if (EFFORT_OPTION_IDS.has(opt.id) && typeof opt.value === "string" && opt.value.trim()) {
      return opt.value.trim();
    }
  }
  if (target.effort?.trim()) return target.effort.trim();
  return null;
}

export function resolveTargetModelSummary(
  target: DispatchAgentTarget | null | undefined,
  providers: ReadonlyArray<DispatchProviderSummary>,
): {
  readonly provider: DispatchProviderSummary | null;
  readonly model: DispatchProviderSummary["models"][number] | null;
} {
  if (!target) return { provider: null, model: null };
  const provider = providers.find((p) => p.instanceId === target.providerInstanceId) ?? null;
  if (!provider) return { provider: null, model: null };
  const model = target.model
    ? (provider.models.find((m) => m.slug === target.model) ?? null)
    : (provider.models[0] ?? null);
  return { provider, model };
}

export function resolveTargetOptionDescriptors(
  target: DispatchAgentTarget | null | undefined,
  providers: ReadonlyArray<DispatchProviderSummary>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return resolveTargetModelSummary(target, providers).model?.optionDescriptors ?? [];
}

export function resolveTargetOptionValue(
  target: DispatchAgentTarget | null | undefined,
  descriptor: ProviderOptionDescriptor,
): string | boolean | null {
  const normalized = normalizeDispatchTargetOptions(target);
  const direct = normalized.find((opt) => opt.id === descriptor.id);
  if (direct !== undefined) {
    if (descriptor.type === "boolean" && typeof direct.value === "boolean") {
      return direct.value;
    }
    if (descriptor.type === "select" && typeof direct.value === "string") {
      return direct.value;
    }
  }

  if (isReasoningSelect(descriptor)) {
    const rawEffort = resolveAgentEffortLabel(target);
    if (rawEffort) {
      const matched = descriptor.options.find(
        (choice) => choice.id === rawEffort || choice.id.toLowerCase() === rawEffort.toLowerCase(),
      );
      if (matched) return matched.id;
    }
  }

  if (descriptor.currentValue !== undefined) {
    return descriptor.currentValue;
  }
  if (descriptor.type === "select") {
    const choices = selectableProviderOptionChoices(descriptor);
    return choices.find((choice) => choice.isDefault)?.id ?? null;
  }
  return null;
}

export interface AgentTargetDisplayInfo {
  readonly provider: DispatchProviderSummary | null;
  readonly driverKind: ProviderDriverKind | null;
  readonly providerLabel: string;
  readonly modelName: string | null;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly reasoningDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null;
  readonly reasoningValue: string | null;
  readonly effortLabel: string | null;
  readonly isFast: boolean;
  readonly isUltrafast: boolean;
  readonly fullLabel: string;
}

export function resolveAgentTargetDisplay(
  target: DispatchAgentTarget,
  providers: ReadonlyArray<DispatchProviderSummary>,
): AgentTargetDisplayInfo {
  const { provider, model } = resolveTargetModelSummary(target, providers);
  const providerLabel = provider ? providerLabelOf(provider) : target.providerInstanceId;
  const modelName = model?.name || target.model || null;
  const descriptors = model?.optionDescriptors ?? [];
  const reasoningDescriptor = descriptors.find(isReasoningSelect) ?? null;

  const rawDriver = provider?.provider?.trim();
  const driverKind = rawDriver ? ProviderDriverKind.make(rawDriver) : null;

  const rawEffort = resolveAgentEffortLabel(target);
  let reasoningValue: string | null = null;
  let effortLabel: string | null = null;

  if (reasoningDescriptor) {
    const resolved = resolveTargetOptionValue(target, reasoningDescriptor);
    if (typeof resolved === "string") {
      reasoningValue = resolved;
      effortLabel =
        reasoningDescriptor.options.find((opt) => opt.id === resolved)?.label ?? resolved;
    }
  } else if (rawEffort) {
    reasoningValue = rawEffort;
    effortLabel =
      FALLBACK_EFFORT_CHOICES.find((opt) => opt.id === rawEffort.toLowerCase())?.label ?? rawEffort;
  }

  let isFast = false;
  let isUltrafast = false;
  for (const descriptor of descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      if (resolveTargetOptionValue(target, descriptor) === true) {
        isFast = true;
      }
    } else if (descriptor.id === "serviceTier" && descriptor.type === "select") {
      const tierVal = resolveTargetOptionValue(target, descriptor);
      const tierLabel = descriptor.options.find((opt) => opt.id === tierVal)?.label;
      if (tierLabel === "Ultrafast") {
        isFast = true;
        isUltrafast = true;
      } else if (tierLabel === "Fast") {
        isFast = true;
      }
    }
  }

  const parts = [providerLabel, modelName, effortLabel].filter(Boolean);
  return {
    provider,
    driverKind,
    providerLabel,
    modelName,
    descriptors,
    reasoningDescriptor,
    reasoningValue,
    effortLabel,
    isFast,
    isUltrafast,
    fullLabel: parts.join(" · "),
  };
}

export function applyTargetOptionChange(
  target: DispatchAgentTarget,
  descriptor: ProviderOptionDescriptor,
  value: string | boolean,
  allDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
): DispatchAgentTarget {
  const isReasoning = isReasoningControl(descriptor);
  const existing = normalizeDispatchTargetOptions(target);
  const nextMap = new Map<string, string | boolean>();

  for (const opt of existing) {
    if (isReasoning && EFFORT_OPTION_IDS.has(opt.id) && opt.id !== descriptor.id) {
      continue;
    }
    nextMap.set(opt.id, opt.value);
  }
  nextMap.set(descriptor.id, value);

  const nextOptions = [...nextMap.entries()].map(([id, val]) => ({ id, value: val }));
  const nextEffort =
    isReasoningSelect(descriptor) && typeof value === "string"
      ? value
      : target.effort && allDescriptors.some((d) => isReasoningSelect(d) && d.id === descriptor.id)
        ? undefined
        : target.effort;

  return {
    providerInstanceId: target.providerInstanceId,
    ...(target.model ? { model: target.model } : {}),
    ...(nextEffort ? { effort: nextEffort } : {}),
    options: nextOptions,
  };
}

export function applyFallbackEffortChange(
  target: DispatchAgentTarget,
  effort: string,
): DispatchAgentTarget {
  const existing = normalizeDispatchTargetOptions(target).filter(
    (opt) => !EFFORT_OPTION_IDS.has(opt.id),
  );
  return {
    providerInstanceId: target.providerInstanceId,
    ...(target.model ? { model: target.model } : {}),
    effort,
    ...(existing.length > 0 ? { options: existing } : {}),
  };
}

export function buildTargetForModelSelection(
  prevTarget: DispatchAgentTarget | null,
  provider: DispatchProviderSummary,
  modelSlug: string | undefined,
): DispatchAgentTarget {
  const resolvedSlug = modelSlug ?? provider.models[0]?.slug;
  const nextModel = resolvedSlug
    ? (provider.models.find((m) => m.slug === resolvedSlug) ?? null)
    : (provider.models[0] ?? null);
  const nextDescriptors = nextModel?.optionDescriptors ?? [];

  if (!prevTarget || nextDescriptors.length === 0) {
    return {
      providerInstanceId: provider.instanceId,
      ...(resolvedSlug ? { model: resolvedSlug } : {}),
    };
  }

  const prevOptions = normalizeDispatchTargetOptions(prevTarget);
  const prevEffort = resolveAgentEffortLabel(prevTarget);
  const carriedOptions: DispatchAgentOptionSelection[] = [];
  let carriedEffort: string | undefined;

  for (const descriptor of nextDescriptors) {
    if (descriptor.type === "select") {
      if (isReasoningControl(descriptor)) {
        if (prevEffort) {
          const matched = selectableProviderOptionChoices(descriptor).find(
            (choice) =>
              choice.id === prevEffort || choice.id.toLowerCase() === prevEffort.toLowerCase(),
          );
          if (matched) {
            carriedOptions.push({ id: descriptor.id, value: matched.id });
            carriedEffort = matched.id;
          }
        }
        continue;
      }

      const prevMatch = prevOptions.find((opt) => opt.id === descriptor.id);
      if (
        prevMatch &&
        typeof prevMatch.value === "string" &&
        selectableProviderOptionChoices(descriptor).some((choice) => choice.id === prevMatch.value)
      ) {
        carriedOptions.push({ id: descriptor.id, value: prevMatch.value });
      }
      continue;
    }

    const prevMatch = prevOptions.find((opt) => opt.id === descriptor.id);
    if (prevMatch && typeof prevMatch.value === "boolean") {
      carriedOptions.push({ id: descriptor.id, value: prevMatch.value });
    }
  }

  return {
    providerInstanceId: provider.instanceId,
    ...(resolvedSlug ? { model: resolvedSlug } : {}),
    ...(carriedEffort ? { effort: carriedEffort } : {}),
    ...(carriedOptions.length > 0 ? { options: carriedOptions } : {}),
  };
}

export function formatAgentTarget(
  target: DispatchAgentTarget | null | undefined,
  providers: ReadonlyArray<DispatchProviderSummary>,
  nullLabel = "跟随当前对话",
): string {
  if (!target) return nullLabel;
  const provider = providers.find((p) => p.instanceId === target.providerInstanceId);
  const providerName = provider ? providerLabelOf(provider) : target.providerInstanceId;
  const rawEffort = resolveAgentEffortLabel(target);
  const model = target.model
    ? provider?.models.find((m) => m.slug === target.model)
    : provider?.models[0];
  const reasoningDescriptor = model?.optionDescriptors?.find(isReasoningSelect);
  const effort =
    rawEffort && reasoningDescriptor
      ? (reasoningDescriptor.options.find(
          (opt) => opt.id === rawEffort || opt.id.toLowerCase() === rawEffort.toLowerCase(),
        )?.label ?? rawEffort)
      : rawEffort;
  if (!target.model) {
    return effort ? `${providerName} · ${effort}` : providerName;
  }
  const modelName = model?.name ?? target.model;
  return effort ? `${providerName} · ${modelName} · ${effort}` : `${providerName} · ${modelName}`;
}

export function resolveExecutorName(
  step: Pick<DispatchTaskCard, "executor">,
  providers: ReadonlyArray<DispatchProviderSummary>,
): string {
  if (step.executor === "self") return "当前对话 (self)";
  return formatAgentTarget(step.executor, providers);
}

export function formatDecisionOptionsText(
  options: ReadonlyArray<DispatchEscalationOption> | undefined,
): string {
  if (!options || options.length === 0) return "";
  return options
    .map((opt) => (opt.description ? `${opt.id}: ${opt.label} - ${opt.description}` : `${opt.id}: ${opt.label}`))
    .join("\n");
}

export function parseDecisionOptionsText(text: string): ReadonlyArray<DispatchEscalationOption> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const fallbackId = String.fromCharCode(65 + index);
    const colonIdx = line.indexOf(":");
    const cnColonIdx = line.indexOf("：");
    const splitIdx =
      colonIdx > 0 && (cnColonIdx === -1 || colonIdx < cnColonIdx) ? colonIdx : cnColonIdx;

    let id = fallbackId;
    let rest = line;
    if (splitIdx > 0 && splitIdx <= 12) {
      id = line.slice(0, splitIdx).trim() || fallbackId;
      rest = line.slice(splitIdx + 1).trim();
    }

    const sepMatch = /\s+-\s+|\s+-\s*/.exec(rest);
    if (sepMatch && sepMatch.index !== undefined) {
      const label = rest.slice(0, sepMatch.index).trim();
      const description = rest.slice(sepMatch.index + sepMatch[0].length).trim();
      return {
        id,
        label: label || id,
        ...(description ? { description } : {}),
      };
    }

    return {
      id,
      label: rest || id,
    };
  });
}

export function formatElapsedDuration(startedAtIso: string | undefined, nowMs: number): string {
  if (!startedAtIso) return "";
  const startedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedMs)) return "";
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(elapsedSec / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  const seconds = elapsedSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function stripMarkdownPreview(markdown: string, maxChars = 160): string {
  const plain = markdown
    .replace(/```[a-zA-Z0-9_-]*/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?;:。，！？；：])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  if (maxChars <= 0) return "";
  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars).trimEnd()}...`;
}

export interface StepVerificationSummary {
  readonly summaryText: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly hasPatch: boolean;
  readonly checksRunCount: number;
  readonly checksPassedCount: number;
  readonly checkLabel: string;
  readonly reviewLabel: string;
  readonly targetBranchLabel: string;
}

export function summarizeStepVerification(
  step: Pick<DispatchTaskCard, "goal" | "reviewer" | "isolation">,
  run:
    | Pick<
        DispatchStepRun,
        "deliverable" | "acceptanceReports" | "reviews" | "diffSummary" | "hardGate" | "isolation"
      >
    | undefined,
  currentBranch?: string | null,
): StepVerificationSummary {
  const deliverableText = run?.deliverable?.text
    ? stripMarkdownPreview(run.deliverable.text, 200)
    : "";
  const acceptanceSummary = run?.acceptanceReports.at(-1)?.summary?.trim() ?? "";
  const reviewSummary = run?.reviews.at(-1)?.summary?.trim() ?? "";
  const goalText = step.goal.trim();
  const summaryText = deliverableText || acceptanceSummary || reviewSummary || goalText;

  const changedFiles = run?.diffSummary?.changedFiles ?? [];
  const hasPatch = Boolean(run?.diffSummary?.patch.trim());
  const gateResults = run?.hardGate?.results ?? [];
  const checksRunCount = gateResults.length;
  const checksPassedCount = gateResults.filter((r) => r.ok).length;

  let checkLabel: string;
  if (checksRunCount === 0) {
    checkLabel = "未运行检查命令";
  } else if (run?.hardGate?.ok) {
    checkLabel = `已运行 ${checksRunCount} 项检查，全部通过`;
  } else {
    checkLabel = `检查未通过（${checksPassedCount}/${checksRunCount} 通过）`;
  }

  let reviewLabel: string;
  if (step.reviewer === null) {
    reviewLabel = "未启用独立复查";
  } else if ((run?.reviews.length ?? 0) > 0) {
    reviewLabel = run!.reviews.at(-1)!.verdict === "pass" ? "独立复查通过" : "独立复查未通过";
  } else {
    reviewLabel = "未运行独立复查";
  }

  const branchName = currentBranch?.trim();
  const branchSuffix = branchName ? `（${branchName}）` : "";
  const effectiveIsolation = run?.isolation ?? step.isolation;
  const targetBranchLabel =
    effectiveIsolation === "worktree"
      ? `确认后合并 Worktree 改动到当前分支${branchSuffix}未提交列表`
      : `改动已在当前分支${branchSuffix}未提交列表，确认后解锁后续步骤`;

  return {
    summaryText,
    changedFiles,
    hasPatch,
    checksRunCount,
    checksPassedCount,
    checkLabel,
    reviewLabel,
    targetBranchLabel,
  };
}

export function computeBlockedDownstreamSteps<
  T extends Pick<DispatchTaskCard, "id" | "order" | "status" | "dependsOn">,
>(steps: ReadonlyArray<T>, stepId: string): ReadonlyArray<T> {
  const ordered = [...steps].toSorted((a, b) => a.order - b.order);
  const usesDag = ordered.some((step) => step.dependsOn !== undefined);
  if (usesDag) {
    return ordered.filter(
      (step) =>
        step.id !== stepId &&
        step.status === "locked" &&
        (step.dependsOn?.includes(stepId) ?? false),
    );
  }
  const sourceIndex = ordered.findIndex((step) => step.id === stepId);
  if (sourceIndex === -1) return [];
  return ordered.slice(sourceIndex + 1).filter((step) => step.status === "locked");
}

export type UnifiedDiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export interface ParsedUnifiedDiffLine {
  readonly id: string;
  readonly text: string;
  readonly kind: UnifiedDiffLineKind;
  readonly filePath?: string;
}

const DIFF_HEADER_PREFIXES = [
  "index ",
  "--- ",
  "+++ ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "dissimilarity index",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
] as const;

function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  return raw
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractDiffGitPath(line: string): string | undefined {
  const rest = line.slice("diff --git ".length).trim();
  if (!rest) return undefined;
  // Quoted: "a/foo bar" "b/foo bar" or mixed
  const quotedMatch = rest.match(/^"(?:[^"\\]|\\.)+"\s+"b\/((?:[^"\\]|\\.)+)"$/);
  if (quotedMatch?.[1]) {
    return unquoteGitPath(`"${quotedMatch[1]}"`);
  }
  const bMarker = " b/";
  const idx = rest.lastIndexOf(bMarker);
  if (idx !== -1) {
    return unquoteGitPath(rest.slice(idx + bMarker.length));
  }
  return undefined;
}

/**
 * Parse a unified git diff line-by-line with hunk state tracking so lines like
 * `--- old SQL comment` (deletion of `-- old SQL comment`) or `+++ note` inside
 * a hunk are classified as `"del"` / `"add"` rather than file header `"meta"`.
 */
export function parseUnifiedDiffLines(patch: string): ParsedUnifiedDiffLine[] {
  if (!patch) return [];
  const rawLines = patch.split("\n");
  const result: ParsedUnifiedDiffLine[] = [];
  let inHunk = false;
  let sawDiffGit = false;

  for (const [index, text] of rawLines.entries()) {
    const id = `l-${index}`;

    if (text.startsWith("diff --git ")) {
      inHunk = false;
      sawDiffGit = true;
      const filePath = extractDiffGitPath(text);
      result.push({
        id,
        text,
        kind: "meta",
        ...(filePath ? { filePath } : {}),
      });
      continue;
    }

    if (!inHunk) {
      if (text.startsWith("@@")) {
        inHunk = true;
        result.push({ id, text, kind: "hunk" });
        continue;
      }
      if (DIFF_HEADER_PREFIXES.some((prefix) => text.startsWith(prefix))) {
        const fallbackFilePath =
          !sawDiffGit && text.startsWith("+++ b/") ? unquoteGitPath(text.slice(6)) : undefined;
        result.push({
          id,
          text,
          kind: "meta",
          ...(fallbackFilePath ? { filePath: fallbackFilePath } : {}),
        });
        continue;
      }
      result.push({ id, text, kind: "context" });
      continue;
    }

    if (text.startsWith("@@")) {
      result.push({ id, text, kind: "hunk" });
    } else if (text.startsWith("+")) {
      result.push({ id, text, kind: "add" });
    } else if (text.startsWith("-")) {
      result.push({ id, text, kind: "del" });
    } else if (text.startsWith("\\ No newline")) {
      result.push({ id, text, kind: "meta" });
    } else {
      result.push({ id, text, kind: "context" });
    }
  }

  return result;
}
