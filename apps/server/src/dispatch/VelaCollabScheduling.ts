import type * as Schema from "effect/Schema";

import type {
  CollabFinding,
  CollabGateSummary,
  CollabReviewEvidence,
  CollabStep,
} from "./VelaCollabTypes.ts";

export type CollabStepInput = Pick<CollabStep, "stepId" | "title" | "objective" | "kind"> &
  Partial<
    Pick<
      CollabStep,
      | "dependsOn"
      | "criteria"
      | "allowedPaths"
      | "allowedGlobs"
      | "forbiddenPaths"
      | "forbiddenGlobs"
      | "sensitivePaths"
      | "contractNote"
      | "contextFiles"
      | "hardGates"
      | "executor"
      | "decisionOptions"
    >
  >;

export function defineStep(planId: string, input: CollabStepInput, order: number): CollabStep {
  return {
    ...input,
    planId,
    order,
    dependsOn: input.dependsOn ?? [],
    criteria: input.criteria ?? [],
    allowedPaths: input.allowedPaths ?? [],
    hardGates: input.hardGates ?? [],
    status: "locked",
    criteriaVersion: 1,
    phase: "initial",
    attempt: 0,
  };
}

export function topologicalSteps(steps: ReadonlyArray<CollabStep>) {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  if (byId.size !== steps.length) throw new Error("Duplicate collaboration step ID.");
  const ordered: CollabStep[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(step: CollabStep) {
    if (visited.has(step.stepId)) return;
    if (visiting.has(step.stepId)) throw new Error("Collaboration dependencies form a cycle.");
    visiting.add(step.stepId);
    for (const dependency of step.dependsOn) {
      const previous = byId.get(dependency);
      if (!previous) throw new Error(`Unknown collaboration dependency ${dependency}.`);
      visit(previous);
    }
    visiting.delete(step.stepId);
    visited.add(step.stepId);
    ordered.push(step);
  }
  for (const step of steps) {
    if (
      !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(step.stepId) ||
      /\.\.|\.$|\.lock$/.test(step.stepId) ||
      new Set(step.dependsOn).size !== step.dependsOn.length ||
      new Set(step.criteria.map(({ id }) => id)).size !== step.criteria.length ||
      step.criteria.some(({ id, text }) => !id.trim() || !text.trim())
    )
      throw new Error(`Invalid collaboration step or acceptance criteria at ${step.stepId}.`);
    visit(step);
  }
  return ordered;
}

export const stepComplete = (step: CollabStep) =>
  step.status === "integrated" || step.status === "done";

export function unlockSteps(steps: ReadonlyArray<CollabStep>) {
  const complete = new Set(steps.filter(stepComplete).map(({ stepId }) => stepId));
  return steps
    .filter((step) => step.status === "locked" && step.dependsOn.every((id) => complete.has(id)))
    .map((step) => ({ ...step, status: "ready" as const }));
}

export function affectedSteps(ordered: ReadonlyArray<CollabStep>, changed: ReadonlySet<string>) {
  const affected = new Set(changed);
  for (const step of ordered) {
    if (!stepComplete(step) && step.dependsOn.some((id) => affected.has(id)))
      affected.add(step.stepId);
  }
  return affected;
}

export function clearStepEvidence(step: CollabStep): CollabStep {
  const {
    stepBaseOid: _base,
    reviewId: _review,
    reviewQueueSequence: _queue,
    integrationQueueSequence: _integration,
    attentionReason: _reason,
    attentionDetail: _detail,
    workerRunId: _run,
    reviewWorktreePath: _reviewWorktree,
    ...rest
  } = step;
  return rest;
}

export function gateSummaryForWake(summary: CollabGateSummary) {
  return {
    passed: summary.passed,
    gateCount: summary.results.length,
    results: summary.results.slice(0, 12).map(({ command, exitCode }) => ({
      command: command.slice(0, 120),
      exitCode,
    })),
  };
}

export function reviewWakePayload(step: CollabStep, evidence: CollabReviewEvidence) {
  return {
    attempt: step.attempt,
    objective: step.objective.slice(0, 600),
    criteria: step.criteria.map(({ id, text }) => ({ id, text: text.slice(0, 300) })),
    gateSummary: gateSummaryForWake(evidence.gateSummary),
  };
}

export const workerOutputSchema = {
  type: "object",
  properties: {
    outcome: { enum: ["complete", "question", "premise_failed", "decision"] },
    summary: { type: "string", maxLength: 8000 },
    options: { type: "array", maxItems: 12, items: { type: "string", maxLength: 1000 } },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
} as const satisfies Readonly<Record<string, Schema.Json>>;

export const auditOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 8000 },
    findings: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        properties: {
          severity: { enum: ["blocking", "non_blocking"] },
          summary: { type: "string", maxLength: 1500 },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
        },
        required: ["severity", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
} as const satisfies Readonly<Record<string, Schema.Json>>;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readWorkerOutput(value: unknown) {
  if (
    !isObject(value) ||
    typeof value.summary !== "string" ||
    (value.outcome !== "complete" &&
      value.outcome !== "question" &&
      value.outcome !== "premise_failed" &&
      value.outcome !== "decision")
  )
    return undefined;
  const options = Array.isArray(value.options)
    ? value.options.filter((option): option is string => typeof option === "string")
    : [];
  return { outcome: value.outcome, summary: value.summary, options };
}

export function readAuditOutput(value: unknown) {
  if (!isObject(value) || typeof value.summary !== "string" || !Array.isArray(value.findings)) {
    return undefined;
  }
  const findings: CollabFinding[] = [];
  for (const finding of value.findings as ReadonlyArray<unknown>) {
    if (
      !isObject(finding) ||
      typeof finding.summary !== "string" ||
      (finding.severity !== "blocking" && finding.severity !== "non_blocking")
    )
      return undefined;
    findings.push({
      severity: finding.severity,
      summary: finding.summary,
      ...(typeof finding.path === "string" ? { path: finding.path } : {}),
      ...(typeof finding.line === "number" ? { line: finding.line } : {}),
    });
  }
  return { summary: value.summary, findings };
}

export function workerPrompt(step: CollabStep, detail: string) {
  return [
    step.kind === "change"
      ? "Implement the collaboration step in this managed worktree."
      : "Investigate using read-only actions. Return your findings without editing files.",
    `Step ${step.stepId}: ${step.title}`,
    step.objective,
    detail,
    step.contractNote,
    step.contextFiles?.length ? `Context files: ${step.contextFiles.join(", ")}` : undefined,
    step.allowedPaths.length || step.allowedGlobs?.length
      ? `Allowed paths: ${[...step.allowedPaths, ...(step.allowedGlobs ?? [])].join(", ")}`
      : undefined,
    step.forbiddenPaths?.length || step.forbiddenGlobs?.length
      ? `Forbidden paths: ${[...(step.forbiddenPaths ?? []), ...(step.forbiddenGlobs ?? [])].join(", ")}`
      : undefined,
    step.sensitivePaths?.length ? `Sensitive paths: ${step.sensitivePaths.join(", ")}` : undefined,
    ...step.criteria.map(({ id, text }) => `Acceptance [${id}]: ${text}`),
    step.kind === "decision" ? "Return the decision options and your recommendation." : undefined,
    "Submit the requested structured output. Report unmet premises and questions before making further changes.",
  ]
    .filter(Boolean)
    .join("\n");
}
