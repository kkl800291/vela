import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import { VelaCollabEngine } from "../../../dispatch/VelaCollabEngine.ts";
import {
  AgentTargetSchema,
  EscalationOptionSchema,
  ExecutorSchema,
  PlanVersionSchema,
  StepInputSchema,
  StepKindSchema,
  evidenceFields,
  planOptionsFields,
  reviewFields,
} from "../../../dispatch/VelaCollabInputs.ts";
import * as VelaDispatchService from "../../../dispatch/VelaDispatchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  VelaDispatchService.VelaDispatchService,
  VelaCollabEngine,
];

const StepPatchSchema = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(StepKindSchema),
  decisionOptions: Schema.optional(Schema.Array(EscalationOptionSchema)),
  goal: Schema.optional(Schema.String),
  contractNote: Schema.optional(Schema.String).annotate({
    description:
      "Natural-language constraints, invariants, or step boundaries (non-executable rules go here, NOT in hardGates).",
  }),
  premisesToVerify: Schema.optional(Schema.Array(Schema.String)),
  allowedGlobs: Schema.optional(Schema.Array(Schema.String)),
  forbiddenGlobs: Schema.optional(Schema.Array(Schema.String)),
  hardGates: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Executable shell commands ONLY (run via /bin/sh -lc, must exit 0). NEVER put natural-language rules or prose here; put prose rules in contractNote.",
  }),
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
  isolation: Schema.optional(Schema.Literals(["direct", "worktree"])),
  dependsOn: Schema.optional(Schema.Array(TrimmedNonEmptyString)).annotate({
    description:
      "Prerequisite step IDs (e.g. ['S1']). Pass [] for independent steps so they unlock together.",
  }),
  executor: Schema.optional(ExecutorSchema).annotate({
    description:
      "Target executor ('self' or {providerInstanceId, model}). Only change when user requested.",
  }),
  reviewer: Schema.optional(Schema.NullOr(AgentTargetSchema)).annotate({
    description: "Independent reviewer ({providerInstanceId, model}) or null to disable review.",
  }),
  skipProductAcceptance: Schema.optional(Schema.Boolean),
});

const AcceptanceItemSchema = Schema.Struct({
  criterion: TrimmedNonEmptyString,
  status: Schema.Literals(["passed", "failed", "manual_check"]),
  reason: TrimmedNonEmptyString,
  prdEvidence: Schema.optional(Schema.String),
  codeEvidence: Schema.optional(Schema.String),
  fixHint: Schema.optional(Schema.String),
});

const VelaDispatchStatusTool = Tool.make("vela_dispatch_status", {
  description:
    "Read the lightweight Vela collaboration projection or legacy dispatch state. For frozen v2 evidence, pass planId, exactly one reviewId or deliveryId, and view=manifest, diff or file. Diff and file require path.",
  parameters: Schema.Struct({
    ...evidenceFields,
    projectRoot: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read Vela dispatch status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VelaDispatchPlanTool = Tool.make("vela_dispatch_plan", {
  description: [
    "Publish or update a Vela collaboration plan.",
    "publish defaults to v2 and starts managed worktrees. Pass autoStart=false for a draft. Include a requirementSummary, step kind and stable criteria IDs for change steps. Use dependsOn=[] for independent steps.",
    "update revises a v2 plan at expectedPlanVersion. Supply stable IDs for changed steps and cancelStepIds for removals. clear cancels the active plan.",
    "blind_check and save_synthesis operate on v1. Use blind_check only for explicit strict mode. Pass engineVersion=1 to publish a legacy plan.",
  ].join(" "),
  parameters: Schema.Struct({
    ...planOptionsFields,
    action: Schema.Literals(["blind_check", "save_synthesis", "publish", "update", "clear"]),
    engineVersion: Schema.optional(Schema.Literals([1, 2])),
    planId: Schema.optional(TrimmedNonEmptyString),
    expectedPlanVersion: Schema.optional(PlanVersionSchema),
    cancelStepIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    autoStart: Schema.optional(Schema.Boolean),
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    rawUserInput: Schema.optional(Schema.String),
    background: Schema.optional(Schema.String),
    orchestratorProposal: Schema.optional(Schema.String),
    checker: Schema.optional(AgentTargetSchema),
    synthesis: Schema.optional(Schema.String),
    approve: Schema.optional(Schema.Boolean),
    planTitle: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["fast", "strict"])),
    prdSource: Schema.optional(Schema.String),
    sharedContract: Schema.optional(Schema.String),
    requirementSummary: Schema.optional(Schema.String),
    requireProductAcceptance: Schema.optional(Schema.Boolean),
    append: Schema.optional(Schema.Boolean),
    steps: Schema.optional(Schema.Array(StepInputSchema)),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Manage Vela dispatch plan")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const VelaDispatchStepTool = Tool.make("vela_dispatch_step", {
  description: [
    "Control v2 collaboration or legacy dispatch steps.",
    "V2 actions are start, cancel, retry_review, second_opinion, retry_batch and accept_batch_audit. Use planId and the current reviewId, integrationOid or auditId where applicable.",
    "Legacy v1: action='run' starts a step (automatically uses isolated worktree when another step is active).",
    "action='run_parallel': start multiple independent/ready steps concurrently in isolated worktrees.",
    "action='unlock_all': unlock all locked steps for free parallel dispatch.",
    "action='cancel': stop running step. action='accept': merge worktree (if any), confirm ready step & unlock dependents.",
    "action='revert': rollback direct snapshot & reset step. action='complete_self': verify self-edited step. action='update': patch step config.",
  ].join(" "),
  parameters: Schema.Struct({
    action: Schema.Literals([
      "start",
      "retry_review",
      "second_opinion",
      "retry_batch",
      "accept_batch_audit",
      "run",
      "run_parallel",
      "unlock_all",
      "cancel",
      "accept",
      "revert",
      "complete_self",
      "update",
    ]),
    planId: Schema.optional(TrimmedNonEmptyString),
    expectedPlanVersion: Schema.optional(PlanVersionSchema),
    reviewId: Schema.optional(TrimmedNonEmptyString),
    auditId: Schema.optional(TrimmedNonEmptyString),
    integrationOid: Schema.optional(TrimmedNonEmptyString),
    brief: Schema.optional(TrimmedNonEmptyString),
    question: Schema.optional(TrimmedNonEmptyString),
    target: Schema.optional(AgentTargetSchema),
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    stepId: Schema.optional(TrimmedNonEmptyString),
    stepIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    skipPremiseCheck: Schema.optional(Schema.Boolean),
    forceUnlock: Schema.optional(Schema.Boolean),
    forceWorktree: Schema.optional(Schema.Boolean),
    summary: Schema.optional(Schema.String),
    patch: Schema.optional(StepPatchSchema),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Control Vela dispatch step")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const VelaDispatchEscalationTool = Tool.make("vela_dispatch_escalation", {
  description:
    "Resolve an escalation using planId and stepId from the dedicated v2 run, or escalationId for v1. action='reply': answer technical/contract/premise/scope issue (with optional taskSpecPatch) and resume original child thread. action='escalate_human': escalate product/high-risk choice to user with options.",
  parameters: Schema.Struct({
    action: Schema.Literals(["reply", "escalate_human"]),
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    planId: Schema.optional(TrimmedNonEmptyString),
    stepId: Schema.optional(TrimmedNonEmptyString),
    escalationId: Schema.optional(TrimmedNonEmptyString),
    decision: Schema.optional(Schema.String),
    taskSpecPatch: Schema.optional(StepPatchSchema),
    analysis: Schema.optional(Schema.String),
    humanPrompt: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(EscalationOptionSchema)),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Handle Vela dispatch escalation")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const VelaDispatchAcceptanceTool = Tool.make("vela_dispatch_acceptance", {
  description:
    "Submit a frozen v2 review verdict from the dedicated collaboration run. Pass planId, stepId, reviewId, verdict, summary, findings and criteriaResults. Legacy v1 acceptance uses items.",
  parameters: Schema.Struct({
    ...reviewFields,
    planId: Schema.optional(TrimmedNonEmptyString),
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    stepId: TrimmedNonEmptyString,
    summary: TrimmedNonEmptyString,
    items: Schema.optional(Schema.Array(AcceptanceItemSchema)),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Submit Vela product acceptance")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const VelaDispatchToolkit = Toolkit.make(
  VelaDispatchStatusTool,
  VelaDispatchPlanTool,
  VelaDispatchStepTool,
  VelaDispatchEscalationTool,
  VelaDispatchAcceptanceTool,
);
