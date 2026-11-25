// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const OFFICIAL_APP_PRIVATE_ENV_VARS = new Set(["BROWSER_USE_ACCESS_PIPE_PATH"]);
const OFFICIAL_APP_PRIVATE_PLUGINS = new Set(["unified-computer-use@openai-bundled"]);
const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

interface ParsedMcpServerSection {
  enabled: boolean;
  command?: string;
  envVars: string[];
}

interface ParsedPluginSection {
  enabled: boolean;
}

interface ParsedCodexConfig {
  readonly mcpServers: ReadonlyMap<string, ParsedMcpServerSection>;
  readonly plugins: ReadonlyMap<string, ParsedPluginSection>;
}

const stripTomlInlineComment = (line: string): string => {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
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
      return line.slice(0, index);
    }
  }
  return line;
};

const parseTomlStringValue = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return undefined;
};

const parseTomlKeyPath = (rawHeader: string): string[] => {
  const segments: string[] = [];
  let index = 0;
  const length = rawHeader.length;
  while (index < length) {
    while (index < length && (rawHeader[index] === "." || /\s/.test(rawHeader[index]!))) {
      index += 1;
    }
    if (index >= length) break;
    const ch = rawHeader[index]!;
    if (ch === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < length) {
        if (escaped) {
          escaped = false;
        } else if (rawHeader[end] === "\\") {
          escaped = true;
        } else if (rawHeader[end] === '"') {
          break;
        }
        end += 1;
      }
      const token = rawHeader.slice(index, end + 1);
      segments.push(parseTomlStringValue(token) ?? token.slice(1, -1));
      index = end + 1;
    } else if (ch === "'") {
      let end = index + 1;
      while (end < length && rawHeader[end] !== "'") {
        end += 1;
      }
      segments.push(rawHeader.slice(index + 1, end));
      index = end + 1;
    } else {
      let end = index;
      while (end < length && rawHeader[end] !== "." && !/\s/.test(rawHeader[end]!)) {
        end += 1;
      }
      if (end > index) {
        segments.push(rawHeader.slice(index, end));
      }
      index = end;
    }
  }
  return segments;
};

const findTomlEqualsIndex = (line: string): number => {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
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
    } else if (ch === "=") {
      return index;
    }
  }
  return -1;
};

const countUnquotedBracketDelta = (text: string): number => {
  let delta = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
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
    } else if (ch === "[") {
      delta += 1;
    } else if (ch === "]") {
      delta -= 1;
    }
  }
  return delta;
};

const parseTomlStringArray = (raw: string): string[] | undefined => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1);
  const items: string[] = [];
  let index = 0;
  while (index < inner.length) {
    while (index < inner.length && /[\s,]/.test(inner[index]!)) {
      index += 1;
    }
    if (index >= inner.length) break;
    const ch = inner[index]!;
    if (ch === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < inner.length) {
        if (escaped) {
          escaped = false;
        } else if (inner[end] === "\\") {
          escaped = true;
        } else if (inner[end] === '"') {
          break;
        }
        end += 1;
      }
      const value = parseTomlStringValue(inner.slice(index, end + 1));
      if (value !== undefined) items.push(value);
      index = end + 1;
    } else if (ch === "'") {
      let end = index + 1;
      while (end < inner.length && inner[end] !== "'") {
        end += 1;
      }
      items.push(inner.slice(index + 1, end));
      index = end + 1;
    } else {
      let end = index;
      while (end < inner.length && inner[end] !== ",") {
        end += 1;
      }
      const bare = inner.slice(index, end).trim();
      if (bare) items.push(bare);
      index = end + 1;
    }
  }
  return items;
};

const parseTomlBoolean = (raw: string): boolean | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return undefined;
};

const parseCodexConfigToml = (content: string): ParsedCodexConfig => {
  const mcpServers = new Map<string, ParsedMcpServerSection>();
  const plugins = new Map<string, ParsedPluginSection>();
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  let activeTarget:
    | { readonly kind: "mcp"; readonly name: string }
    | { readonly kind: "plugin"; readonly id: string }
    | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const cleaned = stripTomlInlineComment(lines[lineIndex]!).trim();
    if (!cleaned) continue;

    if (cleaned.startsWith("[[") && cleaned.endsWith("]]")) {
      activeTarget = null;
      continue;
    }

    if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
      const segments = parseTomlKeyPath(cleaned.slice(1, -1).trim());
      if (segments.length === 2 && segments[0] === "mcp_servers" && segments[1]) {
        const name = segments[1];
        if (!mcpServers.has(name)) {
          mcpServers.set(name, { enabled: true, envVars: [] });
        }
        activeTarget = { kind: "mcp", name };
      } else if (segments.length === 2 && segments[0] === "plugins" && segments[1]) {
        const id = segments[1];
        if (!plugins.has(id)) {
          plugins.set(id, { enabled: false });
        }
        activeTarget = { kind: "plugin", id };
      } else {
        activeTarget = null;
      }
      continue;
    }

    if (!activeTarget) continue;

    const eqIndex = findTomlEqualsIndex(cleaned);
    if (eqIndex === -1) continue;

    const rawKey = cleaned.slice(0, eqIndex).trim();
    const key = parseTomlStringValue(rawKey) ?? rawKey;
    let rawValue = cleaned.slice(eqIndex + 1).trim();

    let openBrackets = countUnquotedBracketDelta(rawValue);
    while (openBrackets > 0 && lineIndex + 1 < lines.length) {
      lineIndex += 1;
      const nextPart = stripTomlInlineComment(lines[lineIndex]!).trim();
      if (!nextPart) continue;
      rawValue = `${rawValue} ${nextPart}`;
      openBrackets += countUnquotedBracketDelta(nextPart);
    }

    if (activeTarget.kind === "mcp") {
      const entry = mcpServers.get(activeTarget.name);
      if (!entry) continue;
      if (key === "enabled") {
        const enabled = parseTomlBoolean(rawValue);
        if (enabled !== undefined) entry.enabled = enabled;
      } else if (key === "command") {
        const command = parseTomlStringValue(rawValue);
        if (command !== undefined) entry.command = command;
      } else if (key === "env_vars") {
        const envVars = parseTomlStringArray(rawValue);
        if (envVars !== undefined) entry.envVars = envVars;
      }
    } else {
      const entry = plugins.get(activeTarget.id);
      if (!entry) continue;
      if (key === "enabled") {
        const enabled = parseTomlBoolean(rawValue);
        if (enabled !== undefined) entry.enabled = enabled;
      }
    }
  }

  return { mcpServers, plugins };
};

const isExplicitFilesystemCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return (
    NodePath.isAbsolute(trimmed) ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("~\\")
  );
};

const isExistingFile = (filePath: string) =>
  Effect.promise(() =>
    NodeFSP.stat(filePath).then(
      (stats) => stats.isFile(),
      () => false,
    ),
  );

const readOptionalUtf8File = (filePath: string) =>
  Effect.promise(() => NodeFSP.readFile(filePath, "utf8").catch(() => undefined));

const isMissingOfficialAppPipeEnv = (
  envVars: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): boolean =>
  envVars.some(
    (varName) => OFFICIAL_APP_PRIVATE_ENV_VARS.has(varName) && !environment[varName]?.trim(),
  );

const isMcpServerUnavailable = Effect.fn("isMcpServerUnavailable")(function* (input: {
  readonly command?: string | undefined;
  readonly envVars: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  if (isMissingOfficialAppPipeEnv(input.envVars, input.environment)) {
    return true;
  }
  const command = input.command?.trim();
  if (!command || !isExplicitFilesystemCommand(command)) {
    return false;
  }
  const resolvedCommand = expandHomePath(command, input.homeDirectory);
  return !(yield* isExistingFile(resolvedCommand));
});

const isSinglePathSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectEnvVarNamesFromPluginEntry = (entry: Record<string, unknown>): string[] => {
  const names: string[] = [];
  if (Array.isArray(entry.env_vars)) {
    for (const item of entry.env_vars) {
      if (typeof item === "string") names.push(item);
    }
  }
  if (isRecord(entry.env)) {
    for (const [key, val] of Object.entries(entry.env)) {
      names.push(key);
      if (typeof val === "string") {
        for (const privateVar of OFFICIAL_APP_PRIVATE_ENV_VARS) {
          if (val.includes(privateVar)) names.push(privateVar);
        }
      }
    }
  }
  return names;
};

const isCachedPluginUnavailable = Effect.fn("isCachedPluginUnavailable")(function* (input: {
  readonly codexHome: string;
  readonly pluginId: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const atIndex = input.pluginId.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === input.pluginId.length - 1) {
    return false;
  }
  const pluginName = input.pluginId.slice(0, atIndex);
  const marketplace = input.pluginId.slice(atIndex + 1);
  if (!isSinglePathSegment(pluginName) || !isSinglePathSegment(marketplace)) {
    return false;
  }

  const cachePluginDir = NodePath.join(
    input.codexHome,
    "plugins",
    "cache",
    marketplace,
    pluginName,
  );
  const versionEntries = yield* Effect.promise(() =>
    NodeFSP.readdir(cachePluginDir, { withFileTypes: true }).catch(() => []),
  );

  for (const dirEntry of versionEntries) {
    if (!dirEntry.isDirectory()) continue;
    const mcpJsonPath = NodePath.join(cachePluginDir, dirEntry.name, ".mcp.json");
    const rawJson = yield* readOptionalUtf8File(mcpJsonPath);
    if (!rawJson) continue;

    const parsedJson = yield* decodeUnknownJson(rawJson).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (!isRecord(parsedJson) || !isRecord(parsedJson.mcpServers)) continue;

    for (const serverValue of Object.values(parsedJson.mcpServers)) {
      if (!isRecord(serverValue) || serverValue.enabled === false) continue;
      const command = typeof serverValue.command === "string" ? serverValue.command : undefined;
      const envVars = collectEnvVarNamesFromPluginEntry(serverValue);
      if (
        yield* isMcpServerUnavailable({
          command,
          envVars,
          homeDirectory: input.homeDirectory,
          environment: input.environment,
        })
      ) {
        return true;
      }
    }
  }

  return false;
});

const resolveEffectiveCodexHome = (
  homeDirectory: string,
  input: {
    readonly homePath?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  },
): string => {
  const explicitHome = input.homePath?.trim();
  if (explicitHome) {
    return expandHomePath(explicitHome, homeDirectory);
  }
  const envHome = input.environment?.CODEX_HOME?.trim();
  if (envHome) {
    return expandHomePath(envHome, homeDirectory);
  }
  return NodePath.join(homeDirectory, ".codex");
};

export const resolveCodexUnavailableMcpOverrides = Effect.fn("resolveCodexUnavailableMcpOverrides")(
  function* (input: {
    readonly homePath?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }): Effect.fn.Return<ReadonlyArray<string>> {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const effectiveEnv = input.environment ?? process.env;
    const codexHome = resolveEffectiveCodexHome(homeDirectory, input);
    const configPath = NodePath.join(codexHome, "config.toml");

    const configContent = yield* readOptionalUtf8File(configPath);
    if (!configContent) {
      return [];
    }

    const parsed = parseCodexConfigToml(configContent);
    const disabledMcpServers: string[] = [];
    for (const [name, entry] of parsed.mcpServers) {
      if (!entry.enabled) continue;
      if (
        yield* isMcpServerUnavailable({
          command: entry.command,
          envVars: entry.envVars,
          homeDirectory,
          environment: effectiveEnv,
        })
      ) {
        disabledMcpServers.push(name);
      }
    }

    const disabledPlugins: string[] = [];
    for (const [id, entry] of parsed.plugins) {
      if (!entry.enabled) continue;
      if (
        OFFICIAL_APP_PRIVATE_PLUGINS.has(id) &&
        !effectiveEnv.BROWSER_USE_ACCESS_PIPE_PATH?.trim()
      ) {
        disabledPlugins.push(id);
        continue;
      }
      if (
        yield* isCachedPluginUnavailable({
          codexHome,
          pluginId: id,
          homeDirectory,
          environment: effectiveEnv,
        })
      ) {
        disabledPlugins.push(id);
      }
    }

    disabledMcpServers.sort();
    disabledPlugins.sort();

    const overrides: string[] = [];
    if (disabledMcpServers.length > 0) {
      overrides.push(
        "-c",
        `mcp_servers={${disabledMcpServers.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`,
      );
    }
    if (disabledPlugins.length > 0) {
      overrides.push(
        "-c",
        `plugins={${disabledPlugins.map((id) => `${JSON.stringify(id)}={enabled=false}`).join(",")}}`,
      );
    }
    return overrides;
  },
);
