import { Atom } from "effect/reactivity";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { appAtomRegistry } from "../rpc/atomRegistry";

export type McpEngineId = "antigravity" | "codex" | "claude" | "cursor" | "factory" | "kimi";
export type McpTransport = "stdio" | "http";

export interface UnifiedMcpServerEntry {
  readonly name: string;
  readonly transport: McpTransport;
  readonly enabled: boolean;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  readonly bearerTokenEnvVar?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maskedEnvKeys: ReadonlyArray<string>;
  readonly maskedHeaderKeys: ReadonlyArray<string>;
}

export interface McpPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly pluginName: string;
  readonly transport: McpTransport;
  readonly enabled: boolean;
  readonly summary: string;
  readonly sourcePath: string;
}

export interface EngineMcpState {
  readonly id: McpEngineId;
  readonly label: string;
  readonly format: "json" | "toml";
  readonly configPath: string;
  readonly displayPath: string;
  readonly exists: boolean;
  readonly parseError?: string;
  readonly servers: ReadonlyArray<UnifiedMcpServerEntry>;
  readonly plugins: ReadonlyArray<McpPluginEntry>;
}

export interface UnifiedMcpSnapshot {
  readonly engines: ReadonlyArray<EngineMcpState>;
  readonly secretMaskSentinel: string;
  readonly updatedAt: string;
}

export interface McpSyncEngineResult {
  readonly engineId: McpEngineId;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SyncMcpServerResult {
  readonly snapshot: UnifiedMcpSnapshot;
  readonly results: ReadonlyArray<McpSyncEngineResult>;
  readonly ok: boolean;
}

export interface McpTestResult {
  readonly ok: boolean;
  readonly status: "connected" | "auth_required" | "error";
  readonly engineId: McpEngineId;
  readonly name: string;
  readonly transport: McpTransport;
  readonly latencyMs: number;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolCount?: number;
  readonly sampleTools?: ReadonlyArray<string>;
  readonly missingEnvVars?: ReadonlyArray<string>;
  readonly supportsOAuth?: boolean;
  readonly message: string;
  readonly testedAt: string;
}

export const unifiedMcpSnapshotAtom = Atom.make<UnifiedMcpSnapshot | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("vela:unified-mcp-snapshot"),
);

export const unifiedMcpErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("vela:unified-mcp-error"),
);

export const unifiedMcpTestResultsAtom = Atom.make<Readonly<Record<string, McpTestResult>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("vela:unified-mcp-test-results"));

export const unifiedMcpViewModeAtom = Atom.make<"matrix" | "engine">("matrix").pipe(
  Atom.keepAlive,
  Atom.withLabel("vela:unified-mcp-view-mode"),
);

export const unifiedMcpActiveEngineTabAtom = Atom.make<McpEngineId>("antigravity").pipe(
  Atom.keepAlive,
  Atom.withLabel("vela:unified-mcp-active-engine-tab"),
);

const REVALIDATE_MIN_INTERVAL_MS = 1_500;

let lastFetchedAt = 0;
let lastContentSignature: string | null = null;
let inflightSnapshotRequest: Promise<UnifiedMcpSnapshot | null> | null = null;

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

export async function fetchMcpApi<T>(pathname: string, init?: RequestInit): Promise<T> {
  const url = resolvePrimaryEnvironmentHttpUrl(pathname);
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

  const response = await fetch(url, {
    ...init,
    headers,
    credentials,
  });

  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;

  if (!response.ok) {
    const errorMessage =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return data as T;
}

function snapshotContentSignature(snapshot: UnifiedMcpSnapshot): string {
  return JSON.stringify({
    engines: snapshot.engines,
    secretMaskSentinel: snapshot.secretMaskSentinel,
  });
}

export function setUnifiedMcpSnapshot(next: UnifiedMcpSnapshot): void {
  const signature = snapshotContentSignature(next);
  lastFetchedAt = Date.now();
  if (appAtomRegistry.get(unifiedMcpErrorAtom) !== null) {
    appAtomRegistry.set(unifiedMcpErrorAtom, null);
  }
  // Skip redundant atom writes when disk configs did not change (updatedAt changes every request).
  if (signature === lastContentSignature && appAtomRegistry.get(unifiedMcpSnapshotAtom) !== null) {
    return;
  }
  lastContentSignature = signature;
  appAtomRegistry.set(unifiedMcpSnapshotAtom, next);
}

export function recordUnifiedMcpTestResult(
  engineId: McpEngineId,
  name: string,
  result: McpTestResult,
): void {
  const engineKey = `${engineId}:${name}`;
  const prev = appAtomRegistry.get(unifiedMcpTestResultsAtom);
  appAtomRegistry.set(unifiedMcpTestResultsAtom, {
    ...prev,
    [engineKey]: result,
    [name]: result,
  });
}

export async function refreshUnifiedMcpSnapshot(options?: {
  readonly force?: boolean;
  readonly surfaceError?: boolean;
}): Promise<UnifiedMcpSnapshot | null> {
  const force = options?.force ?? false;
  const cached = appAtomRegistry.get(unifiedMcpSnapshotAtom);

  if (!force && cached !== null && Date.now() - lastFetchedAt < REVALIDATE_MIN_INTERVAL_MS) {
    return cached;
  }

  if (inflightSnapshotRequest !== null) {
    return inflightSnapshotRequest;
  }

  if (force && appAtomRegistry.get(unifiedMcpErrorAtom) !== null) {
    appAtomRegistry.set(unifiedMcpErrorAtom, null);
  }

  const request = (async (): Promise<UnifiedMcpSnapshot | null> => {
    try {
      const next = await fetchMcpApi<UnifiedMcpSnapshot>("/api/vela/mcp");
      setUnifiedMcpSnapshot(next);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options?.surfaceError || appAtomRegistry.get(unifiedMcpSnapshotAtom) === null) {
        appAtomRegistry.set(unifiedMcpErrorAtom, message);
      }
      return null;
    } finally {
      inflightSnapshotRequest = null;
    }
  })();

  inflightSnapshotRequest = request;
  return request;
}

export function prefetchUnifiedMcpSnapshot(): void {
  if (typeof window === "undefined") return;
  void refreshUnifiedMcpSnapshot({ force: false, surfaceError: false });
}
