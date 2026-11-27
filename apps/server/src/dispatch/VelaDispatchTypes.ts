import type { CollabAttentionReason } from "@t3tools/contracts";

export type DispatchIsolationMode = "direct" | "worktree";

export type DispatchStepKind = "research" | "decision" | "change"; // 调研/排查(只读) | 决策(用户拍板) | 改动(代码/文档/配置)

export type DispatchStepStatus =
  | "locked"
  | "ready"
  | "running"
  | "awaiting_decision"
  | "premise_failed"
  | "waiting_orchestrator"
  | "needs_human_decision"
  | "boundary_violation"
  | "hard_gate_failed"
  | "reviewing"
  | "fixing_review"
  | "awaiting_product_acceptance"
  | "fixing_acceptance"
  | "ready_to_accept"
  | "done"
  | "cancelled";

export interface DispatchAgentOptionSelection {
  readonly id: string;
  readonly value: string | boolean;
}

export interface DispatchAgentTarget {
  readonly providerInstanceId: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly options?:
    | ReadonlyArray<DispatchAgentOptionSelection>
    | Readonly<Record<string, unknown>>
    | undefined;
}

export interface DispatchTaskCard {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly goal: string;
  readonly kind?: DispatchStepKind | undefined; // undefined 视为 "change"（兼容旧数据）
  readonly decisionOptions?: ReadonlyArray<DispatchEscalationOption> | undefined;
  readonly warnings?: ReadonlyArray<string> | undefined; // 发布校验产生的非阻断提示
  readonly isolation: DispatchIsolationMode;
  /** Prerequisite step IDs (`[]` = independent, unlocks immediately in parallel). */
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  /** Steps sharing the same parallelGroup unlock together (recommended with isolation: "worktree"). */
  readonly parallelGroup?: string | undefined;
  readonly premisesToVerify: ReadonlyArray<string>;
  readonly contextFiles: ReadonlyArray<string>;
  readonly contractNote?: string | undefined;
  readonly prdSource?: string | undefined;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly allowedGlobs: ReadonlyArray<string>;
  readonly forbiddenGlobs: ReadonlyArray<string>;
  readonly sensitiveGlobs: ReadonlyArray<string>;
  readonly hardGates: ReadonlyArray<string>;
  /** `"self"` means the orchestrator thread edits directly; otherwise a Vela provider target. */
  readonly executor: "self" | DispatchAgentTarget;
  /** Optional independent fresh-session reviewer; null disables review for this step. */
  readonly reviewer?: DispatchAgentTarget | null | undefined;
  readonly skipProductAcceptance?: boolean | undefined;
  readonly status: DispatchStepStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DispatchDiffSummary {
  readonly changedFiles: ReadonlyArray<string>;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface DispatchBoundaryAudit {
  readonly ok: boolean;
  readonly outOfScopeFiles: ReadonlyArray<string>;
  readonly forbiddenFiles: ReadonlyArray<string>;
  readonly sensitiveFiles: ReadonlyArray<string>;
}

export interface DispatchHardGateItem {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
}

export interface DispatchHardGateSummary {
  readonly ok: boolean;
  readonly results: ReadonlyArray<DispatchHardGateItem>;
  readonly logText: string;
}

export interface DispatchReviewIssue {
  readonly severity: "blocker" | "high" | "medium" | "low";
  readonly file?: string | undefined;
  readonly summary: string;
  readonly fixHint?: string | undefined;
}

export interface DispatchReviewVerdict {
  readonly round: number;
  readonly verdict: "pass" | "fail";
  readonly summary: string;
  readonly issues: ReadonlyArray<DispatchReviewIssue>;
  readonly reviewerThreadId?: string | undefined;
  readonly reviewedAt: string;
}

export type DispatchAcceptanceItemStatus = "passed" | "failed" | "manual_check";

export interface DispatchAcceptanceItem {
  readonly criterion: string;
  readonly status: DispatchAcceptanceItemStatus;
  readonly reason: string;
  readonly prdEvidence?: string | undefined;
  readonly codeEvidence?: string | undefined;
  readonly fixHint?: string | undefined;
}

export interface DispatchAcceptanceReport {
  readonly round: number;
  readonly passed: boolean;
  readonly summary: string;
  readonly items: ReadonlyArray<DispatchAcceptanceItem>;
  readonly submittedAt: string;
}

export interface DispatchPremiseFailure {
  readonly premise: string;
  readonly actual: string;
}

export type DispatchEscalationKind =
  | "premise_failed"
  | "executor_question"
  | "boundary_violation"
  | "hard_gate_failed"
  | "review_limit"
  | "acceptance_limit";

export interface DispatchEscalationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
}

export interface DispatchEscalationRecord {
  readonly id: string;
  readonly stepId: string;
  readonly kind: DispatchEscalationKind;
  readonly status: "open_orchestrator" | "open_human" | "resolved" | "dismissed";
  readonly title: string;
  readonly question: string;
  readonly factsFound?: string | undefined;
  readonly analysis?: string | undefined;
  readonly humanPrompt?: string | undefined;
  readonly options: ReadonlyArray<DispatchEscalationOption>;
  readonly resolution?: {
    readonly resolvedBy: "orchestrator" | "human";
    readonly decision: string;
    readonly selectedOptionId?: string | undefined;
    readonly resolvedAt: string;
  } | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DispatchDeliverable {
  readonly kind: "report" | "decision" | "change_summary";
  readonly text: string; // markdown，截断到 12000 字符
  readonly selectedOptionId?: string | undefined;
  readonly producedAt: string;
}

export interface DispatchStepRun {
  readonly stepId: string;
  readonly isolation: DispatchIsolationMode;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly baselineTree: string | null;
  readonly completedTree?: string | null | undefined;
  readonly workspacePath: string;
  readonly childThreadId: string | null;
  readonly childRunId: string | null;
  readonly reviewerThreadIds: ReadonlyArray<string>;
  readonly status: DispatchStepStatus;
  readonly headline: string;
  readonly lastError: string | null;
  readonly premiseFailures: ReadonlyArray<DispatchPremiseFailure>;
  readonly diffSummary: DispatchDiffSummary | null;
  readonly boundaryAudit: DispatchBoundaryAudit | null;
  readonly hardGate: DispatchHardGateSummary | null;
  readonly reviews: ReadonlyArray<DispatchReviewVerdict>;
  readonly acceptanceReports: ReadonlyArray<DispatchAcceptanceReport>;
  readonly deliverable?: DispatchDeliverable | null | undefined;
  readonly decisionAnalysis?: string | undefined;
  readonly recommendedOptionId?: string | undefined;
  readonly escalationRounds: number;
  readonly reviewRound: number;
  readonly acceptanceRound: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface DispatchBlindCheckRecord {
  readonly id: string;
  readonly rawUserInput: string;
  readonly background: string;
  readonly orchestratorProposal: string;
  readonly checker: DispatchAgentTarget;
  readonly checkerThreadId: string | null;
  readonly checkerFacts: string;
  readonly synthesis: string;
  readonly status: "running" | "ready_for_approval" | "approved" | "failed";
  readonly error?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DispatchConfig {
  readonly defaultAgent?: DispatchAgentTarget | null | undefined;
  readonly enableBatchAudit?: boolean | undefined;
  readonly maxReviewRounds: number;
  readonly maxOrchestratorEscalationRounds: number;
  readonly maxAcceptanceRounds: number;
  readonly defaultHardGates: ReadonlyArray<string>;
  readonly defaultSensitiveGlobs: ReadonlyArray<string>;
  readonly requireProductAcceptance: boolean;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  defaultAgent: null,
  maxReviewRounds: 2,
  maxOrchestratorEscalationRounds: 3,
  maxAcceptanceRounds: 2,
  defaultHardGates: [],
  defaultSensitiveGlobs: [
    ".env",
    ".env.*",
    "**/*.pem",
    "**/*.key",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lock",
  ],
  requireProductAcceptance: true,
};

export interface DispatchEventLogEntry {
  readonly at: string;
  readonly stepId?: string | undefined;
  readonly text: string;
}

export interface DispatchRequirementSnapshot {
  readonly userInput?: string | undefined; // 用户在面板里输入的原文
  readonly summary?: string | undefined; // 主控提炼的范围摘要
  readonly capturedAt: string;
}

export interface DispatchArchivedPlan {
  readonly id: string;
  readonly planTitle: string;
  readonly mode: "fast" | "strict";
  readonly requirement?: DispatchRequirementSnapshot | null | undefined;
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly archivedAt: string;
}

export interface DispatchAttentionItem {
  readonly engineVersion?: 2;
  readonly planId?: string;
  readonly attentionReason?: CollabAttentionReason | "ready_to_deliver";
  readonly id: string;
  readonly kind: "decision" | "escalation" | "accept";
  readonly projectRoot: string;
  readonly threadId: string | null;
  readonly planTitle: string | null;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly summary: string;
  readonly blockedStepTitles: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface VelaDispatchState {
  readonly version: 1;
  readonly projectRoot: string;
  readonly projectId: string | null;
  readonly parentThreadId: string | null;
  readonly planTitle: string | null;
  readonly mode: "fast" | "strict";
  readonly prdSource: string | null;
  readonly sharedContractPath: string | null;
  readonly requirement?: DispatchRequirementSnapshot | null | undefined;
  readonly config: DispatchConfig;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly escalations: ReadonlyArray<DispatchEscalationRecord>;
  readonly events: ReadonlyArray<DispatchEventLogEntry>;
  readonly history?: ReadonlyArray<DispatchArchivedPlan> | undefined;
  readonly updatedAt: string;
}

export interface PublishDispatchStepInput {
  readonly id?: string | undefined;
  readonly order?: number | undefined;
  readonly title: string;
  readonly goal: string;
  readonly kind?: DispatchStepKind | undefined;
  readonly decisionOptions?: ReadonlyArray<DispatchEscalationOption> | undefined;
  readonly isolation?: DispatchIsolationMode | undefined;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly parallelGroup?: string | undefined;
  readonly premisesToVerify?: ReadonlyArray<string> | undefined;
  readonly contextFiles?: ReadonlyArray<string> | undefined;
  readonly contractNote?: string | undefined;
  readonly prdSource?: string | undefined;
  readonly acceptanceCriteria?: ReadonlyArray<string> | undefined;
  readonly allowedGlobs?: ReadonlyArray<string> | undefined;
  readonly forbiddenGlobs?: ReadonlyArray<string> | undefined;
  readonly sensitiveGlobs?: ReadonlyArray<string> | undefined;
  readonly hardGates?: ReadonlyArray<string> | undefined;
  readonly executor?: "self" | DispatchAgentTarget | undefined;
  readonly reviewer?: DispatchAgentTarget | null | undefined;
  readonly skipProductAcceptance?: boolean | undefined;
}

export interface DispatchTaskSpecPatch {
  readonly title?: string | undefined;
  readonly kind?: DispatchStepKind | undefined;
  readonly decisionOptions?: ReadonlyArray<DispatchEscalationOption> | undefined;
  readonly goal?: string | undefined;
  readonly contractNote?: string | undefined;
  readonly premisesToVerify?: ReadonlyArray<string> | undefined;
  readonly allowedGlobs?: ReadonlyArray<string> | undefined;
  readonly forbiddenGlobs?: ReadonlyArray<string> | undefined;
  readonly hardGates?: ReadonlyArray<string> | undefined;
  readonly acceptanceCriteria?: ReadonlyArray<string> | undefined;
  readonly isolation?: DispatchIsolationMode | undefined;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly executor?: "self" | DispatchAgentTarget | undefined;
  readonly reviewer?: DispatchAgentTarget | null | undefined;
  readonly skipProductAcceptance?: boolean | undefined;
}
