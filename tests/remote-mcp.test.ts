import { describe, expect, it } from "vitest";
import { importOpenCodeMcp } from "../src/main/config/opencode";
import { McpManager } from "../src/main/mcp/manager";

const config = JSON.stringify({
  mcp: {
    servers: {
      rea: { type: "local", command: ["node", "rea.mjs", "mcp"] },
      tinyfish: { type: "remote", url: "https://agent.tinyfish.ai/mcp" },
      zap: { type: "remote", url: "http://127.0.0.1:8282", headers: { Authorization: "Bearer secret" } },
      broken: { type: "remote", url: "not-a-url" },
    },
  },
});

describe("remote MCP import", () => {
  it("keeps remote servers with their URL and headers", () => {
    const { servers, skipped } = importOpenCodeMcp(config);
    const byId = Object.fromEntries(servers.map((server) => [server.id, server]));
    expect(byId.rea?.command).toBe("node");
    expect(byId.tinyfish).toMatchObject({ url: "https://agent.tinyfish.ai/mcp", enabled: true });
    expect(byId.zap?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(byId.zap?.command).toBeUndefined();
    expect(skipped).toContain("broken (invalid remote url)");
  });
});

// Opt-in: contacts a real remote MCP endpoint. OPENHACK_LIVE_MCP=1 to run.
const live = process.env.OPENHACK_LIVE_MCP === "1" ? it : it.skip;

describe("HTTP transport", () => {
  live("connects to a remote MCP server and lists its tools", async () => {
    const manager = new McpManager(() => []);
    const status = await manager.connect({
      id: "tinyfish",
      name: "TinyFish",
      url: "https://agent.tinyfish.ai/mcp",
      headers: { "x-tinyfish-access-mode": "keyless" },
      enabled: true,
    });
    expect(status.state, status.error).toBe("ready");
    // The keyless tier exposes a single tool; the 43-tool catalog belongs to
    // the CLI's authenticated session. What matters here is the transport.
    expect(status.tools.length).toBeGreaterThanOrEqual(1);
    expect(status.tools.some((tool) => tool.name.includes("search"))).toBe(true);
    expect(status.tools.every((tool) => tool.name.startsWith("mcp_tinyfish_"))).toBe(true);
    await manager.disconnect("tinyfish");
  }, 60000);

  it("reports a clear error when a remote endpoint is unreachable", async () => {
    const manager = new McpManager(() => []);
    const status = await manager.connect({ id: "dead", name: "Dead", url: "http://127.0.0.1:9/mcp", enabled: true });
    expect(status.state).toBe("failed");
    expect(status.error).toBeTruthy();
  }, 30000);
});
