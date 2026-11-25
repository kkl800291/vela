import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

export type DispatchIsolationMode = "direct" | "worktree";

export type DispatchStepKind = "research" | "decision" | "change";

export type DispatchStepStatus =
  | "locked"
  | "ready"
  | "running"
  | "premise_failed"
  | "waiting_orchestrator"
  | "awaiting_decision"
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
  readonly kind?: DispatchStepKind | undefined;
  readonly isolation: DispatchIsolationMode;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly parallelGroup?: string | undefined;
  readonly premisesToVerify: ReadonlyArray<string>;
  readonly contextFiles: ReadonlyArray<string>;
  readonly contractNote?: string | undefined;
  readonly prdSource?: string | undefined;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly decisionOptions?: ReadonlyArray<DispatchEscalationOption> | undefined;
  readonly warnings?: ReadonlyArray<string> | undefined;
  readonly allowedGlobs: ReadonlyArray<string>;
  readonly forbiddenGlobs: ReadonlyArray<string>;
  readonly sensitiveGlobs: ReadonlyArray<string>;
  readonly hardGates: ReadonlyArray<string>;
  readonly executor: "self" | DispatchAgentTarget;
  readonly reviewer?: DispatchAgentTarget | null | undefined;
  readonly skipProductAcceptance?: boolean | undefined;
  readonly status: DispatchStepStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DispatchDeliverable {
  readonly kind: "report" | "decision" | "change_summary";
  readonly text: string;
  readonly selectedOptionId?: string | undefined;
  readonly producedAt: string;
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

export interface DispatchAcceptanceItem {
  readonly criterion: string;
  readonly status: "passed" | "failed" | "manual_check";
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

export interface DispatchEscalationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
}

export interface DispatchEscalationRecord {
  readonly id: string;
  readonly stepId: string;
  readonly kind: string;
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

export interface DispatchStepRun {
  readonly stepId: string;
  readonly isolation: DispatchIsolationMode;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly baselineTree: string | null;
  readonly workspacePath: string;
  readonly childThreadId: string | null;
  readonly childRunId: string | null;
  readonly reviewerThreadIds: ReadonlyArray<string>;
  readonly status: DispatchStepStatus;
  readonly headline: string;
  readonly lastError: string | null;
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

export interface DispatchEventLogEntry {
  readonly at: string;
  readonly stepId?: string | undefined;
  readonly text: string;
}

export interface DispatchConfig {
  readonly defaultAgent?: DispatchAgentTarget | null | undefined;
  readonly maxReviewRounds?: number | undefined;
  readonly maxOrchestratorEscalationRounds?: number | undefined;
  readonly maxAcceptanceRounds?: number | undefined;
  readonly defaultHardGates?: ReadonlyArray<string> | undefined;
  readonly defaultSensitiveGlobs?: ReadonlyArray<string> | undefined;
  readonly requireProductAcceptance?: boolean | undefined;
}

export interface DispatchRequirementSnapshot {
  readonly userInput?: string | undefined;
  readonly summary?: string | undefined;
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

export interface DispatchTaskSpecPatch {
  readonly title?: string | undefined;
  readonly goal?: string | undefined;
  readonly kind?: DispatchStepKind | undefined;
  readonly decisionOptions?: ReadonlyArray<DispatchEscalationOption> | undefined;
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
  readonly config?: DispatchConfig | undefined;
  readonly blindCheck: DispatchBlindCheckRecord | null;
  readonly steps: ReadonlyArray<DispatchTaskCard>;
  readonly runs: Readonly<Record<string, DispatchStepRun>>;
  readonly escalations: ReadonlyArray<DispatchEscalationRecord>;
  readonly events: ReadonlyArray<DispatchEventLogEntry>;
  readonly history?: ReadonlyArray<DispatchArchivedPlan> | undefined;
  readonly updatedAt: string;
}

export interface DispatchProviderSummary {
  readonly instanceId: string;
  readonly provider: string;
  readonly name: string;
  readonly status: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  }>;
}

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function buildAuthRequest(init?: RequestInit): Promise<{
  readonly headers: Headers;
  readonly credentials: RequestCredentials;
}> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let credentials: RequestCredentials = "omit";
  if (isSameOriginBrowserPrimary()) {
    credentials = "include";
  } else {
    const token = await readDesktopPrimaryBearerToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return { headers, credentials };
}

function resolveDispatchUrl(
  pathname: string,
  searchParams?: Readonly<Record<string, string>>,
): string {
  const url = new URL(resolvePrimaryEnvironmentHttpUrl(pathname));
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export async function fetchDispatchApi<T>(
  pathname: string,
  init?: RequestInit,
  searchParams?: Readonly<Record<string, string>>,
): Promise<T> {
  const url = resolveDispatchUrl(pathname, searchParams);
  const { headers, credentials } = await buildAuthRequest(init);
  const response = await fetch(url, { ...init, headers, credentials });
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;

  if (!response.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const stateCache = new Map<string, VelaDispatchState>();
const stateListeners = new Map<string, Set<(state: VelaDispatchState) => void>>();
const activeStreams = new Map<string, { refCount: number; abort: AbortController }>();

let providersCache: ReadonlyArray<DispatchProviderSummary> | null = null;
let providersInflight: Promise<ReadonlyArray<DispatchProviderSummary>> | null = null;

export function dispatchCacheKey(projectRoot: string, threadId?: string | null): string {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId ? `${projectRoot}::${normalizedThreadId}` : projectRoot;
}

export function setCachedDispatchState(
  projectRoot: string,
  next: VelaDispatchState,
  threadId?: string | null,
): void {
  const key = dispatchCacheKey(projectRoot, threadId);
  stateCache.set(key, next);
  const listeners = stateListeners.get(key);
  if (listeners) {
    for (const listener of listeners) {
      listener(next);
    }
  }
}

export async function refreshDispatchState(
  projectRoot: string,
  threadId?: string | null,
): Promise<VelaDispatchState> {
  const normalizedThreadId = threadId?.trim();
  const state = await fetchDispatchApi<VelaDispatchState>("/api/vela/dispatch/state", undefined, {
    projectRoot,
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
  });
  setCachedDispatchState(projectRoot, state, normalizedThreadId);
  return state;
}

function ensureDispatchStream(projectRoot: string, threadId?: string | null): () => void {
  const normalizedThreadId = threadId?.trim();
  const key = dispatchCacheKey(projectRoot, normalizedThreadId);
  let entry = activeStreams.get(key);
  if (!entry) {
    const abort = new AbortController();
    entry = { refCount: 0, abort };
    activeStreams.set(key, entry);

    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const url = resolveDispatchUrl("/api/vela/dispatch/stream", {
            projectRoot,
            ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
          });
          const { headers, credentials } = await buildAuthRequest();
          headers.set("Accept", "text/event-stream");
          const response = await fetch(url, {
            headers,
            credentials,
            signal: abort.signal,
          });
          if (!response.ok || !response.body) {
            await new Promise((r) => setTimeout(r, 3_000));
            continue;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!abort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf("\n\n");
            while (idx !== -1) {
              const rawEvent = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const dataLines = rawEvent
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim());
              if (dataLines.length > 0) {
                try {
                  const parsed = JSON.parse(dataLines.join("\n")) as VelaDispatchState;
                  setCachedDispatchState(projectRoot, parsed, normalizedThreadId);
                } catch {
                  // Ignore malformed SSE chunk
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          }
        } catch {
          if (abort.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 2_500));
        }
      }
    })();
  }

  entry.refCount += 1;
  return () => {
    const current = activeStreams.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount <= 0) {
      current.abort.abort();
      activeStreams.delete(key);
    }
  };
}

interface DispatchStore {
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => VelaDispatchState | null;
}

const EMPTY_DISPATCH_STORE: DispatchStore = {
  subscribe: () => () => {},
  getSnapshot: () => null,
};

const dispatchStores = new Map<string, DispatchStore>();

function getDispatchStore(
  projectRoot: string | undefined,
  normalizedThreadId: string | undefined,
): DispatchStore {
  if (!projectRoot) return EMPTY_DISPATCH_STORE;
  const key = dispatchCacheKey(projectRoot, normalizedThreadId);
  let store = dispatchStores.get(key);
  if (!store) {
    store = {
      subscribe: (onStoreChange: () => void) => {
        let set = stateListeners.get(key);
        if (!set) {
          set = new Set();
          stateListeners.set(key, set);
        }
        const listener = () => onStoreChange();
        set.add(listener);
        const stopStream = ensureDispatchStream(projectRoot, normalizedThreadId);
        return () => {
          set?.delete(listener);
          stopStream();
        };
      },
      getSnapshot: () => stateCache.get(key) ?? null,
    };
    dispatchStores.set(key, store);
  }
  return store;
}

export function useVelaDispatchState(
  projectRoot: string | undefined,
  threadId?: string | null,
): {
  readonly state: VelaDispatchState | null;
  readonly refresh: () => Promise<void>;
} {
  const normalizedThreadId = threadId?.trim() || undefined;
  const store = getDispatchStore(projectRoot, normalizedThreadId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const refresh = async () => {
    if (!projectRoot) return;
    await refreshDispatchState(projectRoot, normalizedThreadId);
  };

  return { state, refresh };
}

export function useVelaDispatchProviders(): ReadonlyArray<DispatchProviderSummary> {
  const [providers, setProviders] = useState<ReadonlyArray<DispatchProviderSummary>>(() =>
    providersCache && providersCache.every((p) => Boolean(p.name?.trim()))
      ? providersCache
      : [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads cached Vela provider catalog for dispatch target pickers
  useEffect(() => {
    if (providersCache && providersCache.every((p) => Boolean(p.name?.trim()))) return;
    if (!providersInflight) {
      providersInflight = fetchDispatchApi<{ providers: DispatchProviderSummary[] }>(
        "/api/vela/dispatch/providers",
      )
        .then((res) => {
          providersCache = res.providers;
          return res.providers;
        })
        .catch(() => [])
        .finally(() => {
          providersInflight = null;
        });
    }
    let active = true;
    void providersInflight.then((list) => {
      if (active) setProviders(list);
    });
    return () => {
      active = false;
    };
  }, []);

  return providers;
}
