/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { isReasoningControl, isReasoningSelect, selectableProviderOptionChoices } from "@t3tools/client-runtime/model-traits";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import type {
  DispatchAgentOptionSelection,
  DispatchAgentTarget,
  DispatchEscalationOption,
  DispatchProviderSummary,
  DispatchStepKind,
  DispatchStepRun,
  DispatchStepStatus,
  DispatchTaskCard,
} from "~/state/velaDispatch";

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
      return { tone: "done", className: "bg-foreground/80", sweep: false };
    case "needs_human_decision":
    case "awaiting_decision":
      return { tone: "attention", className: "bg-warning", sweep: false };
    case "ready_to_accept":
      return { tone: "ready_to_accept", className: "bg-foreground/50", sweep: false };
    case "running":
    case "reviewing":
    case "fixing_review":
    case "fixing_acceptance":
    case "awaiting_product_acceptance":
    case "waiting_orchestrator":
      return { tone: "busy", className: "bg-foreground/30", sweep: true };
    case "premise_failed":
    case "boundary_violation":
    case "hard_gate_failed":
      return { tone: "failed", className: "bg-destructive/70", sweep: false };
    case "locked":
    case "ready":
    case "cancelled":
      return { tone: "muted", className: "bg-muted", sweep: false };
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
