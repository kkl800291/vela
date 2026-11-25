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
    expect(ag.servers[0]?.headers?.["X-Custom"]).toBe("plain-value");
    expect(ag.servers[0]?.maskedHeaderKeys).toEqual(["Authorization"]);
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
});
