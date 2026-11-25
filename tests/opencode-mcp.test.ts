import { describe, expect, it } from "vitest";
import { importOpenCodeMcp } from "../src/main/config/opencode";

const config = JSON.stringify({
  mcp: {
    servers: {
      rea: {
        type: "local",
        command: ["node", "rea.mjs", "mcp"],
        environment: { JAVA_HOME: "C:/jdk", GHIDRA_INSTALL_DIR: "C:/ghidra" },
      },
      craft: { type: "local", command: ["craft-anything-cli.exe", "mcp"], disabled: false },
      old: { type: "local", command: ["old.exe"], disabled: true },
      tinyfish: { type: "remote", url: "https://agent.tinyfish.ai/mcp" },
      broken: { type: "local", command: [] },
      "bad id!": { type: "local", command: ["x.exe"] },
    },
  },
});

describe("OpenCode MCP import", () => {
  it("keeps stdio servers, preserves env and disabled state", () => {
    const { servers, skipped } = importOpenCodeMcp(config);
    const byId = Object.fromEntries(servers.map((server) => [server.id, server]));
    expect(Object.keys(byId).sort()).toEqual(["craft", "old", "rea", "tinyfish"]);
    expect(byId.rea).toMatchObject({ command: "node", args: ["rea.mjs", "mcp"], enabled: true });
    expect(byId.rea?.env).toEqual({ JAVA_HOME: "C:/jdk", GHIDRA_INSTALL_DIR: "C:/ghidra" });
    expect(byId.craft?.enabled).toBe(true);
    expect(byId.old?.enabled).toBe(false);
    expect(byId.tinyfish).toMatchObject({ url: "https://agent.tinyfish.ai/mcp", enabled: true });
    expect(byId.tinyfish?.command).toBeUndefined();
    expect(skipped).toEqual(expect.arrayContaining(["broken (no command)", "bad id! (unsupported id)"]));
  });

  it("returns nothing when there is no mcp block", () => {
    const { servers, skipped } = importOpenCodeMcp(JSON.stringify({ providers: {} }));
    expect(servers).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("accepts JSON with comments, like the real file", () => {
    const withComments = `{
      // operator note
      "mcp": { "servers": { "rea": { "type": "local", "command": ["node", "rea.mjs"] } } }
    }`;
    const { servers } = importOpenCodeMcp(withComments);
    expect(servers[0]?.id).toBe("rea");
  });
});
