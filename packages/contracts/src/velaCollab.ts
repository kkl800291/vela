export type CollabStepKind = "change" | "research" | "decision";

export type CollabStepPhase = "initial" | "repair" | "conflict";

export type CollabAttentionReason =
  | "decision"
  | "escalation"
  | "gate_failed"
  | "repair_limit"
  | "conflict_limit"
  | "review_incomplete"
  | "evidence_error"
  | "manual_check_required";

export type CollabStepStatus =
  | "locked"
  | "ready"
  | "developing"
  | "verifying_gates"
  | "queued_for_review"
  | "reviewing"
  | "integrating"
  | "integrated"
  | "done"
  | "needs_attention"
  | "cancelled";

export type CollabPlanStatus =
  | "draft"
  | "running"
  | "batch_verifying"
  | "ready_to_deliver"
  | "delivered"
  | "cancelled"
  | "failed";

export interface VelaCollabAgentTarget {
  readonly providerInstanceId: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | Readonly<Record<string, unknown>>
    | undefined;
}

export interface VelaCollabProjection {
  readonly engineVersion: 2;
  readonly planId: string;
  readonly planVersion: number;
  readonly revision: number;
  readonly title: string;
  readonly status: CollabPlanStatus;
  readonly stepCount: number;
  readonly blocked: boolean;
  readonly integrationOid?: string;
  readonly config: {
    readonly defaultDevAgent?: VelaCollabAgentTarget;
    readonly enableBatchAudit: boolean;
    readonly batchAuditAgent?: VelaCollabAgentTarget | null;
  };
  readonly batchGates?: ReadonlyArray<string>;
  readonly batchGateSummary?: {
    readonly passed: boolean;
    readonly commands: ReadonlyArray<{ readonly command: string; readonly passed: boolean }>;
  };
  readonly steps: ReadonlyArray<{
    readonly stepId: string;
    readonly title: string;
    readonly kind: CollabStepKind;
    readonly status: CollabStepStatus;
    readonly phase: CollabStepPhase;
    readonly attempt: number;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly hardGates?: ReadonlyArray<string>;
    readonly criteria?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly executor?: VelaCollabAgentTarget;
    readonly childThreadId?: string;
    readonly attentionReason?: CollabAttentionReason;
    readonly attentionDetail?: string;
    readonly decisionOptions?: ReadonlyArray<string>;
    readonly reviewId?: string;
    readonly reviewSummary?: {
      readonly fileCount: number;
      readonly additions: number;
      readonly deletions: number;
      readonly gateResults: ReadonlyArray<{ readonly command: string; readonly passed: boolean }>;
    };
    readonly manualChecks?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly queuePosition?: number;
    readonly secondOpinion?: {
      readonly reviewId: string;
      readonly childThreadId: string;
      readonly summary: string;
      readonly blockingFindings: number;
    };
    readonly latestVerdict?: {
      readonly reviewId: string;
      readonly verdict: "approve" | "request_changes";
      readonly summary: string;
      readonly decidedAt: string;
    };
  }>;
  readonly activeInbox?: {
    readonly inboxItemId: string;
    readonly kind:
      | "review"
      | "orchestrator_escalation"
      | "batch_verification_failed"
      | "delivery_ready";
    readonly stepId?: string;
    readonly reviewId?: string;
    readonly threadRunId?: string;
    readonly status: "pending" | "dispatched" | "completed" | "invalidated";
  };
  readonly deliveryId?: string;
  readonly delivery?: {
    readonly deliveryId: string;
    readonly expectedTargetState: string;
    readonly deliveryOid: string;
  };
  readonly appliedDelivery?: {
    readonly deliveryId: string;
    readonly operationId: string;
    readonly appliedAt: string;
    readonly revertedAt?: string;
  };
  readonly attentionDetail?: string;
  readonly canRetryBatch?: boolean;
  readonly batchAudit?: {
    readonly auditId: string;
    readonly integrationOid: string;
    readonly summary: string;
    readonly blockingFindings: number;
    readonly childThreadId?: string;
  };
}
