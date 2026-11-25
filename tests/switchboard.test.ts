import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ModelEvent, ToolDefinition } from "../src/shared/contracts";
import type { ModelProvider, ModelRequest } from "../src/main/providers/types";
import { AgentEngine } from "../src/main/agent/engine";
import { ToolDirectory } from "../src/main/agent/directory";
import { runSwitchboard, switchboardDefinitions } from "../src/main/agent/switchboard";
import { parseSkill, SkillRegistry } from "../src/main/skills/registry";
import { Workspace } from "../src/main/workspace/workspace";

const signal = () => new AbortController().signal;

function fakeTool(name: string, description: string, risk: "read" | "execute" = "execute"): ToolDefinition {
  return { name, description, risk, parameters: { type: "object", properties: { target: { type: "string", description: "target" } } } };
}

describe("tool directory", () => {
  const tools = [
    fakeTool("mcp_rea_inspect_native_binary", "[REA] Inspect a native binary and return sections, imports and protections", "read"),
    fakeTool("mcp_rea_decompile_managed_method", "[REA] Decompile a .NET method to pseudo C", "read"),
    fakeTool("mcp_craft_core_target_open", "[Craft] Open a target for investigation"),
    fakeTool("web_search", "Search the live web", "read"),
  ];

  it("ranks name matches above description matches and reports the backend", () => {
    const directory = new ToolDirectory(tools);
    const hits = directory.search("decompile managed method");
    expect(hits[0]?.name).toBe("mcp_rea_decompile_managed_method");
    expect(hits[0]?.backend).toBe("mcp:rea");
    expect(directory.backends()).toEqual(["builtin", "mcp:craft", "mcp:rea"]);
  });

  it("only surfaces tools that match, and describes one on demand", () => {
    const directory = new ToolDirectory(tools);
    expect(directory.search("zzz nothing matches")).toEqual([]);
    const described = directory.describe("mcp_rea_inspect_native_binary");
    expect(described?.risk).toBe("read");
    expect(JSON.stringify(described?.parameters)).toContain("target");
    expect(directory.risk("mcp_rea_decompile_managed_method")).toBe("read");
    expect(directory.risk("nope")).toBeUndefined();
    expect(directory.schemaBytes()).toBeGreaterThan(0);
  });

  it("uses the server label when the caller supplies one", () => {
    const labelled = new ToolDirectory(tools, (tool) => {
      const tag = /^\[([^\]]+)\]/.exec(tool.description ?? "");
      return tag ? `mcp:${tag[1]}` : "external";
    });
    expect(labelled.search("decompile")[0]?.backend).toBe("mcp:REA");
  });

  it("counts every tool while keeping summaries short", () => {
    const directory = new ToolDirectory(tools);
    expect(directory.size).toBe(4);
    for (const hit of directory.search("inspect binary craft web", 12)) expect(hit.summary.length).toBeLessThanOrEqual(160);
  });
});

describe("switchboard verbs", () => {
  const directory = new ToolDirectory([
    fakeTool("mcp_rea_inspect_native_binary", "[REA] Inspect a native binary", "read"),
    fakeTool("mcp_rea_annotate_native_function", "[REA] Rename and comment a native function", "execute"),
  ]);

  it("searches, describes and refuses an unknown name", async () => {
    const searched = JSON.parse(await runSwitchboard("tool_search", { query: "inspect native binary" }, { directory, callTool: async () => "" }));
    expect(searched.tools[0].name).toBe("mcp_rea_inspect_native_binary");
    expect(searched.indexed).toBe(2);

    const described = JSON.parse(await runSwitchboard("tool_describe", { name: "mcp_rea_annotate_native_function" }, { directory, callTool: async () => "" }));
    expect(described.risk).toBe("execute");

    await expect(runSwitchboard("tool_describe", { name: "ghost" }, { directory, callTool: async () => "" })).rejects.toThrow(/Unknown tool/u);
  });

  it("forwards a routed call with its arguments and refuses an unindexed tool", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const result = await runSwitchboard("tool_call", { name: "mcp_rea_inspect_native_binary", arguments: { target: "a.exe" } }, {
      directory,
      callTool: async (name, args) => { calls.push({ name, args }); return "{\"ok\":true}"; },
    });
    expect(result).toBe("{\"ok\":true}");
    expect(calls).toEqual([{ name: "mcp_rea_inspect_native_binary", args: { target: "a.exe" } }]);
    await expect(runSwitchboard("tool_call", { name: "not_indexed" }, { directory, callTool: async () => "" })).rejects.toThrow(/Unknown tool/u);
  });

  it("exposes five verbs and nothing else", () => {
    expect(switchboardDefinitions().map((tool) => tool.name).sort()).toEqual(["skill_load", "skill_search", "tool_call", "tool_describe", "tool_search"]);
  });
});

describe("skills", () => {
  async function registryWith(files: Record<string, string>): Promise<SkillRegistry> {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-skills-"));
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "SKILL.md"), body);
    }
    return SkillRegistry.load([root]);
  }

  const recon = `---\nname: web-recon\ndescription: Map a web target surface before touching it.\n---\n\n# Steps\n1. Scope.\n`;
  const api = `---\nname: api-testing\ndescription: Find broken object authorization in JSON APIs.\n---\n\n# Steps\n1. Swap ids.\n`;

  it("indexes frontmatter and loads a body only on demand", async () => {
    const registry = await registryWith({ a: recon, b: api });
    expect(registry.size).toBe(2);
    expect(registry.indexText()).toContain("web-recon: Map a web target");
    expect(registry.indexText()).not.toContain("Swap ids");
    expect(registry.search("api authorization")[0]?.name).toBe("api-testing");
    expect(registry.load("web-recon")?.body).toContain("1. Scope.");
  });

  it("rejects a skill without a description and keeps the first duplicate", async () => {
    expect(parseSkill("---\nname: x\n---\nbody", "x")).toBeUndefined();
    expect(parseSkill("no frontmatter", "x")).toBeUndefined();
    const registry = await registryWith({ a: recon, b: recon.replace("Map a web target surface", "duplicate") });
    expect(registry.size).toBe(1);
  });

  it("returns a note instead of throwing when no skills are installed", async () => {
    const empty = await registryWith({});
    const result = JSON.parse(await runSwitchboard("skill_search", { query: "recon" }, { skills: empty, callTool: async () => "" }));
    expect(result.found).toBe(0);
    expect(result.note).toContain("No skills");
  });
});

describe("engine with the switchboard", () => {
  /** Emits tool_search, then tool_call for the hidden tool, then a final answer. */
  function scriptedProvider(seen: ModelRequest[], steps: ModelEvent[][]): ModelProvider {
    let index = 0;
    return {
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        seen.push(request);
        const step = steps[Math.min(index, steps.length - 1)]!;
        index += 1;
        for (const event of step) yield event;
      },
    };
  }

  const hidden = Array.from({ length: 150 }, (_, i) =>
    fakeTool(`mcp_rea_tool_${i}`, `[REA] Hidden capability number ${i} that would cost schema tokens`, "read"));

  it("keeps 150 MCP tools out of the prompt and still reaches one", async () => {
    const seen: ModelRequest[] = [];
    const dispatched: string[] = [];
    const provider = scriptedProvider(seen, [
      [{ type: "tool.completed", callId: "c1", name: "tool_search", argumentsJson: JSON.stringify({ query: "hidden capability 7" }) }, { type: "finished", reason: "tool_calls" }],
      [{ type: "tool.completed", callId: "c2", name: "tool_call", argumentsJson: JSON.stringify({ name: "mcp_rea_tool_7", arguments: { target: "x" } }) }, { type: "finished", reason: "tool_calls" }],
      [{ type: "text.delta", text: "done" }, { type: "finished", reason: "stop" }],
    ]);
    const engine = new AgentEngine({ permission: "autonomous" });
    const workspace = new Workspace(await mkdtemp(path.join(tmpdir(), "openhack-switch-")));
    const result = await engine.run({
      provider, model: "fake", input: "find something", history: [], workspace, signal: signal(),
      tools: [...hidden, fakeTool("agent_spawn", "Spawn parallel workers")],
      directory: new ToolDirectory(hidden),
      callExternalTool: async (name) => { dispatched.push(name); return "{\"ok\":true,\"tool\":\"" + name + "\"}"; },
    }, () => undefined);

    const exposed = seen[0]!.tools.map((tool) => tool.name);
    expect(exposed).toContain("tool_search");
    expect(exposed).toContain("tool_call");
    expect(exposed).toContain("agent_spawn");
    expect(exposed.some((name) => name.startsWith("mcp_rea_tool_"))).toBe(false);
    expect(JSON.stringify(seen[0]!.tools)).not.toContain("Hidden capability");
    expect(dispatched).toEqual(["mcp_rea_tool_7"]);
    expect(result.text).toBe("done");
  });

  it("refuses a routed call in plan mode when the target mutates", async () => {
    const seen: ModelRequest[] = [];
    const provider = scriptedProvider(seen, [
      [{ type: "tool.completed", callId: "c1", name: "tool_call", argumentsJson: JSON.stringify({ name: "mcp_rea_annotate_native_function" }) }, { type: "finished", reason: "tool_calls" }],
      [{ type: "text.delta", text: "blocked" }, { type: "finished", reason: "stop" }],
    ]);
    const engine = new AgentEngine({ permission: "autonomous" });
    const workspace = new Workspace(await mkdtemp(path.join(tmpdir(), "openhack-plan-")));
    let called = false;
    const events: string[] = [];
    const tools = [fakeTool("mcp_rea_annotate_native_function", "[REA] Rename a native function", "execute")];
    await engine.run({
      provider, model: "fake", input: "rename it", history: [], workspace, signal: signal(), mode: "plan",
      tools, directory: new ToolDirectory(tools),
      callExternalTool: async () => { called = true; return "{}"; },
    }, (event) => { events.push(event.type); });
    expect(called).toBe(false);
    expect(events).toContain("tool.failed");
  });
});

describe("message shape", () => {
  it("keeps tool result messages addressable for the provider", () => {
    const message: ChatMessage = { id: "1", role: "tool", content: "{}", tool_call_id: "c1", name: "tool_call", createdAt: new Date().toISOString() };
    expect(message.tool_call_id).toBe("c1");
  });
});
