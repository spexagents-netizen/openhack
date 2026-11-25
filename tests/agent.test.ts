import { createServer } from "node:http";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../src/main/agent/engine";
import { OpenAICompatibleProvider } from "../src/main/providers/openai-compatible";
import { Workspace } from "../src/main/workspace/workspace";

const servers = new Set<ReturnType<typeof createServer>>();
afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
});

describe("AgentEngine integration", () => {
  it("streams a model tool call, executes it in the workspace and returns the final answer", async () => {
    const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests.length === 1) {
          response.write('data: {"choices":[{"delta":{"reasoning_content":"checking the workspace first"}}]}\n\n');
          response.write('data: {"choices":[{"delta":{"content":"I will create the note.","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"workspace.write","arguments":"{\\"path\\":\\"result.txt\\",\\"content\\":\\"verified\\"}"}}]}}]}\n\n');
          response.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
        } else {
          response.write('data: {"choices":[{"delta":{"content":"Created and verified."}}]}\n\ndata: [DONE]\n\n');
        }
        response.end();
      });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock address");
    const provider = new OpenAICompatibleProvider({
      id: "mock",
      name: "Mock",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "not-logged",
      models: [{ id: "mock-model", name: "Mock model", tools: true }],
      maxTokensField: "max_tokens",
      headerTimeoutMs: 30000,
      chunkTimeoutMs: 30000,
    });
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhack-agent-")));
    const events: Array<{ type: string }> = [];
    const engine = new AgentEngine({ permission: "workspace" });
    const result = await engine.run({
      provider,
      model: "mock-model",
      input: "Create result.txt",
      history: [],
      workspace: new Workspace(root),
      signal: new AbortController().signal,
    }, (event) => { events.push(event); });

    expect(result.text).toBe("Created and verified.");
    expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe("verified");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", name: "workspace.write" }));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content?.includes("result.txt"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("not-logged");
  });

  it("keeps the workspace untouched when the operator denies a write", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (calls === 1) response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"denied","function":{"name":"workspace_write","arguments":"{\\"path\\":\\"denied.txt\\",\\"content\\":\\"no\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
        else response.end('data: {"choices":[{"delta":{"content":"Write denied; workspace unchanged."}}]}\n\ndata: [DONE]\n\n');
      });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhack-denied-")));
    const provider = new OpenAICompatibleProvider({
      id: "mock", name: "Mock", baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "model", name: "Model", tools: true }], maxTokensField: "max_tokens",
      headerTimeoutMs: 30000, chunkTimeoutMs: 30000,
    });
    const events: string[] = [];
    const engine = new AgentEngine({ permission: "supervised", requestApproval: async () => false });
    const result = await engine.run({
      provider, model: "model", input: "Write", history: [], workspace: new Workspace(root),
      signal: new AbortController().signal,
    }, (event) => { events.push(event.type); });
    expect(result.text).toContain("unchanged");
    expect(events).toContain("tool.failed");
    await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps running past the retired 32-step ceiling until the model answers", async () => {
    let calls = 0;
    const rounds = 40;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (calls <= rounds) {
          const args = JSON.stringify({ path: "trace.txt", content: `step ${calls}\n` });
          const payload = {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `call-${calls}`,
                  type: "function",
                  function: { name: "workspace.write", arguments: args },
                }],
              },
            }],
          };
          response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        } else {
          response.end('data: {"choices":[{"delta":{"content":"Finished after the full trace."}}]}\n\ndata: [DONE]\n\n');
        }
      });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhack-unbounded-")));
    const provider = new OpenAICompatibleProvider({
      id: "mock", name: "Mock", baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "model", name: "Model", tools: true }], maxTokensField: "max_tokens",
      headerTimeoutMs: 30000, chunkTimeoutMs: 30000,
    });
    const engine = new AgentEngine({ permission: "autonomous" });
    const result = await engine.run({
      provider, model: "model", input: "loop until done", history: [], workspace: new Workspace(root),
      signal: new AbortController().signal,
    }, () => undefined);
    expect(calls).toBe(rounds + 1);
    expect(result.text).toContain("Finished after the full trace");
    expect(await readFile(path.join(root, "trace.txt"), "utf8")).toContain("step 40");
  });
});
