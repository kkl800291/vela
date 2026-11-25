// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MCP_ENGINE_IDS = [
  "antigravity",
  "codex",
  "claude",
  "cursor",
  "factory",
  "kimi",
] as const;

export type McpEngineId = (typeof MCP_ENGINE_IDS)[number];

export type McpTransport = "stdio" | "http";

export const SECRET_MASK_SENTINEL = "••••••••";

const SENSITIVE_KEY_PATTERN = /token|key|secret|auth|password|cookie|credential/i;

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

export interface UpsertMcpServerInput {
  readonly name: string;
  readonly originalName?: string;
  readonly transport: McpTransport;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  readonly bearerTokenEnvVar?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly targets: ReadonlyArray<McpEngineId>;
  readonly preserveSecretsFromEngineId?: McpEngineId;
}

export interface ToggleMcpServerInput {
  readonly engineId: McpEngineId;
  readonly name: string;
  readonly enabled: boolean;
}

export interface DeleteMcpServerInput {
  readonly name: string;
  readonly engineIds: ReadonlyArray<McpEngineId>;
}

export interface SyncMcpServerInput {
  readonly sourceEngineId: McpEngineId;
  readonly name: string;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
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

export interface ApplyMcpAuthInput {
  readonly name: string;
  readonly sourceEngineId: McpEngineId;
  readonly targetEngineIds: ReadonlyArray<McpEngineId>;
  readonly mode: "bearer_token" | "api_key_header" | "env_var";
  readonly token?: string;
  readonly headerName?: string;
  readonly envVarName?: string;
}

interface RawMcpServerEntry {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  bearerTokenEnvVar?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface EngineDescriptor {
  readonly id: McpEngineId;
  readonly label: string;
  readonly format: "json" | "toml";
  readonly relativePath: string;
  readonly urlField: "url" | "serverUrl";
  readonly includeTypeField: boolean;
}

const ENGINE_DESCRIPTORS: ReadonlyArray<EngineDescriptor> = [
  {
    id: "antigravity",
    label: "Antigravity",
    format: "json",
    relativePath: ".gemini/config/mcp_config.json",
    urlField: "serverUrl",
    includeTypeField: false,
  },
  {
    id: "codex",
    label: "Codex",
    format: "toml",
    relativePath: ".codex/config.toml",
    urlField: "url",
    includeTypeField: false,
  },
  {
    id: "claude",
    label: "Claude Code",
    format: "json",
    relativePath: ".claude.json",
    urlField: "url",
    includeTypeField: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    relativePath: ".cursor/mcp.json",
    urlField: "url",
    includeTypeField: false,
  },
  {
    id: "factory",
    label: "Factory",
    format: "json",
    relativePath: ".factory/mcp.json",
    urlField: "url",
    includeTypeField: true,
  },
  {
    id: "kimi",
    label: "Kimi Code",
    format: "json",
    relativePath: ".kimi-code/mcp.json",
    urlField: "url",
    includeTypeField: false,
  },
];

const ENGINE_BY_ID = new Map<McpEngineId, EngineDescriptor>(
  ENGINE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export function isMcpEngineId(value: unknown): value is McpEngineId {
  return typeof value === "string" && ENGINE_BY_ID.has(value as McpEngineId);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v === "string") {
      out[key] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[key] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractBearerEnvVarFromAuthHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return match?.[1];
}

function maskEntry(raw: RawMcpServerEntry): UnifiedMcpServerEntry {
  const maskedEnvKeys: string[] = [];
  let maskedEnv: Record<string, string> | undefined;
  if (raw.env && Object.keys(raw.env).length > 0) {
    maskedEnv = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (isSensitiveKey(k) && v.length > 0 && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim())) {
        maskedEnv[k] = SECRET_MASK_SENTINEL;
        maskedEnvKeys.push(k);
      } else {
        maskedEnv[k] = v;
      }
    }
  }

  const maskedHeaderKeys: string[] = [];
  let maskedHeaders: Record<string, string> | undefined;
  if (raw.headers && Object.keys(raw.headers).length > 0) {
    maskedHeaders = {};
    for (const [k, v] of Object.entries(raw.headers)) {
      const isEnvPlaceholder = /^Bearer\s+\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim());
      if (isSensitiveKey(k) && v.length > 0 && !isEnvPlaceholder) {
        maskedHeaders[k] = SECRET_MASK_SENTINEL;
        maskedHeaderKeys.push(k);
      } else {
        maskedHeaders[k] = v;
      }
    }
  }

  return {
    name: raw.name,
    transport: raw.transport,
    enabled: raw.enabled,
    ...(raw.command !== undefined ? { command: raw.command } : {}),
    ...(raw.args !== undefined ? { args: raw.args } : {}),
    ...(raw.url !== undefined ? { url: raw.url } : {}),
    ...(raw.bearerTokenEnvVar !== undefined ? { bearerTokenEnvVar: raw.bearerTokenEnvVar } : {}),
    ...(maskedEnv !== undefined ? { env: maskedEnv } : {}),
    ...(maskedHeaders !== undefined ? { headers: maskedHeaders } : {}),
    maskedEnvKeys,
    maskedHeaderKeys,
  };
}

function ensureOneTimeBackup(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.vela.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  ensureOneTimeBackup(filePath);
  const tmpPath = `${filePath}.vela.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Adapter (Antigravity, Claude Code, Cursor, Factory, Kimi Code)
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonServerEntry(name: string, rawObj: Record<string, unknown>): RawMcpServerEntry {
  const url =
    typeof rawObj.url === "string"
      ? rawObj.url
      : typeof rawObj.serverUrl === "string"
        ? rawObj.serverUrl
        : undefined;
  const command = typeof rawObj.command === "string" ? rawObj.command : undefined;
  const args = Array.isArray(rawObj.args)
    ? rawObj.args.filter((item): item is string => typeof item === "string")
    : undefined;
  const env = normalizeStringRecord(rawObj.env);
  const headers = normalizeStringRecord(rawObj.headers);
  const disabled = rawObj.disabled === true || rawObj.enabled === false;
  const transport: McpTransport = url && !command ? "http" : "stdio";
  const bearerTokenEnvVar =
    typeof rawObj.bearerTokenEnvVar === "string"
      ? rawObj.bearerTokenEnvVar
      : extractBearerEnvVarFromAuthHeader(headers?.Authorization ?? headers?.authorization);

  return {
    name,
    transport,
    enabled: !disabled,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(bearerTokenEnvVar !== undefined ? { bearerTokenEnvVar } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

function serializeJsonServerEntry(
  descriptor: EngineDescriptor,
  entry: RawMcpServerEntry,
  existingObj?: Record<string, unknown>,
): Record<string, unknown> {
  // Preserve any unknown engine-specific fields if editing in place
  const base: Record<string, unknown> = existingObj ? { ...existingObj } : {};
  delete base.command;
  delete base.args;
  delete base.url;
  delete base.serverUrl;
  delete base.env;
  delete base.headers;
  delete base.disabled;
  delete base.enabled;
  delete base.type;

  if (entry.transport === "http") {
    if (descriptor.includeTypeField) {
      base.type = "http";
    }
    base[descriptor.urlField] = entry.url ?? "";
    const headers: Record<string, string> = { ...(entry.headers ?? {}) };
    if (
      entry.bearerTokenEnvVar &&
      !headers.Authorization &&
      !headers.authorization
    ) {
      headers.Authorization = `Bearer \${${entry.bearerTokenEnvVar}}`;
    }
    if (Object.keys(headers).length > 0) {
      base.headers = headers;
    }
  } else {
    if (descriptor.includeTypeField) {
      base.type = "stdio";
    }
    base.command = entry.command ?? "";
    if (entry.args && entry.args.length > 0) {
      base.args = [...entry.args];
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      base.env = { ...entry.env };
    }
  }

  if (!entry.enabled) {
    base.disabled = true;
  } else if (descriptor.id === "factory") {
    base.disabled = false;
  }

  return base;
}

function readJsonEngine(
  configPath: string,
): { exists: boolean; servers: RawMcpServerEntry[]; parseError?: string } {
  if (!fs.existsSync(configPath)) {
    return { exists: false, servers: [] };
  }
  try {
    const rawText = fs.readFileSync(configPath, "utf8").trim();
    if (!rawText) {
      return { exists: true, servers: [] };
    }
    const parsed: unknown = JSON.parse(rawText);
    if (!isPlainObject(parsed)) {
      return { exists: true, servers: [], parseError: "Root JSON value is not an object" };
    }
    const mcpServers = parsed.mcpServers;
    if (!isPlainObject(mcpServers)) {
      return { exists: true, servers: [] };
    }
    const servers: RawMcpServerEntry[] = [];
    for (const [name, value] of Object.entries(mcpServers)) {
      if (!isPlainObject(value)) continue;
      servers.push(parseJsonServerEntry(name, value));
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
    return { exists: true, servers };
  } catch (error) {
    return {
      exists: true,
      servers: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function mutateJsonEngine(
  descriptor: EngineDescriptor,
  configPath: string,
  mutator: (mcpServers: Record<string, unknown>) => void,
): void {
  let root: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const rawText = fs.readFileSync(configPath, "utf8").trim();
    if (rawText) {
      const parsed: unknown = JSON.parse(rawText);
      if (!isPlainObject(parsed)) {
        throw new Error(`Cannot edit ${configPath}: root JSON value is not an object`);
      }
      root = { ...parsed };
    }
  }
  const existingServers = isPlainObject(root.mcpServers) ? { ...root.mcpServers } : {};
  mutator(existingServers);
  root.mcpServers = existingServers;
  writeFileAtomic(configPath, `${JSON.stringify(root, null, 2)}\n`);
}

function scanAntigravityPlugins(homeDir: string): McpPluginEntry[] {
  const pluginsDir = path.join(homeDir, ".gemini", "config", "plugins");
  if (!fs.existsSync(pluginsDir)) return [];

  const results: McpPluginEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const pluginDir = path.join(pluginsDir, dirent.name);
    const mcpConfigPath = path.join(pluginDir, "mcp_config.json");
    if (!fs.existsSync(mcpConfigPath)) continue;

    let pluginDisplayName = dirent.name;
    const pluginJsonPath = path.join(pluginDir, "plugin.json");
    if (fs.existsSync(pluginJsonPath)) {
      try {
        const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (typeof pluginJson.displayName === "string" && pluginJson.displayName.trim()) {
          pluginDisplayName = pluginJson.displayName.trim();
        } else if (typeof pluginJson.name === "string" && pluginJson.name.trim()) {
          pluginDisplayName = pluginJson.name.trim();
        }
      } catch {
        // Ignore malformed plugin metadata
      }
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as Record<string, unknown>;
      if (!isPlainObject(parsed.mcpServers)) continue;
      for (const [serverName, rawCfg] of Object.entries(parsed.mcpServers)) {
        if (!isPlainObject(rawCfg)) continue;
        const entry = parseJsonServerEntry(serverName, rawCfg);
        const summary =
          entry.transport === "http"
            ? (entry.url ?? "HTTP MCP")
            : [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ");
        results.push({
          id: `${dirent.name}:${serverName}`,
          name: serverName,
          pluginName: pluginDisplayName,
          transport: entry.transport,
          enabled: entry.enabled,
          summary,
          sourcePath: mcpConfigPath,
        });
      }
    } catch {
      // Skip unreadable plugin mcp config
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex TOML Adapter (~/.codex/config.toml)
// Preserves all comments & unrelated sections verbatim.
// ─────────────────────────────────────────────────────────────────────────────

interface TomlSection {
  readonly headerLine: string | null; // null for preamble before first [section]
  readonly segments: ReadonlyArray<string>;
  readonly lines: string[];
}

function stripTomlInlineComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlKeyPath(rawHeader: string): string[] {
  const segments: string[] = [];
  let i = 0;
  const len = rawHeader.length;
  while (i < len) {
    while (i < len && (rawHeader[i] === " " || rawHeader[i] === "\t" || rawHeader[i] === ".")) {
      i += 1;
    }
    if (i >= len) break;
    const ch = rawHeader[i]!;
    if (ch === '"') {
      i += 1;
      let buf = "";
      while (i < len && rawHeader[i] !== '"') {
        if (rawHeader[i] === "\\" && i + 1 < len) {
          buf += rawHeader[i + 1]!;
          i += 2;
        } else {
          buf += rawHeader[i]!;
          i += 1;
        }
      }
      i += 1; // closing quote
      segments.push(buf);
    } else if (ch === "'") {
      i += 1;
      let buf = "";
      while (i < len && rawHeader[i] !== "'") {
        buf += rawHeader[i]!;
        i += 1;
      }
      i += 1;
      segments.push(buf);
    } else {
      let buf = "";
      while (i < len && rawHeader[i] !== "." && rawHeader[i] !== " " && rawHeader[i] !== "\t") {
        buf += rawHeader[i]!;
        i += 1;
      }
      if (buf) segments.push(buf);
    }
  }
  return segments;
}

function parseTomlSections(content: string): TomlSection[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  // Avoid adding an extra empty line if the file ended with a newline
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const sections: TomlSection[] = [];
  let current: TomlSection = { headerLine: null, segments: [], lines: [] };
  sections.push(current);

  for (const line of rawLines) {
    const trimmed = stripTomlInlineComment(line).trim();
    if (
      trimmed.startsWith("[") &&
      !trimmed.startsWith("[[") &&
      trimmed.endsWith("]")
    ) {
      const inner = trimmed.slice(1, -1).trim();
      const segments = parseTomlKeyPath(inner);
      current = { headerLine: line, segments, lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }

  return sections;
}

function parseTomlStringValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function parseTomlStringArray(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1);
  const items: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i]!)) i += 1;
    if (i >= inner.length) break;
    const ch = inner[i]!;
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < inner.length) {
        if (escaped) {
          escaped = false;
        } else if (inner[j] === "\\") {
          escaped = true;
        } else if (inner[j] === '"') {
          break;
        }
        j += 1;
      }
      const token = inner.slice(i, j + 1);
      const val = parseTomlStringValue(token);
      if (val !== undefined) items.push(val);
      i = j + 1;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < inner.length && inner[j] !== "'") j += 1;
      items.push(inner.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < inner.length && inner[j] !== ",") j += 1;
      const bare = inner.slice(i, j).trim();
      if (bare) items.push(bare);
      i = j + 1;
    }
  }
  return items;
}

function parseTomlInlineTable(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};
  const result: Record<string, string> = {};
  // Split top-level commas outside quotes
  const parts: string[] = [];
  let start = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === ",") {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));

  for (const part of parts) {
    const eqIndex = findTomlEqualsIndex(part);
    if (eqIndex === -1) continue;
    const rawKey = part.slice(0, eqIndex).trim();
    const rawVal = part.slice(eqIndex + 1).trim();
    const key = parseTomlStringValue(rawKey) ?? rawKey;
    const val = parseTomlStringValue(rawVal) ?? rawVal;
    if (key) result[key] = val;
  }
  return result;
}

function findTomlEqualsIndex(line: string): number {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "=") {
      return i;
    }
  }
  return -1;
}

function collectTomlKeyValues(lines: ReadonlyArray<string>): Array<{ key: string; rawValue: string }> {
  const pairs: Array<{ key: string; rawValue: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const cleaned = stripTomlInlineComment(lines[i]!).trim();
    if (!cleaned) {
      i += 1;
      continue;
    }
    const eqIndex = findTomlEqualsIndex(cleaned);
    if (eqIndex === -1) {
      i += 1;
      continue;
    }
    const rawKey = cleaned.slice(0, eqIndex).trim();
    const key = parseTomlStringValue(rawKey) ?? rawKey;
    let rawValue = cleaned.slice(eqIndex + 1).trim();

    // Support multiline arrays / inline tables
    let openBrackets = countUnquotedDelta(rawValue, "[", "]");
    let openBraces = countUnquotedDelta(rawValue, "{", "}");
    while ((openBrackets > 0 || openBraces > 0) && i + 1 < lines.length) {
      i += 1;
      const nextPart = stripTomlInlineComment(lines[i]!).trim();
      rawValue = `${rawValue} ${nextPart}`;
      openBrackets += countUnquotedDelta(nextPart, "[", "]");
      openBraces += countUnquotedDelta(nextPart, "{", "}");
    }

    pairs.push({ key, rawValue });
    i += 1;
  }
  return pairs;
}

function countUnquotedDelta(text: string, openChar: string, closeChar: string): number {
  let delta = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === openChar) {
      delta += 1;
    } else if (ch === closeChar) {
      delta -= 1;
    }
  }
  return delta;
}

function formatTomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function serializeCodexTomlSections(entry: RawMcpServerEntry): string[] {
  const keySeg = formatTomlKeySegment(entry.name);
  const lines: string[] = [`[mcp_servers.${keySeg}]`];

  if (entry.transport === "http") {
    lines.push(`url = ${JSON.stringify(entry.url ?? "")}`);
    if (entry.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${JSON.stringify(entry.bearerTokenEnvVar)}`);
    }
    if (!entry.enabled) {
      lines.push("enabled = false");
    }
    const headers = entry.headers ? { ...entry.headers } : {};
    // Avoid duplicating Authorization if it's purely the bearerTokenEnvVar placeholder
    if (
      entry.bearerTokenEnvVar &&
      headers.Authorization === `Bearer \${${entry.bearerTokenEnvVar}}`
    ) {
      delete headers.Authorization;
    }
    const headerEntries = Object.entries(headers);
    if (headerEntries.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${keySeg}.http_headers]`);
      for (const [k, v] of headerEntries) {
        lines.push(`${formatTomlKeySegment(k)} = ${JSON.stringify(v)}`);
      }
    }
  } else {
    lines.push(`command = ${JSON.stringify(entry.command ?? "")}`);
    if (entry.args && entry.args.length > 0) {
      lines.push(`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
    }
    if (!entry.enabled) {
      lines.push("enabled = false");
    }
    const envEntries = entry.env ? Object.entries(entry.env) : [];
    if (envEntries.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${keySeg}.env]`);
      for (const [k, v] of envEntries) {
        lines.push(`${formatTomlKeySegment(k)} = ${JSON.stringify(v)}`);
      }
    }
  }

  return lines;
}

function readCodexEngine(configPath: string): {
  exists: boolean;
  servers: RawMcpServerEntry[];
  plugins: McpPluginEntry[];
  parseError?: string;
} {
  if (!fs.existsSync(configPath)) {
    return { exists: false, servers: [], plugins: [] };
  }
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const sections = parseTomlSections(content);
    const serverMap = new Map<string, RawMcpServerEntry>();
    const plugins: McpPluginEntry[] = [];

    const ensureServer = (name: string): RawMcpServerEntry => {
      let existing = serverMap.get(name);
      if (!existing) {
        existing = { name, transport: "stdio", enabled: true };
        serverMap.set(name, existing);
      }
      return existing;
    };

    for (const section of sections) {
      if (section.segments.length >= 2 && section.segments[0] === "mcp_servers") {
        const serverName = section.segments[1]!;
        const entry = ensureServer(serverName);
        const kvPairs = collectTomlKeyValues(section.lines);

        if (section.segments.length === 2) {
          for (const { key, rawValue } of kvPairs) {
            if (key === "command") {
              const val = parseTomlStringValue(rawValue);
              if (val !== undefined) entry.command = val;
            } else if (key === "args") {
              const arr = parseTomlStringArray(rawValue);
              if (arr !== undefined) entry.args = arr;
            } else if (key === "url") {
              const val = parseTomlStringValue(rawValue);
              if (val !== undefined) {
                entry.url = val;
                entry.transport = "http";
              }
            } else if (key === "bearer_token_env_var") {
              const val = parseTomlStringValue(rawValue);
              if (val !== undefined) entry.bearerTokenEnvVar = val;
            } else if (key === "enabled") {
              entry.enabled = rawValue.trim() !== "false";
            } else if (key === "env") {
              const tbl = parseTomlInlineTable(rawValue);
              if (tbl && Object.keys(tbl).length > 0) {
                entry.env = { ...(entry.env ?? {}), ...tbl };
              }
            } else if (key === "http_headers") {
              const tbl = parseTomlInlineTable(rawValue);
              if (tbl && Object.keys(tbl).length > 0) {
                entry.headers = { ...(entry.headers ?? {}), ...tbl };
              }
            }
          }
        } else if (section.segments.length === 3 && section.segments[2] === "env") {
          const env: Record<string, string> = { ...(entry.env ?? {}) };
          for (const { key, rawValue } of kvPairs) {
            env[key] = parseTomlStringValue(rawValue) ?? rawValue;
          }
          if (Object.keys(env).length > 0) entry.env = env;
        } else if (section.segments.length === 3 && section.segments[2] === "http_headers") {
          const headers: Record<string, string> = { ...(entry.headers ?? {}) };
          for (const { key, rawValue } of kvPairs) {
            headers[key] = parseTomlStringValue(rawValue) ?? rawValue;
          }
          if (Object.keys(headers).length > 0) entry.headers = headers;
        }
      } else if (section.segments.length === 2 && section.segments[0] === "plugins") {
        const pluginId = section.segments[1]!;
        const kvPairs = collectTomlKeyValues(section.lines);
        const enabledPair = kvPairs.find((pair) => pair.key === "enabled");
        const enabled = enabledPair ? enabledPair.rawValue.trim() !== "false" : true;
        const shortName = pluginId.split("@")[0] ?? pluginId;
        plugins.push({
          id: `codex-plugin:${pluginId}`,
          name: shortName,
          pluginName: pluginId,
          transport: "http",
          enabled,
          summary: `Codex Plugin (${pluginId})`,
          sourcePath: configPath,
        });
      }
    }

    const servers = [...serverMap.values()].map((entry) => ({
      ...entry,
      transport: entry.url && !entry.command ? ("http" as const) : ("stdio" as const),
    }));
    servers.sort((a, b) => a.name.localeCompare(b.name));
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { exists: true, servers, plugins };
  } catch (error) {
    return {
      exists: true,
      servers: [],
      plugins: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderTomlSections(sections: ReadonlyArray<TomlSection>): string {
  const outLines: string[] = [];
  for (const section of sections) {
    if (section.headerLine !== null) {
      outLines.push(section.headerLine);
    }
    outLines.push(...section.lines);
  }
  // Collapse excessive trailing blank lines to a single trailing newline
  while (outLines.length > 0 && outLines[outLines.length - 1]!.trim() === "") {
    outLines.pop();
  }
  return outLines.length > 0 ? `${outLines.join("\n")}\n` : "";
}

function upsertCodexTomlServer(
  configPath: string,
  entry: RawMcpServerEntry,
  originalName?: string,
): void {
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const sections = parseTomlSections(content);
  const namesToReplace = new Set<string>([entry.name]);
  if (originalName && originalName !== entry.name) {
    namesToReplace.add(originalName);
  }

  let insertIndex = -1;
  const remaining: TomlSection[] = [];
  for (const section of sections) {
    const isTarget =
      section.segments.length >= 2 &&
      section.segments[0] === "mcp_servers" &&
      namesToReplace.has(section.segments[1]!);
    if (isTarget) {
      if (insertIndex === -1) {
        insertIndex = remaining.length;
      }
      continue;
    }
    remaining.push(section);
  }

  const newLines = serializeCodexTomlSections(entry);
  const newSections = parseTomlSections(`${newLines.join("\n")}\n`).filter(
    (section) => section.headerLine !== null,
  );

  // Ensure a clean blank separator before inserted block
  const prevSection =
    insertIndex === -1 ? remaining[remaining.length - 1] : remaining[insertIndex - 1];
  if (
    prevSection &&
    (prevSection.headerLine !== null || prevSection.lines.some((line) => line.trim() !== ""))
  ) {
    if (
      prevSection.lines.length === 0 ||
      prevSection.lines[prevSection.lines.length - 1]!.trim() !== ""
    ) {
      prevSection.lines.push("");
    }
  }
  const lastNewSection = newSections[newSections.length - 1];
  if (insertIndex !== -1 && insertIndex < remaining.length && lastNewSection) {
    lastNewSection.lines.push("");
  }

  if (insertIndex === -1) {
    remaining.push(...newSections);
  } else {
    remaining.splice(insertIndex, 0, ...newSections);
  }

  writeFileAtomic(configPath, renderTomlSections(remaining));
}

function toggleCodexTomlServer(configPath: string, name: string, enabled: boolean): void {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Codex config not found at ${configPath}`);
  }
  const content = fs.readFileSync(configPath, "utf8");
  const sections = parseTomlSections(content);
  const target = sections.find(
    (section) =>
      section.segments.length === 2 &&
      section.segments[0] === "mcp_servers" &&
      section.segments[1] === name,
  );
  if (!target) {
    throw new Error(`MCP server "${name}" not found in Codex config`);
  }

  let updated = false;
  for (let i = 0; i < target.lines.length; i += 1) {
    const cleaned = stripTomlInlineComment(target.lines[i]!).trim();
    const eqIndex = findTomlEqualsIndex(cleaned);
    if (eqIndex !== -1 && cleaned.slice(0, eqIndex).trim() === "enabled") {
      target.lines[i] = `enabled = ${enabled ? "true" : "false"}`;
      updated = true;
      break;
    }
  }

  if (!updated) {
    // Insert before trailing blank lines of this section
    let insertAt = target.lines.length;
    while (insertAt > 0 && target.lines[insertAt - 1]!.trim() === "") {
      insertAt -= 1;
    }
    target.lines.splice(insertAt, 0, `enabled = ${enabled ? "true" : "false"}`);
  }

  writeFileAtomic(configPath, renderTomlSections(sections));
}

function deleteCodexTomlServer(configPath: string, name: string): void {
  if (!fs.existsSync(configPath)) return;
  const content = fs.readFileSync(configPath, "utf8");
  const sections = parseTomlSections(content);
  const remaining = sections.filter(
    (section) =>
      !(
        section.segments.length >= 2 &&
        section.segments[0] === "mcp_servers" &&
        section.segments[1] === name
      ),
  );
  writeFileAtomic(configPath, renderTomlSections(remaining));
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedMcpManager Public API
// ─────────────────────────────────────────────────────────────────────────────

export class UnifiedMcpManager {
  private readonly homeDir: string;

  constructor(homeDir: string = os.homedir()) {
    this.homeDir = homeDir;
  }

  private resolveConfigPath(descriptor: EngineDescriptor): string {
    return path.join(this.homeDir, descriptor.relativePath);
  }

  private readRawEngineServers(engineId: McpEngineId): {
    exists: boolean;
    servers: RawMcpServerEntry[];
    plugins: McpPluginEntry[];
    parseError?: string;
  } {
    const descriptor = ENGINE_BY_ID.get(engineId);
    if (!descriptor) {
      throw new Error(`Unknown MCP engine: ${String(engineId)}`);
    }
    const configPath = this.resolveConfigPath(descriptor);
    if (descriptor.format === "toml") {
      return readCodexEngine(configPath);
    }
    const jsonResult = readJsonEngine(configPath);
    const plugins = engineId === "antigravity" ? scanAntigravityPlugins(this.homeDir) : [];
    return { ...jsonResult, plugins };
  }

  public getSnapshot(): UnifiedMcpSnapshot {
    const engines: EngineMcpState[] = ENGINE_DESCRIPTORS.map((descriptor) => {
      const configPath = this.resolveConfigPath(descriptor);
      const raw = this.readRawEngineServers(descriptor.id);
      return {
        id: descriptor.id,
        label: descriptor.label,
        format: descriptor.format,
        configPath,
        displayPath: `~/${descriptor.relativePath}`,
        exists: raw.exists,
        ...(raw.parseError ? { parseError: raw.parseError } : {}),
        servers: raw.servers.map(maskEntry),
        plugins: raw.plugins,
      };
    });

    return {
      engines,
      secretMaskSentinel: SECRET_MASK_SENTINEL,
      updatedAt: new Date().toISOString(),
    };
  }

  private resolveUnmaskedSecrets(
    input: UpsertMcpServerInput,
    targetEngineId: McpEngineId,
  ): RawMcpServerEntry {
    const trimmedName = input.name.trim();
    const lookupName = input.originalName?.trim() || trimmedName;

    // Look up existing raw entry on target engine first, then fallback to preserveSecretsFromEngineId
    const targetRaw = this.readRawEngineServers(targetEngineId).servers.find(
      (server) => server.name === lookupName || server.name === trimmedName,
    );
    const fallbackRaw =
      !targetRaw && input.preserveSecretsFromEngineId
        ? this.readRawEngineServers(input.preserveSecretsFromEngineId).servers.find(
            (server) => server.name === lookupName || server.name === trimmedName,
          )
        : undefined;
    const referenceRaw = targetRaw ?? fallbackRaw;

    const resolvedEnv: Record<string, string> = {};
    if (input.env) {
      for (const [k, v] of Object.entries(input.env)) {
        const key = k.trim();
        if (!key) continue;
        if (v === SECRET_MASK_SENTINEL && referenceRaw?.env?.[key] !== undefined) {
          resolvedEnv[key] = referenceRaw.env[key]!;
        } else {
          resolvedEnv[key] = v;
        }
      }
    }

    const resolvedHeaders: Record<string, string> = {};
    if (input.headers) {
      for (const [k, v] of Object.entries(input.headers)) {
        const key = k.trim();
        if (!key) continue;
        if (v === SECRET_MASK_SENTINEL && referenceRaw?.headers?.[key] !== undefined) {
          resolvedHeaders[key] = referenceRaw.headers[key]!;
        } else {
          resolvedHeaders[key] = v;
        }
      }
    }

    const cleanArgs = input.args?.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    const bearerTokenEnvVar =
      input.bearerTokenEnvVar?.trim() ||
      extractBearerEnvVarFromAuthHeader(
        resolvedHeaders.Authorization ?? resolvedHeaders.authorization,
      );

    return {
      name: trimmedName,
      transport: input.transport,
      enabled: input.enabled ?? true,
      ...(input.transport === "stdio"
        ? {
            command: input.command?.trim() ?? "",
            ...(cleanArgs && cleanArgs.length > 0 ? { args: cleanArgs } : {}),
            ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
          }
        : {
            url: input.url?.trim() ?? "",
            ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
            ...(Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : {}),
          }),
    };
  }

  public upsertServer(input: UpsertMcpServerInput): UnifiedMcpSnapshot {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("MCP server name is required");
    }
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
      throw new Error("At least one target engine is required");
    }
    if (input.transport === "stdio" && !input.command?.trim()) {
      throw new Error("Command is required for stdio MCP servers");
    }
    if (input.transport === "http" && !input.url?.trim()) {
      throw new Error("URL is required for HTTP MCP servers");
    }

    const originalName = input.originalName?.trim();

    for (const targetEngineId of input.targets) {
      const descriptor = ENGINE_BY_ID.get(targetEngineId);
      if (!descriptor) {
        throw new Error(`Unknown target engine: ${String(targetEngineId)}`);
      }
      const configPath = this.resolveConfigPath(descriptor);
      const rawEntry = this.resolveUnmaskedSecrets(input, targetEngineId);

      if (descriptor.format === "toml") {
        upsertCodexTomlServer(configPath, rawEntry, originalName);
      } else {
        mutateJsonEngine(descriptor, configPath, (mcpServers) => {
          const existingObj = isPlainObject(mcpServers[originalName ?? trimmedName])
            ? (mcpServers[originalName ?? trimmedName] as Record<string, unknown>)
            : isPlainObject(mcpServers[trimmedName])
              ? (mcpServers[trimmedName] as Record<string, unknown>)
              : undefined;
          if (originalName && originalName !== trimmedName) {
            delete mcpServers[originalName];
          }
          mcpServers[trimmedName] = serializeJsonServerEntry(descriptor, rawEntry, existingObj);
        });
      }
    }

    return this.getSnapshot();
  }

  public toggleServer(input: ToggleMcpServerInput): UnifiedMcpSnapshot {
    const descriptor = ENGINE_BY_ID.get(input.engineId);
    if (!descriptor) {
      throw new Error(`Unknown MCP engine: ${String(input.engineId)}`);
    }
    const name = input.name.trim();
    if (!name) {
      throw new Error("MCP server name is required");
    }
    const configPath = this.resolveConfigPath(descriptor);

    if (descriptor.format === "toml") {
      toggleCodexTomlServer(configPath, name, input.enabled);
    } else {
      mutateJsonEngine(descriptor, configPath, (mcpServers) => {
        const existing = mcpServers[name];
        if (!isPlainObject(existing)) {
          throw new Error(`MCP server "${name}" not found in ${descriptor.label}`);
        }
        const next: Record<string, unknown> = { ...existing };
        delete next.enabled;
        if (!input.enabled) {
          next.disabled = true;
        } else if (descriptor.id === "factory") {
          next.disabled = false;
        } else {
          delete next.disabled;
        }
        mcpServers[name] = next;
      });
    }

    return this.getSnapshot();
  }

  public deleteServer(input: DeleteMcpServerInput): UnifiedMcpSnapshot {
    const name = input.name.trim();
    if (!name) {
      throw new Error("MCP server name is required");
    }
    for (const engineId of input.engineIds) {
      const descriptor = ENGINE_BY_ID.get(engineId);
      if (!descriptor) continue;
      const configPath = this.resolveConfigPath(descriptor);
      if (!fs.existsSync(configPath)) continue;

      if (descriptor.format === "toml") {
        deleteCodexTomlServer(configPath, name);
      } else {
        mutateJsonEngine(descriptor, configPath, (mcpServers) => {
          delete mcpServers[name];
        });
      }
    }

    return this.getSnapshot();
  }

  public syncServer(input: SyncMcpServerInput): UnifiedMcpSnapshot {
    const name = input.name.trim();
    if (!name) {
      throw new Error("MCP server name is required");
    }
    const sourceData = this.readRawEngineServers(input.sourceEngineId);
    const sourceEntry = sourceData.servers.find((server) => server.name === name);
    if (!sourceEntry) {
      throw new Error(`MCP server "${name}" not found in ${input.sourceEngineId}`);
    }

    for (const targetEngineId of input.targetEngineIds) {
      if (targetEngineId === input.sourceEngineId) continue;
      const descriptor = ENGINE_BY_ID.get(targetEngineId);
      if (!descriptor) continue;
      const configPath = this.resolveConfigPath(descriptor);

      if (descriptor.format === "toml") {
        upsertCodexTomlServer(configPath, sourceEntry);
      } else {
        mutateJsonEngine(descriptor, configPath, (mcpServers) => {
          const existingObj = isPlainObject(mcpServers[name])
            ? (mcpServers[name] as Record<string, unknown>)
            : undefined;
          mcpServers[name] = serializeJsonServerEntry(descriptor, sourceEntry, existingObj);
        });
      }
    }

    return this.getSnapshot();
  }

  public async testServer(engineId: McpEngineId, name: string): Promise<McpTestResult> {
    const trimmedName = name.trim();
    const rawEngine = this.readRawEngineServers(engineId);
    const entry = rawEngine.servers.find((server) => server.name === trimmedName);
    if (!entry) {
      return {
        ok: false,
        status: "error",
        engineId,
        name: trimmedName,
        transport: "stdio",
        latencyMs: 0,
        message: `未在 ${engineId} 配置中找到 MCP "${trimmedName}"`,
        testedAt: new Date().toISOString(),
      };
    }

    if (entry.transport === "http") {
      return testHttpMcpServer(engineId, entry);
    }
    return testStdioMcpServer(engineId, entry);
  }

  public getRawServerUrl(engineId: McpEngineId, name: string): string | null {
    const rawEngine = this.readRawEngineServers(engineId);
    const entry = rawEngine.servers.find((server) => server.name === name.trim());
    return entry?.transport === "http" && entry.url ? entry.url : null;
  }

  public applyAuthToServer(input: ApplyMcpAuthInput): UnifiedMcpSnapshot {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("MCP server name is required");
    }
    if (input.targetEngineIds.length === 0) {
      throw new Error("At least one target engine is required");
    }

    const sourceEntry = this.readRawEngineServers(input.sourceEngineId).servers.find(
      (server) => server.name === trimmedName,
    );
    if (!sourceEntry) {
      throw new Error(`MCP server "${trimmedName}" not found in ${input.sourceEngineId}`);
    }

    for (const targetEngineId of input.targetEngineIds) {
      const descriptor = ENGINE_BY_ID.get(targetEngineId);
      if (!descriptor) continue;
      const configPath = this.resolveConfigPath(descriptor);
      const existingTarget = this.readRawEngineServers(targetEngineId).servers.find(
        (server) => server.name === trimmedName,
      );
      const baseEntry: RawMcpServerEntry = existingTarget
        ? { ...existingTarget, headers: { ...(existingTarget.headers ?? {}) } }
        : { ...sourceEntry, headers: { ...(sourceEntry.headers ?? {}) } };

      const nextHeaders: Record<string, string> = { ...(baseEntry.headers ?? {}) };
      let nextBearerEnvVar = baseEntry.bearerTokenEnvVar;

      if (input.mode === "bearer_token") {
        const rawToken = input.token?.trim() ?? "";
        if (!rawToken) throw new Error("Token is required");
        delete nextHeaders.authorization;
        nextHeaders.Authorization = rawToken.toLowerCase().startsWith("bearer ")
          ? rawToken
          : `Bearer ${rawToken}`;
        nextBearerEnvVar = undefined;
      } else if (input.mode === "api_key_header") {
        const headerName = input.headerName?.trim() || "X-API-Key";
        const rawToken = input.token?.trim() ?? "";
        if (!rawToken) throw new Error("Header value is required");
        nextHeaders[headerName] = rawToken;
      } else if (input.mode === "env_var") {
        const envVar = input.envVarName?.trim() ?? "";
        if (!envVar) throw new Error("Environment variable name is required");
        nextBearerEnvVar = envVar;
        delete nextHeaders.authorization;
        delete nextHeaders.Authorization;
      }

      const updatedEntry: RawMcpServerEntry = {
        ...baseEntry,
        ...(nextBearerEnvVar ? { bearerTokenEnvVar: nextBearerEnvVar } : {}),
        ...(Object.keys(nextHeaders).length > 0 ? { headers: nextHeaders } : {}),
      };
      if (!nextBearerEnvVar) {
        delete updatedEntry.bearerTokenEnvVar;
      }
      if (Object.keys(nextHeaders).length === 0) {
        delete updatedEntry.headers;
      }

      if (descriptor.format === "toml") {
        upsertCodexTomlServer(configPath, updatedEntry);
      } else {
        mutateJsonEngine(descriptor, configPath, (mcpServers) => {
          const existingObj = isPlainObject(mcpServers[trimmedName])
            ? (mcpServers[trimmedName] as Record<string, unknown>)
            : undefined;
          mcpServers[trimmedName] = serializeJsonServerEntry(descriptor, updatedEntry, existingObj);
        });
      }
    }

    return this.getSnapshot();
  }
}

function expandEnvPlaceholders(
  value: string,
  missing: Set<string>,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => {
    const resolved = process.env[varName];
    if (!resolved) {
      missing.add(varName);
      return "";
    }
    return resolved;
  });
}

function parseJsonRpcPayload(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Direct JSON response
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  // Server-Sent Events (SSE) stream: extract first JSON-RPC data line with result/error
  const lines = trimmed.split(/\r?\n/);
  let fallback: Record<string, unknown> | null = null;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isPlainObject(parsed)) {
        if ("result" in parsed || "error" in parsed) return parsed;
        fallback = parsed;
      }
    } catch {
      // Ignore non-JSON SSE chunks
    }
  }
  return fallback;
}

function extractInitializeMeta(rpc: Record<string, unknown>): {
  serverName?: string;
  serverVersion?: string;
} {
  if (!isPlainObject(rpc.result)) return {};
  const serverInfo = rpc.result.serverInfo;
  if (!isPlainObject(serverInfo)) return {};
  return {
    ...(typeof serverInfo.name === "string" ? { serverName: serverInfo.name } : {}),
    ...(typeof serverInfo.version === "string" ? { serverVersion: serverInfo.version } : {}),
  };
}

function extractToolsMeta(rpc: Record<string, unknown>): {
  toolCount?: number;
  sampleTools?: string[];
} {
  if (!isPlainObject(rpc.result) || !Array.isArray(rpc.result.tools)) return {};
  const tools = rpc.result.tools;
  const sampleTools = tools
    .slice(0, 8)
    .map((item) => (isPlainObject(item) && typeof item.name === "string" ? item.name : null))
    .filter((item): item is string => item !== null);
  return {
    toolCount: tools.length,
    sampleTools,
  };
}

async function testHttpMcpServer(
  engineId: McpEngineId,
  entry: RawMcpServerEntry,
): Promise<McpTestResult> {
  const startedAt = Date.now();
  const url = entry.url?.trim() ?? "";
  if (!url) {
    return {
      ok: false,
      status: "error",
      engineId,
      name: entry.name,
      transport: "http",
      latencyMs: 0,
      message: "未配置 HTTP 服务地址",
      testedAt: new Date().toISOString(),
    };
  }

  const missingEnv = new Set<string>();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (entry.headers) {
    for (const [k, v] of Object.entries(entry.headers)) {
      headers[k] = expandEnvPlaceholders(v, missingEnv);
    }
  }

  if (entry.bearerTokenEnvVar && !headers.Authorization && !headers.authorization) {
    const token = process.env[entry.bearerTokenEnvVar];
    if (!token) {
      missingEnv.add(entry.bearerTokenEnvVar);
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  if (missingEnv.size > 0) {
    const missingList = [...missingEnv];
    return {
      ok: false,
      status: "auth_required",
      engineId,
      name: entry.name,
      transport: "http",
      latencyMs: Date.now() - startedAt,
      missingEnvVars: missingList,
      message: `缺少环境变量：${missingList.join(", ")}`,
      testedAt: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const initResponse = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vela-mcp-check", version: "0.1.0" },
        },
      }),
    });

    if (initResponse.status === 401 || initResponse.status === 403) {
      const wwwAuth = initResponse.headers.get("www-authenticate") ?? "";
      const supportsOAuth =
        /resource_metadata=|authorization_uri=/i.test(wwwAuth) ||
        /\bbearer\b/i.test(wwwAuth);
      return {
        ok: false,
        status: "auth_required",
        engineId,
        name: entry.name,
        transport: "http",
        latencyMs: Date.now() - startedAt,
        supportsOAuth,
        message: supportsOAuth
          ? `需要 OAuth 授权登录或配置 Token (HTTP ${initResponse.status})`
          : `需要登录认证或 Token 无效 (HTTP ${initResponse.status})`,
        testedAt: new Date().toISOString(),
      };
    }

    const initText = await initResponse.text();
    if (!initResponse.ok) {
      return {
        ok: false,
        status: "error",
        engineId,
        name: entry.name,
        transport: "http",
        latencyMs: Date.now() - startedAt,
        message: `HTTP ${initResponse.status}${initText ? `: ${initText.slice(0, 140)}` : ""}`,
        testedAt: new Date().toISOString(),
      };
    }

    const initRpc = parseJsonRpcPayload(initText);
    if (!initRpc) {
      return {
        ok: false,
        status: "error",
        engineId,
        name: entry.name,
        transport: "http",
        latencyMs: Date.now() - startedAt,
        message: "服务端返回非 JSON-RPC 响应，请检查 MCP 地址是否正确",
        testedAt: new Date().toISOString(),
      };
    }

    if (isPlainObject(initRpc.error)) {
      const errMsg =
        typeof initRpc.error.message === "string" ? initRpc.error.message : "MCP 初始化被拒绝";
      return {
        ok: false,
        status: "error",
        engineId,
        name: entry.name,
        transport: "http",
        latencyMs: Date.now() - startedAt,
        message: errMsg,
        testedAt: new Date().toISOString(),
      };
    }

    const initMeta = extractInitializeMeta(initRpc);
    const sessionId = initResponse.headers.get("mcp-session-id");
    const followUpHeaders: Record<string, string> = {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };

    // Best-effort notifications/initialized + tools/list
    let toolsMeta: { toolCount?: number; sampleTools?: string[] } = {};
    try {
      await fetch(url, {
        method: "POST",
        headers: followUpHeaders,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).catch(() => undefined);

      const toolsResponse = await fetch(url, {
        method: "POST",
        headers: followUpHeaders,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      if (toolsResponse.ok) {
        const toolsRpc = parseJsonRpcPayload(await toolsResponse.text());
        if (toolsRpc) {
          toolsMeta = extractToolsMeta(toolsRpc);
        }
      }
    } catch {
      // initialize already succeeded; tools/list is best-effort
    }

    return {
      ok: true,
      status: "connected",
      engineId,
      name: entry.name,
      transport: "http",
      latencyMs: Date.now() - startedAt,
      ...initMeta,
      ...toolsMeta,
      message: "MCP 握手成功",
      testedAt: new Date().toISOString(),
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: "error",
      engineId,
      name: entry.name,
      transport: "http",
      latencyMs: Date.now() - startedAt,
      message: isAbort
        ? "连接超时 (8s)"
        : error instanceof Error
          ? error.message
          : String(error),
      testedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function testStdioMcpServer(
  engineId: McpEngineId,
  entry: RawMcpServerEntry,
): Promise<McpTestResult> {
  const startedAt = Date.now();
  const command = entry.command?.trim() ?? "";
  if (!command) {
    return Promise.resolve({
      ok: false,
      status: "error",
      engineId,
      name: entry.name,
      transport: "stdio",
      latencyMs: 0,
      message: "未配置启动命令",
      testedAt: new Date().toISOString(),
    });
  }

  return new Promise<McpTestResult>((resolve) => {
    let settled = false;
    let initMeta: { serverName?: string; serverVersion?: string } = {};
    let initialized = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let toolsTimer: ReturnType<typeof setTimeout> | null = null;

    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(entry.env ?? {}) };
    const child = spawn(command, entry.args ?? [], {
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (toolsTimer) clearTimeout(toolsTimer);
      clearTimeout(overallTimer);
      try {
        if (!child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              if (!child.killed) child.kill("SIGKILL");
            } catch {
              // Ignore
            }
          }, 400).unref();
        }
      } catch {
        // Ignore cleanup errors
      }
    };

    const finish = (result: Omit<McpTestResult, "engineId" | "name" | "transport" | "latencyMs" | "testedAt">) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ...result,
        engineId,
        name: entry.name,
        transport: "stdio",
        latencyMs: Date.now() - startedAt,
        testedAt: new Date().toISOString(),
      });
    };

    const overallTimer = setTimeout(() => {
      if (initialized) {
        finish({
          ok: true,
          status: "connected",
          ...initMeta,
          message: "MCP 握手成功",
        });
      } else {
        const stderrSnippet = stderrBuffer.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 180);
        finish({
          ok: false,
          status: "error",
          message: stderrSnippet ? `握手超时 (8s)：${stderrSnippet}` : "进程启动后 8s 内未响应 MCP 握手",
        });
      }
    }, 8000);

    const handleRpcMessage = (rpc: Record<string, unknown>) => {
      if (rpc.id === 1) {
        if (isPlainObject(rpc.error)) {
          const msg =
            typeof rpc.error.message === "string" ? rpc.error.message : "MCP 初始化失败";
          finish({ ok: false, status: "error", message: msg });
          return;
        }
        initialized = true;
        initMeta = extractInitializeMeta(rpc);
        try {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
          );
        } catch {
          finish({ ok: true, status: "connected", ...initMeta, message: "MCP 握手成功" });
          return;
        }
        toolsTimer = setTimeout(() => {
          finish({ ok: true, status: "connected", ...initMeta, message: "MCP 握手成功" });
        }, 3000);
      } else if (rpc.id === 2) {
        const toolsMeta = extractToolsMeta(rpc);
        finish({
          ok: true,
          status: "connected",
          ...initMeta,
          ...toolsMeta,
          message: "MCP 握手成功",
        });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("{")) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isPlainObject(parsed)) {
            handleRpcMessage(parsed);
          }
        } catch {
          // Ignore non-JSON log lines printed to stdout by noisy servers
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrBuffer.length < 2000) {
        stderrBuffer += chunk;
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT" ? `找不到可执行命令：${command}` : err.message;
      finish({ ok: false, status: "error", message: msg });
    });

    child.on("exit", (code) => {
      if (settled) return;
      if (initialized) {
        finish({ ok: true, status: "connected", ...initMeta, message: "MCP 握手成功" });
      } else {
        const stderrSnippet = stderrBuffer.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 180);
        finish({
          ok: false,
          status: "error",
          message: stderrSnippet || `进程异常退出 (exit ${String(code ?? "unknown")})`,
        });
      }
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "vela-mcp-check", version: "0.1.0" },
          },
        })}\n`,
      );
    } catch (err) {
      finish({
        ok: false,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export const defaultUnifiedMcpManager = new UnifiedMcpManager();
