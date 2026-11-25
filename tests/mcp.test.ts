import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/shared/contracts";
import { McpManager } from "../src/main/mcp/manager";

describe("McpManager", () => {
  it("starts a real stdio MCP server, inventories tools and calls one", async () => {
    const config: McpServerConfig = {
      id: "fixture",
      name: "Fixture",
      command: process.execPath,
      args: [path.join(process.cwd(), "tests", "fixtures", "mcp-server.mjs")],
      enabled: true,
      env: { OPENHACK_TEST_MCP: "1" },
    };
    const manager = new McpManager(() => [config]);
    try {
      const status = await manager.connect(config);
      expect(status.state).toBe("ready");
      expect(status.tools).toHaveLength(1);
      expect(status.tools[0]).toMatchObject({ name: "mcp_fixture_echo", risk: "read" });
      expect(status.envKeys).toEqual(["OPENHACK_TEST_MCP"]);
      const result = await manager.callTool("mcp_fixture_echo", { text: "signal" }, new AbortController().signal);
      expect(result).toBe("echo:signal");
      expect(manager.tools().map((tool) => tool.name)).toContain("mcp_fixture_echo");
    } finally {
      await manager.closeAll();
    }
  });

  it("reports a failed startup instead of leaving a half-connected server", async () => {
    const config: McpServerConfig = { id: "bad", name: "Bad", command: "definitely-not-an-executable", args: [], enabled: true };
    const manager = new McpManager(() => [config]);
    const status = await manager.connect(config);
    expect(status.state).toBe("failed");
    expect(status.error).toBeTruthy();
    expect(manager.tools()).toEqual([]);
    await manager.closeAll();
  });
});
