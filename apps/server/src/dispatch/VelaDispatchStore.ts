// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_DISPATCH_CONFIG,
  type DispatchEventLogEntry,
  type DispatchTaskCard,
  type VelaDispatchState,
} from "./VelaDispatchTypes.ts";

const MAX_EVENT_LOG_ENTRIES = 80;

export type DispatchScope =
  | string
  | { readonly projectRoot: string; readonly threadId?: string | null | undefined };

export function normalizeProjectRoot(projectRoot: string): string {
  return NodePath.resolve(projectRoot);
}

export function sanitizeThreadScopeId(threadId: string): string {
  return threadId.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function normalizeDispatchScope(scope: DispatchScope): {
  readonly projectRoot: string;
  readonly threadId: string | null;
  readonly key: string;
} {
  if (typeof scope === "string") {
    const projectRoot = normalizeProjectRoot(scope);
    return { projectRoot, threadId: null, key: projectRoot };
  }
  const projectRoot = normalizeProjectRoot(scope.projectRoot);
  const rawThreadId = scope.threadId?.trim();
  const threadId = rawThreadId ? rawThreadId : null;
  const key = threadId ? `${projectRoot}::thread::${threadId}` : projectRoot;
  return { projectRoot, threadId, key };
}

export function projectDispatchSlug(projectRoot: string): string {
  const normalized = normalizeProjectRoot(projectRoot);
  const base =
    NodePath.basename(normalized)
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 32) || "project";
  const hash = NodeCrypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

function legacyDispatchDirOf(scope: DispatchScope): string {
  const { projectRoot, threadId } = normalizeDispatchScope(scope);
  const baseDir = NodePath.join(projectRoot, ".vela", "dispatch");
  return threadId ? NodePath.join(baseDir, "threads", sanitizeThreadScopeId(threadId)) : baseDir;
}

export function dispatchDirOf(scope: DispatchScope, stateDir: string): string {
  const { projectRoot, threadId } = normalizeDispatchScope(scope);
  const baseDir = NodePath.join(stateDir, "dispatch", projectDispatchSlug(projectRoot));
  return threadId ? NodePath.join(baseDir, "threads", sanitizeThreadScopeId(threadId)) : baseDir;
}

export function dispatchStateFileOf(scope: DispatchScope, stateDir: string): string {
  return NodePath.join(dispatchDirOf(scope, stateDir), "state.json");
}

export function dispatchContractFileOf(scope: DispatchScope, stateDir: string): string {
  const { threadId } = normalizeDispatchScope(scope);
  return threadId
    ? NodePath.join(dispatchDirOf(scope, stateDir), "contract.md")
    : NodePath.join(dispatchDirOf(scope, stateDir), "contracts", "latest.md");
}

export function dispatchLedgerFileOf(scope: DispatchScope, stateDir: string): string {
  return NodePath.join(dispatchDirOf(scope, stateDir), "ledger.md");
}

export function createEmptyDispatchState(
  projectRoot: string,
  threadId?: string | null,
): VelaDispatchState {
  const normalizedThreadId = threadId?.trim() || null;
  return {
    version: 1,
    projectRoot: normalizeProjectRoot(projectRoot),
    projectId: null,
    parentThreadId: normalizedThreadId,
    planTitle: null,
    mode: "fast",
    prdSource: null,
    sharedContractPath: null,
    requirement: null,
    config: DEFAULT_DISPATCH_CONFIG,
    blindCheck: null,
    steps: [],
    runs: {},
    escalations: [],
    events: [],
    history: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Computes which locked steps should unlock next:
 * - If any step declares `dependsOn` (DAG mode), unlock every locked step whose `dependsOn`
 *   prerequisites are all `done`.
 * - Otherwise preserve order + `parallelGroup` unlocking.
 */
export function unlockReadySteps(
  steps: ReadonlyArray<DispatchTaskCard>,
): ReadonlyArray<DispatchTaskCard> {
  const ordered = [...steps].toSorted((a, b) => a.order - b.order);
  const now = new Date().toISOString();

  const usesDag = ordered.some((step) => step.dependsOn !== undefined);
  if (usesDag) {
    const doneIds = new Set(ordered.filter((s) => s.status === "done").map((s) => s.id));
    return ordered.map((step) => {
      if (step.status !== "locked") return step;
      const deps = step.dependsOn ?? [];
      if (deps.every((depId) => doneIds.has(depId))) {
        return { ...step, status: "ready", updatedAt: now };
      }
      return step;
    });
  }

  const firstNotDone = ordered.find((step) => step.status !== "done");
  if (!firstNotDone) return ordered;

  // If any earlier step is already active/ready/failed (not done and not locked), keep later locked steps locked.
  if (firstNotDone.status !== "locked") {
    return ordered;
  }

  const groupToUnlock = firstNotDone.parallelGroup?.trim();
  return ordered.map((step) => {
    if (step.id === firstNotDone.id) {
      return { ...step, status: "ready", updatedAt: now };
    }
    if (groupToUnlock && step.status === "locked" && step.parallelGroup?.trim() === groupToUnlock) {
      return { ...step, status: "ready", updatedAt: now };
    }
    return step;
  });
}

export class VelaDispatchStore {
  private readonly emitter = new NodeEvents.EventEmitter();
  private readonly cache = new Map<string, VelaDispatchState>();
  private readonly writeLocks = new Map<string, Promise<unknown>>();
  private readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = NodePath.resolve(
      stateDir?.trim() || NodePath.join(NodeOS.homedir(), ".t3", "dispatch-state"),
    );
    this.emitter.setMaxListeners(100);
  }

  public subscribe(
    scope: DispatchScope,
    listener: (state: VelaDispatchState) => void,
  ): () => void {
    const { key } = normalizeDispatchScope(scope);
    const eventName = `state:${key}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }

  private emit(scopeKey: string, state: VelaDispatchState): void {
    this.emitter.emit(`state:${scopeKey}`, state);
  }

  public async read(scope: DispatchScope): Promise<VelaDispatchState> {
    const normalized = normalizeDispatchScope(scope);
    const { projectRoot, threadId, key } = normalized;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const primaryFile = dispatchStateFileOf(normalized, this.stateDir);
    const legacyFile = NodePath.join(legacyDispatchDirOf(normalized), "state.json");
    const filePath = NodeFS.existsSync(primaryFile)
      ? primaryFile
      : NodeFS.existsSync(legacyFile)
        ? legacyFile
        : null;
    if (!filePath) {
      const empty = createEmptyDispatchState(projectRoot, threadId);
      this.cache.set(key, empty);
      return empty;
    }

    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<VelaDispatchState>;
      const hydrated: VelaDispatchState = {
        ...createEmptyDispatchState(projectRoot, threadId),
        ...parsed,
        version: 1,
        projectRoot,
        parentThreadId: parsed.parentThreadId ?? threadId,
        config: {
          ...DEFAULT_DISPATCH_CONFIG,
          ...parsed.config,
        },
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
        escalations: Array.isArray(parsed.escalations) ? parsed.escalations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
      this.cache.set(key, hydrated);
      return hydrated;
    } catch {
      const empty = createEmptyDispatchState(projectRoot, threadId);
      this.cache.set(key, empty);
      return empty;
    }
  }

  public async update(
    scope: DispatchScope,
    updater: (current: VelaDispatchState) => VelaDispatchState,
    eventLog?: { readonly stepId?: string | undefined; readonly text: string },
  ): Promise<VelaDispatchState> {
    const normalized = normalizeDispatchScope(scope);
    const { projectRoot, threadId, key } = normalized;
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const nextOperation = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.read(normalized);
        const now = new Date().toISOString();
        let next = updater(current);
        if (eventLog?.text.trim()) {
          const entry: DispatchEventLogEntry = {
            at: now,
            ...(eventLog.stepId ? { stepId: eventLog.stepId } : {}),
            text: eventLog.text.trim(),
          };
          const events = [...next.events, entry].slice(-MAX_EVENT_LOG_ENTRIES);
          next = { ...next, events };
        }
        next = {
          ...next,
          projectRoot,
          parentThreadId: next.parentThreadId ?? threadId,
          updatedAt: now,
        };

        const dir = dispatchDirOf(normalized, this.stateDir);
        await NodeFSP.mkdir(dir, { recursive: true });
        const filePath = dispatchStateFileOf(normalized, this.stateDir);
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await NodeFSP.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await NodeFSP.rename(tmpPath, filePath);

        this.cache.set(key, next);
        this.emit(key, next);
        return next;
      });

    this.writeLocks.set(key, nextOperation);
    return nextOperation;
  }

  public async writeSharedContract(scope: DispatchScope, content: string): Promise<string> {
    const normalized = normalizeDispatchScope(scope);
    const filePath = dispatchContractFileOf(normalized, this.stateDir);
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, `${content.trim()}\n`, "utf8");
    return filePath;
  }

  public async readSharedContract(scope: DispatchScope): Promise<string | undefined> {
    const normalized = normalizeDispatchScope(scope);
    const primaryFile = dispatchContractFileOf(normalized, this.stateDir);
    const legacyFile = NodePath.join(
      legacyDispatchDirOf(normalized),
      normalized.threadId ? "contract.md" : NodePath.join("contracts", "latest.md"),
    );
    const filePath = NodeFS.existsSync(primaryFile)
      ? primaryFile
      : NodeFS.existsSync(legacyFile)
        ? legacyFile
        : null;
    if (!filePath) return undefined;
    try {
      return await NodeFSP.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  public async appendLedger(scope: DispatchScope, entryMarkdown: string): Promise<void> {
    const filePath = dispatchLedgerFileOf(scope, this.stateDir);
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    const header = NodeFS.existsSync(filePath) ? "" : "# Vela Dispatch Ledger\n\n";
    await NodeFSP.appendFile(filePath, `${header}${entryMarkdown.trim()}\n\n`, "utf8");
  }

  public async readLedgerExcerpt(scope: DispatchScope, maxChars = 2500): Promise<string> {
    const primaryFile = dispatchLedgerFileOf(scope, this.stateDir);
    const legacyFile = NodePath.join(legacyDispatchDirOf(scope), "ledger.md");
    const filePath = NodeFS.existsSync(primaryFile)
      ? primaryFile
      : NodeFS.existsSync(legacyFile)
        ? legacyFile
        : null;
    if (!filePath) return "";
    try {
      const text = await NodeFSP.readFile(filePath, "utf8");
      return text.length > maxChars ? text.slice(-maxChars) : text;
    } catch {
      return "";
    }
  }
}
