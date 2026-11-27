import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  type CollabAttentionReason,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type ProviderOptionDescriptor,
  type VelaCollabProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { useEffect, useState, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

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
  readonly completedTree?: string | null | undefined;
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
  readonly enableBatchAudit?: boolean | undefined;
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

export interface DispatchAttentionItem {
  readonly engineVersion?: 2;
  readonly planId?: string;
  readonly attentionReason?: CollabAttentionReason | "ready_to_deliver";
  readonly id: string;
  readonly kind: "decision" | "escalation" | "accept";
  readonly projectRoot: string;
  readonly threadId: string | null;
  readonly planTitle: string | null;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly summary: string;
  readonly blockedStepTitles: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface ScopedDispatchAttentionItem extends DispatchAttentionItem {
  readonly environmentId: EnvironmentId;
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
  readonly collab?: VelaCollabProjection | null;
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

function buildUrlWithSearchParams(
  baseUrlString: string,
  searchParams?: Readonly<Record<string, string>>,
): string {
  const url = new URL(baseUrlString);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function normalizeHttpMethod(method: string | undefined): "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" {
  const upper = (method ?? "GET").toUpperCase();
  if (
    upper === "GET" ||
    upper === "POST" ||
    upper === "PUT" ||
    upper === "DELETE" ||
    upper === "PATCH" ||
    upper === "HEAD" ||
    upper === "OPTIONS"
  ) {
    return upper;
  }
  return "GET";
}

async function resolveDispatchRequest(
  pathname: string,
  init?: RequestInit,
  searchParams?: Readonly<Record<string, string>>,
  environmentId?: EnvironmentId | null,
): Promise<{
  readonly url: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials;
}> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const targetEnvId = environmentId ?? EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(targetEnvId)),
  );

  if (prepared !== null) {
    const url = buildUrlWithSearchParams(
      environmentEndpointUrl(prepared.httpBaseUrl, pathname),
      searchParams,
    );
    const auth = prepared.httpAuthorization;
    if (auth === null) {
      return { url, headers, credentials: "include" };
    }
    if (auth._tag === "Bearer") {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { url, headers, credentials: "omit" };
    }
    // DPoP authorization for remote / relay-connected environments
    const dpopHeaders = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime);
        const signerOpt = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner).pipe(
          Effect.provide(context),
        );
        if (Option.isNone(signerOpt)) {
          return null;
        }
        const proof = yield* signerOpt.value.createProof({
          method: normalizeHttpMethod(init?.method),
          url,
          accessToken: auth.accessToken,
        });
        return {
          authorization: `DPoP ${auth.accessToken}`,
          dpop: proof,
        };
      }),
    );
    if (dpopHeaders === null) {
      throw new Error("远端环境缺少 DPoP 签名器，无法发送派发请求");
    }
    headers.set("Authorization", dpopHeaders.authorization);
    headers.set("DPoP", dpopHeaders.dpop);
    return { url, headers, credentials: "omit" };
  }

  if (environmentId && environmentId !== PRIMARY_LOCAL_ENVIRONMENT_ID) {
    throw new Error("远端环境尚未连接，无法访问派发服务");
  }

  const url = buildUrlWithSearchParams(resolvePrimaryEnvironmentHttpUrl(pathname), searchParams);
  let credentials: RequestCredentials = "omit";
  if (isSameOriginBrowserPrimary()) {
    credentials = "include";
  } else {
    const token = await readDesktopPrimaryBearerToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return { url, headers, credentials };
}

export async function fetchDispatchApi<T>(
  pathname: string,
  init?: RequestInit,
  searchParams?: Readonly<Record<string, string>>,
  environmentId?: EnvironmentId | null,
): Promise<T> {
  const { url, headers, credentials } = await resolveDispatchRequest(
    pathname,
    init,
    searchParams,
    environmentId,
  );
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

export type CollabEvidenceTarget = { readonly reviewId: string } | { readonly deliveryId: string };

export interface CollabEvidenceFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "A" | "M" | "D" | "R";
  readonly isBinary: boolean;
  readonly sizeBytes: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
}

interface CollabEvidencePage {
  readonly offset: number;
  readonly nextOffset: number | null;
}

type CollabEvidenceText =
  | { readonly encoding: "utf8"; readonly text: string }
  | { readonly encoding: "base64"; readonly dataBase64: string };

type CollabEvidenceEntry = { readonly oid: string; readonly mode: string };

type CollabEvidenceQuery =
  | { readonly view: "manifest"; readonly offset?: number }
  | { readonly view: "diff"; readonly path: string; readonly offset?: number }
  | {
      readonly view: "file";
      readonly path: string;
      readonly side?: "base" | "snapshot";
      readonly startLine?: number;
      readonly endLine?: number;
    };

export interface CollabEvidenceResults {
  readonly manifest: CollabEvidencePage & {
    readonly kind: "manifest";
    readonly files: ReadonlyArray<CollabEvidenceFile>;
    readonly summary?: string;
  };
  readonly diff:
    | (CollabEvidencePage &
        CollabEvidenceText & {
          readonly kind: "patch";
          readonly file: CollabEvidenceFile;
          readonly byteLength: number;
        })
    | { readonly kind: "binary"; readonly file: CollabEvidenceFile };
  readonly file:
    | (CollabEvidenceText & {
        readonly kind: "lines";
        readonly entry: CollabEvidenceEntry;
        readonly startLine: number;
        readonly endLine: number;
        readonly byteLength: number;
        readonly truncated: boolean;
      })
    | { readonly kind: "binary"; readonly entry: CollabEvidenceEntry };
}

export function fetchCollabEvidence<View extends CollabEvidenceQuery["view"]>(
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
    readonly planId: string;
    readonly target: CollabEvidenceTarget;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
    readonly view: View;
  } & Extract<CollabEvidenceQuery, { view: View }>,
): Promise<CollabEvidenceResults[View]> {
  const { environmentId, signal, target, ...query } = input;
  const params = Object.fromEntries(
    Object.entries({ ...query, ...target }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
  return fetchDispatchApi(
    "/api/vela/dispatch/v2/evidence",
    signal ? { signal } : undefined,
    params,
    environmentId,
  );
}

const stateCache = new Map<string, VelaDispatchState>();
const stateListeners = new Map<string, Set<(state: VelaDispatchState) => void>>();
const activeStreams = new Map<string, { refCount: number; abort: AbortController }>();

const providersCacheByEnv = new Map<string, ReadonlyArray<DispatchProviderSummary>>();
const providersInflightByEnv = new Map<string, Promise<ReadonlyArray<DispatchProviderSummary>>>();

function normalizeEnvCacheKey(environmentId?: EnvironmentId | null): string {
  return environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
}

export function dispatchCacheKey(
  projectRoot: string,
  threadId?: string | null,
  environmentId?: EnvironmentId | null,
): string {
  const envKey = normalizeEnvCacheKey(environmentId);
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId ? `${envKey}::${projectRoot}::${normalizedThreadId}` : `${envKey}::${projectRoot}`;
}

export function setCachedDispatchState(
  projectRoot: string,
  next: VelaDispatchState,
  threadId?: string | null,
  environmentId?: EnvironmentId | null,
): void {
  const key = dispatchCacheKey(projectRoot, threadId, environmentId);
  const previous = stateCache.get(key)?.collab;
  if (
    previous &&
    next.collab?.planId === previous.planId &&
    next.collab.revision < previous.revision
  ) {
    return;
  }
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
  environmentId?: EnvironmentId | null,
): Promise<VelaDispatchState> {
  const normalizedThreadId = threadId?.trim();
  const state = await fetchDispatchApi<VelaDispatchState>(
    "/api/vela/dispatch/state",
    undefined,
    {
      projectRoot,
      ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
    },
    environmentId,
  );
  setCachedDispatchState(projectRoot, state, normalizedThreadId, environmentId);
  return state;
}

function ensureDispatchStream(
  projectRoot: string,
  threadId?: string | null,
  environmentId?: EnvironmentId | null,
): () => void {
  const normalizedThreadId = threadId?.trim();
  const key = dispatchCacheKey(projectRoot, normalizedThreadId, environmentId);
  let entry = activeStreams.get(key);
  if (!entry) {
    const abort = new AbortController();
    entry = { refCount: 0, abort };
    activeStreams.set(key, entry);

    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const { url, headers, credentials } = await resolveDispatchRequest(
            "/api/vela/dispatch/stream",
            { headers: { Accept: "text/event-stream" } },
            {
              projectRoot,
              ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
            },
            environmentId,
          );
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
                  setCachedDispatchState(projectRoot, parsed, normalizedThreadId, environmentId);
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
  environmentId?: EnvironmentId | null,
): DispatchStore {
  if (!projectRoot) return EMPTY_DISPATCH_STORE;
  const key = dispatchCacheKey(projectRoot, normalizedThreadId, environmentId);
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
        const stopStream = ensureDispatchStream(projectRoot, normalizedThreadId, environmentId);
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
  environmentId?: EnvironmentId | null,
): {
  readonly state: VelaDispatchState | null;
  readonly refresh: () => Promise<void>;
} {
  const normalizedThreadId = threadId?.trim() || undefined;
  const store = getDispatchStore(projectRoot, normalizedThreadId, environmentId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const refresh = async () => {
    if (!projectRoot) return;
    await refreshDispatchState(projectRoot, normalizedThreadId, environmentId);
  };

  return { state, refresh };
}

function getValidCachedProviders(envKey: string): ReadonlyArray<DispatchProviderSummary> | null {
  const cached = providersCacheByEnv.get(envKey);
  if (cached && cached.every((p) => Boolean(p.name?.trim()))) {
    return cached;
  }
  return null;
}

export function useVelaDispatchProviders(
  environmentId?: EnvironmentId | null,
): ReadonlyArray<DispatchProviderSummary> {
  const envKey = normalizeEnvCacheKey(environmentId);
  const [providersByEnv, setProvidersByEnv] = useState<{
    readonly envKey: string;
    readonly list: ReadonlyArray<DispatchProviderSummary>;
  }>(() => ({
    envKey,
    list: getValidCachedProviders(envKey) ?? [],
  }));

  const currentCached = getValidCachedProviders(envKey);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads cached Vela provider catalog per environmentId for dispatch target pickers
  useEffect(() => {
    const valid = getValidCachedProviders(envKey);
    if (valid) return;
    let inflight = providersInflightByEnv.get(envKey);
    if (!inflight) {
      inflight = fetchDispatchApi<{ providers: DispatchProviderSummary[] }>(
        "/api/vela/dispatch/providers",
        undefined,
        undefined,
        environmentId,
      )
        .then((res) => {
          providersCacheByEnv.set(envKey, res.providers);
          return res.providers;
        })
        .catch(() => [])
        .finally(() => {
          providersInflightByEnv.delete(envKey);
        });
      providersInflightByEnv.set(envKey, inflight);
    }
    let active = true;
    void inflight.then((list) => {
      if (active) setProvidersByEnv({ envKey, list });
    });
    return () => {
      active = false;
    };
  }, [envKey, environmentId]);

  if (currentCached) return currentCached;
  return providersByEnv.envKey === envKey ? providersByEnv.list : [];
}

interface AttentionEnvEntry {
  items: ReadonlyArray<ScopedDispatchAttentionItem>;
  refCount: number;
  abort: AbortController;
}

const attentionByEnv = new Map<string, AttentionEnvEntry>();
const attentionListeners = new Set<() => void>();
let attentionVersion = 0;

function notifyAttentionListeners(): void {
  attentionVersion += 1;
  for (const listener of attentionListeners) {
    listener();
  }
}

function retainAttentionEnvStream(environmentId: EnvironmentId): () => void {
  const envKey = normalizeEnvCacheKey(environmentId);
  let entry = attentionByEnv.get(envKey);
  if (!entry) {
    const abort = new AbortController();
    entry = { items: [], refCount: 0, abort };
    attentionByEnv.set(envKey, entry);

    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const { url, headers, credentials } = await resolveDispatchRequest(
            "/api/vela/dispatch/attention/stream",
            { headers: { Accept: "text/event-stream" } },
            undefined,
            environmentId,
          );
          const response = await fetch(url, {
            headers,
            credentials,
            signal: abort.signal,
          });
          if (!response.ok || !response.body) {
            await new Promise((r) => setTimeout(r, 4_000));
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
                  const parsed = JSON.parse(dataLines.join("\n")) as {
                    items?: ReadonlyArray<DispatchAttentionItem>;
                  };
                  const scoped = (parsed.items ?? []).map((item) => ({
                    ...item,
                    environmentId,
                  }));
                  const target = attentionByEnv.get(envKey);
                  if (target) {
                    target.items = scoped;
                    notifyAttentionListeners();
                  }
                } catch {
                  // Ignore malformed SSE chunk
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          }
        } catch {
          if (abort.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 3_500));
        }
      }
    })();
  }

  entry.refCount += 1;
  return () => {
    const current = attentionByEnv.get(envKey);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount <= 0) {
      current.abort.abort();
      attentionByEnv.delete(envKey);
      notifyAttentionListeners();
    }
  };
}

function subscribeAttentionSnapshot(listener: () => void): () => void {
  attentionListeners.add(listener);
  return () => {
    attentionListeners.delete(listener);
  };
}

function readAttentionSnapshot(): number {
  return attentionVersion;
}

export function useVelaDispatchAttention(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<ScopedDispatchAttentionItem> {
  const envKeyList = environmentIds.join("\n");
  useSyncExternalStore(subscribeAttentionSnapshot, readAttentionSnapshot, readAttentionSnapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to per-environment dispatch attention SSE streams while environments are connected
  useEffect(() => {
    const ids = envKeyList
      .split("\n")
      .filter((id) => id.length > 0)
      .map((id) => EnvironmentId.make(id));
    const cleanups = ids.map((envId) => retainAttentionEnvStream(envId));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [envKeyList]);

  const combined: ScopedDispatchAttentionItem[] = [];
  for (const envId of environmentIds) {
    const entry = attentionByEnv.get(normalizeEnvCacheKey(envId));
    if (entry?.items.length) {
      combined.push(...entry.items);
    }
  }
  return combined.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const pendingFocusByThread = new Map<string, { readonly stepId: string; readonly at: number }>();
const focusListenersByThread = new Map<string, Set<(stepId: string) => void>>();

export function requestFocusDispatchStep(threadId: string, stepId: string): void {
  const listeners = focusListenersByThread.get(threadId);
  if (listeners && listeners.size > 0) {
    pendingFocusByThread.delete(threadId);
    for (const listener of listeners) {
      listener(stepId);
    }
    return;
  }
  pendingFocusByThread.set(threadId, { stepId, at: Date.now() });
}

export function subscribeFocusDispatchStep(
  threadId: string,
  listener: (stepId: string) => void,
): () => void {
  let set = focusListenersByThread.get(threadId);
  if (!set) {
    set = new Set();
    focusListenersByThread.set(threadId, set);
  }
  set.add(listener);

  const pending = pendingFocusByThread.get(threadId);
  if (pending) {
    pendingFocusByThread.delete(threadId);
    if (Date.now() - pending.at < 5_000) {
      listener(pending.stepId);
    }
  }

  return () => {
    set?.delete(listener);
    if (set?.size === 0) {
      focusListenersByThread.delete(threadId);
    }
  };
}
