// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";

import { defaultUnifiedMcpManager, type McpEngineId } from "./UnifiedMcpManager.ts";

export interface McpOAuthStartResult {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly name: string;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
}

export interface McpOAuthStatusResult {
  readonly sessionId: string;
  readonly status: "pending" | "completed" | "error";
  readonly name: string;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
  readonly message?: string;
}

interface ActiveOAuthSession {
  readonly sessionId: string;
  readonly name: string;
  readonly sourceEngineId: McpEngineId;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
  status: "pending" | "completed" | "error";
  message?: string;
  readonly server: http.Server;
  readonly timer: ReturnType<typeof setTimeout>;
}

const activeSessions = new Map<string, ActiveOAuthSession>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseQuotedParam(header: string, key: string): string | undefined {
  const regex = new RegExp(`${key}="([^"]+)"`, "i");
  return regex.exec(header)?.[1];
}

function renderCallbackHtml(ok: boolean, title: string, detail: string): string {
  const accent = ok ? "#111111" : "#b91c1c";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>✦ Vela MCP 授权</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      background: #fafafa;
      color: #111111;
    }
    .card {
      max-width: 420px;
      padding: 28px 32px;
      border-radius: 14px;
      background: #ffffff;
      border: 1px solid #e5e5e5;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.06);
      text-align: center;
    }
    .brand {
      font-size: 13px;
      letter-spacing: 0.04em;
      color: #666666;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
      color: ${accent};
    }
    p {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: #555555;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">✦ Vela</div>
    <h1>${title}</h1>
    <p>${detail}</p>
  </div>
</body>
</html>`;
}

async function discoverOAuthEndpoints(mcpUrl: string): Promise<{
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopes?: string;
  readonly tokenAuthMethods: ReadonlyArray<string>;
}> {
  // Step 1: Probe MCP endpoint to read WWW-Authenticate header if present
  let resourceMetadataUrl: string | undefined;
  let scopeFromHeader: string | undefined;
  let authServerFromHeader: string | undefined;

  try {
    const probe = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vela-oauth", version: "0.1.0" },
        },
      }),
    });
    const wwwAuth = probe.headers.get("www-authenticate") ?? "";
    resourceMetadataUrl = parseQuotedParam(wwwAuth, "resource_metadata");
    scopeFromHeader = parseQuotedParam(wwwAuth, "scope");
    authServerFromHeader = parseQuotedParam(wwwAuth, "authorization_uri");
  } catch {
    // Fall back to well-known URLs below
  }

  const parsedUrl = new URL(mcpUrl);
  const prmCandidates = [
    ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
    `${parsedUrl.origin}/.well-known/oauth-protected-resource${parsedUrl.pathname}`,
    `${parsedUrl.origin}/.well-known/oauth-protected-resource`,
  ];

  let resource = mcpUrl;
  let authServerOrigin: string | undefined;
  let scopes = scopeFromHeader;

  for (const candidate of prmCandidates) {
    try {
      const res = await fetch(candidate, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      if (!isPlainObject(body)) continue;
      if (typeof body.resource === "string" && body.resource) {
        resource = body.resource;
      }
      if (Array.isArray(body.authorization_servers) && typeof body.authorization_servers[0] === "string") {
        authServerOrigin = body.authorization_servers[0];
      }
      if (!scopes && Array.isArray(body.scopes_supported)) {
        const list = body.scopes_supported.filter((s): s is string => typeof s === "string");
        if (list.length > 0) scopes = list.join(" ");
      }
      if (authServerOrigin) break;
    } catch {
      // Try next candidate
    }
  }

  const asMetadataCandidates: string[] = [];
  if (authServerFromHeader) {
    asMetadataCandidates.push(authServerFromHeader);
  }
  if (authServerOrigin) {
    const cleanOrigin = authServerOrigin.replace(/\/+$/, "");
    asMetadataCandidates.push(`${cleanOrigin}/.well-known/oauth-authorization-server`);
    asMetadataCandidates.push(`${cleanOrigin}/.well-known/openid-configuration`);
  }
  asMetadataCandidates.push(`${parsedUrl.origin}/.well-known/oauth-authorization-server`);

  for (const candidate of asMetadataCandidates) {
    try {
      const res = await fetch(candidate, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      if (!isPlainObject(body)) continue;
      const authorizationEndpoint =
        typeof body.authorization_endpoint === "string" ? body.authorization_endpoint : undefined;
      const tokenEndpoint =
        typeof body.token_endpoint === "string" ? body.token_endpoint : undefined;
      if (!authorizationEndpoint || !tokenEndpoint) continue;

      const registrationEndpoint =
        typeof body.registration_endpoint === "string" ? body.registration_endpoint : undefined;
      if (!scopes && Array.isArray(body.scopes_supported)) {
        const list = body.scopes_supported.filter((s): s is string => typeof s === "string");
        if (list.length > 0) scopes = list.join(" ");
      }
      const tokenAuthMethods = Array.isArray(body.token_endpoint_auth_methods_supported)
        ? body.token_endpoint_auth_methods_supported.filter(
            (m): m is string => typeof m === "string",
          )
        : ["none", "client_secret_post"];

      return {
        resource,
        authorizationEndpoint,
        tokenEndpoint,
        ...(registrationEndpoint ? { registrationEndpoint } : {}),
        ...(scopes ? { scopes } : {}),
        tokenAuthMethods,
      };
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    "该 MCP 服务端未暴露标准 OAuth 2.1 发现元数据，请切换到「填入 Token / 请求头」方式进行配置。",
  );
}

export async function startMcpOAuthLogin(input: {
  readonly name: string;
  readonly sourceEngineId: McpEngineId;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
}): Promise<McpOAuthStartResult> {
  const mcpUrl = defaultUnifiedMcpManager.getRawServerUrl(input.sourceEngineId, input.name);
  if (!mcpUrl) {
    throw new Error(`未找到 HTTP MCP "${input.name}" 的服务地址`);
  }

  const discovery = await discoverOAuthEndpoints(mcpUrl);
  if (!discovery.registrationEndpoint) {
    throw new Error(
      "该 OAuth 服务端不支持动态客户端注册 (DCR)，请使用 Token / 请求头方式认证。",
    );
  }

  const sessionId = crypto.randomUUID();
  const state = base64UrlEncode(crypto.randomBytes(24));
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());

  // Spin up ephemeral local loopback callback server
  let clientId = "";
  let clientSecret: string | undefined;
  let redirectUri = "";
  let tokenAuthMethod: "none" | "client_secret_post" | "client_secret_basic" = "none";

  const callbackServer = http.createServer((req, res) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackHtml(false, "授权会话已失效", "请返回 Vela 重新发起授权。"));
      return;
    }

    const reqUrl = new URL(req.url ?? "/", redirectUri);
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const errorParam = reqUrl.searchParams.get("error");
    const errorDesc = reqUrl.searchParams.get("error_description");
    const code = reqUrl.searchParams.get("code");
    const returnedState = reqUrl.searchParams.get("state");

    if (errorParam) {
      session.status = "error";
      session.message = errorDesc || errorParam;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderCallbackHtml(false, "授权已取消或失败", errorDesc || `错误代码：${errorParam}`),
      );
      closeSessionServer(session);
      return;
    }

    if (!code || returnedState !== state) {
      session.status = "error";
      session.message = "OAuth 回调参数校验失败 (state/code)";
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackHtml(false, "回调校验失败", "请返回 Vela 重试授权。"));
      closeSessionServer(session);
      return;
    }

    // Exchange authorization code for access token
    void (async () => {
      try {
        const params = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          resource: discovery.resource,
        });
        const tokenHeaders: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        };
        if (tokenAuthMethod === "client_secret_basic" && clientSecret) {
          tokenHeaders.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
        } else {
          params.set("client_id", clientId);
          if (clientSecret) {
            params.set("client_secret", clientSecret);
          }
        }

        const tokenResponse = await fetch(discovery.tokenEndpoint, {
          method: "POST",
          headers: tokenHeaders,
          body: params.toString(),
        });
        const tokenBody: unknown = await tokenResponse.json().catch(() => null);
        if (!tokenResponse.ok || !isPlainObject(tokenBody) || typeof tokenBody.access_token !== "string") {
          const errDetail =
            isPlainObject(tokenBody) && typeof tokenBody.error_description === "string"
              ? tokenBody.error_description
              : isPlainObject(tokenBody) && typeof tokenBody.error === "string"
                ? tokenBody.error
                : `HTTP ${tokenResponse.status}`;
          throw new Error(`换取访问令牌失败：${errDetail}`);
        }

        defaultUnifiedMcpManager.applyAuthToServer({
          name: session.name,
          sourceEngineId: session.sourceEngineId,
          targetEngineIds: session.targetEngineIds,
          mode: "bearer_token",
          token: tokenBody.access_token,
        });

        session.status = "completed";
        session.message = `已授权并写入 ${session.targetEngineIds.length} 个引擎配置`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderCallbackHtml(
            true,
            `${session.name} 授权成功`,
            `访问凭据已安全写入所选引擎的本机配置。你可以关闭此页面并返回 Vela。`,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        session.status = "error";
        session.message = msg;
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(false, "授权未能完成", msg));
      } finally {
        closeSessionServer(session);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    callbackServer.once("error", reject);
    callbackServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = callbackServer.address();
  if (!address || typeof address === "string") {
    callbackServer.close();
    throw new Error("无法启动本地 OAuth 回调监听端口");
  }
  redirectUri = `http://127.0.0.1:${address.port}/callback`;

  // Pick a supported client authentication method for DCR
  if (discovery.tokenAuthMethods.includes("none")) {
    tokenAuthMethod = "none";
  } else if (discovery.tokenAuthMethods.includes("client_secret_post")) {
    tokenAuthMethod = "client_secret_post";
  } else {
    tokenAuthMethod = "client_secret_basic";
  }

  // Dynamic Client Registration (RFC 7591)
  try {
    const regResponse = await fetch(discovery.registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_name: "Vela MCP",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: tokenAuthMethod,
        ...(discovery.scopes ? { scope: discovery.scopes } : {}),
      }),
    });
    const regBody: unknown = await regResponse.json().catch(() => null);
    if (!regResponse.ok || !isPlainObject(regBody) || typeof regBody.client_id !== "string") {
      if (regResponse.status === 403) {
        throw new Error(
          "该 MCP 服务端限制了第三方 OAuth 动态注册（例如 Figma 仅对官方白名单客户端开放 OAuth）。请使用下方的「通过 Codex CLI 登录」、对应引擎的官方插件，或切换到「填入 Token / 环境变量」。",
        );
      }
      const detail =
        isPlainObject(regBody) && typeof regBody.error_description === "string"
          ? regBody.error_description
          : `HTTP ${regResponse.status}`;
      throw new Error(`OAuth 客户端注册失败：${detail}`);
    }
    clientId = regBody.client_id;
    if (typeof regBody.client_secret === "string" && regBody.client_secret) {
      clientSecret = regBody.client_secret;
    }
  } catch (err) {
    callbackServer.close();
    throw err;
  }

  const authUrl = new URL(discovery.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", discovery.resource);
  if (discovery.scopes) {
    authUrl.searchParams.set("scope", discovery.scopes);
  }

  const timer = setTimeout(() => {
    const session = activeSessions.get(sessionId);
    if (session && session.status === "pending") {
      session.status = "error";
      session.message = "授权等待超时（3 分钟），请重试";
      closeSessionServer(session);
    }
  }, 180_000);
  timer.unref();

  activeSessions.set(sessionId, {
    sessionId,
    name: input.name,
    sourceEngineId: input.sourceEngineId,
    targetEngineIds: input.targetEngineIds,
    status: "pending",
    server: callbackServer,
    timer,
  });

  return {
    sessionId,
    authorizationUrl: authUrl.toString(),
    name: input.name,
    targetEngineIds: input.targetEngineIds,
  };
}

function closeSessionServer(session: ActiveOAuthSession): void {
  clearTimeout(session.timer);
  try {
    session.server.close();
  } catch {
    // Ignore
  }
  // Retain session status for 5 minutes so frontend polling can read the final state
  setTimeout(() => {
    activeSessions.delete(session.sessionId);
  }, 300_000).unref();
}

export function getMcpOAuthStatus(sessionId: string): McpOAuthStatusResult | null {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    status: session.status,
    name: session.name,
    targetEngineIds: session.targetEngineIds,
    ...(session.message ? { message: session.message } : {}),
  };
}

/**
 * Triggers the official `codex mcp login <name>` flow for Codex-configured MCPs
 * (useful for providers like Figma that only allow whitelisted official clients).
 */
export function startCodexCliMcpLogin(name: string): Promise<{
  readonly ok: boolean;
  readonly message: string;
}> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return Promise.resolve({ ok: false, message: "MCP 名称不能为空" });
  }
  const hasInCodex = defaultUnifiedMcpManager.getRawServerUrl("codex", trimmedName) !== null;
  if (!hasInCodex) {
    return Promise.resolve({
      ok: false,
      message: `Codex 尚未配置 ${trimmedName}，请先点击矩阵中的 Codex 圆点同步后再登录`,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn("codex", ["mcp", "login", trimmedName], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      resolve({ ok, message });
    };

    // If codex mcp login stays running >1.8s without immediate error, it has opened the browser and is waiting for callback.
    const startupTimer = setTimeout(() => {
      finish(true, `已唤起 codex mcp login ${trimmedName}，请在弹出的浏览器中完成授权`);
    }, 1800);
    startupTimer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 1500) output += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (output.length < 1500) output += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        false,
        err.code === "ENOENT" ? "未在 PATH 中找到 codex CLI" : `启动 codex 失败：${err.message}`,
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        finish(true, `Codex 已完成 ${trimmedName} 登录授权`);
      } else {
        const snippet = output.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 180);
        finish(false, snippet || `codex mcp login 退出 (exit ${String(code ?? "unknown")})`);
      }
    });
  });
}
