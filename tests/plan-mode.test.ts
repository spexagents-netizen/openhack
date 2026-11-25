import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/main/agent/engine";
import type { ModelProvider, ModelRequest } from "../src/main/providers/types";
import type { AgentEvent, ModelEvent, ToolDefinition } from "../src/shared/contracts";
import { Workspace } from "../src/main/workspace/workspace";

class FakeProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: ModelEvent[][]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const events = this.script.shift() ?? [
      { type: "text.delta" as const, text: "final" },
      { type: "finished" as const, reason: "stop" as const },
    ];
    for (const event of events) yield event;
  }
}

const writeCall: ModelEvent[] = [
  {
    type: "tool.completed",
    callId: "call-write",
    name: "workspace.write",
    argumentsJson: JSON.stringify({ path: "proof.txt", content: "written" }),
  },
  { type: "finished", reason: "tool_calls" },
];

describe("plan mode", () => {
  it("removes mutating tools from the request and refuses them if the model asks anyway", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-plan-"));
    const provider = new FakeProvider([writeCall]);
    const events: AgentEvent[] = [];
    const engine = new AgentEngine({ permission: "autonomous" });
    const result = await engine.run({
      provider,
      model: "m",
      input: "write proof.txt",
      history: [],
      workspace: new Workspace(root),
      signal: new AbortController().signal,
      mode: "plan",
    }, (event) => events.push(event));

    const tools = provider.requests[0]?.tools ?? [];
    const names = tools.map((tool: ToolDefinition) => tool.name);
    expect(names).toContain("workspace_read");
    expect(names).toContain("web_search");
    expect(names).not.toContain("workspace_write");
    expect(names).not.toContain("process_run");
    expect(names).not.toContain("agent_spawn");

    expect(events).toContainEqual(expect.objectContaining({ type: "tool.failed", name: "workspace.write" }));
    expect(JSON.stringify(events)).toContain("Plan mode is read-only");
    await expect(readFile(path.join(root, "proof.txt"), "utf8")).rejects.toThrow();
    expect(result.text).toBe("final");
  });

  it("executes the same call when the session is in act mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-act-"));
    const provider = new FakeProvider([writeCall]);
    const engine = new AgentEngine({ permission: "autonomous" });
    await engine.run({
      provider,
      model: "m",
      input: "write proof.txt",
      history: [],
      workspace: new Workspace(root),
      signal: new AbortController().signal,
      mode: "act",
    }, () => undefined);
    expect(await readFile(path.join(root, "proof.txt"), "utf8")).toBe("written");
    expect((provider.requests[0]?.tools ?? []).map((tool) => tool.name)).toContain("workspace_write");
  });
});
