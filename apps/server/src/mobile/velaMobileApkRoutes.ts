// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";

interface ApkTicketEntry {
  readonly filePath: string;
  readonly fileName: string;
  readonly expiresAtMs: number;
}

const TICKET_TTL_MS = 5 * 60_000;
const APK_DOWNLOAD_PREFIX = "/api/vela/mobile/apk/download";
const apkTickets = new Map<string, ApkTicketEntry>();

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function extractApkTicket(requestUrl: string): string {
  const parsed = new URL(requestUrl, "http://127.0.0.1");
  const queryTicket = parsed.searchParams.get("ticket")?.trim() ?? "";
  if (queryTicket.length > 0) return queryTicket;
  const prefixWithSlash = `${APK_DOWNLOAD_PREFIX}/`;
  if (!parsed.pathname.startsWith(prefixWithSlash)) return "";
  const rest = parsed.pathname.slice(prefixWithSlash.length);
  const firstSegment = rest.split("/")[0] ?? "";
  return safeDecodeURIComponent(firstSegment).trim();
}

function pruneExpiredTickets(now: number) {
  for (const [token, entry] of apkTickets) {
    if (entry.expiresAtMs <= now) {
      apkTickets.delete(token);
    }
  }
}

function pickNewestApkInDir(dirPath: string): string | null {
  try {
    const entries = NodeFs.readdirSync(dirPath, { withFileTypes: true });
    let bestPath: string | null = null;
    let bestMtimeMs = -1;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".apk")) continue;
      if (!entry.name.toLowerCase().includes("vela")) continue;
      const fullPath = NodePath.join(dirPath, entry.name);
      const stat = NodeFs.statSync(fullPath);
      if (stat.mtimeMs > bestMtimeMs) {
        bestMtimeMs = stat.mtimeMs;
        bestPath = fullPath;
      }
    }
    return bestPath;
  } catch {
    return null;
  }
}

export function resolveMobileApkPath(): string | null {
  const explicit = process.env.VELA_MOBILE_APK_PATH?.trim();
  if (explicit && NodeFs.existsSync(explicit)) {
    return explicit;
  }
  const candidateDirs = [
    NodePath.join(NodeOs.homedir(), ".vela", "mobile"),
    NodePath.resolve(process.cwd(), "release"),
    NodePath.resolve(process.cwd(), "..", "..", "release"),
  ];
  let bestPath: string | null = null;
  let bestMtimeMs = -1;
  for (const dir of candidateDirs) {
    const candidate = pickNewestApkInDir(dir);
    if (!candidate) continue;
    try {
      const stat = NodeFs.statSync(candidate);
      if (stat.mtimeMs > bestMtimeMs) {
        bestMtimeMs = stat.mtimeMs;
        bestPath = candidate;
      }
    } catch {
      // ignore raced/unreadable file
    }
  }
  return bestPath;
}

function readApkMetaSync(filePath: string) {
  const stat = NodeFs.statSync(filePath);
  const fileName = NodePath.basename(filePath);
  const versionMatch = /Vela-([0-9]+\.[0-9]+\.[0-9]+[^-]*)/i.exec(fileName);
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    let bytesRead = 0;
    while ((bytesRead = NodeFs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    NodeFs.closeSync(fd);
  }
  return {
    available: true as const,
    fileName,
    ...(versionMatch?.[1] ? { version: versionMatch[1] } : {}),
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    sha256: hash.digest("hex"),
  };
}

const handleAuthErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const layerMetaRoute = HttpRouter.add(
  "GET",
  "/api/vela/mobile/apk/meta",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const apkPath = resolveMobileApkPath();
    if (!apkPath) {
      return HttpServerResponse.jsonUnsafe({ available: false });
    }
    const meta = yield* Effect.try({
      try: () => readApkMetaSync(apkPath),
      catch: () => null,
    });
    if (!meta) {
      return HttpServerResponse.jsonUnsafe({ available: false });
    }
    return HttpServerResponse.jsonUnsafe(meta);
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const layerTicketRoute = HttpRouter.add(
  "POST",
  "/api/vela/mobile/apk/ticket",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const now = yield* Clock.currentTimeMillis;
    pruneExpiredTickets(now);
    const apkPath = resolveMobileApkPath();
    if (!apkPath) {
      return HttpServerResponse.jsonUnsafe({ error: "未找到可下载的 Android APK" }, { status: 404 });
    }
    const stat = yield* Effect.try({
      try: () => NodeFs.statSync(apkPath),
      catch: () => null,
    });
    if (!stat) {
      return HttpServerResponse.jsonUnsafe({ error: "无法读取 Android APK 文件" }, { status: 404 });
    }
    const token = NodeCrypto.randomBytes(24).toString("base64url");
    const expiresAtMs = now + TICKET_TTL_MS;
    const fileName = NodePath.basename(apkPath);
    const safeFileName = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
    apkTickets.set(token, { filePath: apkPath, fileName, expiresAtMs });
    return HttpServerResponse.jsonUnsafe({
      downloadPath: `${APK_DOWNLOAD_PREFIX}/${encodeURIComponent(token)}/${encodeURIComponent(safeFileName)}`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
      fileName,
      sizeBytes: stat.size,
    });
  }).pipe(Effect.catchTags(handleAuthErrors)),
);

const handleApkDownload = Effect.fn("handleApkDownload")(function* () {
  const now = yield* Clock.currentTimeMillis;
  pruneExpiredTickets(now);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ticket = extractApkTicket(request.url);
  const entry = ticket ? apkTickets.get(ticket) : undefined;
  if (!entry) {
    return HttpServerResponse.jsonUnsafe(
      { error: "下载链接已过期或无效，请在 Vela 设置页重新点击下载" },
      { status: 401 },
    );
  }
  if (!NodeFs.existsSync(entry.filePath)) {
    apkTickets.delete(ticket);
    return HttpServerResponse.jsonUnsafe({ error: "APK 文件已不存在" }, { status: 404 });
  }
  const safeFileName = entry.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const headers = {
    "Content-Disposition": `attachment; filename="${safeFileName}"`,
    "Cache-Control": "no-store",
  };
  if (request.method === "HEAD") {
    const stat = yield* Effect.try({
      try: () => NodeFs.statSync(entry.filePath),
      catch: () => null,
    });
    if (!stat) {
      return HttpServerResponse.jsonUnsafe({ error: "无法读取 APK 文件" }, { status: 500 });
    }
    return HttpServerResponse.empty({
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": String(stat.size),
      },
    });
  }
  const bytes = yield* Effect.try({
    try: () => NodeFs.readFileSync(entry.filePath),
    catch: () => null,
  });
  if (!bytes) {
    return HttpServerResponse.jsonUnsafe({ error: "读取 APK 失败" }, { status: 500 });
  }
  return HttpServerResponse.uint8Array(bytes, {
    status: 200,
    contentType: "application/vnd.android.package-archive",
    headers,
  });
});

const layerDownloadRoute = HttpRouter.add("GET", APK_DOWNLOAD_PREFIX, handleApkDownload);
const layerDownloadPathRoute = HttpRouter.add("GET", `${APK_DOWNLOAD_PREFIX}/*`, handleApkDownload);

export const layer = Layer.mergeAll(
  layerMetaRoute,
  layerTicketRoute,
  layerDownloadRoute,
  layerDownloadPathRoute,
);
