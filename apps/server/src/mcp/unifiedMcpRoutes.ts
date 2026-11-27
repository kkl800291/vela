import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import {
  getMcpOAuthStatus,
  startCodexCliMcpLogin,
  startMcpOAuthLogin,
} from "./UnifiedMcpAuth.ts";
import {
  defaultUnifiedMcpManager,
  isMcpEngineId,
  type ApplyMcpAuthInput,
  type DeleteMcpServerInput,
  type McpEngineId,
  type McpTransport,
  type SyncMcpServerInput,
  type ToggleMcpServerInput,
  type UpsertMcpServerInput,
} from "./UnifiedMcpManager.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEngineIds(value: unknown): McpEngineId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<McpEngineId>();
  for (const item of value) {
    if (isMcpEngineId(item)) seen.add(item);
  }
  return [...seen];
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key || typeof v !== "string") continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function jsonError(message: string, status = 400) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status });
}

export function parseUpsertPayload(body: unknown): UpsertMcpServerInput | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";

  const transport: McpTransport = body.transport === "http" ? "http" : "stdio";
  const targets = parseEngineIds(body.targets);
  if (targets.length === 0) return "Select at least one target engine";

  const command = typeof body.command === "string" ? body.command.trim() : undefined;
  const url = typeof body.url === "string" ? body.url.trim() : undefined;
  if (transport === "stdio" && !command) return "Command is required for stdio MCP";
  if (transport === "http" && !url) return "URL is required for HTTP MCP";

  const args = Array.isArray(body.args)
    ? body.args.filter((item): item is string => typeof item === "string")
    : undefined;
  const env = parseStringRecord(body.env);
  const headers = parseStringRecord(body.headers);
  const originalName =
    typeof body.originalName === "string" && body.originalName.trim()
      ? body.originalName.trim()
      : undefined;
  const bearerTokenEnvVar =
    typeof body.bearerTokenEnvVar === "string" && body.bearerTokenEnvVar.trim()
      ? body.bearerTokenEnvVar.trim()
      : undefined;
  const preserveSecretsFromEngineId = isMcpEngineId(body.preserveSecretsFromEngineId)
    ? body.preserveSecretsFromEngineId
    : undefined;

  return {
    name,
    ...(originalName ? { originalName } : {}),
    transport,
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    targets,
    ...(preserveSecretsFromEngineId ? { preserveSecretsFromEngineId } : {}),
  };
}

function parseTogglePayload(body: unknown): ToggleMcpServerInput | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  if (!isMcpEngineId(body.engineId)) return "Valid engineId is required";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  if (typeof body.enabled !== "boolean") return "Boolean enabled flag is required";
  return { engineId: body.engineId, name, enabled: body.enabled };
}

function parseDeletePayload(body: unknown): DeleteMcpServerInput | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  const engineIds = parseEngineIds(body.engineIds);
  if (engineIds.length === 0) return "At least one engineId is required";
  return { name, engineIds };
}

function parseSyncPayload(body: unknown): SyncMcpServerInput | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  if (!isMcpEngineId(body.sourceEngineId)) return "Valid sourceEngineId is required";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  const targetEngineIds = parseEngineIds(body.targetEngineIds);
  if (targetEngineIds.length === 0) return "At least one targetEngineId is required";
  return { sourceEngineId: body.sourceEngineId, name, targetEngineIds };
}

function parseTestPayload(body: unknown): { engineId: McpEngineId; name: string } | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  if (!isMcpEngineId(body.engineId)) return "Valid engineId is required";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  return { engineId: body.engineId, name };
}

function parseOAuthStartPayload(
  body: unknown,
): { sourceEngineId: McpEngineId; name: string; targetEngineIds: McpEngineId[] } | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  if (!isMcpEngineId(body.sourceEngineId)) return "Valid sourceEngineId is required";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  const targetEngineIds = parseEngineIds(body.targetEngineIds);
  if (targetEngineIds.length === 0) return "Select at least one target engine";
  return { sourceEngineId: body.sourceEngineId, name, targetEngineIds };
}

function parseApplyAuthPayload(body: unknown): ApplyMcpAuthInput | string {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  if (!isMcpEngineId(body.sourceEngineId)) return "Valid sourceEngineId is required";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Server name is required";
  const targetEngineIds = parseEngineIds(body.targetEngineIds);
  if (targetEngineIds.length === 0) return "Select at least one target engine";
  const mode =
    body.mode === "bearer_token" || body.mode === "api_key_header" || body.mode === "env_var"
      ? body.mode
      : null;
  if (!mode) return "Valid auth mode is required";
  const token = typeof body.token === "string" ? body.token.trim() : undefined;
  const headerName = typeof body.headerName === "string" ? body.headerName.trim() : undefined;
  const envVarName = typeof body.envVarName === "string" ? body.envVarName.trim() : undefined;
  return {
    name,
    sourceEngineId: body.sourceEngineId,
    targetEngineIds,
    mode,
    ...(token ? { token } : {}),
    ...(headerName ? { headerName } : {}),
    ...(envVarName ? { envVarName } : {}),
  };
}

const handleAuthErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

function runMcpMutation<A>(operation: () => A) {
  return Effect.try({
    try: operation,
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.match({
      onFailure: (message) => jsonError(message, 400),
      onSuccess: (snapshot) => HttpServerResponse.jsonUnsafe(snapshot),
    }),
  );
}

const layerGetSnapshotRoute = HttpRouter.add(
  "GET",
  "/api/vela/mcp",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const snapshot = defaultUnifiedMcpManager.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot);
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerUpsertRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/upsert",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseUpsertPayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* runMcpMutation(() => defaultUnifiedMcpManager.upsertServer(parsed));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerToggleRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/toggle",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseTogglePayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* runMcpMutation(() => defaultUnifiedMcpManager.toggleServer(parsed));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerDeleteRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/delete",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseDeletePayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* runMcpMutation(() => defaultUnifiedMcpManager.deleteServer(parsed));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerSyncRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/sync",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseSyncPayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* runMcpMutation(() => defaultUnifiedMcpManager.syncServer(parsed));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerTestRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/test",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseTestPayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* Effect.tryPromise({
      try: () => defaultUnifiedMcpManager.testServer(parsed.engineId, parsed.name),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.match({
        onFailure: (message) => jsonError(message, 400),
        onSuccess: (result) => HttpServerResponse.jsonUnsafe(result),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerOAuthStartRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/auth/oauth/start",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseOAuthStartPayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* Effect.tryPromise({
      try: () => startMcpOAuthLogin(parsed),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.match({
        onFailure: (message) => jsonError(message, 400),
        onSuccess: (result) => HttpServerResponse.jsonUnsafe(result),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerOAuthStatusRoute = HttpRouter.add(
  "GET",
  "/api/vela/mcp/auth/oauth/status",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const reqUrl = new URL(request.url, "http://127.0.0.1");
    const sessionId = reqUrl.searchParams.get("sessionId")?.trim() ?? "";
    if (!sessionId) {
      return jsonError("sessionId is required", 400);
    }
    const status = getMcpOAuthStatus(sessionId);
    if (!status) {
      return jsonError("OAuth session not found or expired", 404);
    }
    return HttpServerResponse.jsonUnsafe(status);
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerApplyTokenAuthRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/auth/token",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = parseApplyAuthPayload(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400);
    }
    return yield* runMcpMutation(() => defaultUnifiedMcpManager.applyAuthToServer(parsed));
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerCodexCliLoginRoute = HttpRouter.add(
  "POST",
  "/api/vela/mcp/auth/codex-login",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const name = isPlainObject(body) && typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return jsonError("Server name is required", 400);
    }
    return yield* Effect.tryPromise({
      try: () => startCodexCliMcpLogin(name),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.match({
        onFailure: (message) => jsonError(message, 400),
        onSuccess: (result) =>
          result.ok
            ? HttpServerResponse.jsonUnsafe(result)
            : jsonError(result.message, 400),
      }),
    );
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

export const layer = Layer.mergeAll(
  layerGetSnapshotRoute,
  layerUpsertRoute,
  layerToggleRoute,
  layerDeleteRoute,
  layerSyncRoute,
  layerTestRoute,
  layerOAuthStartRoute,
  layerOAuthStatusRoute,
  layerApplyTokenAuthRoute,
  layerCodexCliLoginRoute,
);
