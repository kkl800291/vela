// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics effectFnOpportunity:off globalDateInEffect:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RunId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  applyWorktreeDeltaToWorkspace,
  auditPathBoundaries,
  captureWorkspaceSnapshot,
  inspectWorkspaceDelta,
  isValidGitTree,
  revertWorkspaceToSnapshot,
  runHardGates,
} from "./VelaDispatchGit.ts";
import {
  buildAcceptanceFixPrompt,
  buildBlindCheckPrompt,
  buildEscalationReplyPrompt,
  buildIndependentReviewPrompt,
  buildResearchReviewPrompt,
  buildReviewFixPrompt,
  buildTaskExecutionPrompt,
  parseDecisionOptions,
  parseExecutorQuestion,
  parsePremiseFailure,
  parseReviewVerdict,
  type UpstreamDeliverable,
} from "./VelaDispatchPrompts.ts";
import { lintDispatchPlan } from "./VelaDispatchPlanLint.ts";
import {
  type DispatchScope,
  VelaDispatchStore,
  createEmptyDispatchState,
  normalizeDispatchScope,
  normalizeProjectRoot,
  unlockReadySteps,
} from "./VelaDispatchStore.ts";
import type {
  DispatchAcceptanceItem,
  DispatchAcceptanceReport,
  DispatchAgentTarget,
  DispatchArchivedPlan,
  DispatchBlindCheckRecord,
  DispatchDeliverable,
  DispatchEscalationKind,
  DispatchEscalationOption,
  DispatchEscalationRecord,
  DispatchIsolationMode,
  DispatchRequirementSnapshot,
  DispatchReviewVerdict,
  DispatchStepKind,
  DispatchStepRun,
  DispatchStepStatus,
  DispatchTaskCard,
  DispatchTaskSpecPatch,
  PublishDispatchStepInput,
  VelaDispatchState,
} from "./VelaDispatchTypes.ts";

const WAIT_CHUNK_MS = 3_000;
const MAX_STEP_WAIT_MS = 30 * 60 * 1000;
const MAX_DELIVERABLE_CHARS = 12_000;
const MAX_UPSTREAM_ITEM_CHARS = 4_000;
const MAX_UPSTREAM_TOTAL_CHARS = 12_000;
const MAX_ARCHIVED_PLANS = 20;
const BUSY_STEP_STATUSES: ReadonlySet<DispatchStepStatus> = new Set([
  "running",
  "reviewing",
  "fixing_review",
  "fixing_acceptance",
  "awaiting_product_acceptance",
]);

export interface DispatchProviderSummary {
  readonly instanceId: string;
  readonly provider: string;
  readonly name: string;
  readonly status: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  }>;
}

export interface StartBlindCheckInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly rawUserInput: string;
  readonly background?: string | undefined;
  readonly orchestratorProposal?: string | undefined;
  readonly checker?: DispatchAgentTarget | undefined;
}

export interface SaveBlindSynthesisInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly synthesis: string;
  readonly approve?: boolean | undefined;
}

export interface PublishPlanInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly planTitle?: string | undefined;
  readonly mode?: "fast" | "strict" | undefined;
  readonly prdSource?: string | undefined;
  readonly sharedContract?: string | undefined;
  readonly requirementSummary?: string | undefined;
  readonly requireProductAcceptance?: boolean | undefined;
  readonly append?: boolean | undefined;
  readonly steps: ReadonlyArray<PublishDispatchStepInput>;
}

export interface DecideStepInput {
  readonly projectRoot: string;
  readonly threadId?: string | null | undefined;
  readonly stepId: string;
  readonly selectedOptionId?: string | undefined;
  readonly decision?: string | undefined;
}

export interface DispatchStepInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly stepId: string;
  readonly skipPremiseCheck?: boolean | undefined;
  readonly parentThreadId?: string | undefined;
  readonly forceUnlock?: boolean | undefined;
  readonly forceWorktree?: boolean | undefined;
}

export interface DispatchParallelStepsInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly stepIds?: ReadonlyArray<string> | undefined;
  readonly parentThreadId?: string | undefined;
}

export interface UpdateStepInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly stepId: string;
  readonly patch: DispatchTaskSpecPatch;
}

export interface ReplyEscalationInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly escalationId: string;
  readonly decision: string;
  readonly resolvedBy: "orchestrator" | "human";
  readonly selectedOptionId?: string | undefined;
  readonly taskSpecPatch?: DispatchTaskSpecPatch | undefined;
}

export interface EscalateToHumanInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly escalationId: string;
  readonly analysis: string;
  readonly humanPrompt: string;
  readonly options?: ReadonlyArray<DispatchEscalationOption> | undefined;
}

export interface SubmitAcceptanceInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly stepId: string;
  readonly summary: string;
  readonly items: ReadonlyArray<DispatchAcceptanceItem>;
}

export interface CompleteSelfStepInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly stepId: string;
  readonly summary: string;
}

export interface KickoffPlanInput {
  readonly projectRoot: string;
  readonly threadId: string;
  readonly requirement?: string | undefined;
  readonly mode: "fast" | "strict";
  readonly defaultAgent?: DispatchAgentTarget | null | undefined;
  readonly deliver?: "server" | "client" | undefined;
}

export interface UpdateConfigInput {
  readonly projectRoot: string;
  readonly threadId?: string | undefined;
  readonly defaultAgent?: DispatchAgentTarget | null | undefined;
  readonly applyToPendingSteps?: boolean | undefined;
}

export interface VelaDispatchServiceShape {
  readonly getState: (
    projectRoot: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState>;
  readonly subscribe: (
    projectRoot: string,
    listener: (state: VelaDispatchState) => void,
    threadId?: string | null,
  ) => () => void;
  readonly listProviders: () => Effect.Effect<ReadonlyArray<DispatchProviderSummary>>;
  readonly startBlindCheck: (
    input: StartBlindCheckInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly saveBlindSynthesis: (
    input: SaveBlindSynthesisInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly publishPlan: (input: PublishPlanInput) => Effect.Effect<VelaDispatchState, Error>;
  readonly updateStep: (input: UpdateStepInput) => Effect.Effect<VelaDispatchState, Error>;
  readonly dispatchStep: (input: DispatchStepInput) => Effect.Effect<VelaDispatchState, Error>;
  readonly dispatchStepsParallel: (
    input: DispatchParallelStepsInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly unlockAllSteps: (
    projectRoot: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly cancelStep: (
    projectRoot: string,
    stepId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly replyEscalation: (
    input: ReplyEscalationInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly escalateToHuman: (
    input: EscalateToHumanInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly submitAcceptance: (
    input: SubmitAcceptanceInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly skipAcceptance: (
    projectRoot: string,
    stepId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly completeSelfStep: (
    input: CompleteSelfStepInput,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly acceptStep: (
    projectRoot: string,
    stepId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly decideStep: (input: DecideStepInput) => Effect.Effect<VelaDispatchState, Error>;
  readonly deleteStep: (
    projectRoot: string,
    stepId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly revertStep: (
    projectRoot: string,
    stepId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly clearPlan: (
    projectRoot: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState>;
  readonly deleteArchivedPlan: (
    projectRoot: string,
    archiveId: string,
    threadId?: string | null,
  ) => Effect.Effect<VelaDispatchState, Error>;
  readonly kickoffPlan: (
    input: KickoffPlanInput,
  ) => Effect.Effect<{ readonly ok: true; readonly prompt?: string }, Error>;
  readonly updateConfig: (input: UpdateConfigInput) => Effect.Effect<VelaDispatchState, Error>;
}

export class VelaDispatchService extends Context.Service<
  VelaDispatchService,
  VelaDispatchServiceShape
>()("t3/dispatch/VelaDispatchService") {}

function newCommandId(prefix: string): CommandId {
  return CommandId.make(`${prefix}-${NodeCrypto.randomUUID()}`);
}

function newMessageId(): MessageId {
  return MessageId.make(`msg-${NodeCrypto.randomUUID()}`);
}

function extractAssistantTextForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  runId: RunId | null,
): string {
  const candidates = projection.messages.filter(
    (msg) => msg.role === "assistant" && (runId === null || msg.runId === runId),
  );
  const picked = candidates.at(-1) ?? projection.messages.filter((m) => m.role === "assistant").at(-1);
  return picked?.text ?? "";
}

const MAX_ACTIVITY_DETAIL_CHARS = 42;

function compactActivityText(raw: string): string {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_ACTIVITY_DETAIL_CHARS) return singleLine;
  return `${singleLine.slice(0, MAX_ACTIVITY_DETAIL_CHARS)}...`;
}

export function summarizeLiveRunActivity(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  runId: RunId | null,
): string | null {
  const items = projection.turnItems.filter(
    (item) => item.type !== "user_message" && (runId === null || item.runId === runId),
  );
  const lastItem = items.at(-1);
  if (!lastItem) return null;

  const stepIndex = items.length;
  switch (lastItem.type) {
    case "command_execution":
      return `正在运行命令：${compactActivityText(lastItem.input)}（第 ${stepIndex} 步）`;
    case "file_change":
      return `正在修改文件：${lastItem.fileName}（第 ${stepIndex} 步）`;
    case "file_search": {
      const pattern = lastItem.pattern ? compactActivityText(lastItem.pattern) : "";
      return `正在检索代码${pattern ? `：${pattern}` : ""}（第 ${stepIndex} 步）`;
    }
    case "web_search":
      return `正在联网检索资料（第 ${stepIndex} 步）`;
    case "reasoning":
      return `正在深度分析推理（第 ${stepIndex} 步）`;
    case "assistant_message":
      return `正在生成回复与结论（第 ${stepIndex} 步）`;
    case "approval_request":
    case "user_input_request":
      return `等待确认或输入（第 ${stepIndex} 步）`;
    default:
      return `正在执行工具调用（第 ${stepIndex} 步）`;
  }
}

function humanizeProviderSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveProviderDisplayName(
  p: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedDisplayName = p.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[p.driver] ?? humanizeProviderSlug(p.driver);
  if (trimmedDisplayName && trimmedDisplayName !== kindLabel) {
    return trimmedDisplayName;
  }
  if (p.instanceId !== defaultInstanceIdForDriver(p.driver)) {
    const humanized = humanizeProviderSlug(p.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedDisplayName || kindLabel || p.instanceId;
}

function pickDefaultAgentTarget(
  providers: ReadonlyArray<ServerProvider>,
  preferredInstanceId?: string,
): DispatchAgentTarget {
  const ready = providers.filter((p) => p.enabled && p.status === "ready");
  const pool = ready.length > 0 ? ready : providers.filter((p) => p.enabled);
  const chosen =
    (preferredInstanceId ? pool.find((p) => p.instanceId === preferredInstanceId) : undefined) ??
    pool[0];
  if (!chosen) {
    return { providerInstanceId: preferredInstanceId ?? "codex" };
  }
  const firstModel = chosen.models[0]?.slug;
  return {
    providerInstanceId: chosen.instanceId,
    ...(firstModel ? { model: firstModel } : {}),
  };
}

const REASONING_OPTION_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "thinkingLevel",
  "reasoning_effort",
  "thought_level",
  "thinking",
]);

function coerceTargetOptionSelections(
  raw: DispatchAgentTarget["options"],
): Array<ProviderOptionSelection> {
  if (!raw) return [];
  const entries: Array<ProviderOptionSelection> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (!id) continue;
      if (typeof item.value === "string") {
        const trimmed = item.value.trim();
        if (trimmed) entries.push({ id, value: trimmed });
      } else if (typeof item.value === "boolean") {
        entries.push({ id, value: item.value });
      }
    }
    return entries;
  }
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const id = rawKey.trim();
    if (!id) continue;
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed) entries.push({ id, value: trimmed });
    } else if (typeof rawValue === "boolean") {
      entries.push({ id, value: rawValue });
    }
  }
  return entries;
}

function resolveCanonicalChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { readonly type: "select" }> | undefined,
  rawValue: string,
): string {
  const trimmed = rawValue.trim();
  if (!descriptor) return trimmed;
  const lowered = trimmed.toLowerCase();
  const matched = descriptor.options.find(
    (choice) =>
      choice.id.toLowerCase() === lowered || choice.label.trim().toLowerCase() === lowered,
  );
  return matched ? matched.id : trimmed;
}

export function normalizeAgentOptionSelections(
  target: DispatchAgentTarget,
  providers: ReadonlyArray<ServerProvider>,
  modelSlug: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const provider = providers.find((p) => p.instanceId === target.providerInstanceId);
  const modelEntry = provider?.models.find((m) => m.slug === modelSlug);
  const reasoningDescriptor = modelEntry?.capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { readonly type: "select" }> =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || REASONING_OPTION_IDS.has(descriptor.id)),
  );

  const selections = coerceTargetOptionSelections(target.options);
  const byId = new Map<string, ProviderOptionSelection>();
  for (const entry of selections) {
    byId.set(entry.id, entry);
  }

  // Remap cross-harness reasoning option ids (e.g. `effort` <-> `reasoningEffort`) to target descriptor.
  if (reasoningDescriptor && !byId.has(reasoningDescriptor.id)) {
    for (const [id, entry] of byId.entries()) {
      if (REASONING_OPTION_IDS.has(id) && typeof entry.value === "string") {
        byId.delete(id);
        byId.set(reasoningDescriptor.id, {
          id: reasoningDescriptor.id,
          value: resolveCanonicalChoiceValue(reasoningDescriptor, entry.value),
        });
        break;
      }
    }
  }

  const rawEffort = target.effort?.trim();
  if (rawEffort) {
    const effortOptionId =
      reasoningDescriptor?.id ?? (provider?.driver === "codex" ? "reasoningEffort" : "effort");
    const hasReasoningSelection = [...byId.keys()].some(
      (id) => id === effortOptionId || REASONING_OPTION_IDS.has(id),
    );
    if (!hasReasoningSelection) {
      byId.set(effortOptionId, {
        id: effortOptionId,
        value: resolveCanonicalChoiceValue(reasoningDescriptor, rawEffort),
      });
    }
  }

  const normalized = [...byId.values()];
  return normalized.length > 0 ? normalized : undefined;
}

export function toModelSelection(
  target: DispatchAgentTarget,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const provider = providers.find((p) => p.instanceId === target.providerInstanceId);
  const modelSlug =
    target.model?.trim() ||
    provider?.models[0]?.slug ||
    "default";
  const options = normalizeAgentOptionSelections(target, providers, modelSlug);
  return {
    instanceId: ProviderInstanceId.make(target.providerInstanceId),
    model: modelSlug as ModelSelection["model"],
    ...(options ? { options } : {}),
  };
}

function resolveSubagentParentThreadId(
  parentThreadId: string | null | undefined,
): ThreadId | undefined {
  const trimmed = parentThreadId?.trim();
  return trimmed ? ThreadId.make(trimmed) : undefined;
}

export function partitionHardGates(rawGates: ReadonlyArray<string>): {
  readonly commands: ReadonlyArray<string>;
  readonly proseNotes: ReadonlyArray<string>;
} {
  const commands: string[] = [];
  const proseNotes: string[] = [];
  for (const raw of rawGates) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rest = trimmed;
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(rest)) {
      rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
    }
    rest = rest.replace(/^[(!\s]+/, "");
    const firstToken = rest.split(/\s+/)[0] ?? "";
    if (!firstToken || !/^[\x21-\x7E]+$/.test(firstToken)) {
      proseNotes.push(trimmed);
    } else {
      commands.push(trimmed);
    }
  }
  return { commands, proseNotes };
}

function mergeProseIntoContractNote(
  existing: string | undefined,
  proseNotes: ReadonlyArray<string>,
): string | undefined {
  const trimmedExisting = existing?.trim() ?? "";
  if (proseNotes.length === 0) return trimmedExisting || undefined;
  const lines = proseNotes
    .filter((note) => !trimmedExisting.includes(note))
    .map((note) => `- 约束：${note}`);
  if (lines.length === 0) return trimmedExisting || undefined;
  return trimmedExisting ? `${trimmedExisting}\n${lines.join("\n")}` : lines.join("\n");
}

function buildDeliverable(
  kind: DispatchDeliverable["kind"],
  text: string,
  selectedOptionId?: string,
): DispatchDeliverable {
  return {
    kind,
    text: text.trim().slice(0, MAX_DELIVERABLE_CHARS),
    ...(selectedOptionId ? { selectedOptionId } : {}),
    producedAt: new Date().toISOString(),
  };
}

export function collectUpstreamDeliverables(
  state: VelaDispatchState,
  step: DispatchTaskCard,
): ReadonlyArray<UpstreamDeliverable> {
  const usesDag = state.steps.some((s) => s.dependsOn !== undefined);
  const depIds = new Set(step.dependsOn ?? []);
  const candidates = (
    usesDag
      ? state.steps.filter((s) => s.id !== step.id && depIds.has(s.id))
      : state.steps.filter((s) => s.id !== step.id && s.order < step.order)
  ).toSorted((a, b) => a.order - b.order);

  const items: UpstreamDeliverable[] = [];
  let remaining = MAX_UPSTREAM_TOTAL_CHARS;
  for (const upstreamStep of candidates) {
    if (remaining <= 0) break;
    const deliverable = state.runs[upstreamStep.id]?.deliverable;
    if (!deliverable?.text.trim()) continue;
    const clipped = deliverable.text.trim().slice(0, Math.min(MAX_UPSTREAM_ITEM_CHARS, remaining));
    if (!clipped) continue;
    remaining -= clipped.length;
    items.push({
      stepId: upstreamStep.id,
      title: upstreamStep.title,
      kind: upstreamStep.kind ?? "change",
      text: clipped,
    });
  }
  return items;
}

function attachLintWarnings(
  steps: ReadonlyArray<DispatchTaskCard>,
  warningsByStep: Readonly<Record<string, ReadonlyArray<string>>>,
): DispatchTaskCard[] {
  return steps.map((card) => {
    const warnings = warningsByStep[card.id];
    if (warnings && warnings.length > 0) {
      return { ...card, warnings: [...warnings] };
    }
    if (card.warnings !== undefined) {
      const { warnings: _removed, ...rest } = card;
      return rest;
    }
    return card;
  });
}

function archiveCurrentPlan(
  curr: VelaDispatchState,
  now: string,
): ReadonlyArray<DispatchArchivedPlan> {
  const existingHistory = curr.history ?? [];
  if (curr.steps.length === 0) {
    return existingHistory;
  }

  const compactRuns: Record<string, DispatchStepRun> = {};
  for (const [stepId, run] of Object.entries(curr.runs)) {
    compactRuns[stepId] = {
      ...run,
      diffSummary: run.diffSummary
        ? {
            changedFiles: run.diffSummary.changedFiles,
            patch: "",
            truncated: true,
          }
        : null,
    };
  }

  const archived: DispatchArchivedPlan = {
    id: `PLAN-${Date.now().toString(36).toUpperCase()}-${NodeCrypto.randomBytes(2).toString("hex")}`,
    planTitle: curr.planTitle || curr.steps[0]?.title || "协作任务计划",
    mode: curr.mode,
    ...(curr.requirement !== undefined ? { requirement: curr.requirement } : {}),
    steps: curr.steps,
    runs: compactRuns,
    archivedAt: now,
  };

  return [archived, ...existingHistory].slice(0, MAX_ARCHIVED_PLANS);
}

function applyTaskSpecPatch(
  step: DispatchTaskCard,
  patch: DispatchTaskSpecPatch | undefined,
): { readonly next: DispatchTaskCard; readonly patchedFields: ReadonlyArray<string> } {
  if (!patch) return { next: step, patchedFields: [] };
  const patchedFields: string[] = [];
  let next = step;

  if (patch.title !== undefined) {
    const trimmed = patch.title.trim();
    if (!trimmed) throw new Error("任务卡标题不能为空");
    next = { ...next, title: trimmed };
    patchedFields.push("title");
  }
  if (patch.kind !== undefined) {
    next = { ...next, kind: patch.kind };
    patchedFields.push("kind");
  }
  if (patch.decisionOptions !== undefined) {
    next = {
      ...next,
      decisionOptions: patch.decisionOptions.map((o) => ({
        id: o.id.trim(),
        label: o.label.trim(),
        ...(o.description?.trim() ? { description: o.description.trim() } : {}),
      })),
    };
    patchedFields.push("decisionOptions");
  }
  if (patch.goal !== undefined) {
    next = { ...next, goal: patch.goal };
    patchedFields.push("goal");
  }
  if (patch.contractNote !== undefined) {
    next = { ...next, contractNote: patch.contractNote };
    patchedFields.push("contractNote");
  }
  if (patch.premisesToVerify !== undefined) {
    next = { ...next, premisesToVerify: [...patch.premisesToVerify] };
    patchedFields.push("premisesToVerify");
  }
  if (patch.allowedGlobs !== undefined) {
    next = { ...next, allowedGlobs: [...patch.allowedGlobs] };
    patchedFields.push("allowedGlobs");
  }
  if (patch.forbiddenGlobs !== undefined) {
    next = { ...next, forbiddenGlobs: [...patch.forbiddenGlobs] };
    patchedFields.push("forbiddenGlobs");
  }
  if (patch.hardGates !== undefined) {
    const partitioned = partitionHardGates(patch.hardGates);
    const mergedNote = mergeProseIntoContractNote(next.contractNote, partitioned.proseNotes);
    next = {
      ...next,
      hardGates: partitioned.commands,
      ...(mergedNote !== undefined ? { contractNote: mergedNote } : {}),
    };
    patchedFields.push("hardGates");
  }
  if (patch.acceptanceCriteria !== undefined) {
    next = { ...next, acceptanceCriteria: [...patch.acceptanceCriteria] };
    patchedFields.push("acceptanceCriteria");
  }
  if (patch.isolation !== undefined) {
    next = { ...next, isolation: patch.isolation };
    patchedFields.push("isolation");
  }
  if (patch.dependsOn !== undefined) {
    next = { ...next, dependsOn: [...patch.dependsOn] };
    patchedFields.push("dependsOn");
  }
  if (patch.executor !== undefined) {
    next = { ...next, executor: patch.executor };
    patchedFields.push("executor");
  }
  if (patch.reviewer !== undefined) {
    next = { ...next, reviewer: patch.reviewer };
    patchedFields.push("reviewer");
  }
  if (patch.skipProductAcceptance !== undefined) {
    next = { ...next, skipProductAcceptance: patch.skipProductAcceptance };
    patchedFields.push("skipProductAcceptance");
  }

  if (patchedFields.length > 0) {
    next = { ...next, updatedAt: new Date().toISOString() };
  }
  return { next, patchedFields };
}

export const layer = Layer.effect(
  VelaDispatchService,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const projectService = yield* ProjectService.ProjectService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    const store = new VelaDispatchStore(serverConfig.stateDir);
    /** Active cancellation controllers keyed by `${scopeKey}::${stepId}`. */
    const activeControllers = new Map<string, AbortController>();
    /** Tracks active direct-write step runs across threads keyed by `${scopeKey}::${stepId}` -> normalizedProjectRoot. */
    const activeDirectRuns = new Map<string, string>();
    /** Serializes lazy restart reconciliation per scope key. */
    const reconcilingScopes = new Map<string, Promise<void>>();

    const makeScope = (projectRoot: string, threadId?: string | null): DispatchScope =>
      threadId?.trim()
        ? { projectRoot: normalizeProjectRoot(projectRoot), threadId: threadId.trim() }
        : normalizeProjectRoot(projectRoot);

    const activeKey = (projectRoot: string, stepId: string, threadId?: string | null) =>
      `${normalizeDispatchScope(makeScope(projectRoot, threadId)).key}::${stepId}`;

    const resolveScopeThreadId = (
      threadId?: string | null,
      parentThreadId?: string | null,
    ): string | undefined => {
      const candidate = threadId?.trim() || parentThreadId?.trim();
      return candidate ? candidate : undefined;
    };

    const resolveProject = async (projectRoot: string): Promise<{
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }> => {
      const normalized = normalizeProjectRoot(projectRoot);
      const found = await runPromise(
        projectService.getByWorkspaceRoot(normalized).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (Option.isSome(found)) {
        return { projectId: found.value.id, workspaceRoot: found.value.workspaceRoot };
      }
      // Fallback: match against project snapshot by resolved path
      const snap = await runPromise(
        projectService.snapshot.pipe(
          Effect.orElseSucceed(() => ({ projects: [] as ReadonlyArray<{ id: ProjectId; workspaceRoot: string }> })),
        ),
      );
      const matched = snap.projects.find((p) => normalizeProjectRoot(p.workspaceRoot) === normalized);
      if (matched) {
        return { projectId: matched.id, workspaceRoot: matched.workspaceRoot };
      }
      throw new Error(`未在 Vela 中找到对应项目：${normalized}`);
    };

    const resolveParentRuntimeMode = async (parentThreadId: string | null): Promise<RuntimeMode> => {
      if (!parentThreadId) return "full-access";
      const shell = await runPromise(
        threadManagement
          .getThreadShell(ThreadId.make(parentThreadId))
          .pipe(Effect.orElseSucceed(() => null)),
      );
      return shell?.runtimeMode ?? "full-access";
    };

    const resolveDefaultAgentTarget = async (input: {
      readonly parentThreadId?: string | null | undefined;
      readonly configDefault?: DispatchAgentTarget | null | undefined;
      readonly providers: ReadonlyArray<ServerProvider>;
    }): Promise<DispatchAgentTarget> => {
      if (input.configDefault?.providerInstanceId) {
        return input.configDefault;
      }
      if (input.parentThreadId) {
        const shell = await runPromise(
          threadManagement
            .getThreadShell(ThreadId.make(input.parentThreadId))
            .pipe(Effect.orElseSucceed(() => null)),
        );
        if (shell?.modelSelection?.instanceId) {
          const opts = shell.modelSelection.options;
          return {
            providerInstanceId: shell.modelSelection.instanceId,
            ...(shell.modelSelection.model ? { model: shell.modelSelection.model } : {}),
            ...(opts && opts.length > 0
              ? { options: opts.map((o) => ({ id: o.id, value: o.value })) }
              : {}),
          };
        }
      }
      return pickDefaultAgentTarget(input.providers);
    };

    const wakeParentOrchestrator = async (input: {
      readonly projectId: ProjectId;
      readonly parentThreadId: string | null;
      readonly text: string;
    }): Promise<void> => {
      if (!input.parentThreadId) return;
      const tid = ThreadId.make(input.parentThreadId);
      const shell = await runPromise(
        threadManagement.getThreadShell(tid).pipe(Effect.orElseSucceed(() => null)),
      );
      if (!shell || shell.deletedAt !== null || shell.archivedAt !== null) return;

      await runPromise(
        threadManagement
          .sendToThread({
            projectId: input.projectId,
            commandId: newCommandId("vela-dispatch-wake"),
            threadId: tid,
            messageId: newMessageId(),
            text: input.text,
            attachments: [],
            mode: "auto",
            createdBy: "system",
            creationSource: "mcp",
          })
          .pipe(Effect.ignore),
      );
    };

    const notifyParentPlanCompleted = async (
      state: VelaDispatchState,
      completedStep: DispatchTaskCard,
    ): Promise<void> => {
      if (
        state.steps.length === 0 ||
        !state.steps.every((s) => s.status === "done") ||
        !state.parentThreadId ||
        !state.projectId
      ) {
        return;
      }
      if (state.steps.length === 1 && (completedStep.kind ?? "change") === "research") {
        return;
      }
      const chunks: string[] = [];
      let totalChars = 0;
      for (const s of [...state.steps].toSorted((a, b) => a.order - b.order)) {
        const r = state.runs[s.id];
        const kindLabel = s.kind ?? "change";
        const files = r?.diffSummary?.changedFiles ?? [];
        const excerpt = r?.deliverable?.text?.trim().slice(0, 800) ?? "";
        const entry = [
          `### ${s.id} ${s.title} (${kindLabel})`,
          ...(files.length > 0 ? [`- 改动文件：${files.join(", ")}`] : []),
          ...(excerpt ? [`- 产出摘要：\n${excerpt}`] : []),
        ].join("\n");
        if (totalChars + entry.length > 3500 && chunks.length > 0) break;
        chunks.push(entry);
        totalChars += entry.length;
      }
      const stepSummaries = chunks.join("\n\n").slice(0, 3500);
      await wakeParentOrchestrator({
        projectId: ProjectId.make(state.projectId),
        parentThreadId: state.parentThreadId,
        text: [
          `[Vela 分步派发回执] 本轮计划「${state.planTitle || "协作任务计划"}」全部 ${state.steps.length} 步已完成。`,
          "",
          stepSummaries,
          "",
          "请用简洁中文在当前主对话向用户确认完成结果并询问下一步打算（例如是否基于以上结论继续拆单、修改代码或结束）；在用户回复前不要自动修改代码或派发新步骤。",
        ].join("\n"),
      });
    };

    const waitForThreadRun = async (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runId: RunId | null;
      readonly signal: AbortSignal;
      readonly onProgress?: ((activityText: string) => Promise<void>) | undefined;
    }): Promise<{ readonly status: string; readonly assistantText: string; readonly aborted: boolean }> => {
      const deadline = Date.now() + MAX_STEP_WAIT_MS;
      let lastReportedActivity: string | null = null;
      while (Date.now() < deadline) {
        if (input.signal.aborted) {
          await runPromise(
            threadManagement
              .interruptThread({
                projectId: input.projectId,
                commandId: newCommandId("vela-dispatch-cancel"),
                threadId: input.threadId,
                ...(input.runId ? { runId: input.runId } : {}),
                reason: "Vela 分工协作面板中止了该任务步",
              })
              .pipe(Effect.ignore),
          );
          return { status: "cancelled", assistantText: "", aborted: true };
        }

        const waitRes = await runPromise(
          threadManagement
            .waitForThread({
              projectId: input.projectId,
              threadId: input.threadId,
              ...(input.runId ? { runId: input.runId } : {}),
              timeoutMs: WAIT_CHUNK_MS,
              untilDelegatedWorkSettled: true,
            })
            .pipe(Effect.orElseSucceed(() => ({ threadId: input.threadId, run: null, timedOut: false }))),
        );

        if (!waitRes.timedOut) {
          const projection = await runPromise(
            threadManagement
              .getThreadProjection(input.threadId)
              .pipe(Effect.orElseSucceed(() => null)),
          );
          const finalRun = ("resultRun" in waitRes ? waitRes.resultRun : undefined) ?? waitRes.run;
          const status = finalRun?.status ?? "completed";
          const assistantText = projection
            ? extractAssistantTextForRun(projection, finalRun?.id ?? input.runId)
            : "";
          return { status, assistantText, aborted: false };
        }

        if (input.onProgress && !input.signal.aborted) {
          const projection = await runPromise(
            threadManagement
              .getThreadProjection(input.threadId)
              .pipe(Effect.orElseSucceed(() => null)),
          );
          const activityText = projection
            ? summarizeLiveRunActivity(projection, input.runId)
            : null;
          if (activityText && activityText !== lastReportedActivity && !input.signal.aborted) {
            lastReportedActivity = activityText;
            await input.onProgress(activityText);
          }
        }
      }

      return { status: "failed", assistantText: "执行超时（超过 30 分钟）", aborted: false };
    };

    const createEscalationAndSave = async (input: {
      readonly projectRoot: string;
      readonly threadId?: string | null | undefined;
      readonly projectId: ProjectId;
      readonly step: DispatchTaskCard;
      readonly kind: DispatchEscalationKind;
      readonly title: string;
      readonly question: string;
      readonly factsFound?: string | undefined;
      readonly options?: ReadonlyArray<DispatchEscalationOption> | undefined;
      readonly forceHuman?: boolean | undefined;
      readonly targetStatus: DispatchStepStatus;
    }): Promise<{ readonly escalation: DispatchEscalationRecord; readonly state: VelaDispatchState }> => {
      const now = new Date().toISOString();
      const scope = makeScope(input.projectRoot, input.threadId);
      const current = await store.read(scope);
      const existingRun = current.runs[input.step.id];
      const nextRounds = (existingRun?.escalationRounds ?? 0) + 1;
      const hitCircuitBreaker = nextRounds > current.config.maxOrchestratorEscalationRounds;
      const toHuman = Boolean(input.forceHuman) || hitCircuitBreaker || !current.parentThreadId;

      const escalation: DispatchEscalationRecord = {
        id: `ESC-${Date.now().toString(36).toUpperCase()}`,
        stepId: input.step.id,
        kind: input.kind,
        status: toHuman ? "open_human" : "open_orchestrator",
        title: input.title,
        question: input.question,
        ...(input.factsFound ? { factsFound: input.factsFound } : {}),
        ...(hitCircuitBreaker
          ? {
              analysis: `该任务步已连续往返 ${nextRounds} 次未自动解开，已触发熔断交由用户拍板。`,
              humanPrompt: input.question,
            }
          : toHuman
            ? { humanPrompt: input.question }
            : {}),
        options: input.options ?? [],
        createdAt: now,
        updatedAt: now,
      };

      const finalStatus: DispatchStepStatus = toHuman ? "needs_human_decision" : input.targetStatus;

      const state = await store.update(
        scope,
        (curr) => {
          const run = curr.runs[input.step.id];
          return {
            ...curr,
            steps: curr.steps.map((s) =>
              s.id === input.step.id ? { ...s, status: finalStatus, updatedAt: now } : s,
            ),
            runs: run
              ? {
                  ...curr.runs,
                  [input.step.id]: {
                    ...run,
                    status: finalStatus,
                    escalationRounds: nextRounds,
                    headline: toHuman ? `等待你拍板：${input.title}` : `等待主控处理：${input.title}`,
                    lastError: input.question,
                    updatedAt: now,
                  },
                }
              : curr.runs,
            escalations: [...curr.escalations, escalation],
          };
        },
        {
          stepId: input.step.id,
          text: `${toHuman ? "触发人工拍板" : "提交主控工单"} (${escalation.id})：${input.title}`,
        },
      );

      if (!toHuman && state.parentThreadId) {
        const wakeText = [
          `[Vela 分工协作自动提醒] 任务步 ${input.step.id}（${input.step.title}）已暂停并提交工单 ${escalation.id}。`,
          `- 类型：${input.kind}`,
          `- 问题：${input.question}`,
          ...(input.factsFound ? [`- 已查证事实：\n${input.factsFound.slice(0, 1500)}`] : []),
          "",
          `请先调用 \`vela_dispatch_status\` 核对详情与代码仓，若属于技术/契约/前提/范围问题，请直接调用 \`vela_dispatch_escalation\`（\`action: "reply"\`, \`escalationId: "${escalation.id}"\`）答复并自动续跑原执行子线程；若涉及产品取舍或高风险变更，请调用 \`vela_dispatch_escalation\`（\`action: "escalate_human"\`, \`escalationId: "${escalation.id}"\`）交由用户拍板。`,
        ].join("\n");
        await wakeParentOrchestrator({
          projectId: input.projectId,
          parentThreadId: state.parentThreadId,
          text: wakeText,
        });
      }

      return { escalation, state };
    };

    // Runs premise/question check, boundary audit, hard gates, fresh review + repair, and acceptance.
    const runPostExecutionPipeline = async (input: {
      readonly projectRoot: string;
      readonly threadId?: string | null | undefined;
      readonly projectId: ProjectId;
      readonly stepId: string;
      readonly assistantText: string;
      readonly runStatus: string;
      readonly signal: AbortSignal;
    }): Promise<void> => {
      if (input.signal.aborted) return;

      const scope = makeScope(input.projectRoot, input.threadId);
      let state = await store.read(scope);
      let step = state.steps.find((s) => s.id === input.stepId);
      let run = state.runs[input.stepId];
      if (!step || !run) return;

      // 1a. Check PREMISE_FAILED protocol
      const premiseFailure = parsePremiseFailure(input.assistantText);
      if (premiseFailure) {
        const reason = premiseFailure.failedPremises
          .map((f) => `前提「${f.premise}」不符：${f.actual}`)
          .join("；");
        await store.update(scope, (curr) => {
          const r = curr.runs[input.stepId];
          if (!r) return curr;
          return {
            ...curr,
            runs: {
              ...curr.runs,
              [input.stepId]: { ...r, premiseFailures: premiseFailure.failedPremises },
            },
          };
        });
        await createEscalationAndSave({
          projectRoot: input.projectRoot,
          threadId: input.threadId,
          projectId: input.projectId,
          step,
          kind: "premise_failed",
          title: `${step.id} 前提核对不符`,
          question: reason,
          factsFound: reason,
          targetStatus: "premise_failed",
        });
        return;
      }

      // 1b. Check NEED_DECISION protocol
      const question = parseExecutorQuestion(input.assistantText);
      if (question) {
        await createEscalationAndSave({
          projectRoot: input.projectRoot,
          threadId: input.threadId,
          projectId: input.projectId,
          step,
          kind: "executor_question",
          title: question.title,
          question: question.question,
          factsFound: question.factsFound,
          options: question.options,
          forceHuman: question.needsHuman,
          targetStatus: "waiting_orchestrator",
        });
        return;
      }

      if (input.runStatus === "failed" || input.runStatus === "interrupted") {
        await createEscalationAndSave({
          projectRoot: input.projectRoot,
          threadId: input.threadId,
          projectId: input.projectId,
          step,
          kind: "hard_gate_failed",
          title: `${step.id} 子线程执行异常 (${input.runStatus})`,
          question: input.assistantText.slice(-1200) || `子线程运行状态：${input.runStatus}`,
          targetStatus: "hard_gate_failed",
        });
        return;
      }

      const kind: DispatchStepKind = step.kind ?? "change";

      if (kind !== "decision") {
        const deliverable = buildDeliverable(
          kind === "research" ? "report" : "change_summary",
          input.assistantText,
        );
        state = await store.update(scope, (curr) => {
          const r = curr.runs[input.stepId];
          if (!r) return curr;
          return {
            ...curr,
            runs: {
              ...curr.runs,
              [input.stepId]: { ...r, deliverable, updatedAt: deliverable.producedAt },
            },
          };
        });
        run = state.runs[input.stepId]!;
      }

      if (kind === "decision") {
        const parsed = parseDecisionOptions(input.assistantText);
        if (parsed) {
          const now = new Date().toISOString();
          await store.update(
            scope,
            (curr) => {
              const r = curr.runs[step!.id];
              return {
                ...curr,
                steps: curr.steps.map((s) =>
                  s.id === step!.id
                    ? {
                        ...s,
                        decisionOptions: parsed.options,
                        status: "awaiting_decision",
                        updatedAt: now,
                      }
                    : s,
                ),
                runs: r
                  ? {
                      ...curr.runs,
                      [step!.id]: {
                        ...r,
                        status: "awaiting_decision",
                        ...(parsed.analysis ? { decisionAnalysis: parsed.analysis } : {}),
                        ...(parsed.recommendation
                          ? { recommendedOptionId: parsed.recommendation }
                          : {}),
                        headline: `等你从 ${parsed.options.length} 个选项中拍板`,
                        lastError: null,
                        updatedAt: now,
                      },
                    }
                  : curr.runs,
              };
            },
            {
              stepId: step.id,
              text: `${step.id} 已整理 ${parsed.options.length} 个决策选项，等待拍板`,
            },
          );
          return;
        }

        await createEscalationAndSave({
          projectRoot: input.projectRoot,
          threadId: input.threadId,
          projectId: input.projectId,
          step,
          kind: "executor_question",
          title: `${step.id} 需要你拍板决策`,
          question:
            input.assistantText.trim().slice(-2000) ||
            "执行代理未能输出标准选项，请直接给出决策意见。",
          forceHuman: true,
          targetStatus: "needs_human_decision",
        });
        return;
      }

      if (kind === "research") {
        const verifyResearchGuards = async (activeStep: DispatchTaskCard, activeRun: DispatchStepRun) => {
          const diffSummary = await inspectWorkspaceDelta(
            activeRun.workspacePath,
            activeRun.isolation === "direct" ? activeRun.baselineTree : null,
          );
          await store.update(scope, (curr) => {
            const r = curr.runs[activeStep.id];
            if (!r) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [activeStep.id]: {
                  ...r,
                  diffSummary,
                  updatedAt: new Date().toISOString(),
                },
              },
            };
          });

          if (diffSummary.changedFiles.length > 0) {
            await createEscalationAndSave({
              projectRoot: input.projectRoot,
              threadId: input.threadId,
              projectId: input.projectId,
              step: activeStep,
              kind: "boundary_violation",
              title: `${activeStep.id} 调研卡不允许修改文件`,
              question: "调研卡不允许修改文件",
              factsFound: `改动文件：${diffSummary.changedFiles.join(", ")}`,
              targetStatus: "boundary_violation",
            });
            return false;
          }

          const gateCommands = partitionHardGates(activeStep.hardGates).commands;
          if (gateCommands.length > 0) {
            const hardGate = await runHardGates(activeRun.workspacePath, gateCommands, {
              signal: input.signal,
            });
            await store.update(scope, (curr) => {
              const r = curr.runs[activeStep.id];
              if (!r) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [activeStep.id]: {
                    ...r,
                    hardGate,
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            });
            if (!hardGate.ok) {
              const failedCmd = hardGate.results.find((r) => !r.ok);
              await createEscalationAndSave({
                projectRoot: input.projectRoot,
                threadId: input.threadId,
                projectId: input.projectId,
                step: activeStep,
                kind: "hard_gate_failed",
                title: `${activeStep.id} Hard Gate 检查未通过`,
                question: failedCmd
                  ? `命令 \`${failedCmd.command}\` 退出码 ${failedCmd.exitCode}`
                  : "自动检查命令失败",
                factsFound: hardGate.logText.slice(-2000),
                targetStatus: "hard_gate_failed",
              });
              return false;
            }
          }
          return true;
        };

        const guardsOk = await verifyResearchGuards(step, run);
        if (!guardsOk || input.signal.aborted) return;

        const providers = await runPromise(providerRegistry.getProviders);
        const reviewerTarget = step.reviewer;
        if (reviewerTarget && step.executor !== "self") {
          const maxRounds = state.config.maxReviewRounds;
          const parentRuntimeMode = await resolveParentRuntimeMode(state.parentThreadId);

          for (let round = 1; round <= maxRounds; round += 1) {
            if (input.signal.aborted) return;
            state = await store.read(scope);
            step = state.steps.find((s) => s.id === input.stepId)!;
            run = state.runs[input.stepId]!;

            await store.update(
              scope,
              (curr) => {
                const r = curr.runs[step!.id];
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === step!.id ? { ...s, status: "reviewing", updatedAt: new Date().toISOString() } : s,
                  ),
                  runs: r
                    ? {
                        ...curr.runs,
                        [step!.id]: {
                          ...r,
                          status: "reviewing",
                          reviewRound: round,
                          headline: `第 ${round} 轮调研报告独立复查中 (${reviewerTarget.providerInstanceId})`,
                          updatedAt: new Date().toISOString(),
                        },
                      }
                    : curr.runs,
                };
              },
              { stepId: step.id, text: `启动全新只读子线程进行第 ${round} 轮调研报告复查` },
            );

            const reviewPrompt = buildResearchReviewPrompt({
              task: step,
              report: run.deliverable?.text ?? input.assistantText,
              requirementSummary: state.requirement?.summary,
              round,
            });

            const reviewParentTid = resolveSubagentParentThreadId(
              state.parentThreadId ?? input.threadId,
            );
            const reviewLaunch = await runPromise(
              threadLaunch.launch({
                commandId: newCommandId("vela-dispatch-review"),
                projectId: input.projectId,
                title: `[Review R${round}] ${step.id}: ${step.title}`,
                titleRenamed: true,
                modelSelection: toModelSelection(reviewerTarget, providers),
                runtimeMode: parentRuntimeMode,
                interactionMode: "plan",
                workspaceStrategy: { type: "root" },
                ...(reviewParentTid ? { subagentParentThreadId: reviewParentTid } : {}),
                workflowRun: {
                  environmentId,
                  runId: `dispatch:${input.threadId ?? "project"}:${step.id}:review-${round}`,
                  workflow: "vela-dispatch",
                  step: `${step.id}-review-${round}`,
                },
                initialMessage: {
                  text: reviewPrompt,
                  attachments: [],
                  ...(reviewParentTid ? { senderThreadId: reviewParentTid } : {}),
                },
                createdBy: "agent",
                creationSource: "mcp",
              }),
            );

            await store.update(scope, (curr) => {
              const r = curr.runs[step!.id];
              if (!r || r.reviewerThreadIds.includes(reviewLaunch.threadId)) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step!.id]: {
                    ...r,
                    reviewerThreadIds: [...r.reviewerThreadIds, reviewLaunch.threadId],
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            });

            const reviewRunId = reviewLaunch.projection.runs.at(-1)?.id ?? null;
            const reviewWait = await waitForThreadRun({
              projectId: input.projectId,
              threadId: reviewLaunch.threadId,
              runId: reviewRunId,
              signal: input.signal,
            });
            if (reviewWait.aborted) return;

            const verdict: DispatchReviewVerdict = parseReviewVerdict(reviewWait.assistantText, {
              round,
              reviewerThreadId: reviewLaunch.threadId,
            });

            await store.update(
              scope,
              (curr) => {
                const r = curr.runs[step!.id];
                if (!r) return curr;
                return {
                  ...curr,
                  runs: {
                    ...curr.runs,
                    [step!.id]: {
                      ...r,
                      reviewerThreadIds: r.reviewerThreadIds.includes(reviewLaunch.threadId)
                        ? r.reviewerThreadIds
                        : [...r.reviewerThreadIds, reviewLaunch.threadId],
                      reviews: [...r.reviews, verdict],
                      updatedAt: new Date().toISOString(),
                    },
                  },
                };
              },
              {
                stepId: step.id,
                text: `第 ${round} 轮调研复查结论：${verdict.verdict === "pass" ? "通过" : `未通过（${verdict.issues.length} 个问题）`}`,
              },
            );

            if (verdict.verdict === "pass") break;

            if (round >= maxRounds) {
              await createEscalationAndSave({
                projectRoot: input.projectRoot,
                threadId: input.threadId,
                projectId: input.projectId,
                step,
                kind: "review_limit",
                title: `${step.id} 调研复查 ${maxRounds} 轮仍未通过`,
                question: verdict.summary,
                factsFound: verdict.issues
                  .map((i) => `[${i.severity}] ${i.file ?? ""} ${i.summary}`)
                  .join("\n"),
                forceHuman: true,
                options: [
                  { id: "accept_anyway", label: "忽略复查意见，直接确认报告" },
                  { id: "retry_fix", label: "继续让原调研子线程补充修订一轮" },
                ],
                targetStatus: "needs_human_decision",
              });
              return;
            }

            const blocking = verdict.issues.filter(
              (i) => i.severity === "blocker" || i.severity === "high",
            );
            const issuesToFix = blocking.length > 0 ? blocking : verdict.issues;
            if (!run.childThreadId) return;

            await store.update(
              scope,
              (curr) => {
                const r = curr.runs[step!.id];
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === step!.id ? { ...s, status: "fixing_review", updatedAt: new Date().toISOString() } : s,
                  ),
                  runs: r
                    ? {
                        ...curr.runs,
                        [step!.id]: {
                          ...r,
                          status: "fixing_review",
                          headline: `第 ${round} 轮复查未通过，请修订调研报告...`,
                          updatedAt: new Date().toISOString(),
                        },
                      }
                    : curr.runs,
                };
              },
              { stepId: step.id, text: `自动打回原调研子线程修订报告（第 ${round} 轮复查问题）` },
            );

            const fixParentTid = resolveSubagentParentThreadId(
              state.parentThreadId ?? input.threadId,
            );
            const fixSend = await runPromise(
              threadManagement.sendToThread({
                projectId: input.projectId,
                commandId: newCommandId("vela-dispatch-review-fix"),
                threadId: ThreadId.make(run.childThreadId),
                messageId: newMessageId(),
                ...(fixParentTid ? { senderThreadId: fixParentTid } : {}),
                text: buildReviewFixPrompt({ task: step, issues: issuesToFix, round }),
                attachments: [],
                mode: "auto",
                createdBy: "agent",
                creationSource: "mcp",
              }),
            );

            await store.update(scope, (curr) => {
              const r = curr.runs[step!.id];
              if (!r) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step!.id]: {
                    ...r,
                    childRunId: fixSend.run.id,
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            });

            const fixWait = await waitForThreadRun({
              projectId: input.projectId,
              threadId: ThreadId.make(run.childThreadId),
              runId: fixSend.run.id,
              signal: input.signal,
            });
            if (fixWait.aborted) return;

            const fixQuestion = parseExecutorQuestion(fixWait.assistantText);
            if (fixQuestion) {
              await createEscalationAndSave({
                projectRoot: input.projectRoot,
                threadId: input.threadId,
                projectId: input.projectId,
                step,
                kind: "executor_question",
                title: fixQuestion.title,
                question: fixQuestion.question,
                factsFound: fixQuestion.factsFound,
                options: fixQuestion.options,
                forceHuman: fixQuestion.needsHuman,
                targetStatus: "waiting_orchestrator",
              });
              return;
            }

            const updatedDeliverable = buildDeliverable("report", fixWait.assistantText);
            state = await store.update(scope, (curr) => {
              const r = curr.runs[step!.id];
              if (!r) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step!.id]: {
                    ...r,
                    deliverable: updatedDeliverable,
                    updatedAt: updatedDeliverable.producedAt,
                  },
                },
              };
            });
            run = state.runs[step.id]!;

            const recheckOk = await verifyResearchGuards(step, run);
            if (!recheckOk || input.signal.aborted) return;
          }
        }

        const latestState = await store.update(
          scope,
          (curr) => {
            const r = curr.runs[step!.id];
            const now = new Date().toISOString();
            return {
              ...curr,
              steps: curr.steps.map((s) =>
                s.id === step!.id ? { ...s, status: "ready_to_accept", updatedAt: now } : s,
              ),
              runs: r
                ? {
                    ...curr.runs,
                    [step!.id]: {
                      ...r,
                      status: "ready_to_accept",
                      headline: "调研完成，等待你确认结论并解锁下一步",
                      lastError: null,
                      updatedAt: now,
                    },
                  }
                : curr.runs,
            };
          },
          { stepId: step.id, text: "只读调研完成，等待用户确认结论" },
        );

        const researchStepId = step.id;
        const researchStepTitle = step.title;
        const latestRun = latestState.runs[researchStepId];
        if (latestState.parentThreadId) {
          const remainingSteps = latestState.steps.filter(
            (s) => s.id !== researchStepId && s.status !== "done",
          );
          const reportText = (latestRun?.deliverable?.text ?? input.assistantText)
            .trim()
            .slice(0, 3500);
          const wakeText =
            remainingSteps.length === 0
              ? [
                  `[Vela 分步派发回执] 调研任务 ${researchStepId}（${researchStepTitle}）已完成（待用户在右侧面板确认验收）。`,
                  "",
                  "## 调研结论",
                  reportText || "（无正文输出）",
                  "",
                  "请用简洁中文在当前主对话向用户总结核心结论、关键方案对比与未决问题，并询问用户的下一步决定；在用户回复前不要自动修改代码或派发新任务。",
                ].join("\n")
              : [
                  `[Vela 分步派发回执] 调研任务 ${researchStepId}（${researchStepTitle}）已完成（待用户在右侧面板确认验收以解锁后续步骤：${remainingSteps.map((s) => s.id).join("、")}）。`,
                  "",
                  "## 调研结论",
                  reportText || "（无正文输出）",
                  "",
                  "请用简洁中文在当前主对话向用户同步核心发现，提醒用户在右侧确认验收或拍板后续步骤；不要自动修改代码或提前开跑下一步。",
                ].join("\n");
          await wakeParentOrchestrator({
            projectId: input.projectId,
            parentThreadId: latestState.parentThreadId,
            text: wakeText,
          });
        }
        return;
      }

      const verifyGates = async (activeStep: DispatchTaskCard, activeRun: DispatchStepRun) => {
        const diffSummary = await inspectWorkspaceDelta(
          activeRun.workspacePath,
          activeRun.isolation === "direct" ? activeRun.baselineTree : null,
        );
        const sensitiveGlobs = [
          ...state.config.defaultSensitiveGlobs,
          ...activeStep.sensitiveGlobs,
        ];
        const boundaryAudit = auditPathBoundaries(diffSummary.changedFiles, {
          allowedGlobs: activeStep.allowedGlobs,
          forbiddenGlobs: activeStep.forbiddenGlobs,
          sensitiveGlobs,
        });

        await store.update(
          scope,
          (curr) => {
            const r = curr.runs[activeStep.id];
            if (!r) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [activeStep.id]: {
                  ...r,
                  diffSummary,
                  boundaryAudit,
                  headline: "正在运行边界审计与强制检查命令...",
                  updatedAt: new Date().toISOString(),
                },
              },
            };
          },
          { stepId: activeStep.id, text: `检测到 ${diffSummary.changedFiles.length} 个增量改动文件，开始门禁检查` },
        );

        if (!boundaryAudit.ok) {
          const parts: string[] = [];
          if (boundaryAudit.outOfScopeFiles.length > 0) {
            parts.push(`超出 allowedGlobs：${boundaryAudit.outOfScopeFiles.join(", ")}`);
          }
          if (boundaryAudit.forbiddenFiles.length > 0) {
            parts.push(`触碰 forbiddenGlobs：${boundaryAudit.forbiddenFiles.join(", ")}`);
          }
          if (boundaryAudit.sensitiveFiles.length > 0) {
            parts.push(`触碰敏感文件：${boundaryAudit.sensitiveFiles.join(", ")}`);
          }
          const msg = parts.join("；");
          await createEscalationAndSave({
            projectRoot: input.projectRoot,
            threadId: input.threadId,
            projectId: input.projectId,
            step: activeStep,
            kind: "boundary_violation",
            title: `${activeStep.id} 改动越界被拦截`,
            question: msg,
            factsFound: `改动文件：${diffSummary.changedFiles.join(", ")}`,
            forceHuman: boundaryAudit.sensitiveFiles.length > 0,
            targetStatus: "boundary_violation",
          });
          return null;
        }

        const gateCommands = partitionHardGates([
          ...state.config.defaultHardGates,
          ...activeStep.hardGates,
        ]).commands;
        const hardGate = await runHardGates(activeRun.workspacePath, gateCommands, {
          signal: input.signal,
        });

        await store.update(scope, (curr) => {
          const r = curr.runs[activeStep.id];
          if (!r) return curr;
          return {
            ...curr,
            runs: {
              ...curr.runs,
              [activeStep.id]: {
                ...r,
                diffSummary,
                boundaryAudit,
                hardGate,
                updatedAt: new Date().toISOString(),
              },
            },
          };
        });

        if (!hardGate.ok) {
          const failedCmd = hardGate.results.find((r) => !r.ok);
          await createEscalationAndSave({
            projectRoot: input.projectRoot,
            threadId: input.threadId,
            projectId: input.projectId,
            step: activeStep,
            kind: "hard_gate_failed",
            title: `${activeStep.id} Hard Gate 检查未通过`,
            question: failedCmd
              ? `命令 \`${failedCmd.command}\` 退出码 ${failedCmd.exitCode}`
              : "自动检查命令失败",
            factsFound: hardGate.logText.slice(-2000),
            targetStatus: "hard_gate_failed",
          });
          return null;
        }

        return { diffSummary, boundaryAudit, hardGate };
      };

      // 2 & 3. Boundary Audit + Hard Gates
      let verified = await verifyGates(step, run);
      if (!verified || input.signal.aborted) return;

      // 4. Independent Fresh-Session Review + Automatic Same-Thread Repair Loop
      const providers = await runPromise(providerRegistry.getProviders);
      const reviewerTarget = step.reviewer;
      if (reviewerTarget && step.executor !== "self") {
        const maxRounds = state.config.maxReviewRounds;
        const parentRuntimeMode = await resolveParentRuntimeMode(state.parentThreadId);

        for (let round = 1; round <= maxRounds; round += 1) {
          if (input.signal.aborted) return;
          state = await store.read(scope);
          step = state.steps.find((s) => s.id === input.stepId)!;
          run = state.runs[input.stepId]!;

          await store.update(
            scope,
            (curr) => {
              const r = curr.runs[step!.id];
              return {
                ...curr,
                steps: curr.steps.map((s) =>
                  s.id === step!.id ? { ...s, status: "reviewing", updatedAt: new Date().toISOString() } : s,
                ),
                runs: r
                  ? {
                      ...curr.runs,
                      [step!.id]: {
                        ...r,
                        status: "reviewing",
                        reviewRound: round,
                        headline: `第 ${round} 轮独立只读复查中 (${reviewerTarget.providerInstanceId})`,
                        updatedAt: new Date().toISOString(),
                      },
                    }
                  : curr.runs,
              };
            },
            { stepId: step.id, text: `启动全新只读子线程进行第 ${round} 轮独立复查` },
          );

          const reviewPrompt = buildIndependentReviewPrompt({
            task: step,
            patch: verified.diffSummary.patch,
            changedFiles: verified.diffSummary.changedFiles,
            hardGateLog: verified.hardGate.logText,
            round,
            requirementSummary: state.requirement?.summary,
          });

          const reviewParentTid = resolveSubagentParentThreadId(
            state.parentThreadId ?? input.threadId,
          );
          const reviewLaunch = await runPromise(
            threadLaunch.launch({
              commandId: newCommandId("vela-dispatch-review"),
              projectId: input.projectId,
              title: `[Review R${round}] ${step.id}: ${step.title}`,
              titleRenamed: true,
              modelSelection: toModelSelection(reviewerTarget, providers),
              runtimeMode: parentRuntimeMode,
              interactionMode: "plan",
              workspaceStrategy:
                run.isolation === "worktree"
                  ? { type: "existing_worktree", worktreePath: run.workspacePath }
                  : { type: "root" },
              ...(reviewParentTid ? { subagentParentThreadId: reviewParentTid } : {}),
              workflowRun: {
                environmentId,
                runId: `dispatch:${input.threadId ?? "project"}:${step.id}:review-${round}`,
                workflow: "vela-dispatch",
                step: `${step.id}-review-${round}`,
              },
              initialMessage: {
                text: reviewPrompt,
                attachments: [],
                ...(reviewParentTid ? { senderThreadId: reviewParentTid } : {}),
              },
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );

          await store.update(scope, (curr) => {
            const r = curr.runs[step!.id];
            if (!r || r.reviewerThreadIds.includes(reviewLaunch.threadId)) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [step!.id]: {
                  ...r,
                  reviewerThreadIds: [...r.reviewerThreadIds, reviewLaunch.threadId],
                  updatedAt: new Date().toISOString(),
                },
              },
            };
          });

          const reviewRunId = reviewLaunch.projection.runs.at(-1)?.id ?? null;
          const reviewWait = await waitForThreadRun({
            projectId: input.projectId,
            threadId: reviewLaunch.threadId,
            runId: reviewRunId,
            signal: input.signal,
          });
          if (reviewWait.aborted) return;

          const verdict: DispatchReviewVerdict = parseReviewVerdict(reviewWait.assistantText, {
            round,
            reviewerThreadId: reviewLaunch.threadId,
          });

          await store.update(
            scope,
            (curr) => {
              const r = curr.runs[step!.id];
              if (!r) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step!.id]: {
                    ...r,
                    reviewerThreadIds: r.reviewerThreadIds.includes(reviewLaunch.threadId)
                      ? r.reviewerThreadIds
                      : [...r.reviewerThreadIds, reviewLaunch.threadId],
                    reviews: [...r.reviews, verdict],
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            },
            {
              stepId: step.id,
              text: `第 ${round} 轮独立复查结论：${verdict.verdict === "pass" ? "通过" : `未通过（${verdict.issues.length} 个问题）`}`,
            },
          );

          if (verdict.verdict === "pass") {
            break;
          }

          if (round >= maxRounds) {
            await createEscalationAndSave({
              projectRoot: input.projectRoot,
              threadId: input.threadId,
              projectId: input.projectId,
              step,
              kind: "review_limit",
              title: `${step.id} 独立复查 ${maxRounds} 轮仍未通过`,
              question: verdict.summary,
              factsFound: verdict.issues
                .map((i) => `[${i.severity}] ${i.file ?? ""} ${i.summary}`)
                .join("\n"),
              forceHuman: true,
              options: [
                { id: "accept_anyway", label: "忽略复查意见，放行进入验收" },
                { id: "retry_fix", label: "继续让原执行子线程返修一轮" },
              ],
              targetStatus: "needs_human_decision",
            });
            return;
          }

          // Automatically send blocking/high issues back to the ORIGINAL executor child thread!
          const blocking = verdict.issues.filter(
            (i) => i.severity === "blocker" || i.severity === "high",
          );
          const issuesToFix = blocking.length > 0 ? blocking : verdict.issues;
          if (!run.childThreadId) return;

          await store.update(
            scope,
            (curr) => {
              const r = curr.runs[step!.id];
              return {
                ...curr,
                steps: curr.steps.map((s) =>
                  s.id === step!.id ? { ...s, status: "fixing_review", updatedAt: new Date().toISOString() } : s,
                ),
                runs: r
                  ? {
                      ...curr.runs,
                      [step!.id]: {
                        ...r,
                        status: "fixing_review",
                        headline: `第 ${round} 轮复查未通过，原执行子线程自动返修中...`,
                        updatedAt: new Date().toISOString(),
                      },
                    }
                  : curr.runs,
              };
            },
            { stepId: step.id, text: `自动打回原执行子线程返修（第 ${round} 轮复查问题）` },
          );

          const fixParentTid = resolveSubagentParentThreadId(
            state.parentThreadId ?? input.threadId,
          );
          const fixSend = await runPromise(
            threadManagement.sendToThread({
              projectId: input.projectId,
              commandId: newCommandId("vela-dispatch-review-fix"),
              threadId: ThreadId.make(run.childThreadId),
              messageId: newMessageId(),
              ...(fixParentTid ? { senderThreadId: fixParentTid } : {}),
              text: buildReviewFixPrompt({ task: step, issues: issuesToFix, round }),
              attachments: [],
              mode: "auto",
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );

          await store.update(scope, (curr) => {
            const r = curr.runs[step!.id];
            if (!r) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [step!.id]: {
                  ...r,
                  childRunId: fixSend.run.id,
                  updatedAt: new Date().toISOString(),
                },
              },
            };
          });

          const fixWait = await waitForThreadRun({
            projectId: input.projectId,
            threadId: ThreadId.make(run.childThreadId),
            runId: fixSend.run.id,
            signal: input.signal,
          });
          if (fixWait.aborted) return;

          const fixQuestion = parseExecutorQuestion(fixWait.assistantText);
          if (fixQuestion) {
            await createEscalationAndSave({
              projectRoot: input.projectRoot,
              threadId: input.threadId,
              projectId: input.projectId,
              step,
              kind: "executor_question",
              title: fixQuestion.title,
              question: fixQuestion.question,
              factsFound: fixQuestion.factsFound,
              options: fixQuestion.options,
              forceHuman: fixQuestion.needsHuman,
              targetStatus: "waiting_orchestrator",
            });
            return;
          }

          // Re-run boundary audit + Hard Gates after repair before next review round.
          const repairedDeliverable = buildDeliverable("change_summary", fixWait.assistantText);
          state = await store.update(scope, (curr) => {
            const r = curr.runs[step!.id];
            if (!r) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [step!.id]: {
                  ...r,
                  deliverable: repairedDeliverable,
                  updatedAt: repairedDeliverable.producedAt,
                },
              },
            };
          });
          run = state.runs[step.id]!;
          verified = await verifyGates(step, run);
          if (!verified || input.signal.aborted) return;
        }
      }

      // 5. Finalize after engineering checks -> Product Acceptance or Ready to Accept
      state = await store.read(scope);
      step = state.steps.find((s) => s.id === input.stepId)!;
      const needsProductAcceptance =
        kind === "change" &&
        state.config.requireProductAcceptance &&
        !step.skipProductAcceptance &&
        Boolean(state.parentThreadId) &&
        step.executor !== "self";

      const finalStatus: DispatchStepStatus = needsProductAcceptance
        ? "awaiting_product_acceptance"
        : "ready_to_accept";

      await store.update(
        scope,
        (curr) => {
          const r = curr.runs[step!.id];
          const now = new Date().toISOString();
          return {
            ...curr,
            steps: curr.steps.map((s) =>
              s.id === step!.id ? { ...s, status: finalStatus, updatedAt: now } : s,
            ),
            runs: r
              ? {
                  ...curr.runs,
                  [step!.id]: {
                    ...r,
                    status: finalStatus,
                    headline: needsProductAcceptance
                      ? "技术校验与复查已通过，等待主控对照需求逐条验收"
                      : "全部检查通过，等待你确认验收并解锁下一步",
                    lastError: null,
                    updatedAt: now,
                  },
                }
              : curr.runs,
          };
        },
        {
          stepId: step.id,
          text: needsProductAcceptance
            ? "技术校验与独立复查通过，已唤醒主控进行产品验收"
            : "全部校验通过，等待用户确认验收",
        },
      );

      if (needsProductAcceptance && state.parentThreadId) {
        const criteriaText =
          step.acceptanceCriteria.length > 0
            ? step.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`).join("\n")
            : "（任务卡未列细项，请对照本步目标与 PRD 核查核心功能完整性）";
        const wakeText = [
          `[Vela 分工协作产品验收提醒] 任务步 ${step.id}（${step.title}）已通过路径审计、Hard Gate 与独立复查。`,
          `- 改动文件：${verified.diffSummary.changedFiles.join(", ") || "（无）"}`,
          ...(state.requirement?.summary
            ? [`- 需求范围摘要：\n${state.requirement.summary}`]
            : []),
          ...(step.prdSource ?? state.prdSource
            ? [`- 需求来源：${step.prdSource ?? state.prdSource}`]
            : []),
          `- 待验收条目：\n${criteriaText}`,
          "",
          `请真实只读核查上述改动代码并对照原始需求/设计文档，然后调用 \`vela_dispatch_acceptance\`（stepId="${step.id}"）提交逐条验收结果（passed / failed / manual_check）。如有 failed 项将自动续跑原执行子线程返修。`,
        ].join("\n");
        await wakeParentOrchestrator({
          projectId: input.projectId,
          parentThreadId: state.parentThreadId,
          text: wakeText,
        });
      }
    };

    const launchStepBackground = (
      projectRoot: string,
      threadId: string | null | undefined,
      stepId: string,
      taskRunner: (signal: AbortSignal) => Promise<void>,
      options?: { readonly isDirectWrite?: boolean | undefined },
    ): void => {
      const scope = makeScope(projectRoot, threadId);
      const key = activeKey(projectRoot, stepId, threadId);
      const prev = activeControllers.get(key);
      if (prev) prev.abort();

      const controller = new AbortController();
      activeControllers.set(key, controller);
      if (options?.isDirectWrite) {
        activeDirectRuns.set(key, normalizeProjectRoot(projectRoot));
      } else {
        activeDirectRuns.delete(key);
      }

      void (async () => {
        try {
          await taskRunner(controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          await store.update(
            scope,
            (curr) => {
              const r = curr.runs[stepId];
              const now = new Date().toISOString();
              return {
                ...curr,
                steps: curr.steps.map((s) =>
                  s.id === stepId ? { ...s, status: "hard_gate_failed", updatedAt: now } : s,
                ),
                runs: r
                  ? {
                      ...curr.runs,
                      [stepId]: {
                        ...r,
                        status: "hard_gate_failed",
                        headline: `执行出错：${message}`,
                        lastError: message,
                        updatedAt: now,
                      },
                    }
                  : curr.runs,
              };
            },
            { stepId, text: `执行异常：${message}` },
          ).catch(() => undefined);
        } finally {
          if (activeControllers.get(key) === controller) {
            activeControllers.delete(key);
            activeDirectRuns.delete(key);
          }
        }
      })();
    };

    const launchSingleStep = async (input: DispatchStepInput): Promise<VelaDispatchState> => {
      const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
      const scopeThreadId = resolveScopeThreadId(input.threadId, input.parentThreadId);
      const scope = makeScope(workspaceRoot, scopeThreadId);
      const current = await store.read(scope);
      const step = current.steps.find((s) => s.id === input.stepId);
      if (!step) throw new Error(`未找到任务步：${input.stepId}`);
      if (step.status === "locked" && !input.forceUnlock) {
        throw new Error(`任务步 ${step.id} 尚未解锁，请先完成并验收前置步骤，或解锁后再派发`);
      }
      if (step.status === "done") {
        throw new Error(`任务步 ${step.id} 已完成并验收`);
      }
      if (
        step.status === "running" ||
        step.status === "reviewing" ||
        step.status === "fixing_review" ||
        step.status === "fixing_acceptance"
      ) {
        throw new Error(`任务步 ${step.id} 正在运行中`);
      }

      const parentThreadId = scopeThreadId ?? current.parentThreadId;
      const kind: DispatchStepKind = step.kind ?? "change";
      const readOnly = kind !== "change";

      if (kind === "decision" && step.decisionOptions && step.decisionOptions.length > 0) {
        const now = new Date().toISOString();
        const optionCount = step.decisionOptions.length;
        const decisionRun: DispatchStepRun = {
          stepId: step.id,
          isolation: "direct",
          branchName: "workspace",
          baseCommit: "",
          baselineTree: null,
          workspacePath: workspaceRoot,
          childThreadId: null,
          childRunId: null,
          reviewerThreadIds: [],
          status: "awaiting_decision",
          headline: `等你从 ${optionCount} 个选项中拍板`,
          lastError: null,
          premiseFailures: [],
          diffSummary: null,
          boundaryAudit: null,
          hardGate: null,
          reviews: [],
          acceptanceReports: [],
          escalationRounds: 0,
          reviewRound: 0,
          acceptanceRound: 0,
          startedAt: now,
          updatedAt: now,
        };
        return await store.update(
          scope,
          (curr) => ({
            ...curr,
            projectId,
            parentThreadId,
            steps: curr.steps.map((s) =>
              s.id === step.id ? { ...s, status: "awaiting_decision", updatedAt: now } : s,
            ),
            runs: { ...curr.runs, [step.id]: decisionRun },
            escalations: curr.escalations.map((e) =>
              e.stepId === step.id &&
              (e.status === "open_orchestrator" || e.status === "open_human")
                ? { ...e, status: "dismissed", updatedAt: now }
                : e,
            ),
          }),
          {
            stepId: step.id,
            text: `${step.id} 已就绪，等你从 ${optionCount} 个选项中拍板`,
          },
        );
      }

      const isSelf = step.executor === "self";
      if (isSelf && !parentThreadId) {
        throw new Error("未找到当前主控对话线程，请先在执行工具下拉菜单中选择具体 AI");
      }

      const otherDirectActiveInScope = readOnly
        ? undefined
        : current.steps.find((s) => {
            if (s.id === step.id) return false;
            if ((s.kind ?? "change") !== "change") return false;
            const active =
              s.status === "running" ||
              s.status === "reviewing" ||
              s.status === "fixing_review" ||
              s.status === "fixing_acceptance";
            if (!active) return false;
            const activeIso = current.runs[s.id]?.isolation ?? s.isolation;
            return activeIso === "direct";
          });

      const currentStepActiveKey = activeKey(workspaceRoot, step.id, scopeThreadId);
      const otherDirectActiveCrossThread = readOnly
        ? false
        : Array.from(activeDirectRuns.entries()).some(
            ([k, root]) => root === workspaceRoot && k !== currentStepActiveKey,
          );
      const hasOtherDirectActive = readOnly
        ? false
        : Boolean(otherDirectActiveInScope) || otherDirectActiveCrossThread;

      if (isSelf && hasOtherDirectActive) {
        throw new Error(
          otherDirectActiveInScope
            ? `当前分支直写已有 ${otherDirectActiveInScope.id} 运行中；如需并行，请把 ${step.id} 的执行 AI 切换为子代理（将自动开独立 Worktree 并行）`
            : `同一工作区另一对话正在执行当前分支直写；请把 ${step.id} 的执行 AI 切换为子代理（将自动开独立 Worktree 并行）`,
        );
      }

      const autoUpgraded =
        !readOnly &&
        !isSelf &&
        step.isolation === "direct" &&
        (Boolean(input.forceWorktree) || hasOtherDirectActive);
      const effectiveIsolation: DispatchIsolationMode = readOnly || isSelf
        ? "direct"
        : step.isolation === "worktree" || autoUpgraded
          ? "worktree"
          : "direct";

      const providers = await runPromise(providerRegistry.getProviders);
      const snapshot = await captureWorkspaceSnapshot(workspaceRoot);
      const prevRun = current.runs[step.id];
      const reuseBaseline = Boolean(
        effectiveIsolation === "direct" &&
          prevRun?.baselineTree &&
          prevRun.baseCommit === snapshot.baseCommit &&
          (await isValidGitTree(workspaceRoot, prevRun.baselineTree)),
      );
      const baselineTree =
        effectiveIsolation === "direct"
          ? reuseBaseline
            ? prevRun!.baselineTree
            : snapshot.baselineTree
          : null;

      const execLabel = isSelf ? "主控当前对话 (self)" : step.executor.providerInstanceId;
      const now = new Date().toISOString();
      const initialHeadline =
        kind === "research"
          ? `正在启动 ${execLabel}，正在只读调研...`
          : kind === "decision"
            ? `正在启动 ${execLabel}，正在整理决策选项...`
            : isSelf
              ? `正在左侧当前主控对话中执行 ${step.id}...`
              : autoUpgraded
                ? `正在自动隔离 Worktree 并启动 ${execLabel} 执行 ${step.id}...`
                : `正在启动 ${execLabel} 子线程执行 ${step.id}...`;
      const initialRun: DispatchStepRun = {
        stepId: step.id,
        isolation: effectiveIsolation,
        branchName: snapshot.branchName,
        baseCommit: snapshot.baseCommit,
        baselineTree,
        workspacePath: workspaceRoot,
        childThreadId: isSelf ? parentThreadId : null,
        childRunId: null,
        reviewerThreadIds: [],
        status: "running",
        headline: initialHeadline,
        lastError: null,
        premiseFailures: [],
        diffSummary: null,
        boundaryAudit: null,
        hardGate: null,
        reviews: [],
        acceptanceReports: [],
        escalationRounds: 0,
        reviewRound: 0,
        acceptanceRound: 0,
        startedAt: now,
        updatedAt: now,
      };

      const nextState = await store.update(
        scope,
        (curr) => ({
          ...curr,
          projectId,
          parentThreadId,
          steps: curr.steps.map((s) =>
            s.id === step.id ? { ...s, status: "running", updatedAt: now } : s,
          ),
          runs: { ...curr.runs, [step.id]: initialRun },
          escalations: curr.escalations.map((e) =>
            e.stepId === step.id &&
            (e.status === "open_orchestrator" || e.status === "open_human")
              ? { ...e, status: "dismissed", updatedAt: now }
              : e,
          ),
        }),
        {
          stepId: step.id,
          text: `派发 ${step.id}（${
            kind === "research"
              ? "只读调研"
              : kind === "decision"
                ? "决策分析"
                : effectiveIsolation === "worktree"
                  ? autoUpgraded
                    ? "自动隔离 Worktree 并行"
                    : "Worktree 并行"
                  : "当前分支直写"
          } -> ${execLabel}）`,
        },
      );

      const sharedContractText = await store.readSharedContract(scope);
      const upstream = collectUpstreamDeliverables(nextState, step);
      const basePrompt = buildTaskExecutionPrompt({
        task: step,
        sharedContractText,
        sharedContractPath: nextState.sharedContractPath ?? undefined,
        skipPremiseCheck: input.skipPremiseCheck,
        upstream,
      });
      const prompt = isSelf
        ? `${basePrompt}\n\n（本步由你当前主控对话直接执行；完成后直接结束回复即可自动过边界与门禁检查，也可调用 \`vela_dispatch_step\`（\`action: "complete_self"\`, \`stepId: "${step.id}"\`）主动提交。）`
        : basePrompt;
      const parentRuntimeMode = await resolveParentRuntimeMode(parentThreadId);
      const execTarget = step.executor;

      launchStepBackground(
        workspaceRoot,
        scopeThreadId,
        step.id,
        async (signal) => {
          const onStepProgress = async (activityText: string) => {
            if (signal.aborted) return;
            await store.update(scope, (curr) => {
              const r = curr.runs[step.id];
              if (r?.status !== "running" || r.headline === activityText) {
                return curr;
              }
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step.id]: {
                    ...r,
                    headline: activityText,
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            });
          };

          if (execTarget === "self") {
            const selfThreadId = ThreadId.make(parentThreadId!);
            const sent = await runPromise(
              threadManagement.sendToThread({
                projectId,
                commandId: newCommandId("vela-dispatch-self"),
                threadId: selfThreadId,
                messageId: newMessageId(),
                text: prompt,
                attachments: [],
                mode: "auto",
                createdBy: "user",
                creationSource: "web",
              }),
            );

            await store.update(scope, (curr) => {
              const r = curr.runs[step.id];
              if (!r) return curr;
              return {
                ...curr,
                runs: {
                  ...curr.runs,
                  [step.id]: {
                    ...r,
                    childThreadId: selfThreadId,
                    childRunId: sent.run.id,
                    updatedAt: new Date().toISOString(),
                  },
                },
              };
            });

            const waitRes = await waitForThreadRun({
              projectId,
              threadId: selfThreadId,
              runId: sent.run.id,
              signal,
              onProgress: onStepProgress,
            });
            if (waitRes.aborted) return;

            const afterSelf = await store.read(scope);
            const latestStepStatus = afterSelf.steps.find((s) => s.id === step.id)?.status;
            if (
              latestStepStatus === "done" ||
              latestStepStatus === "ready_to_accept" ||
              latestStepStatus === "cancelled"
            ) {
              return;
            }

            await runPostExecutionPipeline({
              projectRoot: workspaceRoot,
              threadId: scopeThreadId,
              projectId,
              stepId: step.id,
              assistantText: waitRes.assistantText,
              runStatus: waitRes.status,
              signal,
            });
            return;
          }

          const stepParentTid = resolveSubagentParentThreadId(parentThreadId);
          const launched = await runPromise(
            threadLaunch.launch({
              commandId: newCommandId("vela-dispatch-step"),
              projectId,
              title: `[${step.id}] ${step.title}`,
              titleRenamed: true,
              modelSelection: toModelSelection(execTarget, providers),
              runtimeMode: parentRuntimeMode,
              interactionMode: readOnly ? "plan" : "default",
              workspaceStrategy:
                effectiveIsolation === "worktree"
                  ? {
                      type: "worktree",
                      baseRef: snapshot.baseCommit || "HEAD",
                      startFromOrigin: false,
                    }
                  : { type: "root" },
              ...(stepParentTid ? { subagentParentThreadId: stepParentTid } : {}),
              workflowRun: {
                environmentId,
                runId: `dispatch:${scopeThreadId ?? "project"}:${step.id}`,
                workflow: "vela-dispatch",
                step: step.id,
              },
              initialMessage: {
                text: prompt,
                attachments: [],
                ...(stepParentTid ? { senderThreadId: stepParentTid } : {}),
              },
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );

          const childRunId = launched.projection.runs.at(-1)?.id ?? null;
          const childWorkspacePath = launched.projection.thread.worktreePath ?? workspaceRoot;
          const runningHeadline =
            kind === "research"
              ? `${execTarget.providerInstanceId} 正在只读调研...`
              : kind === "decision"
                ? `${execTarget.providerInstanceId} 正在整理决策选项...`
                : `${execTarget.providerInstanceId} 正在${effectiveIsolation === "worktree" ? "独立 Worktree" : "当前分支"}中执行代码修改...`;

          await store.update(scope, (curr) => {
            const r = curr.runs[step.id];
            if (!r) return curr;
            return {
              ...curr,
              runs: {
                ...curr.runs,
                [step.id]: {
                  ...r,
                  childThreadId: launched.threadId,
                  childRunId,
                  workspacePath: childWorkspacePath,
                  headline: runningHeadline,
                  updatedAt: new Date().toISOString(),
                },
              },
            };
          });

          const waitRes = await waitForThreadRun({
            projectId,
            threadId: launched.threadId,
            runId: childRunId,
            signal,
            onProgress: onStepProgress,
          });
          if (waitRes.aborted) return;

          await runPostExecutionPipeline({
            projectRoot: workspaceRoot,
            threadId: scopeThreadId,
            projectId,
            stepId: step.id,
            assistantText: waitRes.assistantText,
            runStatus: waitRes.status,
            signal,
          });
        },
        { isDirectWrite: !readOnly && effectiveIsolation === "direct" },
      );

      return nextState;
    };

    const completeBlindCheckRun = async (input: {
      readonly scope: DispatchScope;
      readonly projectId: ProjectId;
      readonly checkId: string;
      readonly status: string;
      readonly assistantText: string;
    }): Promise<void> => {
      const updated = await store.update(
        input.scope,
        (curr) =>
          curr.blindCheck
            ? {
                ...curr,
                blindCheck: {
                  ...curr.blindCheck,
                  checkerFacts: input.assistantText,
                  status: input.status === "failed" ? "failed" : "ready_for_approval",
                  ...(input.status === "failed" ? { error: "盲审子线程运行失败" } : {}),
                  updatedAt: new Date().toISOString(),
                },
              }
            : curr,
        { text: "只读代码盲审完成，等待方案对比与确认" },
      );

      if (updated.parentThreadId) {
        await wakeParentOrchestrator({
          projectId: input.projectId,
          parentThreadId: updated.parentThreadId,
          text: [
            `[Vela 分工协作盲审完成] 独立只读审查已完成（${input.checkId}）。`,
            "",
            input.assistantText.slice(0, 3000),
            "",
            "请把盲审查到的真实代码事实与你的方案并排给用户对比；确认后调用 `vela_dispatch_plan`（`action: \"save_synthesis\"`）并按最终方案调用 `vela_dispatch_plan`（`action: \"publish\"`）拆单。",
          ].join("\n"),
        });
      }
    };

    const readChildProjection = async (
      threadId: string,
    ): Promise<OrchestrationV2ThreadProjection | null> => {
      if (typeof threadManagement.getThreadProjection !== "function") return null;
      return await runPromise(
        Effect.suspend(() => threadManagement.getThreadProjection(ThreadId.make(threadId))).pipe(
          Effect.orElseSucceed(() => null),
        ),
      );
    };

    const isRunActiveStatus = (status: string | undefined): boolean =>
      status === "preparing" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting";

    const reconcileOrphanedRuns = async (scope: DispatchScope): Promise<void> => {
      const normalized = normalizeDispatchScope(scope);
      const inflight = reconcilingScopes.get(normalized.key);
      if (inflight) {
        await inflight;
        return;
      }

      const task = (async () => {
        const state = await store.read(scope);
        const scopeThreadId = normalized.threadId ?? state.parentThreadId ?? undefined;
        const orphanedBlind =
          state.blindCheck?.status === "running" &&
          !activeControllers.has(activeKey(state.projectRoot, "__blind_check__", scopeThreadId));
        const orphanedSteps = state.steps.filter(
          (step) =>
            (step.status === "running" ||
              step.status === "reviewing" ||
              step.status === "fixing_review" ||
              step.status === "fixing_acceptance") &&
            !activeControllers.has(activeKey(state.projectRoot, step.id, scopeThreadId)),
        );

        if (!orphanedBlind && orphanedSteps.length === 0) return;

        let resolvedProjectId: ProjectId | null = state.projectId
          ? ProjectId.make(state.projectId)
          : null;
        if (!resolvedProjectId) {
          try {
            resolvedProjectId = (await resolveProject(state.projectRoot)).projectId;
          } catch {
            resolvedProjectId = null;
          }
        }

        if (orphanedBlind && state.blindCheck) {
          const blind = state.blindCheck;
          if (!blind.checkerThreadId || !resolvedProjectId) {
            await store.update(
              scope,
              (curr) =>
                curr.blindCheck?.status === "running"
                  ? {
                      ...curr,
                      blindCheck: {
                        ...curr.blindCheck,
                        status: "failed",
                        error: "服务端重启时盲审尚未创建子线程，请重试或重置",
                        updatedAt: new Date().toISOString(),
                      },
                    }
                  : curr,
              { text: "检测到服务端重启导致盲审中断，已恢复为可重试状态" },
            );
          } else {
            const projection = await readChildProjection(blind.checkerThreadId);
            const latestRun = projection?.runs.at(-1);
            const projectId = resolvedProjectId;
            if (latestRun && isRunActiveStatus(latestRun.status)) {
              launchStepBackground(state.projectRoot, scopeThreadId, "__blind_check__", async (signal) => {
                const waitRes = await waitForThreadRun({
                  projectId,
                  threadId: ThreadId.make(blind.checkerThreadId!),
                  runId: latestRun.id,
                  signal,
                });
                if (waitRes.aborted) return;
                await completeBlindCheckRun({
                  scope,
                  projectId,
                  checkId: blind.id,
                  status: waitRes.status,
                  assistantText: waitRes.assistantText,
                });
              });
            } else if (projection && latestRun?.status === "completed") {
              await completeBlindCheckRun({
                scope,
                projectId,
                checkId: blind.id,
                status: latestRun.status,
                assistantText: extractAssistantTextForRun(projection, latestRun.id),
              });
            } else {
              await store.update(
                scope,
                (curr) =>
                  curr.blindCheck?.status === "running"
                    ? {
                        ...curr,
                        blindCheck: {
                          ...curr.blindCheck,
                          status: "failed",
                          error: "服务端重启导致盲审子线程中断，请重试或重置",
                          updatedAt: new Date().toISOString(),
                        },
                      }
                    : curr,
                { text: "检测到服务端重启导致盲审子线程中断，已恢复为失败状态" },
              );
            }
          }
        }

        for (const step of orphanedSteps) {
          const run = state.runs[step.id];
          const markInterrupted = async (headline: string, reason: string) => {
            const now = new Date().toISOString();
            await store.update(
              scope,
              (curr) => {
                const currentStep = curr.steps.find((s) => s.id === step.id);
                if (
                  !currentStep ||
                  (currentStep.status !== "running" &&
                    currentStep.status !== "reviewing" &&
                    currentStep.status !== "fixing_review" &&
                    currentStep.status !== "fixing_acceptance")
                ) {
                  return curr;
                }
                const currentRun = curr.runs[step.id];
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === step.id ? { ...s, status: "cancelled", updatedAt: now } : s,
                  ),
                  runs: currentRun
                    ? {
                        ...curr.runs,
                        [step.id]: {
                          ...currentRun,
                          status: "cancelled",
                          headline,
                          lastError: reason,
                          updatedAt: now,
                        },
                      }
                    : curr.runs,
                };
              },
              { stepId: step.id, text: `${step.id} ${reason}` },
            );
          };

          if (!run?.childThreadId || !resolvedProjectId) {
            await markInterrupted(
              "服务端重启导致执行中断，可点击重试继续",
              "服务端重启前子线程未完成，已恢复为可重试状态",
            );
            continue;
          }

          const projectId = resolvedProjectId;
          const projection = await readChildProjection(run.childThreadId);
          const targetRun =
            (run.childRunId
              ? projection?.runs.find((candidate) => candidate.id === run.childRunId)
              : undefined) ?? projection?.runs.at(-1);

          if (step.status === "reviewing") {
            if (projection && targetRun?.status === "completed") {
              const assistantText = extractAssistantTextForRun(projection, targetRun.id);
              launchStepBackground(
                state.projectRoot,
                scopeThreadId,
                step.id,
                async (signal) => {
                  await runPostExecutionPipeline({
                    projectRoot: state.projectRoot,
                    threadId: scopeThreadId,
                    projectId,
                    stepId: step.id,
                    assistantText,
                    runStatus: targetRun.status,
                    signal,
                  });
                },
                { isDirectWrite: (step.kind ?? "change") === "change" && run.isolation === "direct" },
              );
            } else {
              await markInterrupted(
                "服务端重启导致复查中断，可点击重试继续",
                "服务端重启前独立复查未完成，已恢复为可重试状态",
              );
            }
            continue;
          }

          if (targetRun && isRunActiveStatus(targetRun.status)) {
            launchStepBackground(
              state.projectRoot,
              scopeThreadId,
              step.id,
              async (signal) => {
                const waitRes = await waitForThreadRun({
                  projectId,
                  threadId: ThreadId.make(run.childThreadId!),
                  runId: targetRun.id,
                  signal,
                });
                if (waitRes.aborted) return;
                await runPostExecutionPipeline({
                  projectRoot: state.projectRoot,
                  threadId: scopeThreadId,
                  projectId,
                  stepId: step.id,
                  assistantText: waitRes.assistantText,
                  runStatus: waitRes.status,
                  signal,
                });
              },
              { isDirectWrite: (step.kind ?? "change") === "change" && run.isolation === "direct" },
            );
          } else if (projection && targetRun?.status === "completed") {
            const assistantText = extractAssistantTextForRun(projection, targetRun.id);
            launchStepBackground(
              state.projectRoot,
              scopeThreadId,
              step.id,
              async (signal) => {
                await runPostExecutionPipeline({
                  projectRoot: state.projectRoot,
                  threadId: scopeThreadId,
                  projectId,
                  stepId: step.id,
                  assistantText,
                  runStatus: targetRun.status,
                  signal,
                });
              },
              { isDirectWrite: (step.kind ?? "change") === "change" && run.isolation === "direct" },
            );
          } else {
            await markInterrupted(
              "服务端重启导致子线程中断，可点击重试继续",
              "服务端重启前子线程未完成，已恢复为可重试状态",
            );
          }
        }
      })().finally(() => {
        if (reconcilingScopes.get(normalized.key) === task) {
          reconcilingScopes.delete(normalized.key);
        }
      });

      reconcilingScopes.set(normalized.key, task);
      await task;
    };

    return {
      getState: (projectRoot, threadId) =>
        Effect.promise(async () => {
          const scope = makeScope(projectRoot, threadId);
          await reconcileOrphanedRuns(scope);
          return await store.read(scope);
        }),

      subscribe: (projectRoot, listener, threadId) => {
        const scope = makeScope(projectRoot, threadId);
        const unsubscribe = store.subscribe(scope, listener);
        void reconcileOrphanedRuns(scope);
        return unsubscribe;
      },

      listProviders: () =>
        providerRegistry.getProviders.pipe(
          Effect.map((providers) =>
            providers
              .filter((p) => p.enabled)
              .map((p) => {
                const activeModels = p.models.filter((m) => !m.isLegacy);
                const visibleModels = activeModels.length > 0 ? activeModels : p.models;
                return {
                  instanceId: p.instanceId,
                  provider: p.driver,
                  name: resolveProviderDisplayName(p),
                  status: p.status,
                  models: visibleModels.map((m) => ({
                    slug: m.slug,
                    name: m.name || m.shortName || m.slug,
                    ...(m.capabilities?.optionDescriptors &&
                    m.capabilities.optionDescriptors.length > 0
                      ? { optionDescriptors: m.capabilities.optionDescriptors }
                      : {}),
                  })),
                };
              }),
          ),
        ),

      startBlindCheck: (input) =>
        Effect.tryPromise({
          try: async () => {
            const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
            const scopeThreadId = resolveScopeThreadId(input.threadId, input.parentThreadId);
            const scope = makeScope(workspaceRoot, scopeThreadId);
            const current = await store.read(scope);
            const providers = await runPromise(providerRegistry.getProviders);
            const parentThreadId = scopeThreadId ?? current.parentThreadId;
            const checker =
              input.checker ??
              (await resolveDefaultAgentTarget({
                parentThreadId,
                configDefault: current.config.defaultAgent,
                providers,
              }));
            const checkerLabel = checker.model
              ? `${checker.providerInstanceId} · ${checker.model}`
              : checker.providerInstanceId;
            const checkId = `BC-${Date.now().toString(36).toUpperCase()}`;
            const now = new Date().toISOString();

            const record: DispatchBlindCheckRecord = {
              id: checkId,
              rawUserInput: input.rawUserInput.trim(),
              background: input.background?.trim() ?? "",
              orchestratorProposal: input.orchestratorProposal?.trim() ?? "",
              checker,
              checkerThreadId: null,
              checkerFacts: "",
              synthesis: "",
              status: "running",
              createdAt: now,
              updatedAt: now,
            };

            const nextState = await store.update(
              scope,
              (curr) => ({
                ...curr,
                projectId,
                parentThreadId,
                mode: "strict",
                blindCheck: record,
              }),
              { text: `启动只读代码盲审 (${checkerLabel})` },
            );

            const ledgerExcerpt = await store.readLedgerExcerpt(scope, 2000);
            const prompt = buildBlindCheckPrompt({
              rawUserInput: record.rawUserInput,
              background: record.background,
              ledgerExcerpt,
            });
            const parentRuntimeMode = await resolveParentRuntimeMode(
              nextState.parentThreadId,
            );

            const blindParentTid = resolveSubagentParentThreadId(parentThreadId);
            launchStepBackground(workspaceRoot, scopeThreadId, "__blind_check__", async (signal) => {
              const launched = await runPromise(
                threadLaunch.launch({
                  commandId: newCommandId("vela-dispatch-blind"),
                  projectId,
                  title: `[盲审] ${record.rawUserInput.slice(0, 32)}`,
                  titleRenamed: true,
                  modelSelection: toModelSelection(checker, providers),
                  runtimeMode: parentRuntimeMode,
                  interactionMode: "plan",
                  workspaceStrategy: { type: "root" },
                  ...(blindParentTid ? { subagentParentThreadId: blindParentTid } : {}),
                  workflowRun: {
                    environmentId,
                    runId: `dispatch:${scopeThreadId ?? "project"}:${checkId}`,
                    workflow: "vela-dispatch",
                    step: `blind-check-${checkId}`,
                  },
                  initialMessage: {
                    text: prompt,
                    attachments: [],
                    ...(blindParentTid ? { senderThreadId: blindParentTid } : {}),
                  },
                  createdBy: "agent",
                  creationSource: "mcp",
                }),
              );

              await store.update(scope, (curr) =>
                curr.blindCheck
                  ? {
                      ...curr,
                      blindCheck: {
                        ...curr.blindCheck,
                        checkerThreadId: launched.threadId,
                        updatedAt: new Date().toISOString(),
                      },
                    }
                  : curr,
              );

              const runId = launched.projection.runs.at(-1)?.id ?? null;
              const waitRes = await waitForThreadRun({
                projectId,
                threadId: launched.threadId,
                runId,
                signal,
              });
              if (waitRes.aborted) return;

              await completeBlindCheckRun({
                scope,
                projectId,
                checkId,
                status: waitRes.status,
                assistantText: waitRes.assistantText,
              });
            });

            return nextState;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      saveBlindSynthesis: (input) =>
        Effect.tryPromise({
          try: async () => {
            const scope = makeScope(input.projectRoot, input.threadId);
            return await store.update(
              scope,
              (curr) => {
                if (!curr.blindCheck) {
                  throw new Error("当前没有进行中的盲审记录");
                }
                return {
                  ...curr,
                  blindCheck: {
                    ...curr.blindCheck,
                    synthesis: input.synthesis.trim(),
                    status: input.approve ? "approved" : curr.blindCheck.status,
                    updatedAt: new Date().toISOString(),
                  },
                };
              },
              { text: input.approve ? "盲审结论已确认，准备拆单" : "已保存盲审综合结论" },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      publishPlan: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (input.steps.length === 0) {
              throw new Error("至少需要 1 张任务卡");
            }
            const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
            const scopeThreadId = resolveScopeThreadId(input.threadId, input.parentThreadId);
            const scope = makeScope(workspaceRoot, scopeThreadId);
            const current = await store.read(scope);

            if (!input.append) {
              const busyStep = current.steps.find((s) => BUSY_STEP_STATUSES.has(s.status));
              if (busyStep) {
                throw new Error(
                  `当前计划有步骤正在执行（${busyStep.id}），请先中止或用 append 追加`,
                );
              }
            }

            const providers = await runPromise(providerRegistry.getProviders);
            const parentThreadId = scopeThreadId ?? current.parentThreadId;
            const defaultExec = await resolveDefaultAgentTarget({
              parentThreadId,
              configDefault: current.config.defaultAgent,
              providers,
            });
            const now = new Date().toISOString();

            const existingIds = new Set(input.append ? current.steps.map((s) => s.id) : []);
            let maxOrder = input.append
              ? current.steps.reduce((max, s) => Math.max(max, s.order), 0)
              : 0;
            let nextSeq = maxOrder + 1;

            const rawSteps: DispatchTaskCard[] = input.steps.map((s, idx) => {
              const kind: DispatchStepKind = s.kind ?? "change";
              const partitioned = partitionHardGates(s.hardGates ?? []);
              const mergedContractNote = mergeProseIntoContractNote(
                s.contractNote?.trim(),
                partitioned.proseNotes,
              );
              let id = s.id?.trim() || "";
              if (!id || existingIds.has(id)) {
                while (existingIds.has(`S${nextSeq}`)) nextSeq += 1;
                id = `S${nextSeq}`;
              }
              existingIds.add(id);
              const order =
                input.append && s.order === undefined ? ++maxOrder : (s.order ?? idx + 1);
              const decisionOptions = s.decisionOptions?.map((o) => ({
                id: o.id.trim(),
                label: o.label.trim(),
                ...(o.description?.trim() ? { description: o.description.trim() } : {}),
              }));
              return {
                id,
                order,
                title: s.title.trim(),
                goal: s.goal.trim(),
                kind,
                ...(decisionOptions !== undefined ? { decisionOptions } : {}),
                isolation: s.isolation ?? "direct",
                ...(s.dependsOn !== undefined ? { dependsOn: [...s.dependsOn] } : {}),
                ...(s.parallelGroup?.trim() ? { parallelGroup: s.parallelGroup.trim() } : {}),
                premisesToVerify: [...(s.premisesToVerify ?? [])],
                contextFiles: [...(s.contextFiles ?? [])],
                ...(mergedContractNote ? { contractNote: mergedContractNote } : {}),
                ...(s.prdSource?.trim() ? { prdSource: s.prdSource.trim() } : {}),
                acceptanceCriteria: [...(s.acceptanceCriteria ?? [])],
                allowedGlobs: [...(s.allowedGlobs ?? [])],
                forbiddenGlobs: [...(s.forbiddenGlobs ?? [])],
                sensitiveGlobs: [...(s.sensitiveGlobs ?? [])],
                hardGates: partitioned.commands,
                executor: s.executor ?? defaultExec,
                reviewer:
                  s.reviewer === undefined
                    ? kind === "change"
                      ? defaultExec
                      : null
                    : s.reviewer,
                ...(s.skipProductAcceptance !== undefined
                  ? { skipProductAcceptance: s.skipProductAcceptance }
                  : {}),
                status: "locked",
                createdAt: now,
                updatedAt: now,
              };
            });

            const stepsForLint =
              input.append && current.steps.length > 0
                ? [...current.steps, ...rawSteps]
                : rawSteps;
            const lintResult = lintDispatchPlan(stepsForLint);
            if (lintResult.errors.length > 0) {
              throw new Error(
                `任务卡校验未通过，请修正后重新 publish：\n${lintResult.errors.map((e) => `- ${e}`).join("\n")}`,
              );
            }

            let sharedContractPath: string | null = null;
            if (input.sharedContract?.trim()) {
              sharedContractPath = await store.writeSharedContract(
                scope,
                input.sharedContract,
              );
            }

            const warningEntries = Object.entries(lintResult.warningsByStep).filter(
              ([, list]) => list.length > 0,
            );
            const warningLogText =
              warningEntries.length > 0
                ? `发布校验提示（${warningEntries.map(([id, list]) => `${id}: ${list.join("；")}`).join(" | ")}）`
                : null;

            const buildNextRequirement = (
              currReq: DispatchRequirementSnapshot | null | undefined,
            ): DispatchRequirementSnapshot => {
              const nextSummary = input.requirementSummary?.trim() || currReq?.summary;
              return {
                ...(currReq?.userInput !== undefined ? { userInput: currReq.userInput } : {}),
                ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
                capturedAt: now,
              };
            };

            if (input.append && current.steps.length > 0) {
              const combinedWithWarnings = attachLintWarnings(
                [...current.steps, ...rawSteps],
                lintResult.warningsByStep,
              );
              const combined = unlockReadySteps(combinedWithWarnings);
              const addedIds = rawSteps.map((s) => s.id).join("、");
              return await store.update(
                scope,
                (curr) => {
                  const nextCombined = unlockReadySteps(
                    attachLintWarnings([...curr.steps, ...rawSteps], lintResult.warningsByStep),
                  );
                  return {
                    ...curr,
                    projectId,
                    parentThreadId,
                    planTitle:
                      curr.planTitle ||
                      input.planTitle?.trim() ||
                      combined[0]?.title ||
                      "协作任务计划",
                    sharedContractPath: sharedContractPath ?? curr.sharedContractPath,
                    requirement: buildNextRequirement(curr.requirement),
                    steps: nextCombined,
                    events: warningLogText
                      ? [...curr.events, { at: now, text: warningLogText }]
                      : curr.events,
                  };
                },
                { text: `已追加 ${rawSteps.length} 张任务卡（${addedIds}）` },
              );
            }

            const steps = unlockReadySteps(attachLintWarnings(rawSteps, lintResult.warningsByStep));

            return await store.update(
              scope,
              (curr) => ({
                ...curr,
                projectId,
                parentThreadId,
                planTitle: input.planTitle?.trim() || steps[0]?.title || "协作任务计划",
                mode: input.mode ?? curr.mode,
                prdSource: input.prdSource?.trim() ?? curr.prdSource,
                sharedContractPath: sharedContractPath ?? curr.sharedContractPath,
                requirement: buildNextRequirement(curr.requirement),
                config: {
                  ...curr.config,
                  ...(input.requireProductAcceptance !== undefined
                    ? { requireProductAcceptance: input.requireProductAcceptance }
                    : {}),
                },
                history: archiveCurrentPlan(curr, now),
                steps,
                runs: {},
                escalations: [],
                events: warningLogText
                  ? [...curr.events, { at: now, text: warningLogText }]
                  : curr.events,
              }),
              {
                text: `已发布 ${steps.length} 步协作任务卡（已解锁：${steps
                  .filter((s) => s.status === "ready")
                  .map((s) => s.id)
                  .join("、")}）`,
              },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      updateStep: (input) =>
        Effect.tryPromise({
          try: async () => {
            const scope = makeScope(input.projectRoot, input.threadId);
            return await store.update(
              scope,
              (curr) => {
                const exists = curr.steps.some((s) => s.id === input.stepId);
                if (!exists) throw new Error(`未找到任务步：${input.stepId}`);
                const patchedSteps = curr.steps.map((s) =>
                  s.id === input.stepId ? applyTaskSpecPatch(s, input.patch).next : s,
                );
                const lintResult = lintDispatchPlan(patchedSteps);
                if (lintResult.errors.length > 0) {
                  throw new Error(
                    `任务卡校验未通过：\n${lintResult.errors.map((e) => `- ${e}`).join("\n")}`,
                  );
                }
                const nextSteps = unlockReadySteps(
                  attachLintWarnings(patchedSteps, lintResult.warningsByStep),
                );
                return {
                  ...curr,
                  steps: nextSteps,
                };
              },
              { stepId: input.stepId, text: `已更新任务卡 ${input.stepId} 配置` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      dispatchStep: (input) =>
        Effect.tryPromise({
          try: () => launchSingleStep(input),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      dispatchStepsParallel: (input) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(input.projectRoot);
            const scopeThreadId = resolveScopeThreadId(input.threadId, input.parentThreadId);
            const scope = makeScope(workspaceRoot, scopeThreadId);
            const current = await store.read(scope);
            const isRunnable = (status: DispatchStepStatus) =>
              status === "ready" ||
              status === "cancelled" ||
              status === "premise_failed" ||
              status === "boundary_violation" ||
              status === "hard_gate_failed";
            const isActive = (status: DispatchStepStatus) =>
              status === "running" ||
              status === "reviewing" ||
              status === "fixing_review" ||
              status === "fixing_acceptance" ||
              status === "awaiting_product_acceptance";

            const targets =
              input.stepIds && input.stepIds.length > 0
                ? current.steps.filter(
                    (s) =>
                      input.stepIds!.includes(s.id) && s.status !== "done" && !isActive(s.status),
                  )
                : current.steps.filter((s) => isRunnable(s.status));

            if (targets.length === 0) {
              throw new Error("当前没有可启动的任务步");
            }
            if (targets.length > 1 && targets.some((s) => s.executor === "self")) {
              throw new Error(
                "并行启动不支持指派给「当前对话 (self)」的步骤，请先将其执行 AI 切换为子代理",
              );
            }

            let latestState = current;
            const forceWorktree = targets.length > 1;
            for (const step of targets) {
              latestState = await launchSingleStep({
                projectRoot: workspaceRoot,
                threadId: scopeThreadId,
                stepId: step.id,
                parentThreadId: scopeThreadId,
                forceUnlock: true,
                forceWorktree,
              });
            }
            return latestState;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      unlockAllSteps: (projectRoot, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const scope = makeScope(projectRoot, threadId);
            const now = new Date().toISOString();
            return await store.update(
              scope,
              (curr) => ({
                ...curr,
                steps: curr.steps.map((s) =>
                  s.status === "locked" ? { ...s, status: "ready", updatedAt: now } : s,
                ),
              }),
              { text: "已解锁全部待执行步骤，可自由并行派发" },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      cancelStep: (projectRoot, stepId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(projectRoot);
            const scope = makeScope(workspaceRoot, threadId);
            const key = activeKey(workspaceRoot, stepId, threadId);
            const controller = activeControllers.get(key);
            if (controller) {
              controller.abort();
              activeControllers.delete(key);
            }
            activeDirectRuns.delete(key);
            const curr = await store.read(scope);

            if (stepId === "__blind_check__") {
              if (curr.blindCheck?.checkerThreadId && curr.projectId) {
                await runPromise(
                  threadManagement
                    .interruptThread({
                      projectId: ProjectId.make(curr.projectId),
                      commandId: newCommandId("vela-dispatch-stop-blind"),
                      threadId: ThreadId.make(curr.blindCheck.checkerThreadId),
                      reason: "用户中止了只读代码盲审",
                    })
                    .pipe(Effect.ignore),
                );
              }
              const now = new Date().toISOString();
              return await store.update(
                scope,
                (state) => ({
                  ...state,
                  blindCheck:
                    state.steps.length === 0
                      ? null
                      : state.blindCheck
                        ? {
                            ...state.blindCheck,
                            status: "failed",
                            error: "已手动中止盲审",
                            updatedAt: now,
                          }
                        : null,
                }),
                { text: "已手动中止只读代码盲审" },
              );
            }

            const run = curr.runs[stepId];
            if (run?.childThreadId && curr.projectId) {
              await runPromise(
                threadManagement
                  .interruptThread({
                    projectId: ProjectId.make(curr.projectId),
                    commandId: newCommandId("vela-dispatch-stop"),
                    threadId: ThreadId.make(run.childThreadId),
                    reason: "用户中止了该协作任务步",
                  })
                  .pipe(Effect.ignore),
              );
            }
            const now = new Date().toISOString();
            return await store.update(
              scope,
              (state) => {
                const r = state.runs[stepId];
                return {
                  ...state,
                  steps: state.steps.map((s) =>
                    s.id === stepId && s.status !== "done"
                      ? { ...s, status: "ready", updatedAt: now }
                      : s,
                  ),
                  runs: r
                    ? {
                        ...state.runs,
                        [stepId]: {
                          ...r,
                          status: "cancelled",
                          headline: "已手动中止，可重新派发或撤回本步",
                          updatedAt: now,
                        },
                      }
                    : state.runs,
                };
              },
              { stepId, text: `已中止任务步 ${stepId}` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      replyEscalation: (input) =>
        Effect.tryPromise({
          try: async () => {
            const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const current = await store.read(scope);
            const esc = current.escalations.find((e) => e.id === input.escalationId);
            if (!esc) throw new Error(`未找到工单：${input.escalationId}`);
            const step = current.steps.find((s) => s.id === esc.stepId);
            if (!step) throw new Error(`未找到工单关联的任务步：${esc.stepId}`);
            const run = current.runs[step.id];
            const now = new Date().toISOString();

            const { next: patchedStep, patchedFields } = applyTaskSpecPatch(
              step,
              input.taskSpecPatch,
            );

            // Special shortcut when human chooses to accept despite review/acceptance limit.
            if (input.selectedOptionId === "accept_anyway") {
              return await store.update(
                scope,
                (curr) => ({
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === step.id ? { ...patchedStep, status: "ready_to_accept", updatedAt: now } : s,
                  ),
                  runs: run
                    ? {
                        ...curr.runs,
                        [step.id]: {
                          ...run,
                          status: "ready_to_accept",
                          headline: "已由人工拍板放行，等待确认验收",
                          lastError: null,
                          updatedAt: now,
                        },
                      }
                    : curr.runs,
                  escalations: curr.escalations.map((e) =>
                    e.id === esc.id
                      ? {
                          ...e,
                          status: "resolved",
                          resolution: {
                            resolvedBy: input.resolvedBy,
                            decision: input.decision,
                            selectedOptionId: input.selectedOptionId,
                            resolvedAt: now,
                          },
                          updatedAt: now,
                        }
                      : e,
                  ),
                }),
                { stepId: step.id, text: `工单 ${esc.id} 已放行进入待验收确认` },
              );
            }

            const nextState = await store.update(
              scope,
              (curr) => ({
                ...curr,
                steps: curr.steps.map((s) =>
                  s.id === step.id ? { ...patchedStep, status: "running", updatedAt: now } : s,
                ),
                runs: run
                  ? {
                      ...curr.runs,
                      [step.id]: {
                        ...run,
                        status: "running",
                        headline: `已收到${input.resolvedBy === "human" ? "用户" : "主控"}决定，正在原执行子线程续跑...`,
                        lastError: null,
                        updatedAt: now,
                      },
                    }
                  : curr.runs,
                escalations: curr.escalations.map((e) =>
                  e.id === esc.id
                    ? {
                        ...e,
                        status: "resolved",
                        resolution: {
                          resolvedBy: input.resolvedBy,
                          decision: input.decision,
                          ...(input.selectedOptionId
                            ? { selectedOptionId: input.selectedOptionId }
                            : {}),
                          resolvedAt: now,
                        },
                        updatedAt: now,
                      }
                    : e,
                ),
              }),
              {
                stepId: step.id,
                text: `${input.resolvedBy === "human" ? "用户" : "主控"}已答复工单 ${esc.id}，恢复原执行子线程续跑`,
              },
            );

            if (!run?.childThreadId) {
              return nextState;
            }

            const replyPrompt = buildEscalationReplyPrompt({
              task: patchedStep,
              decision: input.decision,
              resolvedBy: input.resolvedBy,
              patchedFields,
            });

            const replyParentTid = resolveSubagentParentThreadId(
              nextState.parentThreadId ?? input.threadId,
            );
            launchStepBackground(
              workspaceRoot,
              input.threadId,
              step.id,
              async (signal) => {
                const sent = await runPromise(
                  threadManagement.sendToThread({
                    projectId,
                    commandId: newCommandId("vela-dispatch-resume"),
                    threadId: ThreadId.make(run.childThreadId!),
                    messageId: newMessageId(),
                    ...(replyParentTid ? { senderThreadId: replyParentTid } : {}),
                    text: replyPrompt,
                    attachments: [],
                    mode: "auto",
                    createdBy: input.resolvedBy === "human" ? "user" : "agent",
                    creationSource: "mcp",
                  }),
                );

                await store.update(scope, (curr) => {
                  const r = curr.runs[step.id];
                  if (!r) return curr;
                  return {
                    ...curr,
                    runs: {
                      ...curr.runs,
                      [step.id]: {
                        ...r,
                        childRunId: sent.run.id,
                        updatedAt: new Date().toISOString(),
                      },
                    },
                  };
                });

                const waitRes = await waitForThreadRun({
                  projectId,
                  threadId: ThreadId.make(run.childThreadId!),
                  runId: sent.run.id,
                  signal,
                });
                if (waitRes.aborted) return;

                await runPostExecutionPipeline({
                  projectRoot: workspaceRoot,
                  threadId: input.threadId,
                  projectId,
                  stepId: step.id,
                  assistantText: waitRes.assistantText,
                  runStatus: waitRes.status,
                  signal,
                });
              },
              { isDirectWrite: (step.kind ?? "change") === "change" && run.isolation === "direct" },
            );

            return nextState;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      escalateToHuman: (input) =>
        Effect.tryPromise({
          try: async () => {
            const scope = makeScope(input.projectRoot, input.threadId);
            const now = new Date().toISOString();
            return await store.update(
              scope,
              (curr) => {
                const esc = curr.escalations.find((e) => e.id === input.escalationId);
                if (!esc) throw new Error(`未找到工单：${input.escalationId}`);
                const run = curr.runs[esc.stepId];
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === esc.stepId
                      ? { ...s, status: "needs_human_decision", updatedAt: now }
                      : s,
                  ),
                  runs: run
                    ? {
                        ...curr.runs,
                        [esc.stepId]: {
                          ...run,
                          status: "needs_human_decision",
                          headline: `等待你拍板：${esc.title}`,
                          updatedAt: now,
                        },
                      }
                    : curr.runs,
                  escalations: curr.escalations.map((e) =>
                    e.id === esc.id
                      ? {
                          ...e,
                          status: "open_human",
                          analysis: input.analysis,
                          humanPrompt: input.humanPrompt,
                          ...(input.options && input.options.length > 0
                            ? { options: [...input.options] }
                            : {}),
                          updatedAt: now,
                        }
                      : e,
                  ),
                };
              },
              { text: `工单 ${input.escalationId} 已升级交由用户拍板` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      submitAcceptance: (input) =>
        Effect.tryPromise({
          try: async () => {
            const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const current = await store.read(scope);
            const step = current.steps.find((s) => s.id === input.stepId);
            if (!step) throw new Error(`未找到任务步：${input.stepId}`);
            const run = current.runs[step.id];
            if (!run) throw new Error(`任务步 ${step.id} 尚未执行`);

            const failedItems = input.items.filter((item) => item.status === "failed");
            const passed = failedItems.length === 0;
            const round = run.acceptanceRound + 1;
            const now = new Date().toISOString();

            const report: DispatchAcceptanceReport = {
              round,
              passed,
              summary: input.summary,
              items: [...input.items],
              submittedAt: now,
            };

            if (passed) {
              return await store.update(
                scope,
                (curr) => {
                  const r = curr.runs[step.id]!;
                  return {
                    ...curr,
                    steps: curr.steps.map((s) =>
                      s.id === step.id ? { ...s, status: "ready_to_accept", updatedAt: now } : s,
                    ),
                    runs: {
                      ...curr.runs,
                      [step.id]: {
                        ...r,
                        status: "ready_to_accept",
                        acceptanceRound: round,
                        acceptanceReports: [...r.acceptanceReports, report],
                        headline: "主控产品验收通过，等待你最终确认并解锁下一步",
                        lastError: null,
                        updatedAt: now,
                      },
                    },
                  };
                },
                { stepId: step.id, text: `第 ${round} 轮产品验收通过，进入待确认状态` },
              );
            }

            // Failed -> check circuit breaker
            if (round >= current.config.maxAcceptanceRounds || !run.childThreadId) {
              await store.update(scope, (curr) => {
                const r = curr.runs[step.id]!;
                return {
                  ...curr,
                  runs: {
                    ...curr.runs,
                    [step.id]: {
                      ...r,
                      acceptanceRound: round,
                      acceptanceReports: [...r.acceptanceReports, report],
                      updatedAt: now,
                    },
                  },
                };
              });
              const { state } = await createEscalationAndSave({
                projectRoot: workspaceRoot,
                threadId: input.threadId,
                projectId,
                step,
                kind: "acceptance_limit",
                title: `${step.id} 产品验收 ${round} 轮仍未通过`,
                question: input.summary,
                factsFound: failedItems
                  .map((f) => `${f.criterion}：${f.reason}${f.fixHint ? `（${f.fixHint}）` : ""}`)
                  .join("\n"),
                forceHuman: true,
                options: [
                  { id: "accept_anyway", label: "先放行，进入待确认验收" },
                  { id: "retry_fix", label: "继续让原执行子线程返修" },
                ],
                targetStatus: "needs_human_decision",
              });
              return state;
            }

            // Automatically send acceptance fix prompt back to original executor child thread!
            const nextState = await store.update(
              scope,
              (curr) => {
                const r = curr.runs[step.id]!;
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === step.id ? { ...s, status: "fixing_acceptance", updatedAt: now } : s,
                  ),
                  runs: {
                    ...curr.runs,
                    [step.id]: {
                      ...r,
                      status: "fixing_acceptance",
                      acceptanceRound: round,
                      acceptanceReports: [...r.acceptanceReports, report],
                      headline: `产品验收发现 ${failedItems.length} 项未通过，原执行子线程自动返修中...`,
                      updatedAt: now,
                    },
                  },
                };
              },
              {
                stepId: step.id,
                text: `第 ${round} 轮产品验收发现 ${failedItems.length} 项未通过，自动打回原执行子线程返修`,
              },
            );

            const childThreadId = run.childThreadId;
            const acceptParentTid = resolveSubagentParentThreadId(
              nextState.parentThreadId ?? input.threadId,
            );
            launchStepBackground(
              workspaceRoot,
              input.threadId,
              step.id,
              async (signal) => {
                const sent = await runPromise(
                  threadManagement.sendToThread({
                    projectId,
                    commandId: newCommandId("vela-dispatch-accept-fix"),
                    threadId: ThreadId.make(childThreadId),
                    messageId: newMessageId(),
                    ...(acceptParentTid ? { senderThreadId: acceptParentTid } : {}),
                    text: buildAcceptanceFixPrompt({ task: step, failedItems, round }),
                    attachments: [],
                    mode: "auto",
                    createdBy: "agent",
                    creationSource: "mcp",
                  }),
                );

                await store.update(scope, (curr) => {
                  const r = curr.runs[step.id];
                  if (!r) return curr;
                  return {
                    ...curr,
                    runs: {
                      ...curr.runs,
                      [step.id]: {
                        ...r,
                        childRunId: sent.run.id,
                        updatedAt: new Date().toISOString(),
                      },
                    },
                  };
                });

                const waitRes = await waitForThreadRun({
                  projectId,
                  threadId: ThreadId.make(childThreadId),
                  runId: sent.run.id,
                  signal,
                });
                if (waitRes.aborted) return;

                await runPostExecutionPipeline({
                  projectRoot: workspaceRoot,
                  threadId: input.threadId,
                  projectId,
                  stepId: step.id,
                  assistantText: waitRes.assistantText,
                  runStatus: waitRes.status,
                  signal,
                });
              },
              { isDirectWrite: (step.kind ?? "change") === "change" && run.isolation === "direct" },
            );

            return nextState;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      skipAcceptance: (projectRoot, stepId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const scope = makeScope(projectRoot, threadId);
            const now = new Date().toISOString();
            return await store.update(
              scope,
              (curr) => {
                const r = curr.runs[stepId];
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === stepId ? { ...s, status: "ready_to_accept", updatedAt: now } : s,
                  ),
                  runs: r
                    ? {
                        ...curr.runs,
                        [stepId]: {
                          ...r,
                          status: "ready_to_accept",
                          headline: "已跳过主控产品验收，等待确认验收",
                          updatedAt: now,
                        },
                      }
                    : curr.runs,
                };
              },
              { stepId, text: `已跳过 ${stepId} 产品验收，直接进入待确认` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      completeSelfStep: (input) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const current = await store.read(scope);
            const step = current.steps.find((s) => s.id === input.stepId);
            if (!step) throw new Error(`未找到任务步：${input.stepId}`);
            if (step.status === "locked") throw new Error(`任务步 ${step.id} 尚未解锁`);

            const diffSummary = await inspectWorkspaceDelta(workspaceRoot, null);
            const boundaryAudit = auditPathBoundaries(diffSummary.changedFiles, {
              allowedGlobs: step.allowedGlobs,
              forbiddenGlobs: step.forbiddenGlobs,
              sensitiveGlobs: [...current.config.defaultSensitiveGlobs, ...step.sensitiveGlobs],
            });
            const gateCommands = partitionHardGates([
              ...current.config.defaultHardGates,
              ...step.hardGates,
            ]).commands;
            const hardGate = await runHardGates(workspaceRoot, gateCommands);

            const now = new Date().toISOString();
            const ok = boundaryAudit.ok && hardGate.ok;
            const status: DispatchStepStatus = !boundaryAudit.ok
              ? "boundary_violation"
              : !hardGate.ok
                ? "hard_gate_failed"
                : "done";

            const nextSteps = current.steps.map((s) =>
              s.id === step.id ? { ...s, status, updatedAt: now } : s,
            );
            const unlockedSteps = ok ? unlockReadySteps(nextSteps) : nextSteps;

            if (ok) {
              await store.appendLedger(
                scope,
                `## ${step.id} ${step.title} (self)\n- 时间：${now}\n- 摘要：${input.summary}\n- 改动文件：${diffSummary.changedFiles.join(", ") || "无"}`,
              );
            }

            return await store.update(
              scope,
              (curr) => ({
                ...curr,
                steps: unlockedSteps,
                runs: {
                  ...curr.runs,
                  [step.id]: {
                    stepId: step.id,
                    isolation: "direct",
                    branchName: "current",
                    baseCommit: "",
                    baselineTree: null,
                    workspacePath: workspaceRoot,
                    childThreadId: curr.parentThreadId,
                    childRunId: null,
                    reviewerThreadIds: [],
                    status,
                    headline: ok ? `主控已完成：${input.summary}` : "自执行步骤校验未通过",
                    lastError: ok ? null : !boundaryAudit.ok ? "改动越界" : "Hard Gate 未通过",
                    premiseFailures: [],
                    diffSummary,
                    boundaryAudit,
                    hardGate,
                    reviews: [],
                    acceptanceReports: [],
                    escalationRounds: 0,
                    reviewRound: 0,
                    acceptanceRound: 0,
                    startedAt: now,
                    updatedAt: now,
                  },
                },
              }),
              {
                stepId: step.id,
                text: ok ? `主控自执行 ${step.id} 已通过检查并解锁下一步` : `主控自执行 ${step.id} 未通过检查`,
              },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      acceptStep: (projectRoot, stepId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(projectRoot);
            const scope = makeScope(workspaceRoot, threadId);
            const current = await store.read(scope);
            const step = current.steps.find((s) => s.id === stepId);
            if (!step) throw new Error(`未找到任务步：${stepId}`);
            const run = current.runs[stepId];
            const now = new Date().toISOString();
            let mergeNote = "";
            if (
              run?.isolation === "worktree" &&
              run.workspacePath &&
              normalizeProjectRoot(run.workspacePath) !== workspaceRoot
            ) {
              const merged = await applyWorktreeDeltaToWorkspace(run.workspacePath, workspaceRoot);
              mergeNote =
                merged.appliedFiles.length > 0
                  ? `（已合并 Worktree 改动 ${merged.appliedFiles.length} 个文件回当前分支）`
                  : "（Worktree 无新增文件改动）";
            }

            const deliverableExcerpt = run?.deliverable?.text?.trim().slice(0, 600);
            await store.appendLedger(
              scope,
              [
                `## ${step.id} ${step.title}`,
                `- 时间：${now}`,
                `- 模式：${run?.isolation ?? step.isolation}`,
                `- 改动文件：${run?.diffSummary?.changedFiles.join(", ") || "无"}`,
                ...(deliverableExcerpt ? [`- 产出摘要：\n${deliverableExcerpt}`] : []),
              ].join("\n"),
            );

            const updated = await store.update(
              scope,
              (curr) => {
                const updatedSteps = curr.steps.map((s) =>
                  s.id === stepId ? { ...s, status: "done" as const, updatedAt: now } : s,
                );
                const unlocked = unlockReadySteps(updatedSteps);
                const r = curr.runs[stepId];
                return {
                  ...curr,
                  steps: unlocked,
                  runs: r
                    ? {
                        ...curr.runs,
                        [stepId]: {
                          ...r,
                          status: "done",
                          headline: `已确认验收并解锁下一步${mergeNote}`,
                          updatedAt: now,
                        },
                      }
                    : curr.runs,
                  escalations: curr.escalations.map((e) =>
                    e.stepId === stepId &&
                    (e.status === "open_orchestrator" || e.status === "open_human")
                      ? { ...e, status: "dismissed", updatedAt: now }
                      : e,
                  ),
                };
              },
              { stepId, text: `已确认验收 ${stepId}${mergeNote}，后续步骤已解锁` },
            );
            await notifyParentPlanCompleted(updated, step);
            return updated;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      decideStep: (input) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const current = await store.read(scope);
            const step = current.steps.find((s) => s.id === input.stepId);
            if (!step) throw new Error(`未找到任务步：${input.stepId}`);
            if ((step.kind ?? "change") !== "decision") {
              throw new Error(`只有决策卡（decision）支持直接拍板：${step.id}`);
            }
            if (step.status !== "ready" && step.status !== "awaiting_decision") {
              throw new Error(`任务步 ${step.id} 当前状态（${step.status}）不可拍板`);
            }

            const selectedOptionId = input.selectedOptionId?.trim() || undefined;
            const decisionText = input.decision?.trim() ?? "";
            if (!selectedOptionId && !decisionText) {
              throw new Error("请至少选择一个选项或填写决策说明");
            }

            const selectedOption = selectedOptionId
              ? step.decisionOptions?.find((o) => o.id === selectedOptionId)
              : undefined;
            const optionLine = selectedOption
              ? selectedOption.description?.trim()
                ? `选择：${selectedOption.label}（${selectedOption.description.trim()}）`
                : `选择：${selectedOption.label}`
              : selectedOptionId
                ? `选择：${selectedOptionId}`
                : "";
            const combinedText = optionLine
              ? decisionText && decisionText !== selectedOption?.label
                ? `${optionLine}\n补充：${decisionText}`
                : optionLine
              : decisionText;

            const now = new Date().toISOString();
            const deliverable: DispatchDeliverable = {
              kind: "decision",
              text: combinedText.slice(0, MAX_DELIVERABLE_CHARS),
              ...(selectedOptionId ? { selectedOptionId } : {}),
              producedAt: now,
            };

            await store.appendLedger(
              scope,
              `## ${step.id} ${step.title} (decision)\n- 时间：${now}\n${deliverable.text}`,
            );

            const summaryLabel = selectedOption?.label ?? decisionText.slice(0, 40);
            const updated = await store.update(
              scope,
              (curr) => {
                const updatedSteps = curr.steps.map((s) =>
                  s.id === step.id ? { ...s, status: "done" as const, updatedAt: now } : s,
                );
                const unlocked = unlockReadySteps(updatedSteps);
                const existingRun = curr.runs[step.id];
                const nextRun: DispatchStepRun = existingRun
                  ? {
                      ...existingRun,
                      status: "done",
                      deliverable,
                      headline: `已拍板：${summaryLabel}`,
                      lastError: null,
                      updatedAt: now,
                    }
                  : {
                      stepId: step.id,
                      isolation: "direct",
                      branchName: "current",
                      baseCommit: "",
                      baselineTree: null,
                      workspacePath: workspaceRoot,
                      childThreadId: curr.parentThreadId,
                      childRunId: null,
                      reviewerThreadIds: [],
                      status: "done",
                      headline: `已拍板：${summaryLabel}`,
                      lastError: null,
                      premiseFailures: [],
                      diffSummary: null,
                      boundaryAudit: null,
                      hardGate: null,
                      reviews: [],
                      acceptanceReports: [],
                      deliverable,
                      escalationRounds: 0,
                      reviewRound: 0,
                      acceptanceRound: 0,
                      startedAt: now,
                      updatedAt: now,
                    };
                return {
                  ...curr,
                  steps: unlocked,
                  runs: {
                    ...curr.runs,
                    [step.id]: nextRun,
                  },
                  escalations: curr.escalations.map((e) =>
                    e.stepId === step.id &&
                    (e.status === "open_orchestrator" || e.status === "open_human")
                      ? { ...e, status: "dismissed", updatedAt: now }
                      : e,
                  ),
                };
              },
              { stepId: step.id, text: `已拍板 ${step.id}（${summaryLabel}），后续步骤已解锁` },
            );
            await notifyParentPlanCompleted(updated, step);
            return updated;
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      deleteStep: (projectRoot, stepId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(projectRoot);
            const scope = makeScope(workspaceRoot, threadId);
            const current = await store.read(scope);
            const target = current.steps.find((s) => s.id === stepId);
            if (!target) throw new Error(`未找到任务步：${stepId}`);
            if (BUSY_STEP_STATUSES.has(target.status)) {
              throw new Error(`任务步 ${stepId} 正在执行中，请先中止后再删除`);
            }

            const now = new Date().toISOString();
            return await store.update(
              scope,
              (curr) => {
                const remaining = curr.steps
                  .filter((s) => s.id !== stepId)
                  .map((s) =>
                    s.dependsOn !== undefined
                      ? {
                          ...s,
                          dependsOn: s.dependsOn.filter((id) => id !== stepId),
                          updatedAt: s.dependsOn.includes(stepId) ? now : s.updatedAt,
                        }
                      : s,
                  );
                const lintResult = lintDispatchPlan(remaining);
                const nextSteps = unlockReadySteps(
                  attachLintWarnings(remaining, lintResult.warningsByStep),
                );
                const { [stepId]: _removedRun, ...restRuns } = curr.runs;
                return {
                  ...curr,
                  steps: nextSteps,
                  runs: restRuns,
                  escalations: curr.escalations.filter((e) => e.stepId !== stepId),
                };
              },
              { stepId, text: `已删除任务步 ${stepId}` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      revertStep: (projectRoot, stepId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(projectRoot);
            const scope = makeScope(workspaceRoot, threadId);
            const key = activeKey(workspaceRoot, stepId, threadId);
            const controller = activeControllers.get(key);
            if (controller) {
              controller.abort();
              activeControllers.delete(key);
            }
            activeDirectRuns.delete(key);

            const current = await store.read(scope);
            const step = current.steps.find((s) => s.id === stepId);
            if (!step) throw new Error(`未找到任务步：${stepId}`);
            const run = current.runs[stepId];

            if (run?.childThreadId && current.projectId) {
              await runPromise(
                threadManagement
                  .interruptThread({
                    projectId: ProjectId.make(current.projectId),
                    commandId: newCommandId("vela-dispatch-revert-stop"),
                    threadId: ThreadId.make(run.childThreadId),
                    reason: "撤回任务步并回滚工作区",
                  })
                  .pipe(Effect.ignore),
              );
            }

            let revertNote = "已重置该任务步";
            if (run?.isolation === "direct" && run.baselineTree) {
              const reverted = await revertWorkspaceToSnapshot(workspaceRoot, run.baselineTree);
              revertNote = `已回滚 ${reverted.restoredFiles.length} 个文件、清理 ${reverted.removedFiles.length} 个新建文件`;
            }

            const now = new Date().toISOString();
            return await store.update(
              scope,
              (curr) => {
                const { [stepId]: _removed, ...restRuns } = curr.runs;
                return {
                  ...curr,
                  steps: curr.steps.map((s) =>
                    s.id === stepId ? { ...s, status: "ready", updatedAt: now } : s,
                  ),
                  runs: restRuns,
                  escalations: curr.escalations.map((e) =>
                    e.stepId === stepId &&
                    (e.status === "open_orchestrator" || e.status === "open_human")
                      ? { ...e, status: "dismissed", updatedAt: now }
                      : e,
                  ),
                };
              },
              { stepId, text: `撤回 ${stepId}：${revertNote}` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      clearPlan: (projectRoot, threadId) =>
        Effect.promise(async () => {
          const workspaceRoot = normalizeProjectRoot(projectRoot);
          const scope = makeScope(workspaceRoot, threadId);
          const scopePrefix = `${normalizeDispatchScope(scope).key}::`;
          for (const [key, ctrl] of activeControllers.entries()) {
            if (key.startsWith(scopePrefix)) {
              ctrl.abort();
              activeControllers.delete(key);
              activeDirectRuns.delete(key);
            }
          }
          return await store.update(scope, (curr) => {
            const now = new Date().toISOString();
            const history = archiveCurrentPlan(curr, now);
            return {
              ...createEmptyDispatchState(workspaceRoot, threadId),
              projectId: curr.projectId,
              config: curr.config,
              history,
            };
          });
        }),

      deleteArchivedPlan: (projectRoot, archiveId, threadId) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(projectRoot);
            const scope = makeScope(workspaceRoot, threadId);
            const targetId = archiveId.trim();
            if (!targetId) {
              return await store.read(scope);
            }
            const current = await store.read(scope);
            const existingHistory = current.history ?? [];
            if (!existingHistory.some((item) => item.id === targetId)) {
              return current;
            }
            return await store.update(
              scope,
              (curr) => ({
                ...curr,
                history: (curr.history ?? []).filter((item) => item.id !== targetId),
              }),
              { text: `已删除历史归档计划 ${targetId}` },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      kickoffPlan: (input) =>
        Effect.tryPromise({
          try: async () => {
            const { projectId, workspaceRoot } = await resolveProject(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const tid = ThreadId.make(input.threadId);
            const deliver = input.deliver === "client" ? "client" : "server";

            if (deliver === "server") {
              const shell = await runPromise(
                threadManagement.getThreadShell(tid).pipe(Effect.orElseSucceed(() => null)),
              );
              if (!shell) {
                throw new Error("当前对话还没有创建（尚未发送过消息），请先发送一条消息或刷新后重试");
              }
            }

            const req = input.requirement?.trim();
            const now = new Date().toISOString();

            const commonRules = [
              "拆单必须严格遵守以下规则：",
              "1. 仅拆解当前对话**最近一轮对齐、尚未落地**的需求，忽略前面已完成或无关的讨论；若存在多个未决话题或范围不清，请先反问用户确认，不要直接发布。",
              "2. 调用 `publish` 时必须传入 `requirementSummary`（3~8 行，写清「做什么 / 不做什么」）。",
              "3. 每张任务卡都必须明确设置 `kind`：调研、排查、核对类任务用 `research`（只读，产出结论报告，禁止改文件）；需要用户选方案的用 `decision`（已知选项直接填 `decisionOptions`，未知时留空让执行代理只读调研后提出 2~4 个选项）；只有真的要修改代码/文档/配置才用 `change`。**严禁把非开发任务包装成 `change`。**",
              "4. `change` 卡必须填写 `acceptanceCriteria`，尽量填写 `allowedGlobs`；`hardGates` 只放可执行终端命令（如 `vp run typecheck`），文字约束放 `contractNote`。",
              "5. 互相独立的模块设 `dependsOn: []` 以便同时解锁并行执行，有先后依赖的才填前置 `stepId`；未指定专用模型时省略 `executor` 与 `reviewer`；发布后停下等用户在右侧面板确认或派发，不要自动开跑。",
            ];

            const prompt =
              input.mode === "strict"
                ? [
                    req
                      ? `请使用 Vela 任务派发严谨模式处理以下需求：\n\n${req}`
                      : "请基于我们当前对话最近一轮对齐且尚未落地的需求，启用 Vela 任务派发严谨模式推进。",
                    "",
                    "请先调用 `vela_dispatch_plan`（`action: \"blind_check\"`）只传客观需求与技术背景启动只读盲审（如无特殊指定请省略 `checker` 字段以沿用用户选定的默认 AI）；等盲审返回后与你的方案对比确认，再调用 `vela_dispatch_plan`（`action: \"publish\"`）发布任务卡。",
                    "",
                    ...commonRules,
                  ].join("\n")
                : [
                    req
                      ? `请把以下需求拆解为结构化任务卡发布到 Vela 任务派发面板：\n\n${req}`
                      : "请把我们当前对话最近一轮对齐、尚未落地的方案拆解为有序的结构化任务卡，发布到 Vela 任务派发面板。",
                    "",
                    "请直接调用 `vela_dispatch_plan`（`action: \"publish\"`），不要启动 `blind_check` 子代理，也不要自动调用 `vela_dispatch_step` 开跑。",
                    "",
                    ...commonRules,
                  ].join("\n");

            await store.update(
              scope,
              (curr) => ({
                ...curr,
                projectId,
                parentThreadId: input.threadId,
                mode: input.mode,
                requirement: {
                  userInput: req || undefined,
                  capturedAt: now,
                },
                ...(input.defaultAgent !== undefined
                  ? {
                      config: {
                        ...curr.config,
                        defaultAgent: input.defaultAgent,
                      },
                    }
                  : {}),
              }),
              {
                text:
                  input.mode === "strict"
                    ? "已向当前对话发送「先盲审再拆单」指令"
                    : "已向当前对话发送「拆单上板」指令",
              },
            );

            if (deliver === "client") {
              return { ok: true as const, prompt };
            }

            await runPromise(
              threadManagement.sendToThread({
                projectId,
                commandId: newCommandId("vela-dispatch-kickoff"),
                threadId: tid,
                messageId: newMessageId(),
                text: prompt,
                attachments: [],
                mode: "auto",
                createdBy: "user",
                creationSource: "web",
              }),
            );

            return { ok: true as const };
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),

      updateConfig: (input) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = normalizeProjectRoot(input.projectRoot);
            const scope = makeScope(workspaceRoot, input.threadId);
            const current = await store.read(scope);
            const providers = await runPromise(providerRegistry.getProviders);
            const now = new Date().toISOString();
            const resolvedFallback = await resolveDefaultAgentTarget({
              parentThreadId: input.threadId ?? current.parentThreadId,
              configDefault: input.defaultAgent,
              providers,
            });
            const label = input.defaultAgent
              ? input.defaultAgent.model
                ? `${input.defaultAgent.providerInstanceId} · ${input.defaultAgent.model}`
                : input.defaultAgent.providerInstanceId
              : "跟随当前对话";

            return await store.update(
              scope,
              (curr) => {
                const nextConfig = {
                  ...curr.config,
                  ...(input.defaultAgent !== undefined ? { defaultAgent: input.defaultAgent } : {}),
                };
                const nextSteps = input.applyToPendingSteps
                  ? curr.steps.map((s) => {
                      const busy =
                        s.status === "done" ||
                        s.status === "running" ||
                        s.status === "reviewing" ||
                        s.status === "fixing_review" ||
                        s.status === "fixing_acceptance";
                      if (busy) return s;
                      return {
                        ...s,
                        executor: resolvedFallback,
                        reviewer: s.reviewer === null ? null : resolvedFallback,
                        updatedAt: now,
                      };
                    })
                  : curr.steps;
                return {
                  ...curr,
                  config: nextConfig,
                  steps: nextSteps,
                };
              },
              {
                text: input.applyToPendingSteps
                  ? `已将默认 AI 及待执行步骤切换为：${label}`
                  : `已将默认派发 AI 设为：${label}`,
              },
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
    };
  }),
);
