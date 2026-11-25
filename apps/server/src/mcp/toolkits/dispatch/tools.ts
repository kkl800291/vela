import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as VelaDispatchService from "../../../dispatch/VelaDispatchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  VelaDispatchService.VelaDispatchService,
];

const AgentOptionSelectionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});

const AgentTargetSchema = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Optional reasoning/thinking effort level (e.g. 'low', 'medium', 'high', 'xhigh', 'max'). Mapped automatically to the target harness's reasoning option descriptor.",
  }),
  options: Schema.optional(Schema.Array(AgentOptionSelectionSchema)).annotate({
    description:
      "Optional native model option selections (e.g. [{ id: 'reasoningEffort', value: 'high' }, { id: 'fastMode', value: true }]).",
  }),
});

const ExecutorSchema = Schema.Union([Schema.Literal("self"), AgentTargetSchema]);

const StepKindSchema = Schema.Literals(["research", "decision", "change"]);

const EscalationOptionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});

const StepInputSchema = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  order: Schema.optional(Schema.Number),
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  kind: Schema.optional(StepKindSchema).annotate({
    description:
      "Step card type: 'research' (read-only investigation/check, outputs conclusion report without modifying files), 'decision' (user decision step with 2-4 options), or 'change' (default; modifies code/docs/config and requires acceptanceCriteria).",
  }),
  decisionOptions: Schema.optional(Schema.Array(EscalationOptionSchema)).annotate({
    description:
      "Preset options (at least 2) for a 'decision' card when choices are already known; omit when the step should analyze and propose options first.",
  }),
  isolation: Schema.optional(Schema.Literals(["direct", "worktree"])),
  dependsOn: Schema.optional(Schema.Array(TrimmedNonEmptyString)).annotate({
    description:
      "Prerequisite step IDs (e.g. ['S1']). Pass [] for independent steps so they unlock immediately and run in parallel.",
  }),
  parallelGroup: Schema.optional(TrimmedNonEmptyString),
  premisesToVerify: Schema.optional(Schema.Array(Schema.String)),
  contextFiles: Schema.optional(Schema.Array(Schema.String)),
  contractNote: Schema.optional(Schema.String).annotate({
    description:
      "Natural-language constraints, invariants, or step boundaries (non-executable rules go here, NOT in hardGates).",
  }),
  prdSource: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
  allowedGlobs: Schema.optional(Schema.Array(Schema.String)),
  forbiddenGlobs: Schema.optional(Schema.Array(Schema.String)),
  sensitiveGlobs: Schema.optional(Schema.Array(Schema.String)),
  hardGates: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Executable shell commands ONLY (run via /bin/sh -lc, must exit 0, e.g. 'vp run typecheck'). NEVER put natural-language rules or prose here; put prose rules in contractNote or acceptanceCriteria.",
  }),
  executor: Schema.optional(ExecutorSchema).annotate({
    description:
      "Omit by default so Vela inherits the user's current thread model or panel choice. Set 'self' only when this chat thread itself should perform the step, or {providerInstanceId, model} only when the user explicitly asked for that provider/model.",
  }),
  reviewer: Schema.optional(Schema.NullOr(AgentTargetSchema)).annotate({
    description:
      "Omit by default to inherit the project's selected agent, or set null for read-only/decision steps that do not edit code. Never pick another provider (e.g. codex/GPT) unless the user asked for it.",
  }),
  skipProductAcceptance: Schema.optional(Schema.Boolean),
});

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
    description:
      "Independent reviewer ({providerInstanceId, model}) or null to disable review.",
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
    "Read the current project's Vela Dispatch state: blind check facts, step cards, diffs, hard gates, review verdicts, acceptance reports, and open escalations.",
  parameters: Schema.Struct({
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
    "Manage a gated Vela dispatch plan.",
    "action='publish' (DEFAULT): publish ordered step cards and STOP for user review on the Dispatch panel.",
    "Always set each step's kind ('research' for read-only investigation, 'decision' for user choices, 'change' for file edits; never disguise non-change work as 'change'), pass requirementSummary (3-8 lines stating what is in/out of scope), and provide non-empty acceptanceCriteria on every 'change' step.",
    "NEVER auto-start steps after publishing unless asked, and omit executor/reviewer unless the user named a provider/model.",
    "action='blind_check': read-only fact check from rawUserInput & background (ONLY call when the user explicitly asked for blind check or strict mode).",
    "action='save_synthesis': record synthesis & approve. action='clear': reset plan.",
  ].join(" "),
  parameters: Schema.Struct({
    action: Schema.Literals(["blind_check", "save_synthesis", "publish", "clear"]),
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
    requirementSummary: Schema.optional(Schema.String).annotate({
      description: "3-8 line scope summary stating what is in scope and out of scope for this dispatch plan.",
    }),
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
    "Control dispatch steps.",
    "action='run': start a step (automatically uses isolated worktree when another step is active).",
    "action='run_parallel': start multiple independent/ready steps concurrently in isolated worktrees.",
    "action='unlock_all': unlock all locked steps for free parallel dispatch.",
    "action='cancel': stop running step. action='accept': merge worktree (if any), confirm ready step & unlock dependents.",
    "action='revert': rollback direct snapshot & reset step. action='complete_self': verify self-edited step. action='update': patch step config.",
  ].join(" "),
  parameters: Schema.Struct({
    action: Schema.Literals([
      "run",
      "run_parallel",
      "unlock_all",
      "cancel",
      "accept",
      "revert",
      "complete_self",
      "update",
    ]),
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
    "Resolve or escalate an open dispatch escalation. action='reply': answer technical/contract/premise/scope issue (with optional taskSpecPatch) and resume original child thread. action='escalate_human': escalate product/high-risk choice to user with options.",
  parameters: Schema.Struct({
    action: Schema.Literals(["reply", "escalate_human"]),
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    escalationId: TrimmedNonEmptyString,
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
    "Submit orchestrator per-criterion product acceptance after inspecting real code against PRD. Any failed item automatically resumes the original child thread for repair.",
  parameters: Schema.Struct({
    projectRoot: Schema.optional(TrimmedNonEmptyString),
    stepId: TrimmedNonEmptyString,
    summary: TrimmedNonEmptyString,
    items: Schema.Array(AcceptanceItemSchema),
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
