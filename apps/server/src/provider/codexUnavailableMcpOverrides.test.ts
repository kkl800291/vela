import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCodexUnavailableMcpOverrides } from "./codexUnavailableMcpOverrides.ts";

describe("resolveCodexUnavailableMcpOverrides", () => {
  it.effect("returns empty array when config.toml is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
      const codexHome = path.join(dir, ".codex");
      const result = yield* resolveCodexUnavailableMcpOverrides({
        homePath: codexHome,
        environment: {},
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));

      NodeAssert.deepStrictEqual(result, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "disables missing absolute binary MCPs while keeping existing binaries, bare commands, HTTP servers, and disabled entries untouched",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
        const codexHome = path.join(dir, ".codex");
        const existingBin = path.join(dir, "existing-mcp-bin");
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(existingBin, "#!/bin/sh\nexit 0\n");
        yield* fs.writeFileString(
          path.join(codexHome, "config.toml"),
          [
            "[mcp_servers.node_repl]",
            'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
            'args = ["-"]',
            "",
            "[mcp_servers.existing]",
            `command = ${JSON.stringify(existingBin)}`,
            "",
            "[mcp_servers.npx_tool]",
            'command = "npx"',
            "",
            "[mcp_servers.remote]",
            'url = "https://example.com/mcp"',
            "",
            "[mcp_servers.already_off]",
            'command = "/missing/binary"',
            "enabled = false",
            "",
          ].join("\n"),
        );

        const result = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: {},
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));

        NodeAssert.deepStrictEqual(result, ["-c", 'mcp_servers={"node_repl"={enabled=false}}']);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "detects BROWSER_USE_ACCESS_PIPE_PATH requirement on MCP servers with existing binary",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
        const codexHome = path.join(dir, ".codex");
        const existingBin = path.join(dir, "pipe-mcp-bin");
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(existingBin, "#!/bin/sh\nexit 0\n");
        yield* fs.writeFileString(
          path.join(codexHome, "config.toml"),
          [
            "[mcp_servers.pipe_tool]",
            `command = ${JSON.stringify(existingBin)}`,
            "env_vars = [",
            '  "CODEX_HOME",',
            '  "BROWSER_USE_ACCESS_PIPE_PATH", # private pipe',
            "]",
            "",
          ].join("\n"),
        );

        const withoutPipe = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: {},
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));
        NodeAssert.deepStrictEqual(withoutPipe, [
          "-c",
          'mcp_servers={"pipe_tool"={enabled=false}}',
        ]);

        const withPipe = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: { BROWSER_USE_ACCESS_PIPE_PATH: "/tmp/private.pipe" },
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));
        NodeAssert.deepStrictEqual(withPipe, []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "JSON-quotes dotted MCP server names and disables official bundled private plugin when enabled without pipe env",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
        const codexHome = path.join(dir, ".codex");
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(
          path.join(codexHome, "config.toml"),
          [
            '[mcp_servers."my.broken"]',
            'command = "/nonexistent/my-broken-mcp"',
            "",
            '[plugins."unified-computer-use@openai-bundled"]',
            "enabled = true",
            "",
            '[plugins."other-disabled@openai-bundled"]',
            "enabled = false",
            "",
          ].join("\n"),
        );

        const withoutPipe = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: {},
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));
        NodeAssert.deepStrictEqual(withoutPipe, [
          "-c",
          'mcp_servers={"my.broken"={enabled=false}}',
          "-c",
          'plugins={"unified-computer-use@openai-bundled"={enabled=false}}',
        ]);

        const withPipe = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: { BROWSER_USE_ACCESS_PIPE_PATH: "/tmp/private.pipe" },
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));
        NodeAssert.deepStrictEqual(withPipe, ["-c", 'mcp_servers={"my.broken"={enabled=false}}']);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "disables enabled plugins whose cached .mcp.json references a missing absolute binary",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
        const codexHome = path.join(dir, ".codex");
        const cacheVersionDir = path.join(
          codexHome,
          "plugins",
          "cache",
          "custom-marketplace",
          "desktop-helper",
          "1.0.0",
        );
        yield* fs.makeDirectory(cacheVersionDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(codexHome, "config.toml"),
          ['[plugins."desktop-helper@custom-marketplace"]', "enabled = true", ""].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(cacheVersionDir, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              helper: {
                command: "/Applications/MissingDesktopApp.app/Contents/MacOS/helper",
              },
            },
          }),
        );

        const result = yield* resolveCodexUnavailableMcpOverrides({
          homePath: codexHome,
          environment: {},
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, dir));
        NodeAssert.deepStrictEqual(result, [
          "-c",
          'plugins={"desktop-helper@custom-marketplace"={enabled=false}}',
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers homePath over environment.CODEX_HOME over HostProcess.HomeDirectory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vela-codex-mcp-" });
      const defaultHomeDir = path.join(dir, "default-home");
      const homeCodex = path.join(defaultHomeDir, ".codex");
      const envCodex = path.join(dir, "env-codex");
      const explicitCodex = path.join(dir, "explicit-codex");
      yield* fs.makeDirectory(homeCodex, { recursive: true });
      yield* fs.makeDirectory(envCodex, { recursive: true });
      yield* fs.makeDirectory(explicitCodex, { recursive: true });

      yield* fs.writeFileString(
        path.join(homeCodex, "config.toml"),
        '[mcp_servers.from_home]\ncommand = "/missing/home"\n',
      );
      yield* fs.writeFileString(
        path.join(envCodex, "config.toml"),
        '[mcp_servers.from_env]\ncommand = "/missing/env"\n',
      );
      yield* fs.writeFileString(
        path.join(explicitCodex, "config.toml"),
        '[mcp_servers.from_explicit]\ncommand = "/missing/explicit"\n',
      );

      NodeAssert.deepStrictEqual(
        yield* resolveCodexUnavailableMcpOverrides({
          homePath: explicitCodex,
          environment: { CODEX_HOME: envCodex },
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, defaultHomeDir)),
        ["-c", 'mcp_servers={"from_explicit"={enabled=false}}'],
      );
      NodeAssert.deepStrictEqual(
        yield* resolveCodexUnavailableMcpOverrides({
          environment: { CODEX_HOME: envCodex },
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, defaultHomeDir)),
        ["-c", 'mcp_servers={"from_env"={enabled=false}}'],
      );
      NodeAssert.deepStrictEqual(
        yield* resolveCodexUnavailableMcpOverrides({
          environment: {},
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, defaultHomeDir)),
        ["-c", 'mcp_servers={"from_home"={enabled=false}}'],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
