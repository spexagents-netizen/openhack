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

async function harness() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"continued"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const directory = await mkdtemp(path.join(tmpdir(), "openhack-resume-"));
  const config = await ConfigStore.open(directory, cipher);
  await config.updateProvider({
    id: "mock", name: "Mock", baseURL: `http://127.0.0.1:${address.port}/v1`,
    models: [{ id: "m", name: "M", tools: true }], maxTokensField: "max_tokens",
    headerTimeoutMs: 30000, chunkTimeoutMs: 30000,
  });
  await config.updateSettings({ lastWorkspace: directory, activeProviderId: "mock", activeModel: "m" });
  const sessions = await SessionStore.open(directory);
  const session = await sessions.createSession({ workspacePath: directory, providerId: "mock", model: "m" });
  // Reconstruct the state left by a process that died while waiting for approval:
  // an assistant tool call exists, the tool result does not.
  await sessions.appendMessage(session.id, { id: "assistant-1", role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "workspace_write", arguments: JSON.stringify({ path: "resumed.txt", content: "approved" }) } }] });
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  const service = new AgentService(
    config,
    sessions,
    new McpManager(() => []),
    new PluginManager(path.join(directory, "plugins"), config),
    () => undefined,
    undefined,
    { onRunFinished: () => markFinished() },
  );
  return { service, sessions, session, directory, finished };
}

describe("resumable approvals", () => {
  it("executes the persisted call once and continues the run", async () => {
    const { service, sessions, session, directory, finished } = await harness();
    sessions.saveApproval({
      id: "approval-1",
      sessionId: session.id,
      runId: "dead-run",
      callId: "call-1",
      tool: "workspace_write",
      argumentsJson: JSON.stringify({ path: "resumed.txt", content: "approved" }),
      risk: "write",
      digest: "digest",
      workspace: directory,
      policyVersion: "v",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });
    expect(sessions.pendingApprovals(session.id)).toHaveLength(1);

    const result = await service.resolveApproval("approval-1", true);
    expect(result).toMatchObject({ ok: true, resumed: true });
    await finished;
    expect(await readFile(path.join(directory, "resumed.txt"), "utf8")).toBe("approved");
    expect(sessions.getApproval("approval-1")?.status).toBe("approved");
    expect(sessions.getApproval("approval-1")?.status).not.toBe("pending");

    const stored = sessions.getSession(session.id);
    expect(stored?.messages.some((message) => message.role === "tool" && message.content.includes("resumed.txt"))).toBe(true);
    await sessions.close();
  });

  it("denies without touching the workspace, then refuses a replay", async () => {
    const { service, sessions, session, directory, finished } = await harness();
    sessions.saveApproval({
      id: "approval-2",
      sessionId: session.id,
      runId: "dead-run",
      callId: "call-1",
      tool: "workspace_write",
      argumentsJson: JSON.stringify({ path: "blocked.txt", content: "no" }),
      risk: "write",
      digest: "digest",
      workspace: directory,
      policyVersion: "v",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });
    const result = await service.resolveApproval("approval-2", false);
    expect(result).toMatchObject({ ok: true, resumed: true });
    await finished;
    await expect(readFile(path.join(directory, "blocked.txt"), "utf8")).rejects.toThrow();
    expect(sessions.getApproval("approval-2")?.status).toBe("denied");
    expect((await service.resolveApproval("approval-2", true)).ok).toBe(false);
    await sessions.close();
  });

  it("expires stale approvals instead of resuming them", async () => {
    const { service, sessions, session, directory } = await harness();
    sessions.saveApproval({
      id: "approval-3",
      sessionId: session.id,
      runId: "dead-run",
      callId: "call-1",
      tool: "workspace_write",
      argumentsJson: JSON.stringify({ path: "late.txt", content: "no" }),
      risk: "write",
      digest: "digest",
      workspace: directory,
      policyVersion: "v",
      issuedAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: "pending",
    });
    expect(await sessions.expireApprovals()).toBeGreaterThanOrEqual(1);
    expect(sessions.getApproval("approval-3")?.status).toBe("expired");
    expect((await service.resolveApproval("approval-3", true)).ok).toBe(false);
    await sessions.close();
  });
});
