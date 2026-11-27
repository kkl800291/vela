/* oxlint-disable t3code/no-untranslated-copy -- Vela mobile collaboration API error messages align with desktop */
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { EnvironmentId, VelaCollabProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { isActiveCollabPlan } from "./collabModel";

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
}

export interface MobileApkMeta {
  readonly available: boolean;
  readonly fileName?: string;
  readonly version?: string;
  readonly sizeBytes?: number;
  readonly updatedAt?: string;
  readonly sha256?: string;
}

export interface MobileApkTicket {
  readonly downloadPath: string;
  readonly expiresAt: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

function normalizeHttpMethod(method: string | undefined): HttpMethod {
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

function buildUrl(pathname: string, baseUrl: string, searchParams?: Readonly<Record<string, string>>): string {
  const url = new URL(environmentEndpointUrl(baseUrl, pathname));
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function resolveEnvironmentUrl(environmentId: EnvironmentId, pathname: string): string | null {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (!prepared) return null;
  return new URL(pathname, prepared.httpBaseUrl).toString();
}

export async function fetchEnvironmentApi<T>(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly searchParams?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
  );
  if (!prepared) {
    throw new Error("远端环境尚未连接");
  }

  const method = normalizeHttpMethod(input.method);
  const url = buildUrl(input.pathname, prepared.httpBaseUrl, input.searchParams);
  const headers: Record<string, string> = {};
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const auth = prepared.httpAuthorization;
  if (auth?._tag === "Bearer") {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth?._tag === "Dpop") {
    const dpopHeaders = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime);
        const signerOpt = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner).pipe(
          Effect.provide(context),
        );
        if (Option.isNone(signerOpt)) return null;
        const proof = yield* signerOpt.value.createProof({
          method,
          url,
          accessToken: auth.accessToken,
        });
        return {
          authorization: `DPoP ${auth.accessToken}`,
          dpop: proof,
        };
      }),
    );
    if (!dpopHeaders) {
      throw new Error("缺少 DPoP 签名器，无法发送协作请求");
    }
    headers.Authorization = dpopHeaders.authorization;
    headers.DPoP = dpopHeaders.dpop;
  }

  const response = await fetch(url, {
    method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { readonly error?: string })
    | { readonly error?: string }
    | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error("当前连接的桌面端版本暂不支持此接口，请先更新并重启桌面端 Vela");
  }
  return payload as T;
}

export async function fetchThreadCollabProjection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<VelaCollabProjection | null> {
  const data = await fetchEnvironmentApi<{ readonly collab?: VelaCollabProjection | null }>({
    environmentId: input.environmentId,
    pathname: "/api/vela/dispatch/state",
    searchParams: {
      projectRoot: input.projectRoot,
      threadId: input.threadId,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return data.collab ?? null;
}

export function fetchCollabEvidence<View extends "manifest" | "diff">(
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
    readonly planId: string;
    readonly target: CollabEvidenceTarget;
    readonly view: View;
    readonly offset?: number;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  } & (View extends "diff" ? { readonly path: string } : { readonly path?: undefined }),
): Promise<CollabEvidenceResults[View]> {
  const params: Record<string, string> = {
    threadId: input.threadId,
    planId: input.planId,
    view: input.view,
    ...("reviewId" in input.target
      ? { reviewId: input.target.reviewId }
      : { deliveryId: input.target.deliveryId }),
  };
  if (input.path !== undefined) params.path = input.path;
  if (input.offset !== undefined) params.offset = String(input.offset);
  if (input.maxBytes !== undefined) params.maxBytes = String(input.maxBytes);
  return fetchEnvironmentApi({
    environmentId: input.environmentId,
    pathname: "/api/vela/dispatch/v2/evidence",
    searchParams: params,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function postCollabAction<T = unknown>(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: `/api/vela/dispatch/v2/${string}`;
  readonly body: Record<string, unknown>;
}): Promise<T> {
  return fetchEnvironmentApi<T>({
    environmentId: input.environmentId,
    pathname: input.pathname,
    method: "POST",
    body: input.body,
  });
}

export function fetchMobileApkMeta(environmentId: EnvironmentId, signal?: AbortSignal): Promise<MobileApkMeta> {
  return fetchEnvironmentApi<MobileApkMeta>({
    environmentId,
    pathname: "/api/vela/mobile/apk/meta",
    ...(signal ? { signal } : {}),
  });
}

export function requestMobileApkDownloadTicket(environmentId: EnvironmentId): Promise<MobileApkTicket> {
  return fetchEnvironmentApi<MobileApkTicket>({
    environmentId,
    pathname: "/api/vela/mobile/apk/ticket",
    method: "POST",
    body: {},
  });
}

export function useThreadCollab(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectRoot: string | null;
  readonly threadWorking: boolean;
  readonly enabled: boolean;
}) {
  const [collab, setCollab] = useState<VelaCollabProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks component mount lifecycle for async poll cancellation
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls server-owned collaboration projection with adaptive interval and foreground wake
  useEffect(() => {
    if (!input.enabled || !input.projectRoot) {
      setCollab(null);
      setError(null);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeAbort: AbortController | null = null;
    let stopped = false;

    const pollOnce = () => {
      if (stopped) return;
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      void fetchThreadCollabProjection({
        environmentId: input.environmentId,
        threadId: input.threadId,
        projectRoot: input.projectRoot!,
        signal: abort.signal,
      }).then(
        (next) => {
          if (stopped || !mountedRef.current || abort.signal.aborted) return;
          setCollab(next);
          setError(null);
          const delayMs =
            next && isActiveCollabPlan(next.status)
              ? 3_500
              : input.threadWorking
                ? 8_000
                : null;
          if (delayMs !== null) {
            timer = setTimeout(() => {
              pollOnce();
            }, delayMs);
          }
        },
        (err: unknown) => {
          if (stopped || !mountedRef.current || abort.signal.aborted) return;
          // Silently ignore 404 on older servers that do not expose dispatch routes.
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("HTTP 404")) {
            setError(message);
          }
          if (input.threadWorking) {
            timer = setTimeout(() => {
              pollOnce();
            }, 10_000);
          }
        },
      );
    };

    pollOnce();

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && !stopped) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pollOnce();
      }
    });

    return () => {
      stopped = true;
      activeAbort?.abort();
      if (timer) clearTimeout(timer);
      appStateSub.remove();
    };
  }, [input.enabled, input.environmentId, input.projectRoot, input.threadId, input.threadWorking, refreshNonce]);

  return { collab, error, refresh };
}
