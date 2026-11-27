// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { UnifiedMcpManager } from "./UnifiedMcpManager.ts";
import { parseUpsertPayload } from "./unifiedMcpRoutes.ts";

describe("parseUpsertPayload", () => {
  let tmpHome: string;
  let manager: UnifiedMcpManager;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vela-mcp-route-"));
    manager = new UnifiedMcpManager(tmpHome);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("leaves enabled unset so a disabled Cursor server stays disabled", () => {
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      cursorPath,
      `${JSON.stringify(
        {
          mcpServers: {
            shared: { command: "npx", args: ["-y", "old"], disabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );

    const parsed = parseUpsertPayload({
      name: "shared",
      transport: "stdio",
      command: "npx",
      args: ["-y", "new"],
      targets: ["cursor"],
    });
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    expect(parsed.enabled).toBeUndefined();

    manager.upsertServer(parsed);
    const saved = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as {
      mcpServers: { shared: { command: string; args: string[]; disabled?: boolean } };
    };
    expect(saved.mcpServers.shared.command).toBe("npx");
    expect(saved.mcpServers.shared.args).toEqual(["-y", "new"]);
    expect(saved.mcpServers.shared.disabled).toBe(true);
  });
});
