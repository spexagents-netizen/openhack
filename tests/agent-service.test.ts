import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/main/agent/service";
import { ConfigStore, type SecretCipher } from "../src/main/config/store";
import { McpManager } from "../src/main/mcp/manager";
import { PluginManager } from "../src/main/plugins/manager";
import { SessionStore } from "../src/main/storage/sessions";

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("AgentService", () => {
  it("persists a full run and pauses on approval before mutating the workspace", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (calls === 1) {
          response.end('data: {"choices":[{"delta":{"content":"Writing.","tool_calls":[{"index":0,"id":"call-write","type":"function","function":{"name":"workspace_write","arguments":"{\\"path\\":\\"nested/proof.txt\\",\\"content\\":\\"service-proof\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
        } else {
          response.end('data: {"choices":[{"delta":{"content":"The proof was persisted."}}]}\n\ndata: [DONE]\n\n');
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-service-"));
    const config = await ConfigStore.open(directory, cipher);
    await config.updateProvider({
      id: "mock",
      name: "Mock",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "model", name: "Model", tools: true }],
      maxTokensField: "max_tokens",
      headerTimeoutMs: 30000,
      chunkTimeoutMs: 30000,
    }, "secret");
    await config.updateSettings({ lastWorkspace: directory, activeProviderId: "mock", activeModel: "model" });
    const sessions = await SessionStore.open(directory);
    const session = await sessions.createSession({ workspacePath: directory, providerId: "mock", model: "model" });
    const mcp = new McpManager(() => []);
    const plugins = new PluginManager(path.join(directory, "plugins"), config);
    const pushes: Array<Record<string, unknown>> = [];
    const approvalIds: string[] = [];
    let service!: AgentService;
    service = new AgentService(config, sessions, mcp, plugins, (payload) => {
      const value = payload as { kind?: string; event?: { type?: string; approvalId?: string }; sessionId?: string };
      pushes.push(value as Record<string, unknown>);
      if (value.kind === "agent.event" && value.event?.type === "tool.approval" && value.event.approvalId) {
        const approvalId = value.event.approvalId;
        approvalIds.push(approvalId);
        setTimeout(() => { expect(service.decideApproval(approvalId, true)).toBe(true); }, 5);
      }
    });
    const { runId } = service.start({ sessionId: session.id, input: "Create a nested proof" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 10000);
    expect(await readFile(path.join(directory, "nested", "proof.txt"), "utf8")).toBe("service-proof");
    const stored = sessions.getSession(session.id);
    expect(stored?.title).toBe("Create a nested proof");
    expect(stored?.messages.some((message) => message.role === "tool" && message.content.includes("proof.txt"))).toBe(true);
    expect(stored?.messages.at(-1)?.content).toBe("The proof was persisted.");
    expect(pushes.some((push) => push.kind === "agent.event" && (push.event as { type?: string }).type === "run.completed")).toBe(true);
    // A consumed approval is a spent capability: replaying the id must fail.
    expect(approvalIds).toHaveLength(1);
    expect(service.decideApproval(approvalIds[0]!, true)).toBe(false);

    const second = service.start({ sessionId: session.id, input: "cancel this run" });
    expect(service.cancel(second.runId)).toBe(true);
    expect(service.decideApproval("missing", false)).toBe(false);
    expect(runId).toBeTruthy();
    service.cancelAll();
    await waitFor(() => pushes.filter((push) => push.kind === "run.finished").length >= 2, 5000);
    await sessions.close();
  });

  it("cancels a run that is waiting on an approval and spends the approval", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-wait","type":"function","function":{"name":"workspace_write","arguments":"{\\"path\\":\\"wait.txt\\",\\"content\\":\\"x\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-approval-cancel-"));
    const config = await ConfigStore.open(directory, cipher);
    await config.updateProvider({
      id: "mock", name: "Mock", baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "model", name: "Model", tools: true }],
      maxTokensField: "max_tokens", headerTimeoutMs: 30000, chunkTimeoutMs: 30000,
    });
    await config.updateSettings({ lastWorkspace: directory, activeProviderId: "mock", activeModel: "model" });
    const sessions = await SessionStore.open(directory);
    const session = await sessions.createSession({ workspacePath: directory, providerId: "mock", model: "model" });
    let approvalId = "";
    const pushes: Array<Record<string, unknown>> = [];
    const service = new AgentService(config, sessions, new McpManager(() => []), new PluginManager(path.join(directory, "plugins"), config), (payload) => {
      const value = payload as { kind?: string; event?: { type?: string; approvalId?: string } };
      pushes.push(value as Record<string, unknown>);
      if (value.kind === "agent.event" && value.event?.type === "tool.approval" && value.event.approvalId) approvalId = value.event.approvalId;
    });
    const { runId } = service.start({ sessionId: session.id, input: "write and wait" });
    await waitFor(() => Boolean(approvalId), 5000);
    expect(service.cancel(runId)).toBe(true);
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 5000);
    expect(service.decideApproval(approvalId, true)).toBe(false);
    await sessions.close();
  });

  it("rejects unknown sessions, providers and models before creating a run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-service-errors-"));
    const config = await ConfigStore.open(directory, cipher);
    const sessions = await SessionStore.open(directory);
    const service = new AgentService(config, sessions, new McpManager(() => []), new PluginManager(path.join(directory, "plugins"), config), () => undefined);
    expect(() => service.start({ sessionId: "missing", input: "x" })).toThrow(/Session/);
    const session = await sessions.createSession({ workspacePath: directory, providerId: "p", model: "m" });
    expect(() => service.start({ sessionId: session.id, input: "x" })).toThrow(/provider/);
    await config.updateProvider({
      id: "p", name: "P", baseURL: "https://example.invalid", models: [{ id: "m", name: "M", tools: true }],
      maxTokensField: "max_tokens", headerTimeoutMs: 1000, chunkTimeoutMs: 1000,
    });
    expect(() => service.start({ sessionId: session.id, input: "" })).toThrow(/empty/);
    expect(() => service.start({ sessionId: session.id, input: "x", model: "other" })).toThrow(/model/);
    await sessions.close();
  });
});

async function waitFor(check: () => boolean, timeout: number): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
