// @effect-diagnostics globalDate:off
import type {
  DispatchAcceptanceItem,
  DispatchEscalationOption,
  DispatchPremiseFailure,
  DispatchReviewIssue,
  DispatchReviewVerdict,
  DispatchStepKind,
  DispatchTaskCard,
} from "./VelaDispatchTypes.ts";

export interface UpstreamDeliverable {
  readonly stepId: string;
  readonly title: string;
  readonly kind: DispatchStepKind;
  readonly text: string;
}

export interface ParsedDecisionOptions {
  readonly question: string;
  readonly analysis?: string | undefined;
  readonly recommendation?: string | undefined;
  readonly options: ReadonlyArray<DispatchEscalationOption>;
}

function stepKindLabel(kind: DispatchStepKind): string {
  switch (kind) {
    case "research":
      return "调研";
    case "decision":
      return "决策";
    case "change":
      return "改动";
  }
}

export interface ParsedExecutorQuestion {
  readonly title: string;
  readonly question: string;
  readonly factsFound?: string | undefined;
  readonly options: ReadonlyArray<DispatchEscalationOption>;
  readonly needsHuman: boolean;
}

export function buildBlindCheckPrompt(input: {
  readonly rawUserInput: string;
  readonly background?: string | undefined;
  readonly ledgerExcerpt?: string | undefined;
}): string {
  return [
    "你正在执行一次【只读代码盲审核对（Blind Fact Check）】。",
    "请严禁修改任何文件，仅基于真实代码仓库进行调查并给出客观事实报告。",
    "",
    "## 用户原始需求",
    input.rawUserInput.trim(),
    ...(input.background?.trim() ? ["", "## 客观技术背景", input.background.trim()] : []),
    ...(input.ledgerExcerpt?.trim()
      ? ["", "## 近期任务账本摘录", input.ledgerExcerpt.trim()]
      : []),
    "",
    "## 输出要求",
    "1. 列出与需求直接相关的真实文件路径、关键符号、现有架构约定与约束。",
    "2. 指出潜在风险、依赖关系、已有类似实现以及容易踩坑的边界条件。",
    "3. 给出简洁、基于代码事实的实现建议与拆分建议。",
  ].join("\n");
}

export function buildTaskExecutionPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly sharedContractText?: string | undefined;
  readonly sharedContractPath?: string | undefined;
  readonly skipPremiseCheck?: boolean | undefined;
  readonly upstream?: ReadonlyArray<UpstreamDeliverable> | undefined;
}): string {
  const { task } = input;
  const kind: DispatchStepKind = task.kind ?? "change";
  const sections: string[] = [
    `你正在执行 Vela 分工协作任务卡 **${task.id}：${task.title}**（类型：${stepKindLabel(kind)}）。`,
    kind === "change"
      ? "请严格遵守本卡边界与协议，直接完成本步目标（严禁擅自 git commit / git push / 切换分支）。"
      : "本步为只读任务，严禁修改任何文件或执行 git commit / git push / 切换分支。",
    "",
    "## 本步目标",
    task.goal,
  ];

  if (input.upstream && input.upstream.length > 0) {
    sections.push("", "## 前置步骤产出（请基于这些结论执行）");
    for (const item of input.upstream) {
      sections.push("", `### ${item.stepId} ${item.title}（${stepKindLabel(item.kind)}）`, item.text);
    }
  }

  if (task.contextFiles.length > 0) {
    sections.push("", "## 重点参考文件", ...task.contextFiles.map((f) => `- \`${f}\``));
  }

  if (task.contractNote?.trim()) {
    sections.push("", "## 本步契约与接口约定", task.contractNote.trim());
  }

  if (input.sharedContractText?.trim()) {
    const contractTitle = input.sharedContractPath?.trim()
      ? `## 共享契约（已落盘 ${input.sharedContractPath.trim()}）`
      : "## 共享契约";
    sections.push("", contractTitle, input.sharedContractText.trim().slice(0, 6000));
  }

  if (task.allowedGlobs.length > 0 || task.forbiddenGlobs.length > 0) {
    sections.push("", "## 改动路径边界（系统改完会强制审计）");
    if (task.allowedGlobs.length > 0) {
      sections.push(`- 允许修改范围：${task.allowedGlobs.map((g) => `\`${g}\``).join("、")}`);
    }
    if (task.forbiddenGlobs.length > 0) {
      sections.push(`- 严禁修改范围：${task.forbiddenGlobs.map((g) => `\`${g}\``).join("、")}`);
    }
  }

  if (task.hardGates.length > 0) {
    sections.push(
      "",
      "## 强制检查命令（Hard Gates，改完后系统会自动跑）",
      ...task.hardGates.map((g) => `- \`${g}\``),
    );
  }

  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      "",
      "## 验收标准（独立复查与产品验收共用）",
      ...task.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`),
    );
  }

  if (!input.skipPremiseCheck && task.premisesToVerify.length > 0) {
    sections.push(
      "",
      "## 动手前必须核对的代码前提（不符即停，不要强改）",
      ...task.premisesToVerify.map((p, idx) => `${idx + 1}. ${p}`),
      "",
      "如果发现任意前提与真实代码不符，请**不要修改代码**，直接输出如下 JSON 块并结束本轮：",
      "```json",
      '{"status":"PREMISE_FAILED","failedPremises":[{"premise":"前提内容","actual":"实际查到的代码事实"}]}',
      "```",
    );
  }

  sections.push(
    "",
    "## 遇到歧义或阻塞时（停机提问协议）",
    "如果遇到未定义的接口/产品取舍、范围冲突或必须主控/人类确认的问题，请暂停继续，直接输出如下 JSON 块并结束本轮：",
    "```json",
    '{"status":"NEED_DECISION","title":"简短标题","question":"具体问题","factsFound":"已核查的代码事实","needsHuman":false,"options":[{"id":"A","label":"方案A","description":"说明"}]}',
    "```",
  );

  if (kind === "research") {
    sections.push(
      "",
      "## 输出要求",
      "本步为只读调研/排查，严禁修改任何文件；最终输出结论报告：结论、证据（文件:行号/命令输出）、未决问题。",
    );
  } else if (kind === "decision") {
    sections.push(
      "",
      "## 输出要求",
      "本步为只读方案决策分析，严禁修改任何文件。请只读分析后给出 2~4 个选项，并必须输出如下 JSON 块：",
      "```json",
      '{"status":"DECISION_OPTIONS","question":"需要用户拍板的问题","analysis":"各方案利弊对比与推荐说明","recommendation":"A","options":[{"id":"A","label":"方案A","description":"说明"},{"id":"B","label":"方案B","description":"说明"}]}',
      "```",
    );
  } else {
    sections.push("", "否则请完成代码修改，自行验证通过后用简洁中文总结改动文件与结果。");
  }

  return sections.join("\n");
}

export function buildIndependentReviewPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly patch: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly hardGateLog: string;
  readonly round: number;
  readonly requirementSummary?: string | undefined;
}): string {
  const { task } = input;
  return [
    `你正在执行任务卡 **${task.id}：${task.title}** 的第 ${input.round} 轮【独立只读技术复查】。`,
    "你是一个全新、无偏见的独立审查员。严禁修改任何文件，请直接对照目标、验收标准、改动 diff 与检查日志给出客观结论。",
    ...(input.requirementSummary?.trim()
      ? ["", "## 需求范围摘要", input.requirementSummary.trim()]
      : []),
    "",
    "## 任务目标",
    task.goal,
    ...(task.acceptanceCriteria.length > 0
      ? [
          "",
          "## 验收标准",
          ...task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
        ]
      : []),
    "",
    `## 本步增量改动文件（${input.changedFiles.length} 个）`,
    ...input.changedFiles.map((f) => `- \`${f}\``),
    "",
    "## 增量 Diff",
    "```diff",
    input.patch || "(无文本 diff)",
    "```",
    ...(input.hardGateLog
      ? ["", "## Hard Gate 检查输出", "```text", input.hardGateLog.slice(-4000), "```"]
      : []),
    "",
    "## 复查输出格式（必须包含且仅包含一个合法 JSON 块）",
    "仅当存在真实功能缺陷、契约不符、边界遗漏、类型/安全隐患或明显违背验收标准时判定 `fail`；轻微风格偏好不要打回。",
    "```json",
    '{"verdict":"pass","summary":"简明结论","issues":[{"severity":"high","file":"path/to/file","summary":"问题描述","fixHint":"具体修复建议"}]}',
    "```",
  ].join("\n");
}

export function buildResearchReviewPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly report: string;
  readonly requirementSummary?: string | undefined;
  readonly round: number;
}): string {
  const { task } = input;
  return [
    `你正在执行调研任务卡 **${task.id}：${task.title}** 的第 ${input.round} 轮【独立只读复查】。`,
    "你是一个全新、无偏见的独立审查员。严禁修改任何文件，请审查调研结论报告：结论是否回答了目标、证据是否充分可信。",
    ...(input.requirementSummary?.trim()
      ? ["", "## 需求范围摘要", input.requirementSummary.trim()]
      : []),
    "",
    "## 任务目标",
    task.goal,
    ...(task.acceptanceCriteria.length > 0
      ? [
          "",
          "## 验收标准",
          ...task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
        ]
      : []),
    "",
    "## 调研结论报告",
    input.report.trim() || "(无报告内容)",
    "",
    "## 复查输出格式（必须包含且仅包含一个合法 JSON 块）",
    "仅当结论未回答核心目标、缺乏真实文件/行号/命令输出证据、或存在明显事实矛盾时判定 `fail`。",
    "```json",
    '{"verdict":"pass","summary":"简明结论","issues":[{"severity":"high","file":"path/to/file","summary":"问题描述","fixHint":"具体补充或修正建议"}]}',
    "```",
  ].join("\n");
}

export function buildReviewFixPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly issues: ReadonlyArray<DispatchReviewIssue>;
  readonly round: number;
}): string {
  const isResearch = (input.task.kind ?? "change") === "research";
  if (isResearch) {
    return [
      `第 ${input.round} 轮独立复查发现以下问题，请修订调研报告（严禁修改任何文件，仅在回复中输出更新后的完整结论报告）：`,
      "",
      ...input.issues.map(
        (issue, idx) =>
          `${idx + 1}. [${issue.severity.toUpperCase()}]${issue.file ? ` \`${issue.file}\`` : ""} ${issue.summary}${issue.fixHint ? `\n   - 修订建议：${issue.fixHint}` : ""}`,
      ),
      "",
      "请补充核查并输出修订后的完整调研报告（包含结论、证据与未决问题）。",
    ].join("\n");
  }
  return [
    `第 ${input.round} 轮独立技术复查发现以下必须修复的问题，请在当前原会话上下文中直接修复（严禁 git commit / push）：`,
    "",
    ...input.issues.map(
      (issue, idx) =>
        `${idx + 1}. [${issue.severity.toUpperCase()}]${issue.file ? ` \`${issue.file}\`` : ""} ${issue.summary}${issue.fixHint ? `\n   - 修复建议：${issue.fixHint}` : ""}`,
    ),
    "",
    `修复范围仍需遵守任务卡 ${input.task.id} 的路径边界。修完后简洁汇报修改结果。`,
  ].join("\n");
}

export function buildAcceptanceFixPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly failedItems: ReadonlyArray<DispatchAcceptanceItem>;
  readonly round: number;
}): string {
  return [
    `第 ${input.round} 轮主控产品验收未通过，请按以下逐条意见在当前原会话中修复（严禁 git commit / push）：`,
    "",
    ...input.failedItems.map(
      (item, idx) =>
        `${idx + 1}. 验收项：${item.criterion}\n   - 原因：${item.reason}${item.fixHint ? `\n   - 修改指引：${item.fixHint}` : ""}${item.codeEvidence ? `\n   - 代码位置：${item.codeEvidence}` : ""}`,
    ),
    "",
    `请完成修复并自检后汇报结果。`,
  ].join("\n");
}

export function buildEscalationReplyPrompt(input: {
  readonly task: DispatchTaskCard;
  readonly decision: string;
  readonly resolvedBy: "orchestrator" | "human";
  readonly patchedFields: ReadonlyArray<string>;
}): string {
  const actor = input.resolvedBy === "human" ? "用户" : "主控 Agent";
  return [
    `${actor}已针对任务卡 ${input.task.id} 的暂停工单给出明确决定，请基于此决定继续完成任务：`,
    "",
    "## 决策内容",
    input.decision,
    ...(input.patchedFields.length > 0
      ? ["", `（任务卡已同步更新字段：${input.patchedFields.join("、")}）`]
      : []),
    "",
    "请严格按以上决定继续执行并完成本步改动（严禁 git commit / push）。",
  ].join("\n");
}

function extractJsonBlocks(text: string): unknown[] {
  const results: unknown[] = [];
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      results.push(JSON.parse(raw));
    } catch {
      // Ignore non-JSON fenced blocks
    }
  }
  if (results.length === 0) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        results.push(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
      } catch {
        // Ignore non-JSON text
      }
    }
  }
  return results;
}

export function parsePremiseFailure(
  text: string,
): { readonly failedPremises: ReadonlyArray<DispatchPremiseFailure> } | null {
  for (const candidate of extractJsonBlocks(text)) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.status !== "PREMISE_FAILED") continue;
    const rawList = Array.isArray(obj.failedPremises) ? obj.failedPremises : [];
    const failedPremises: DispatchPremiseFailure[] = rawList
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const premise = typeof rec.premise === "string" ? rec.premise.trim() : "";
        const actual = typeof rec.actual === "string" ? rec.actual.trim() : "";
        if (!premise && !actual) return null;
        return { premise: premise || "未具名前提", actual: actual || "与代码现状不符" };
      })
      .filter((x): x is DispatchPremiseFailure => x !== null);
    return {
      failedPremises:
        failedPremises.length > 0
          ? failedPremises
          : [{ premise: "前置代码前提", actual: "执行代理报告前提与代码现状不符" }],
    };
  }
  return null;
}

export function parseExecutorQuestion(text: string): ParsedExecutorQuestion | null {
  for (const candidate of extractJsonBlocks(text)) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.status !== "NEED_DECISION") continue;
    const question = typeof obj.question === "string" ? obj.question.trim() : "";
    if (!question) continue;
    const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "需要确认方案";
    const factsFound = typeof obj.factsFound === "string" ? obj.factsFound.trim() : undefined;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: DispatchEscalationOption[] = rawOptions
      .map((opt, idx): DispatchEscalationOption | null => {
        if (typeof opt === "string" && opt.trim()) {
          return { id: String(idx + 1), label: opt.trim() };
        }
        if (!opt || typeof opt !== "object") return null;
        const rec = opt as Record<string, unknown>;
        const label = typeof rec.label === "string" ? rec.label.trim() : "";
        if (!label) return null;
        return {
          id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : String(idx + 1),
          label,
          ...(typeof rec.description === "string" && rec.description.trim()
            ? { description: rec.description.trim() }
            : {}),
        };
      })
      .filter((x): x is DispatchEscalationOption => x !== null);
    return {
      title,
      question,
      factsFound,
      options,
      needsHuman: obj.needsHuman === true,
    };
  }
  return null;
}

export function parseDecisionOptions(text: string): ParsedDecisionOptions | null {
  for (const candidate of extractJsonBlocks(text)) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.status !== "DECISION_OPTIONS") continue;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: DispatchEscalationOption[] = rawOptions
      .map((opt, idx): DispatchEscalationOption | null => {
        if (typeof opt === "string" && opt.trim()) {
          return { id: String.fromCharCode(65 + idx), label: opt.trim() };
        }
        if (!opt || typeof opt !== "object") return null;
        const rec = opt as Record<string, unknown>;
        const label = typeof rec.label === "string" ? rec.label.trim() : "";
        if (!label) return null;
        return {
          id:
            typeof rec.id === "string" && rec.id.trim()
              ? rec.id.trim()
              : String.fromCharCode(65 + idx),
          label,
          ...(typeof rec.description === "string" && rec.description.trim()
            ? { description: rec.description.trim() }
            : {}),
        };
      })
      .filter((x): x is DispatchEscalationOption => x !== null);
    if (options.length < 2) continue;
    const question =
      typeof obj.question === "string" && obj.question.trim()
        ? obj.question.trim()
        : "请选择执行方案";
    const analysis =
      typeof obj.analysis === "string" && obj.analysis.trim() ? obj.analysis.trim() : undefined;
    const recommendation =
      typeof obj.recommendation === "string" && obj.recommendation.trim()
        ? obj.recommendation.trim()
        : undefined;
    return {
      question,
      ...(analysis ? { analysis } : {}),
      ...(recommendation ? { recommendation } : {}),
      options,
    };
  }
  return null;
}

export function parseReviewVerdict(
  text: string,
  meta: { readonly round: number; readonly reviewerThreadId?: string | undefined },
): DispatchReviewVerdict {
  const now = new Date().toISOString();
  for (const candidate of extractJsonBlocks(text)) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.verdict !== "pass" && obj.verdict !== "fail") continue;
    const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
    const issues: DispatchReviewIssue[] = rawIssues
      .map((item): DispatchReviewIssue | null => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
        if (!summary) return null;
        const sev = rec.severity;
        const severity: DispatchReviewIssue["severity"] =
          sev === "blocker" || sev === "high" || sev === "medium" || sev === "low" ? sev : "medium";
        return {
          severity,
          ...(typeof rec.file === "string" && rec.file.trim() ? { file: rec.file.trim() } : {}),
          summary,
          ...(typeof rec.fixHint === "string" && rec.fixHint.trim()
            ? { fixHint: rec.fixHint.trim() }
            : {}),
        };
      })
      .filter((x): x is DispatchReviewIssue => x !== null);
    return {
      round: meta.round,
      verdict: obj.verdict,
      summary:
        typeof obj.summary === "string" && obj.summary.trim()
          ? obj.summary.trim()
          : obj.verdict === "pass"
            ? "独立复查通过"
            : "独立复查发现需修复问题",
      issues,
      reviewerThreadId: meta.reviewerThreadId,
      reviewedAt: now,
    };
  }

  // Fallback heuristic if reviewer returned prose without strict JSON block.
  const lower = text.toLowerCase();
  const looksFail =
    lower.includes('"verdict": "fail"') ||
    lower.includes("verdict: fail") ||
    lower.includes("不通过");
  return {
    round: meta.round,
    verdict: looksFail ? "fail" : "pass",
    summary: text.trim().slice(0, 300) || (looksFail ? "独立复查未通过" : "独立复查通过"),
    issues: looksFail
      ? [{ severity: "high", summary: text.trim().slice(0, 600) || "请核查独立复查意见" }]
      : [],
    reviewerThreadId: meta.reviewerThreadId,
    reviewedAt: now,
  };
}
