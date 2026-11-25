import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
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

interface Body {
  messages: Array<{ role: string; content: string; tool_calls?: unknown }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
}

async function harness(options: { taskCount?: number; failBrief?: string; childDelay?: number; blankBrief?: boolean } = {}) {
  const taskCount = options.taskCount ?? 2;
  const childDelay = options.childDelay ?? 150;
  let inFlight = 0;
  let maxInFlight = 0;
  const childRequests: Body[] = [];
  const parentRequests: Body[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Body;
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const isChild = system.includes("a worker spawned by the lead agent");
      const last = parsed.messages.at(-1);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const finish = (payload: string, delay = 0) => {
        setTimeout(() => {
          inFlight -= 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(payload);
        }, delay);
      };
      if (isChild) {
        childRequests.push(parsed);
        const brief = parsed.messages.at(-1)?.content ?? "";
        if (options.failBrief && brief.includes(options.failBrief)) {
          inFlight -= 1;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "worker exploded" } }));
          return;
        }
        const report = brief.includes("ALPHA") ? "REPORT-ALPHA" : "REPORT-BETA";
        finish(`data: {"choices":[{"delta":{"content":"${report}"}}]}\n\ndata: [DONE]\n\n`, childDelay);
        return;
      }
      parentRequests.push(parsed);
      if (last?.role === "tool") {
        finish('data: {"choices":[{"delta":{"content":"army complete"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      const tasks = Array.from({ length: taskCount }, (_, index) => ({
        name: index === 0 ? "ALPHA" : `BETA-${index}`,
        role: "probe",
        brief: options.blankBrief && index === 0
          ? ""
          : index === 1 && options.failBrief
            ? `${options.failBrief} task: this one must fail`
            : index === 0 ? "ALPHA task: enumerate the target" : `BETA task ${index}: check surface ${index}`,
      }));
      const args = JSON.stringify({ tasks });
      finish(`data: {"choices":[{"delta":{"content":"Dispatching the army.","tool_calls":[{"index":0,"id":"call-spawn","type":"function","function":{"name":"agent_spawn","arguments":${JSON.stringify(args)}}}]}}]}\n\ndata: [DONE]\n\n`, 30);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const directory = await mkdtemp(path.join(tmpdir(), "openhack-spawn-"));
  const config = await ConfigStore.open(directory, cipher);
  await config.updateProvider({
    id: "mock", name: "Mock", baseURL: `http://127.0.0.1:${address.port}/v1`,
    models: [{ id: "m", name: "M", tools: true }],
    maxTokensField: "max_tokens", headerTimeoutMs: 30000, chunkTimeoutMs: 30000,
  });
  await config.updateSettings({ lastWorkspace: directory, activeProviderId: "mock", activeModel: "m" });
  const sessions = await SessionStore.open(directory);
  const session = await sessions.createSession({ workspacePath: directory, providerId: "mock", model: "m" });
  const pushes: Array<Record<string, unknown>> = [];
  let service!: AgentService;
  service = new AgentService(config, sessions, new McpManager(() => []), new PluginManager(path.join(directory, "plugins"), config), (payload) => {
    const value = payload as { kind?: string; event?: { type?: string; approvalId?: string } };
    pushes.push(value as Record<string, unknown>);
    if (value.kind === "agent.event" && value.event?.type === "tool.approval" && value.event.approvalId) {
      const approvalId = value.event.approvalId;
      setTimeout(() => service.decideApproval(approvalId, true), 5);
    }
  });
  return { service, sessions, session, childRequests, parentRequests, pushes, getMaxInFlight: () => maxInFlight };
}

async function waitFor(check: () => boolean, timeout = 15000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("dynamic subagent spawn", () => {
  it("fans out parallel workers inside the same session and aggregates their reports", async () => {
    const { service, sessions, session, childRequests, parentRequests, pushes, getMaxInFlight } = await harness({ taskCount: 2 });
    service.start({ sessionId: session.id, input: "spawn-please map the target" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 20000);

    const stored = sessions.getSession(session.id);
    const workers = (stored?.messages ?? []).filter((message) => message.agentName);
    expect(workers.map((message) => message.agentName)).toEqual(["ALPHA", "BETA-1"]);
    expect(workers.map((message) => message.content)).toEqual(["REPORT-ALPHA", "REPORT-BETA"]);
    expect(workers.every((message) => message.agentRole === "probe")).toBe(true);

    expect(getMaxInFlight()).toBeGreaterThanOrEqual(2);
    expect(sessions.listSessions("chat")).toHaveLength(1);
    expect(sessions.listSessions("bus")).toHaveLength(0);

    const toolResult = (stored?.messages ?? []).find((message) => message.role === "tool" && message.name === "agent_spawn");
    expect(toolResult?.content).toContain("\"completed\":2");
    expect(toolResult?.content).toContain("REPORT-ALPHA");
    expect(stored?.messages.at(-1)?.content).toBe("army complete");

    // Workers must not be able to spawn their own army.
    for (const request of childRequests) {
      const names = (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
      expect(names).not.toContain("agent_spawn");
    }
    expect(parentRequests.length).toBeGreaterThanOrEqual(2);
    expect(pushes.some((push) => (push.event as { type?: string })?.type === "subagent.completed")).toBe(true);
  });

  it("reports a failed worker without losing the rest of the army", async () => {
    const { service, sessions, session, pushes } = await harness({ taskCount: 2, failBrief: "FAIL" });
    service.start({ sessionId: session.id, input: "spawn-please mixed" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 20000);
    const stored = sessions.getSession(session.id);
    const raw = (stored?.messages ?? []).find((message) => message.role === "tool" && message.name === "agent_spawn")?.content ?? "{}";
    const result = JSON.parse(raw) as { completed?: number; failed?: number; workers?: Array<{ status: string }> };
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.workers?.some((worker) => worker.status === "failed")).toBe(true);
    expect(stored?.messages.some((message) => message.agentName === "BETA-1" && message.content.includes("Worker failed"))).toBe(true);
    expect(pushes.some((push) => {
      const event = push.event as { type?: string; status?: string };
      return event?.type === "subagent.completed" && event.status === "failed";
    })).toBe(true);
  });

  it("aborts every worker when the parent run is cancelled", async () => {
    const { service, sessions, session, pushes } = await harness({ taskCount: 2, childDelay: 3000 });
    const { runId } = service.start({ sessionId: session.id, input: "spawn-please slow" });
    await waitFor(() => pushes.some((push) => (push.event as { type?: string })?.type === "subagent.started"), 5000);
    expect(service.cancel(runId)).toBe(true);
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 10000);
    const statuses = pushes
      .map((push) => push.event as { type?: string; status?: string })
      .filter((event) => event?.type === "subagent.completed")
      .map((event) => event.status);
    expect(statuses.sort()).toEqual(["cancelled", "cancelled"]);
    const stored = sessions.getSession(session.id);
    expect(stored?.messages.some((message) => message.content.includes("Worker failed"))).toBe(false);
  });

  it("refuses to exceed the per-session worker cap", async () => {
    const { service, sessions, session, pushes } = await harness({ taskCount: 5 });
    for (let index = 0; index < 20; index += 1) {
      await sessions.appendMessage(session.id, { role: "assistant", content: `earlier ${index}`, agentId: `old-${index}`, agentName: `OLD-${index}` });
    }
    expect(sessions.countSessionWorkers(session.id)).toBe(20);
    service.start({ sessionId: session.id, input: "spawn-please overflow" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 20000);
    const failedEvent = pushes.find((push) => (push.event as { type?: string })?.type === "tool.failed");
    expect(JSON.stringify(failedEvent)).toContain("cap is 24");
  });

  it("queues workers beyond the pool limit and still finishes the whole batch", async () => {
    const { service, sessions, session, pushes, getMaxInFlight } = await harness({ taskCount: 8, childDelay: 120 });
    service.start({ sessionId: session.id, input: "spawn-please eight" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 25000);
    const stored = sessions.getSession(session.id);
    const raw = (stored?.messages ?? []).find((message) => message.role === "tool" && message.name === "agent_spawn")?.content ?? "{}";
    const result = JSON.parse(raw) as { completed?: number };
    expect(result.completed).toBe(8);
    expect(getMaxInFlight()).toBeLessThanOrEqual(6);
    expect(getMaxInFlight()).toBeGreaterThanOrEqual(6);
  });

  it("rejects a task with no brief before any worker starts", async () => {
    const { service, sessions, session, childRequests, pushes } = await harness({ taskCount: 1, blankBrief: true });
    service.start({ sessionId: session.id, input: "spawn-please empty" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 20000);
    expect(childRequests).toHaveLength(0);
    const failed = pushes.find((push) => (push.event as { type?: string })?.type === "tool.failed");
    expect(JSON.stringify(failed)).toContain("missing a brief");
  });

  it("rejects an oversized batch without starting any worker", async () => {
    const { service, sessions, session, childRequests, pushes } = await harness({ taskCount: 9 });
    service.start({ sessionId: session.id, input: "spawn-please too many" });
    await waitFor(() => pushes.some((push) => push.kind === "run.finished"), 20000);
    expect(childRequests).toHaveLength(0);
    expect(pushes.some((push) => (push.event as { type?: string })?.type === "tool.failed")).toBe(true);
    const stored = sessions.getSession(session.id);
    expect(stored?.messages.some((message) => message.agentName)).toBe(false);
  });
});
