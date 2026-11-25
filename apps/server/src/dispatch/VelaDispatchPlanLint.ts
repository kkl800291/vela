import type { DispatchTaskCard } from "./VelaDispatchTypes.ts";

export interface DispatchPlanLintResult {
  readonly errors: string[];
  readonly warningsByStep: Record<string, string[]>;
}

function globStaticPrefix(glob: string): string {
  const normalized = glob.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const starIdx = normalized.indexOf("*");
  return starIdx === -1 ? normalized : normalized.slice(0, starIdx);
}

function globsMayOverlap(
  globsA: ReadonlyArray<string>,
  globsB: ReadonlyArray<string>,
): boolean {
  for (const rawA of globsA) {
    const trimmedA = rawA.trim();
    if (!trimmedA) continue;
    const prefixA = globStaticPrefix(trimmedA);
    for (const rawB of globsB) {
      const trimmedB = rawB.trim();
      if (!trimmedB) continue;
      const prefixB = globStaticPrefix(trimmedB);
      if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) {
        return true;
      }
    }
  }
  return false;
}

function computeTransitiveAncestors(
  steps: ReadonlyArray<DispatchTaskCard>,
  idSet: ReadonlySet<string>,
): Map<string, Set<string>> {
  const depsById = new Map<string, ReadonlyArray<string>>();
  for (const step of steps) {
    depsById.set(step.id, step.dependsOn ?? []);
  }

  const ancestors = new Map<string, Set<string>>();
  for (const step of steps) {
    const visited = new Set<string>();
    const queue: string[] = [...(depsById.get(step.id) ?? [])];
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (depId === step.id || !idSet.has(depId) || visited.has(depId)) continue;
      visited.add(depId);
      for (const nextDep of depsById.get(depId) ?? []) {
        if (!visited.has(nextDep)) {
          queue.push(nextDep);
        }
      }
    }
    ancestors.set(step.id, visited);
  }
  return ancestors;
}

function addWarning(
  warningsByStep: Record<string, string[]>,
  stepId: string,
  message: string,
): void {
  const existing = warningsByStep[stepId];
  if (!existing) {
    warningsByStep[stepId] = [message];
    return;
  }
  if (!existing.includes(message)) {
    existing.push(message);
  }
}

/** Validates dispatch task cards for structural/dependency errors and non-blocking warnings. */
export function lintDispatchPlan(
  steps: ReadonlyArray<DispatchTaskCard>,
): DispatchPlanLintResult {
  const errors: string[] = [];
  const warningsByStep: Record<string, string[]> = {};

  const idCounts = new Map<string, number>();
  for (const step of steps) {
    idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
  }
  const reportedDuplicates = new Set<string>();
  for (const step of steps) {
    if ((idCounts.get(step.id) ?? 0) > 1 && !reportedDuplicates.has(step.id)) {
      reportedDuplicates.add(step.id);
      errors.push(`任务卡 ID 重复：${step.id}`);
    }
  }

  const idSet = new Set(steps.map((s) => s.id));
  const stepById = new Map<string, DispatchTaskCard>();
  for (const step of steps) {
    if (!stepById.has(step.id)) {
      stepById.set(step.id, step);
    }
  }

  for (const step of steps) {
    const deps = step.dependsOn ?? [];
    for (const depId of deps) {
      if (depId === step.id) {
        errors.push(`${step.id} 不能依赖自身（dependsOn 包含 ${depId}）`);
      } else if (!idSet.has(depId)) {
        errors.push(`${step.id} 的 dependsOn 引用了不存在的步骤：${depId}`);
      }
    }

    const kind = step.kind ?? "change";
    if (kind === "change") {
      const hasCriteria = step.acceptanceCriteria.some((c) => c.trim().length > 0);
      if (!hasCriteria) {
        errors.push(`${step.id}（改动卡）必须填写至少一条验收标准（acceptanceCriteria）`);
      }
    } else if (kind === "decision" && step.decisionOptions !== undefined) {
      if (step.decisionOptions.length < 2) {
        errors.push(`${step.id}（决策卡）若预设 decisionOptions，至少需要 2 个选项`);
      }
    }
  }

  // DFS cycle detection across dependsOn graph
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const reportedCycles = new Set<string>();

  const dfs = (nodeId: string) => {
    color.set(nodeId, 1);
    stackIndex.set(nodeId, stack.length);
    stack.push(nodeId);

    const node = stepById.get(nodeId);
    for (const depId of node?.dependsOn ?? []) {
      if (depId === nodeId || !idSet.has(depId)) continue;
      const state = color.get(depId) ?? 0;
      if (state === 1) {
        const startIdx = stackIndex.get(depId) ?? 0;
        const cycle = [...stack.slice(startIdx), depId];
        const key = cycle.join("->");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          errors.push(`存在循环依赖：${cycle.join(" -> ")}`);
        }
      } else if (state === 0) {
        dfs(depId);
      }
    }

    stack.pop();
    stackIndex.delete(nodeId);
    color.set(nodeId, 2);
  };

  for (const step of steps) {
    if ((color.get(step.id) ?? 0) === 0) {
      dfs(step.id);
    }
  }

  // Non-blocking warnings for change cards
  for (const step of steps) {
    if ((step.kind ?? "change") !== "change") continue;
    if (step.allowedGlobs.every((g) => g.trim().length === 0)) {
      addWarning(warningsByStep, step.id, "未限定改动范围，越界检查不会生效");
    }
    if (step.hardGates.every((g) => g.trim().length === 0)) {
      addWarning(warningsByStep, step.id, "未配置 hardGates，改完后不会自动运行校验命令");
    }
  }

  // Concurrent change-card allowedGlobs overlap check
  const usesDag = steps.some((s) => s.dependsOn !== undefined);
  const ancestors = usesDag ? computeTransitiveAncestors(steps, idSet) : null;

  for (let i = 0; i < steps.length; i += 1) {
    const a = steps[i]!;
    if ((a.kind ?? "change") !== "change" || a.allowedGlobs.length === 0) continue;

    for (let j = i + 1; j < steps.length; j += 1) {
      const b = steps[j]!;
      if ((b.kind ?? "change") !== "change" || b.allowedGlobs.length === 0) continue;
      if (a.id === b.id) continue;

      const concurrent = usesDag
        ? !ancestors!.get(a.id)!.has(b.id) && !ancestors!.get(b.id)!.has(a.id)
        : Boolean(a.parallelGroup?.trim()) && a.parallelGroup?.trim() === b.parallelGroup?.trim();

      if (!concurrent) continue;
      if (globsMayOverlap(a.allowedGlobs, b.allowedGlobs)) {
        addWarning(warningsByStep, a.id, `与 ${b.id} 可能改同一批文件`);
        addWarning(warningsByStep, b.id, `与 ${a.id} 可能改同一批文件`);
      }
    }
  }

  return { errors, warningsByStep };
}
