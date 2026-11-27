import type {
  CollabAttentionReason,
  CollabPlanStatus,
  CollabStepKind,
  CollabStepPhase,
  CollabStepStatus,
} from "@t3tools/contracts";

import type { DispatchAgentTarget } from "./VelaDispatchTypes.ts";

export type {
  CollabAttentionReason,
  CollabPlanStatus,
  CollabStepKind,
  CollabStepPhase,
  CollabStepStatus,
  VelaCollabProjection,
} from "@t3tools/contracts";

export interface CollabScope {
  readonly environmentId: string;
  readonly parentThreadId: string;
}

export interface CollabRepositoryBinding {
  readonly canonicalTargetWorktree: string;
  readonly gitCommonDir: string | null;
}

export interface CollabCriterion {
  readonly id: string;
  readonly text: string;
}

export interface CollabGateSummary {
  readonly passed: boolean;
  readonly results: ReadonlyArray<{
    readonly command: string;
    readonly exitCode: number | null;
    readonly output?: string;
  }>;
}

export type CollabFileMode = "100644" | "100755" | "120000" | "160000";

export interface CollabTreeEntry {
  readonly oid: string;
  readonly mode: CollabFileMode;
}

export interface CollabSnapshotFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "A" | "M" | "D" | "R";
  readonly isBinary: boolean;
  readonly sizeBytes: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly oldMode: CollabFileMode | null;
  readonly newMode: CollabFileMode | null;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface CollabReviewEvidence {
  readonly reviewId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly stepBaseOid: string;
  readonly reviewedOid: string;
  readonly criteriaVersion: number;
  readonly gateSummary: CollabGateSummary;
  readonly changedFiles: ReadonlyArray<CollabSnapshotFile>;
  readonly summary?: string;
  readonly createdAt: string;
}

export interface CollabFinding {
  readonly severity: "blocking" | "non_blocking";
  readonly summary: string;
  readonly path?: string;
  readonly line?: number;
}

export interface CollabReviewVerdict {
  readonly reviewId: string;
  readonly verdict: "approve" | "request_changes";
  readonly summary: string;
  readonly findings: ReadonlyArray<CollabFinding>;
  readonly criteriaResults: ReadonlyArray<{
    readonly criterionId: string;
    readonly result: "pass" | "fail" | "manual_check";
    readonly summary?: string;
  }>;
  readonly reviewerRunId: string;
  readonly decidedAt: string;
}

export interface BatchAuditRecord {
  readonly auditId: string;
  readonly reviewId?: string;
  readonly planVersion: number;
  readonly baseOid: string;
  readonly integrationOid: string;
  readonly auditorRunId: string;
  readonly summary: string;
  readonly findings: ReadonlyArray<CollabFinding>;
  readonly completedAt: string;
}

export interface CollabDeliveryDrift {
  readonly expectedTargetState: string;
  readonly mergedCandidateCommitOid: string;
}

export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly planVersion: number;
  readonly baseOid: string;
  readonly deliveryOid: string;
  readonly expectedTargetState: string;
  readonly batchGateSummary: CollabGateSummary;
  readonly batchAuditId?: string;
  readonly applicationBaseOid?: string;
  readonly createdAt: string;
}

export interface AppliedDeliveryRecord {
  readonly deliveryId: string;
  readonly operationId: string;
  readonly appliedBaseTree: string;
  readonly appliedResultTree: string;
  readonly appliedAt: string;
}

export interface RevertedDeliveryRecord {
  readonly deliveryId: string;
  readonly operationId: string;
  readonly revertedBaseTree: string;
  readonly revertedResultTree: string;
  readonly revertedAt: string;
}

export interface CollabDeliveryWrite {
  readonly path: string;
  readonly expectedOld: CollabTreeEntry | null;
  readonly targetNew: CollabTreeEntry | null;
}

export interface CollabDeliveryRecovery extends CollabRepositoryBinding {
  readonly planId: string;
  readonly operationId: string;
  readonly baseTree: string;
  readonly resultTree: string;
  readonly writes: ReadonlyArray<CollabDeliveryWrite>;
}

export interface CollabPlan extends CollabScope, CollabRepositoryBinding {
  readonly engineVersion: 2;
  readonly planId: string;
  readonly planVersion: number;
  readonly revision: number;
  readonly status: CollabPlanStatus;
  readonly title: string;
  readonly requirement: string;
  readonly baseOid?: string;
  readonly integrationOid?: string;
  readonly deliveryId?: string;
  readonly batchGates: ReadonlyArray<string>;
  readonly defaultDevAgent?:
    | DispatchAgentTarget
    | { readonly provider: string; readonly model?: string };
  readonly enableBatchAudit?: boolean;
  readonly batchAuditAgent?: DispatchAgentTarget | null;
  readonly integrationWorktreePath?: string;
  readonly integrationWorktreeGitDir?: string;
  readonly projectId?: string;
  readonly attentionDetail?: string;
  readonly batchGateSummary?: CollabGateSummary;
  readonly batchTargetDrift?: CollabDeliveryDrift;
  readonly batchAuditId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CollabStep {
  readonly planId: string;
  readonly stepId: string;
  readonly order: number;
  readonly kind: CollabStepKind;
  readonly status: CollabStepStatus;
  readonly title: string;
  readonly objective: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly criteriaVersion: number;
  readonly criteria: ReadonlyArray<CollabCriterion>;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly allowedGlobs?: ReadonlyArray<string>;
  readonly forbiddenGlobs?: ReadonlyArray<string>;
  readonly executor?: DispatchAgentTarget;
  readonly forbiddenPaths?: ReadonlyArray<string>;
  readonly sensitivePaths?: ReadonlyArray<string>;
  readonly contractNote?: string;
  readonly contextFiles?: ReadonlyArray<string>;
  readonly decisionOptions?: ReadonlyArray<string>;
  readonly hardGates: ReadonlyArray<string>;
  readonly phase: CollabStepPhase;
  readonly attempt: number;
  readonly childThreadId?: string;
  readonly worktreePath?: string;
  readonly reviewWorktreePath?: string;
  readonly stepBaseOid?: string;
  readonly reviewId?: string;
  readonly reviewQueueSequence?: number;
  readonly integrationQueueSequence?: number;
  readonly attentionReason?: CollabAttentionReason;
  readonly attentionDetail?: string;
  readonly workerRunId?: string;
  readonly repairCount?: number;
  readonly conflictCount?: number;
}

export interface CollabInboxItem extends CollabScope {
  readonly inboxItemId: string;
  readonly planId: string;
  readonly kind:
    | "review"
    | "orchestrator_escalation"
    | "batch_verification_failed"
    | "delivery_ready";
  readonly stepId?: string;
  readonly reviewId?: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly threadRunId?: string;
  readonly status: "pending" | "dispatched" | "completed" | "invalidated";
  readonly payloadJson: string;
  readonly receiptJson: string | null;
}

export type CollabInboxWake = Omit<CollabInboxItem, "status" | "receiptJson" | "threadRunId">;

export type CollabOutboxKind =
  | "enqueue_inbox"
  | "create_worktree"
  | "remove_worktree"
  | "send_thread"
  | "initialize_plan"
  | "freeze_step_base"
  | "verify_step_gates"
  | "verify_batch_gates"
  | "freeze_delivery"
  | "update_integration"
  | "apply_delivery"
  | "revert_delivery";

export interface CollabOutboxIntent {
  readonly operationId: string;
  readonly planId: string;
  readonly kind: CollabOutboxKind;
  readonly expectedPlanVersion: number;
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly status: "pending" | "completed" | "invalidated";
  readonly receiptJson: string | null;
  readonly recovery?: CollabDeliveryRecovery;
}

export interface CollabOperationLease {
  readonly kind: "integration" | "target_worktree";
  readonly resourceId: string;
  readonly operationId: string;
  readonly ownerId: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface CollabRecordMap {
  readonly review: CollabReviewEvidence;
  readonly verdict: CollabReviewVerdict;
  readonly batch_audit: BatchAuditRecord;
  readonly delivery: DeliveryRecord;
  readonly applied: AppliedDeliveryRecord;
  readonly reverted: RevertedDeliveryRecord;
}

export type CollabRecord = {
  [Kind in keyof CollabRecordMap]: {
    readonly kind: Kind;
    readonly id: string;
    readonly value: CollabRecordMap[Kind];
  };
}[keyof CollabRecordMap];
