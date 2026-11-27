// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { SECRET_MASK_SENTINEL, UnifiedMcpManager } from "./UnifiedMcpManager.ts";

describe("UnifiedMcpManager", () => {
  let tmpHome: string;
  let manager: UnifiedMcpManager;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vela-mcp-test-"));
    manager = new UnifiedMcpManager(tmpHome);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads JSON & TOML configs, masks sensitive keys, and scans Antigravity plugins", () => {
    // Antigravity mcp_config.json with sensitive Authorization header
    fs.mkdirSync(path.join(tmpHome, ".gemini/config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".gemini/config/mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            docmesh: {
              serverUrl: "https://docmesh.internal/mcp",
              headers: {
                Authorization: "Bearer super-secret-raw-token",
                "X-Custom": "plain-value",
                "X-Env-Ref": "${CUSTOM_HEADER_TOKEN}",
              },
            },
          },
        },
        null,
        2,
      ),
    );

    // Antigravity plugin
    fs.mkdirSync(path.join(tmpHome, ".gemini/config/plugins/figma"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".gemini/config/plugins/figma/plugin.json"),
      JSON.stringify({ name: "figma", displayName: "Figma" }),
    );
    fs.writeFileSync(
      path.join(tmpHome, ".gemini/config/plugins/figma/mcp_config.json"),
      JSON.stringify({ mcpServers: { figma: { serverUrl: "https://mcp.figma.com/mcp" } } }),
    );

    // Codex config.toml with comments, unrelated settings, env table, and plugin
    fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".codex/config.toml"),
      [
        "# User comment must survive",
        'model = "gpt-5.4"',
        "",
        "[mcp_servers.github]",
        'url = "https://api.githubcopilot.com/mcp/"',
        'bearer_token_env_var = "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN"',
        "",
        "[mcp_servers.lanhu]",
        'command = "node"',
        'args = ["/path/to/lanhu.js"]',
        "",
        "[mcp_servers.lanhu.env]",
        'API_TOKEN = "raw-lanhu-secret"',
        'LOG_LEVEL = "info"',
        "",
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
    );

    // Claude Code ~/.claude.json with unrelated metadata
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        numStartups: 42,
        tipsHistory: { welcome: 1 },
        mcpServers: {
          rea: { type: "stdio", command: "rea-mcp", args: ["--stdio"] },
        },
      }),
    );

    const snap = manager.getSnapshot();
    expect(snap.engines).toHaveLength(6);

    const ag = snap.engines.find((e) => e.id === "antigravity")!;
    expect(ag.servers).toHaveLength(1);
    expect(ag.servers[0]?.transport).toBe("http");
    expect(ag.servers[0]?.url).toBe("https://docmesh.internal/mcp");
    expect(ag.servers[0]?.headers?.Authorization).toBe(SECRET_MASK_SENTINEL);
    expect(ag.servers[0]?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(ag.servers[0]?.headers?.["X-Env-Ref"]).toBe("${CUSTOM_HEADER_TOKEN}");
    expect(ag.servers[0]?.maskedHeaderKeys).toEqual(["Authorization", "X-Custom"]);
    expect(ag.plugins).toHaveLength(1);
    expect(ag.plugins[0]?.name).toBe("figma");

    const codex = snap.engines.find((e) => e.id === "codex")!;
    expect(codex.servers).toHaveLength(2);
    const gh = codex.servers.find((s) => s.name === "github")!;
    expect(gh.transport).toBe("http");
    expect(gh.bearerTokenEnvVar).toBe("CODEX_GITHUB_PERSONAL_ACCESS_TOKEN");
    const lanhu = codex.servers.find((s) => s.name === "lanhu")!;
    expect(lanhu.env?.API_TOKEN).toBe(SECRET_MASK_SENTINEL);
    expect(lanhu.env?.LOG_LEVEL).toBe("info");
    expect(codex.plugins).toHaveLength(1);
    expect(codex.plugins[0]?.name).toBe("github");
  });

  it("preserves unrelated keys in ~/.claude.json and unrelated TOML comments/sections on upsert/toggle/delete", () => {
    const claudePath = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(
      claudePath,
      JSON.stringify({ numStartups: 99, customNested: { keep: true }, mcpServers: {} }),
    );

    const codexPath = path.join(tmpHome, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        "# Keep this header comment",
        'model = "gpt-5.4"',
        "",
        "[features]",
        "multi_agent = true",
        "",
      ].join("\n"),
    );

    manager.upsertServer({
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      targets: ["claude", "codex", "antigravity"],
    });

    // Verify backup created
    expect(fs.existsSync(`${claudePath}.vela.bak`)).toBe(true);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(true);

    // Verify Claude preserved unrelated keys
    const claudeRaw = JSON.parse(fs.readFileSync(claudePath, "utf8")) as Record<string, unknown>;
    expect(claudeRaw.numStartups).toBe(99);
    expect(claudeRaw.customNested).toEqual({ keep: true });

    // Verify Antigravity used serverUrl
    const agRaw = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".gemini/config/mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(agRaw.mcpServers.context7?.serverUrl).toBe("https://mcp.context7.com/mcp");

    // Verify Codex preserved comment & [features]
    const codexTextAfterUpsert = fs.readFileSync(codexPath, "utf8");
    expect(codexTextAfterUpsert).toContain("# Keep this header comment");
    expect(codexTextAfterUpsert).toContain("[features]\nmulti_agent = true");
    expect(codexTextAfterUpsert).toContain('[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"');

    // Toggle disabled on Codex & Claude
    manager.toggleServer({ engineId: "codex", name: "context7", enabled: false });
    manager.toggleServer({ engineId: "claude", name: "context7", enabled: false });
    const afterToggle = manager.getSnapshot();
    expect(afterToggle.engines.find((e) => e.id === "codex")?.servers[0]?.enabled).toBe(false);
    expect(afterToggle.engines.find((e) => e.id === "claude")?.servers[0]?.enabled).toBe(false);

    // Delete on Codex and verify unrelated sections still intact
    manager.deleteServer({ name: "context7", engineIds: ["codex"] });
    const codexTextAfterDelete = fs.readFileSync(codexPath, "utf8");
    expect(codexTextAfterDelete).toContain("# Keep this header comment");
    expect(codexTextAfterDelete).toContain("multi_agent = true");
    expect(codexTextAfterDelete).not.toContain("mcp_servers.context7");
  });

  it("preserves raw secrets on edit when mask sentinel is unchanged, and syncs raw secrets server-side", () => {
    fs.mkdirSync(path.join(tmpHome, ".gemini/config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".gemini/config/mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          docmesh: {
            serverUrl: "https://docmesh.internal/mcp",
            headers: {
              Authorization: "Bearer super-secret-value-123",
            },
          },
        },
      }),
    );

    // Edit URL while keeping masked Authorization sentinel
    manager.upsertServer({
      name: "docmesh",
      transport: "http",
      url: "https://docmesh.internal/mcp-v2",
      headers: { Authorization: SECRET_MASK_SENTINEL },
      targets: ["antigravity"],
      preserveSecretsFromEngineId: "antigravity",
    });

    const agAfterEdit = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".gemini/config/mcp_config.json"), "utf8"),
    ) as { mcpServers: { docmesh: { serverUrl: string; headers: { Authorization: string } } } };
    expect(agAfterEdit.mcpServers.docmesh.serverUrl).toBe("https://docmesh.internal/mcp-v2");
    expect(agAfterEdit.mcpServers.docmesh.headers.Authorization).toBe(
      "Bearer super-secret-value-123",
    );

    // Sync from Antigravity to Cursor & Codex server-side
    manager.syncServer({
      sourceEngineId: "antigravity",
      name: "docmesh",
      targetEngineIds: ["cursor", "codex"],
    });

    const cursorAfterSync = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".cursor/mcp.json"), "utf8"),
    ) as { mcpServers: { docmesh: { url: string; headers: { Authorization: string } } } };
    expect(cursorAfterSync.mcpServers.docmesh.url).toBe("https://docmesh.internal/mcp-v2");
    expect(cursorAfterSync.mcpServers.docmesh.headers.Authorization).toBe(
      "Bearer super-secret-value-123",
    );

    const codexAfterSync = fs.readFileSync(path.join(tmpHome, ".codex/config.toml"), "utf8");
    expect(codexAfterSync).toContain("[mcp_servers.docmesh]");
    expect(codexAfterSync).toContain('Authorization = "Bearer super-secret-value-123"');
  });

  it("preserves unmanaged Codex TOML fields (cwd, startup_timeout_sec, etc.) and comments on edit & rename", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        "[mcp_servers.mytool]",
        "# Keep this comment inside section",
        'command = "uvx"',
        'args = ["mytool-mcp"]',
        'cwd = "/Users/dev/workspace"',
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 120",
        'enabled_tools = ["read", "search"]',
        "",
        "[mcp_servers.mytool.env]",
        "# Keep env comment",
        'API_KEY = "keep-secret"',
        'OLD_VAR = "remove-me"',
        "",
      ].join("\n"),
    );

    // Edit args and env on Codex without dropping cwd, timeouts, or comments
    manager.upsertServer({
      name: "mytool",
      transport: "stdio",
      enabled: true,
      command: "uvx",
      args: ["mytool-mcp", "--fast"],
      env: { API_KEY: "keep-secret", NEW_VAR: "added" },
      targets: ["codex"],
    });

    const editedText = fs.readFileSync(codexPath, "utf8");
    expect(editedText).toContain('args = ["mytool-mcp", "--fast"]');
    expect(editedText).toContain('cwd = "/Users/dev/workspace"');
    expect(editedText).toContain("startup_timeout_sec = 30");
    expect(editedText).toContain("tool_timeout_sec = 120");
    expect(editedText).toContain('enabled_tools = ["read", "search"]');
    expect(editedText).toContain("# Keep this comment inside section");
    expect(editedText).toContain("# Keep env comment");
    expect(editedText).toContain('NEW_VAR = "added"');
    expect(editedText).not.toContain("OLD_VAR");

    // Rename server and confirm unmanaged fields & comments still survive
    manager.upsertServer({
      name: "mytool_v2",
      originalName: "mytool",
      transport: "stdio",
      enabled: false,
      command: "uvx",
      args: ["mytool-mcp", "--fast"],
      env: { API_KEY: "keep-secret", NEW_VAR: "added" },
      targets: ["codex"],
    });

    const renamedText = fs.readFileSync(codexPath, "utf8");
    expect(renamedText).toContain("[mcp_servers.mytool_v2]");
    expect(renamedText).toContain("[mcp_servers.mytool_v2.env]");
    expect(renamedText).not.toContain("[mcp_servers.mytool]");
    expect(renamedText).toContain('cwd = "/Users/dev/workspace"');
    expect(renamedText).toContain("startup_timeout_sec = 30");
    expect(renamedText).toContain("enabled = false");
    expect(renamedText).toContain("# Keep this comment inside section");
  });

  it("reports per-engine sync results when one target fails while still refreshing succeeded targets", () => {
    const claudePath = path.join(tmpHome, ".claude.json");
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      claudePath,
      JSON.stringify({
        mcpServers: {
          shared_tool: { command: "npx", args: ["-y", "shared-mcp"] },
        },
      }),
    );
    // Corrupt Cursor config so syncing to Cursor fails while Antigravity succeeds
    fs.writeFileSync(path.join(cursorDir, "mcp.json"), "{ invalid-json");

    const syncRes = manager.syncServer({
      sourceEngineId: "claude",
      name: "shared_tool",
      targetEngineIds: ["antigravity", "cursor"],
    });

    expect(syncRes.ok).toBe(false);
    expect(syncRes.results).toHaveLength(2);
    expect(syncRes.results.find((r) => r.engineId === "antigravity")).toEqual({
      engineId: "antigravity",
      ok: true,
    });
    const cursorRes = syncRes.results.find((r) => r.engineId === "cursor");
    expect(cursorRes?.ok).toBe(false);
    expect(cursorRes?.error).toBeTruthy();

    // Snapshot reflects Antigravity's successful write despite Cursor's failure
    const agState = syncRes.snapshot.engines.find((e) => e.id === "antigravity");
    expect(agState?.servers.some((s) => s.name === "shared_tool")).toBe(true);
  });

  it("rejects renaming to an existing server name without overwriting targets", () => {
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          one: { command: "npx", args: ["-y", "one-mcp"] },
          two: { command: "uvx", args: ["two-mcp"] },
        },
      }),
    );

    expect(() =>
      manager.upsertServer({
        name: "two",
        originalName: "one",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "one-mcp"],
        targets: ["cursor"],
      }),
    ).toThrow(/无法重命名为「two」/);

    const cursorAfter = manager.getSnapshot().engines.find((e) => e.id === "cursor");
    expect(cursorAfter?.servers.map((s) => s.name)).toEqual(["one", "two"]);
    expect(cursorAfter?.servers.find((s) => s.name === "two")?.command).toBe("uvx");
  });

  it("preserves per-engine enabled state on multi-target upsert when enabled is omitted", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      `[mcp_servers.shared]\ncommand = "npx"\nargs = ["-y", "old"]\n`,
    );
    fs.writeFileSync(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "npx", args: ["-y", "old"], disabled: true },
        },
      }),
    );

    const next = manager.upsertServer({
      name: "shared",
      originalName: "shared",
      transport: "stdio",
      command: "npx",
      args: ["-y", "new"],
      targets: ["codex", "cursor"],
    });

    expect(
      next.engines.find((e) => e.id === "codex")?.servers.find((s) => s.name === "shared")?.enabled,
    ).toBe(true);
    expect(
      next.engines.find((e) => e.id === "cursor")?.servers.find((s) => s.name === "shared")?.enabled,
    ).toBe(false);
  });

  it("masks custom api_key_header values and restores them when the sentinel is saved back", () => {
    fs.mkdirSync(path.join(tmpHome, ".gemini/config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".gemini/config/mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          docmesh: { serverUrl: "https://docmesh.internal/mcp" },
        },
      }),
    );

    const saved = manager.applyAuthToServer({
      name: "docmesh",
      sourceEngineId: "antigravity",
      targetEngineIds: ["antigravity"],
      mode: "api_key_header",
      headerName: "X-Custom",
      token: "super-secret-custom",
    });
    const savedServer = saved.engines
      .find((engine) => engine.id === "antigravity")
      ?.servers.find((server) => server.name === "docmesh");
    expect(savedServer?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(savedServer?.maskedHeaderKeys).toContain("X-Custom");

    const freshServer = manager
      .getSnapshot()
      .engines.find((engine) => engine.id === "antigravity")
      ?.servers.find((server) => server.name === "docmesh");
    expect(freshServer?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(freshServer?.maskedHeaderKeys).toContain("X-Custom");

    manager.upsertServer({
      name: "docmesh",
      transport: "http",
      url: "https://docmesh.internal/mcp-v2",
      headers: { "X-Custom": SECRET_MASK_SENTINEL },
      targets: ["antigravity"],
    });

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".gemini/config/mcp_config.json"), "utf8"),
    ) as {
      mcpServers: { docmesh: { serverUrl: string; headers: Record<string, string> } };
    };
    expect(raw.mcpServers.docmesh.serverUrl).toBe("https://docmesh.internal/mcp-v2");
    expect(raw.mcpServers.docmesh.headers["X-Custom"]).toBe("super-secret-custom");
  });

  it("keeps unrelated TOML array-of-tables blocks intact across toggle, upsert, rename, and delete", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const arrayBlock = [
      "[[profiles]] # profile table",
      'name = "dev"',
      'command = "echo keep"',
      "enabled = true",
      "# keep profile comment",
      'note = "do not touch"',
    ].join("\n");
    fs.writeFileSync(
      codexPath,
      [
        "# keep preamble",
        "",
        "[mcp_servers.docs]",
        'command = "node"',
        'args = ["server.js"]',
        "",
        arrayBlock,
        "",
        "[features]",
        "multi_agent = true",
        "",
      ].join("\n"),
    );

    manager.toggleServer({ engineId: "codex", name: "docs", enabled: false });
    const toggled = fs.readFileSync(codexPath, "utf8");
    expect(toggled).toContain(
      ['[mcp_servers.docs]', 'command = "node"', 'args = ["server.js"]', "enabled = false", "", arrayBlock].join(
        "\n",
      ),
    );
    expect(toggled).toContain("[features]\nmulti_agent = true");
    expect(manager.getSnapshot().engines.find((engine) => engine.id === "codex")?.servers).toEqual([
      expect.objectContaining({ name: "docs", command: "node", enabled: false }),
    ]);

    manager.upsertServer({
      name: "docs",
      transport: "stdio",
      command: "node",
      args: ["server.js", "--watch"],
      env: { LOG_LEVEL: "debug" },
      targets: ["codex"],
    });
    const edited = fs.readFileSync(codexPath, "utf8");
    expect(edited).toContain(
      [
        "[mcp_servers.docs]",
        'command = "node"',
        'args = ["server.js", "--watch"]',
        "enabled = false",
        "",
        "[mcp_servers.docs.env]",
        'LOG_LEVEL = "debug"',
        "",
        arrayBlock,
      ].join("\n"),
    );

    manager.upsertServer({
      name: "docs_v2",
      originalName: "docs",
      transport: "http",
      url: "https://docs.example/mcp",
      headers: { "X-Org": "header-secret" },
      targets: ["codex"],
    });
    const renamed = fs.readFileSync(codexPath, "utf8");
    expect(renamed).toContain("[mcp_servers.docs_v2]");
    expect(renamed).toContain("[mcp_servers.docs_v2.http_headers]");
    expect(renamed).toContain('X-Org = "header-secret"');
    expect(renamed).not.toMatch(/\[mcp_servers\.docs(?!_v2)/);
    expect(renamed).toContain(
      ["[mcp_servers.docs_v2.http_headers]", 'X-Org = "header-secret"', "", arrayBlock].join("\n"),
    );
    expect(renamed).toContain("# keep preamble");
    expect(renamed).toContain("[features]\nmulti_agent = true");

    manager.deleteServer({ name: "docs_v2", engineIds: ["codex"] });
    const deleted = fs.readFileSync(codexPath, "utf8");
    expect(deleted).toContain(["# keep preamble", "", arrayBlock, "", "[features]", "multi_agent = true"].join("\n"));
    expect(deleted).not.toContain("mcp_servers");
    expect(manager.getSnapshot().engines.find((engine) => engine.id === "codex")?.servers).toEqual([]);
  });

  it("does not treat [[1]] or [1] inside multiline TOML values as table headers", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const notesBlock = [
      "[notes]",
      "values = [",
      '  "keep-me",',
      "  [1],",
      "  [[1]]",
      "]",
      'text = """',
      "[[1]]",
      "[1]",
      "keep multiline",
      '"""',
      "literal = '''",
      "[[1]]",
      "[1]",
      "'''",
      "meta = {",
      "[[1]]",
      "[1]",
      "}",
    ].join("\n");
    const docsBlock = [
      "[mcp_servers.docs]",
      'command = "node"',
      "args = [",
      '  "docs-arg",',
      "  [1],",
      "  [[1]]",
      "]",
    ].join("\n");
    fs.writeFileSync(
      codexPath,
      ["# preamble", "", notesBlock, "", docsBlock, "", "[[profiles]]", 'name = "dev"', ""].join("\n"),
    );

    manager.toggleServer({ engineId: "codex", name: "docs", enabled: false });
    const toggled = fs.readFileSync(codexPath, "utf8");
    expect(toggled).toContain(notesBlock);
    expect(toggled).toContain([docsBlock, "enabled = false", "", "[[profiles]]", 'name = "dev"'].join("\n"));
    expect(toggled).not.toContain("enabled = false\n  [1]");
    expect(toggled).not.toContain("enabled = false\n[[1]]");

    manager.deleteServer({ name: "docs", engineIds: ["codex"] });
    const deleted = fs.readFileSync(codexPath, "utf8");
    expect(deleted).toContain(notesBlock);
    expect(deleted).toContain(["[[profiles]]", 'name = "dev"'].join("\n"));
    expect(deleted).not.toContain("mcp_servers.docs");
    expect(deleted).not.toContain("docs-arg");
    expect(deleted).toContain('"keep-me"');
    expect(deleted).not.toContain("enabled =");
  });

  it("ignores array-of-tables MCP paths and refuses writes that would conflict with them", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const arrayOwned = [
      "[[mcp_servers.foo]]",
      'command = "echo-array"',
      "",
      "[mcp_servers.foo.env]",
      'API_TOKEN = "keep-me"',
      "",
      "[features]",
      "x = true",
      "",
    ].join("\n");
    fs.writeFileSync(codexPath, arrayOwned);

    const snap = manager.getSnapshot().engines.find((engine) => engine.id === "codex");
    expect(snap?.servers).toEqual([]);

    manager.deleteServer({ name: "foo", engineIds: ["codex"] });
    expect(fs.readFileSync(codexPath, "utf8")).toBe(arrayOwned);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);

    expect(() =>
      manager.upsertServer({
        name: "foo",
        transport: "stdio",
        command: "node",
        targets: ["codex"],
      }),
    ).toThrow(/\[\[mcp_servers\.foo\]\]/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(arrayOwned);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);

    const envArray = [
      "[mcp_servers.docs]",
      'command = "node"',
      "",
      "[[mcp_servers.docs.env]]",
      'API_TOKEN = "keep-me"',
      "",
    ].join("\n");
    fs.writeFileSync(codexPath, envArray);
    expect(() =>
      manager.upsertServer({
        name: "docs",
        transport: "stdio",
        command: "node",
        env: { LOG_LEVEL: "debug" },
        targets: ["codex"],
      }),
    ).toThrow(/\[\[mcp_servers\.docs\.env\]\]/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(envArray);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);
  });

  it("rejects a mask sentinel on a renamed header or env key instead of writing it to disk", () => {
    fs.mkdirSync(path.join(tmpHome, ".gemini/config"), { recursive: true });
    const agPath = path.join(tmpHome, ".gemini/config/mcp_config.json");
    const original = `${JSON.stringify(
      {
        mcpServers: {
          docmesh: {
            serverUrl: "https://docmesh.internal/mcp",
            headers: { "X-Custom": "real-header-secret" },
          },
          local: {
            command: "node",
            env: { API_TOKEN: "real-env-secret" },
          },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(agPath, original);

    expect(() =>
      manager.upsertServer({
        name: "docmesh",
        transport: "http",
        url: "https://docmesh.internal/mcp",
        headers: { "X-Renamed": SECRET_MASK_SENTINEL },
        targets: ["antigravity"],
      }),
    ).toThrow(/X-Renamed/);

    expect(() =>
      manager.upsertServer({
        name: "local",
        transport: "stdio",
        command: "node",
        env: { API_TOKEN_RENAMED: SECRET_MASK_SENTINEL },
        targets: ["antigravity"],
      }),
    ).toThrow(/API_TOKEN_RENAMED/);

    const after = fs.readFileSync(agPath, "utf8");
    expect(after).toBe(original);
    expect(after).not.toContain(SECRET_MASK_SENTINEL);
    expect(fs.existsSync(`${agPath}.vela.bak`)).toBe(false);
  });

  it("keeps a following array table when a multiline string closes with four quotes", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const original = [
      "[mcp_servers.docs]",
      'command = "node"',
      "args = [",
      '"""keep""""]',
      "",
      "[[profiles]]",
      'name = "dev"',
      "",
    ].join("\n");
    fs.writeFileSync(codexPath, original);

    manager.deleteServer({ name: "docs", engineIds: ["codex"] });
    const deleted = fs.readFileSync(codexPath, "utf8");
    expect(deleted).toContain(["[[profiles]]", 'name = "dev"'].join("\n"));
    expect(deleted).not.toContain("mcp_servers.docs");
    expect(deleted).not.toContain('"""keep""""');
  });

  it("toggles the real enabled key and ignores assignments inside multiline strings", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const notes = ['notes = """', "enabled = false", '"""'].join("\n");
    fs.writeFileSync(
      codexPath,
      ["[mcp_servers.docs]", 'command = "node"', notes, "enabled = true", ""].join("\n"),
    );

    manager.toggleServer({ engineId: "codex", name: "docs", enabled: false });
    const toggled = fs.readFileSync(codexPath, "utf8");
    expect(toggled).toContain([notes, "enabled = false"].join("\n"));
    expect(toggled).not.toContain("enabled = true");

    fs.writeFileSync(
      codexPath,
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example/mcp"',
        "",
        "[mcp_servers.docs.http_headers]",
        'Authorization = "Bearer real-token"',
        'notes = """',
        'Fake-Header = "x"',
        '"""',
        'X-Real = "kept"',
        "",
      ].join("\n"),
    );
    const server = manager
      .getSnapshot()
      .engines.find((engine) => engine.id === "codex")
      ?.servers.find((entry) => entry.name === "docs");
    expect(server?.headers).not.toHaveProperty("Fake-Header");
    expect(server?.headers?.Authorization).toBe(SECRET_MASK_SENTINEL);
    expect(server?.headers?.["X-Real"]).toBe(SECRET_MASK_SENTINEL);
  });

  it("rejects unicode-equivalent array tables and dotted subtable keys before writing", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const unicodeArray = ['[[mcp_servers."f\\u006Fo"]]', 'command = "echo-array"', ""].join("\n");
    fs.writeFileSync(codexPath, unicodeArray);

    expect(() =>
      manager.upsertServer({
        name: "foo",
        transport: "stdio",
        command: "node",
        targets: ["codex"],
      }),
    ).toThrow(/\[\[mcp_servers\.foo\]\]/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(unicodeArray);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);

    const dotted = ["[mcp_servers.docs]", 'command = "node"', 'env.API_TOKEN = "x"', ""].join("\n");
    fs.writeFileSync(codexPath, dotted);
    expect(() =>
      manager.upsertServer({
        name: "docs",
        transport: "stdio",
        command: "node",
        env: { LOG_LEVEL: "debug" },
        targets: ["codex"],
      }),
    ).toThrow(/env\.API_TOKEN/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(dotted);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);
  });

  it("does not rename an earlier engine when a later target rejects a mask sentinel", () => {
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    const claudePath = path.join(tmpHome, ".claude.json");
    const cursorOriginal = `${JSON.stringify(
      {
        mcpServers: {
          shared: {
            url: "https://example.com/mcp",
            headers: { "X-Custom": "cursor-secret" },
          },
        },
      },
      null,
      2,
    )}\n`;
    const claudeOriginal = `${JSON.stringify(
      {
        mcpServers: {
          shared: { url: "https://example.com/mcp" },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(cursorPath, cursorOriginal);
    fs.writeFileSync(claudePath, claudeOriginal);

    expect(() =>
      manager.upsertServer({
        name: "shared-v2",
        originalName: "shared",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": SECRET_MASK_SENTINEL },
        targets: ["cursor", "claude"],
      }),
    ).toThrow(/X-Custom/);

    expect(fs.readFileSync(cursorPath, "utf8")).toBe(cursorOriginal);
    expect(fs.readFileSync(claudePath, "utf8")).toBe(claudeOriginal);
    expect(fs.existsSync(`${cursorPath}.vela.bak`)).toBe(false);
    expect(fs.readFileSync(cursorPath, "utf8")).not.toContain("shared-v2");
  });

  it("prepares every target before writing so a later failure leaves earlier engines untouched", () => {
    const cursorDir = path.join(tmpHome, ".cursor");
    const codexDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    const claudePath = path.join(tmpHome, ".claude.json");
    const codexPath = path.join(codexDir, "config.toml");
    const cursorOriginal = `${JSON.stringify(
      {
        mcpServers: {
          shared: { command: "original-cursor", args: ["--stdio"] },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(cursorPath, cursorOriginal);
    fs.writeFileSync(claudePath, "{ invalid-json");

    expect(() =>
      manager.upsertServer({
        name: "shared-v2",
        originalName: "shared",
        transport: "stdio",
        command: "node",
        targets: ["cursor", "claude"],
      }),
    ).toThrow(SyntaxError);
    expect(fs.readFileSync(cursorPath, "utf8")).toBe(cursorOriginal);
    expect(fs.readFileSync(claudePath, "utf8")).toBe("{ invalid-json");
    expect(fs.existsSync(`${cursorPath}.vela.bak`)).toBe(false);

    const codexOriginal = ["[[mcp_servers.shared-v2]]", 'command = "echo-array"', ""].join("\n");
    fs.writeFileSync(codexPath, codexOriginal);
    expect(() =>
      manager.upsertServer({
        name: "shared-v2",
        originalName: "shared",
        transport: "stdio",
        command: "node",
        targets: ["cursor", "codex"],
      }),
    ).toThrow(/\[\[mcp_servers\.shared-v2\]\]/);
    expect(fs.readFileSync(cursorPath, "utf8")).toBe(cursorOriginal);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(codexOriginal);
    expect(fs.existsSync(`${cursorPath}.vela.bak`)).toBe(false);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);
  });

  it("treats an escaped backslash before U as literal and rejects parent dotted server keys", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    const serverName = "x\\U00000041";
    const literalArray = [`[[mcp_servers.'${serverName}']]`, 'command = "echo-array"', ""].join("\n");
    fs.writeFileSync(codexPath, literalArray);

    expect(() =>
      manager.upsertServer({
        name: serverName,
        transport: "stdio",
        command: "node",
        targets: ["codex"],
      }),
    ).toThrow(/\[\[mcp_servers\.x\\U00000041\]\]/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(literalArray);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);

    const dottedParent = ["[mcp_servers]", 'docs.command = "old"', ""].join("\n");
    fs.writeFileSync(codexPath, dottedParent);
    expect(() =>
      manager.upsertServer({
        name: "docs",
        transport: "stdio",
        command: "node",
        targets: ["codex"],
      }),
    ).toThrow(/docs\.command/);
    expect(fs.readFileSync(codexPath, "utf8")).toBe(dottedParent);
    expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);
  });

  it("decodes multiline basic header strings before masking and round-tripping the sentinel", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example/mcp"',
        "",
        "[mcp_servers.docs.http_headers]",
        'X-Custom = """',
        "synthetic-\\",
        '  value"""',
        "",
      ].join("\n"),
    );

    const before = manager
      .getSnapshot()
      .engines.find((engine) => engine.id === "codex")
      ?.servers.find((entry) => entry.name === "docs");
    expect(before?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(before?.maskedHeaderKeys).toContain("X-Custom");

    manager.upsertServer({
      name: "docs",
      transport: "http",
      url: "https://docs.example/mcp-v2",
      headers: { "X-Custom": SECRET_MASK_SENTINEL },
      targets: ["codex"],
    });
    const saved = fs.readFileSync(codexPath, "utf8");
    expect(saved).toContain('url = "https://docs.example/mcp-v2"');
    expect(saved).toContain('X-Custom = "synthetic-value"');
    expect(saved).not.toContain('"""');
    expect(saved).not.toContain("synthetic-\\");
  });

  it("rejects inline tables that already define an MCP server and does not write other engines", () => {
    const cursorDir = path.join(tmpHome, ".cursor");
    const codexDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    const codexPath = path.join(codexDir, "config.toml");
    const cursorOriginal = `${JSON.stringify(
      {
        mcpServers: {
          docs: { command: "original-cursor", args: ["--stdio"] },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(cursorPath, cursorOriginal);

    const fixtures = [
      ['mcp_servers.docs = { command = "old" }', ""].join("\n"),
      ["[mcp_servers]", 'docs = { command = "old" }', ""].join("\n"),
      ['mcp_servers = { docs = { command = "old" } }', ""].join("\n"),
    ];
    for (const codexOriginal of fixtures) {
      fs.writeFileSync(codexPath, codexOriginal);
      fs.rmSync(`${codexPath}.vela.bak`, { force: true });
      fs.rmSync(`${cursorPath}.vela.bak`, { force: true });
      expect(() =>
        manager.upsertServer({
          name: "docs",
          transport: "stdio",
          command: "node",
          targets: ["cursor", "codex"],
        }),
      ).toThrow(/无法写入 \[mcp_servers\.docs\]/);
      expect(fs.readFileSync(cursorPath, "utf8")).toBe(cursorOriginal);
      expect(fs.readFileSync(codexPath, "utf8")).toBe(codexOriginal);
      expect(fs.existsSync(`${cursorPath}.vela.bak`)).toBe(false);
      expect(fs.existsSync(`${codexPath}.vela.bak`)).toBe(false);
    }
  });

  it("decodes multiline strings nested inside an inline http_headers table", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example/mcp"',
        "http_headers = { X-Custom = \"\"\"",
        "synthetic-\\",
        "  value#literal\"\"\", Y-Note = '''",
        "line1",
        "line2''' }",
        "",
      ].join("\n"),
    );

    const before = manager
      .getSnapshot()
      .engines.find((engine) => engine.id === "codex")
      ?.servers.find((entry) => entry.name === "docs");
    expect(before?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(before?.headers?.["Y-Note"]).toBe(SECRET_MASK_SENTINEL);
    expect(before?.maskedHeaderKeys).toEqual(expect.arrayContaining(["X-Custom", "Y-Note"]));

    manager.upsertServer({
      name: "docs",
      transport: "http",
      url: "https://docs.example/mcp-v2",
      headers: {
        "X-Custom": SECRET_MASK_SENTINEL,
        "Y-Note": SECRET_MASK_SENTINEL,
      },
      targets: ["codex"],
    });
    const saved = fs.readFileSync(codexPath, "utf8");
    expect(saved).toContain('url = "https://docs.example/mcp-v2"');
    expect(saved).toContain('X-Custom = "synthetic-value#literal"');
    expect(saved).toContain('Y-Note = "line1\\nline2"');
    expect(saved).not.toContain('"""');
    expect(saved).not.toContain("'''");
  });

  it("ignores trailing comments after multiline strings and inline header tables while preserving inline spacing and quote comments", () => {
    const codexDir = path.join(tmpHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        "[mcp_servers.docs_inline]",
        'url = "https://docs.example/mcp"',
        "http_headers = { X-Custom = \"\"\"",
        "synthetic-\\",
        '  value#literal""", X-Pad = """first   ',
        'second#literal""" } # keep this comment',
        "",
        "[mcp_servers.docs_subtable]",
        'url = "https://sub.example/mcp"',
        "",
        "[mcp_servers.docs_subtable.http_headers]",
        'X-Single = """abc""" # single comment',
        'X-Quote = """abc"#literal""" # trailing note',
        'X-Four = """abc"""" # four note',
        'X-Multi = """',
        'line-one',
        'line-two""" # closing comment',
        "",
      ].join("\n"),
    );

    const beforeSnap = manager.getSnapshot().engines.find((engine) => engine.id === "codex");
    const beforeInline = beforeSnap?.servers.find((entry) => entry.name === "docs_inline");
    const beforeSubtable = beforeSnap?.servers.find((entry) => entry.name === "docs_subtable");
    expect(beforeInline?.headers?.["X-Custom"]).toBe(SECRET_MASK_SENTINEL);
    expect(beforeInline?.headers?.["X-Pad"]).toBe(SECRET_MASK_SENTINEL);
    expect(beforeSubtable?.headers?.["X-Single"]).toBe(SECRET_MASK_SENTINEL);
    expect(beforeSubtable?.headers?.["X-Quote"]).toBe(SECRET_MASK_SENTINEL);
    expect(beforeSubtable?.headers?.["X-Four"]).toBe(SECRET_MASK_SENTINEL);
    expect(beforeSubtable?.headers?.["X-Multi"]).toBe(SECRET_MASK_SENTINEL);

    manager.upsertServer({
      name: "docs_inline",
      transport: "http",
      url: "https://docs.example/mcp-v2",
      headers: {
        "X-Custom": SECRET_MASK_SENTINEL,
        "X-Pad": SECRET_MASK_SENTINEL,
      },
      targets: ["codex"],
    });
    manager.upsertServer({
      name: "docs_subtable",
      transport: "http",
      url: "https://sub.example/mcp-v2",
      headers: {
        "X-Single": SECRET_MASK_SENTINEL,
        "X-Quote": SECRET_MASK_SENTINEL,
        "X-Four": SECRET_MASK_SENTINEL,
        "X-Multi": SECRET_MASK_SENTINEL,
      },
      targets: ["codex"],
    });
    const saved = fs.readFileSync(codexPath, "utf8");
    expect(saved).toContain('url = "https://docs.example/mcp-v2"');
    expect(saved).toContain('X-Custom = "synthetic-value#literal"');
    expect(saved).toContain('X-Pad = "first   \\nsecond#literal"');
    expect(saved).toContain('url = "https://sub.example/mcp-v2"');
    expect(saved).toContain('X-Single = "abc" # single comment');
    expect(saved).toContain('X-Quote = "abc\\"#literal" # trailing note');
    expect(saved).toContain('X-Four = "abc\\"" # four note');
    expect(saved).toContain('X-Multi = "line-one\\nline-two" # closing comment');
    expect(saved).not.toContain("keep this comment");
    expect(saved).not.toContain('"""');
  });
});
