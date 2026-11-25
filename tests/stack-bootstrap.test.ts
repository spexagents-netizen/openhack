import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreset, planStack, type PresetServer } from "../src/main/mcp/bootstrap";

const preset = {
  servers: [
    { id: "rea", name: "REA", tier: "core" as const, run: { command: "npx", args: ["-y", "rea-agents@6.10.1", "mcp"] }, requires: ["npx"] },
    { id: "re-mcp", name: "re-mcp", tier: "re" as const, run: { command: "uvx", args: ["re-mcp-ghidra"] }, requires: ["uvx"] },
    { id: "reva", name: "ReVa", tier: "re" as const, manual: "Ghidra extension", docs: "https://example.test" },
    { id: "burp", name: "Burp", tier: "web" as const, manual: "BApp", requires: ["java"] },
  ] satisfies PresetServer[],
};

const probe = (available: string[]) => async (command: string) => available.includes(command);

describe("stack bootstrap", () => {
  it("adds only entries whose prerequisites exist", async () => {
    const plan = await planStack(preset, [], probe(["npx"]));
    expect(plan.servers.map((server) => server.id)).toEqual(["rea"]);
    expect(plan.report.added).toEqual(["rea"]);
    expect(plan.report.blocked).toEqual([{ id: "re-mcp", requires: ["uvx"] }]);
    expect(plan.report.manual.map((entry) => entry.id)).toEqual(["reva", "burp"]);
  });

  it("leaves an existing server untouched, whatever its state", async () => {
    const plan = await planStack(preset, [{ id: "rea", name: "REA", command: "old", args: [], enabled: false }], probe(["npx", "uvx"]));
    expect(plan.report.existing).toEqual(["rea"]);
    expect(plan.servers.map((server) => server.id)).toEqual(["re-mcp"]);
  });

  it("produces a config the MCP manager can launch", async () => {
    const plan = await planStack(preset, [], probe(["npx", "uvx"]));
    expect(plan.servers[0]).toMatchObject({ id: "rea", command: "npx", enabled: true });
    expect(plan.servers[0]?.args).toEqual(["-y", "rea-agents@6.10.1", "mcp"]);
  });

  it("reads the shipped preset and rejects a malformed one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-preset-"));
    const good = path.join(root, "good.json");
    await writeFile(good, JSON.stringify({ servers: [{ id: "ok", name: "Ok", run: { command: "npx", args: [] } }, { id: "bad id!", name: "x" }] }));
    const parsed = await loadPreset(good);
    expect(parsed.servers.map((entry) => entry.id)).toEqual(["ok"]);

    const bad = path.join(root, "bad.json");
    await writeFile(bad, JSON.stringify({ nope: true }));
    await expect(loadPreset(bad)).rejects.toThrow(/servers/u);

    const shipped = await loadPreset(path.join(process.cwd(), "presets", "mcp-stack.json"));
    expect(shipped.servers.length).toBeGreaterThanOrEqual(6);
    expect(shipped.servers.some((entry) => entry.id === "rea" && entry.run)).toBe(true);
  });
});
