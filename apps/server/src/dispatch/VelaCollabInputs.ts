import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { VelaCollabError, type EvidenceInput } from "./VelaCollabEngine.ts";
import type { CollabStepInput } from "./VelaCollabScheduling.ts";

const AgentOptionSelectionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});

export const AgentTargetSchema = Schema.Struct({
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

export const ExecutorSchema = Schema.Union([Schema.Literal("self"), AgentTargetSchema]);

export const StepKindSchema = Schema.Literals(["research", "decision", "change"]);

export const EscalationOptionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});

export const StepInputSchema = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  stepId: Schema.optional(TrimmedNonEmptyString),
  order: Schema.optional(Schema.Number),
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  kind: Schema.optional(StepKindSchema).annotate({
    description:
      "Step kind: research (read-only report), decision (user choice), or change (default, edits files). Give change steps criteria in v2 or acceptanceCriteria in v1.",
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
  criteria: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        text: TrimmedNonEmptyString,
      }),
    ),
  ),
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

export const planOptionsFields = {
  planTitle: Schema.optional(Schema.String),
  requirementSummary: Schema.optional(Schema.String),
  defaultDevAgent: Schema.optional(AgentTargetSchema),
  batchGates: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  enableBatchAudit: Schema.optional(Schema.Boolean),
  batchAuditAgent: Schema.optional(Schema.NullOr(AgentTargetSchema)),
};

export const PlanVersionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const reviewFields = {
  reviewId: Schema.optional(TrimmedNonEmptyString),
  verdict: Schema.optional(Schema.Literals(["approve", "request_changes"])),
  findings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        severity: Schema.Literals(["blocking", "non_blocking"]),
        summary: TrimmedNonEmptyString,
        path: Schema.optional(TrimmedNonEmptyString),
        line: Schema.optional(PlanVersionSchema),
      }),
    ),
  ),
  criteriaResults: Schema.optional(
    Schema.Array(
      Schema.Struct({
        criterionId: TrimmedNonEmptyString,
        result: Schema.Literals(["pass", "fail", "manual_check"]),
        summary: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  ),
};

export const evidenceFields = {
  planId: Schema.optional(TrimmedNonEmptyString),
  reviewId: Schema.optional(TrimmedNonEmptyString),
  deliveryId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(Schema.Literals(["manifest", "diff", "file"])),
  path: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  startLine: Schema.optional(PlanVersionSchema),
  endLine: Schema.optional(PlanVersionSchema),
  side: Schema.optional(Schema.Literals(["base", "snapshot"])),
  maxBytes: Schema.optional(PlanVersionSchema),
};
export const EvidenceQuerySchema = Schema.Struct(evidenceFields);

export const evidenceInput = Effect.fn("dispatch.evidenceInput")(function* (
  query: typeof EvidenceQuerySchema.Type,
  scope: Pick<EvidenceInput, "environmentId" | "threadId" | "repositoryPath">,
): Effect.fn.Return<EvidenceInput, VelaCollabError> {
  const { planId, reviewId, deliveryId, view, path, offset, side, startLine, endLine, maxBytes } =
    query;
  const evidence =
    reviewId && !deliveryId ? { reviewId } : deliveryId && !reviewId ? { deliveryId } : null;
  if (!planId || !view || !evidence) {
    return yield* new VelaCollabError({
      message: "Evidence requires planId, view and exactly one reviewId or deliveryId.",
    });
  }
  const common = { ...scope, planId, evidence, ...(maxBytes === undefined ? {} : { maxBytes }) };
  if (view === "manifest")
    return { ...common, kind: view, ...(offset === undefined ? {} : { offset }) };
  if (!path)
    return yield* new VelaCollabError({
      message: "A file path is required for diff or file evidence.",
    });
  if (view === "diff")
    return { ...common, kind: view, path, ...(offset === undefined ? {} : { offset }) };
  return {
    ...common,
    kind: view,
    path,
    ...(side === undefined ? {} : { side }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
});

export const collabSteps = Effect.fn("dispatch.collabSteps")(function* (
  steps: ReadonlyArray<typeof StepInputSchema.Type>,
  requireIds = false,
) {
  const result: CollabStepInput[] = [];
  for (const [index, step] of steps.entries()) {
    const { id, stepId, title, goal, executor, kind = "change" } = step;
    if (id && stepId && id !== stepId)
      return yield* new VelaCollabError({ message: "id and stepId must identify the same step." });
    if (requireIds && !(id || stepId)) {
      return yield* new VelaCollabError({
        message: "Plan updates require a stable ID on each updated step.",
      });
    }
    if (executor === "self") {
      return yield* new VelaCollabError({
        message:
          'Collaboration v2 uses managed workers. For executor "self", select engineVersion 1.',
      });
    }
    const criteria =
      step.criteria ?? step.acceptanceCriteria?.map((text, i) => ({ id: `c${i + 1}`, text }));
    result.push({
      stepId: stepId ?? id ?? `S${index + 1}`,
      title,
      objective: goal,
      kind,
      ...(criteria === undefined ? {} : { criteria }),
      ...(executor === undefined ? {} : { executor }),
      ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn }),
      ...(step.allowedGlobs === undefined ? {} : { allowedGlobs: step.allowedGlobs }),
      ...(step.forbiddenGlobs === undefined ? {} : { forbiddenGlobs: step.forbiddenGlobs }),
      ...(step.sensitiveGlobs === undefined ? {} : { sensitivePaths: step.sensitiveGlobs }),
      ...(step.contractNote === undefined ? {} : { contractNote: step.contractNote }),
      ...(step.contextFiles === undefined ? {} : { contextFiles: step.contextFiles }),
      ...(step.hardGates === undefined ? {} : { hardGates: step.hardGates }),
      ...(step.decisionOptions === undefined
        ? {}
        : {
            decisionOptions: step.decisionOptions.map(({ label, description }) =>
              description ? `${label} · ${description}` : label,
            ),
          }),
    });
  }
  return result;
});

export const collabPlanOptions = ({
  planTitle,
  requirementSummary,
  defaultDevAgent,
  batchGates,
  enableBatchAudit,
  batchAuditAgent,
}: typeof PlanOptionsSchema.Type) => ({
  ...(planTitle === undefined ? {} : { title: planTitle }),
  ...(requirementSummary === undefined ? {} : { requirement: requirementSummary }),
  ...(defaultDevAgent === undefined ? {} : { defaultDevAgent }),
  ...(batchGates === undefined ? {} : { batchGates }),
  ...(enableBatchAudit === undefined ? {} : { enableBatchAudit }),
  ...(batchAuditAgent === undefined ? {} : { batchAuditAgent }),
});
const PlanOptionsSchema = Schema.Struct(planOptionsFields);
