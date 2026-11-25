import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUS_MAX_HOPS, BusService, DEFAULT_BUS_AGENTS, type BusRunnerRequest } from "../src/main/bus/bus";
import { ConfigStore, type SecretCipher } from "../src/main/config/store";
import { SessionStore } from "../src/main/storage/sessions";

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};

const closers: Array<() => Promise<void>> = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
// Bus dispatch is asynchronous, so tests wait for the observable state rather
// than assuming one sleep is enough under coverage instrumentation.
const until = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await tick();
  return predicate();
};
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "openhack-bus-"));
  const config = await ConfigStore.open(directory, cipher);
  await config.updateProvider({
    id: "mock", name: "Mock", baseURL: "https://example.invalid",
    models: [{ id: "m", name: "M", tools: true }],
    maxTokensField: "max_tokens", headerTimeoutMs: 1000, chunkTimeoutMs: 1000,
  });
  await config.updateSettings({ lastWorkspace: directory, activeProviderId: "mock", activeModel: "m" });
  const sessions = await SessionStore.open(directory);
  const pushes: Array<Record<string, unknown>> = [];
  const bus = new BusService({ sessions, config, broadcast: (payload) => pushes.push(payload as Record<string, unknown>) });
  const runs: Array<BusRunnerRequest & { runId: string }> = [];
  bus.attachRunner({
    start: (request) => {
      const runId = `run-${runs.length + 1}`;
      runs.push({ ...request, runId });
      return { runId };
    },
  });
  closers.push(async () => { await bus.close(); await sessions.close(); });
  return { bus, sessions, config, runs, pushes };
}

describe("BusService", () => {
  it("dispatches an operator task to a specialist and posts the result back", async () => {
    const { bus, runs, sessions } = await harness();
    const posted = bus.postFromOperator({ channel: "op", content: "@ghost map the target", to: "recon" });
    expect(posted.dispatchedTo).toBe("recon");
    await tick();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(runs[0]?.systemExtra).toContain("You are GHOST");
    expect(runs[0]?.input).toContain("#op operator → recon");

    const status = bus.snapshot("op").agents.find((agent) => agent.id === "recon");
    expect(status?.state).toBe("working");

    bus.onRunFinished({ runId: runs[0]!.runId, status: "completed", text: "two hosts, ports 22 and 443" });
    const messages = bus.messages("op");
    expect(messages.map((message) => message.sender)).toEqual(["operator", "recon"]);
    expect(messages[1]).toMatchObject({ kind: "result", hops: 1 });
    expect(messages[1]?.content).toContain("443");
    expect(bus.snapshot("op").agents.find((agent) => agent.id === "recon")?.state).toBe("idle");

    const stored = sessions.listSessions("bus");
    expect(stored[0]?.kind).toBe("bus");
    expect(sessions.listSessions("chat")).toHaveLength(0);
  });

  it("shares memory, exposes the roster, and refuses to loop past the hop limit", async () => {
    const { bus, runs } = await harness();
    const posted = bus.postFromOperator({ channel: "op", content: "start", to: "lead" });
    expect(posted.dispatchedTo).toBe("lead");
    await until(() => runs.length > 0);

    const write = JSON.parse(await bus.callTool("bus_memory_write", { key: "target", value: "10.0.0.5" }, runs[0]!.runId)) as { entry: { value: string } };
    expect(write.entry.value).toBe("10.0.0.5");
    const memory = JSON.parse(await bus.callTool("bus_memory_read", { key: "target" }, runs[0]!.runId)) as Array<{ key: string; updatedBy: string }>;
    expect(memory[0]).toMatchObject({ key: "target", updatedBy: "lead" });

    const roster = JSON.parse(await bus.callTool("bus_roster", {}, runs[0]!.runId)) as Array<{ id: string; state: string }>;
    expect(roster.map((agent) => agent.id)).toEqual(DEFAULT_BUS_AGENTS.map((agent) => agent.id));

    let currentRun = runs[0]!.runId;
    for (let hop = 0; hop < BUS_MAX_HOPS + 2; hop += 1) {
      const before = runs.length;
      const result = JSON.parse(await bus.callTool("bus_send", { to: "recon", content: `hop ${hop}` }, currentRun)) as { ok?: boolean };
      // A refused send never starts a run; only wait when dispatch was accepted.
      if (!result.ok) break;
      // A dispatched run starts in tens of milliseconds. A longer wait means the
      // send was queued behind the barrier, so stop rather than stall the suite.
      await until(() => runs.length > before, 800);
      const started = runs.length > before ? runs.at(-1) : undefined;
      if (!started) break;
      bus.onRunFinished({ runId: currentRun, status: "completed", text: `hop ${hop} done` });
      currentRun = started.runId;
    }
    // Release the last dispatched run so shutdown is not left waiting on it.
    bus.onRunFinished({ runId: currentRun, status: "completed", text: "final" });
    const channel = bus.messages("op");
    expect(channel.some((message) => message.sender === "system" && message.content.includes("Hop limit"))).toBe(true);
    expect(runs.length).toBeLessThanOrEqual(BUS_MAX_HOPS + 1);
  });

  it("queues beyond the concurrency limit and drains on completion", async () => {
    const { bus, runs } = await harness();
    for (const id of ["lead", "recon", "exploit", "reverse"]) {
      bus.postFromOperator({ channel: "load", content: `task for ${id}`, to: id });
    }
    // A repeat dispatch to the same agent still consumes a slot; the cap counts
    // runs, not distinct agent ids.
    bus.postFromOperator({ channel: "load", content: "second recon task", to: "recon" });
    await tick();
    expect(runs).toHaveLength(3);
    const queued = bus.snapshot("load").agents.filter((agent) => agent.state === "queued");
    expect(queued.map((agent) => agent.id).sort()).toEqual(["recon", "reverse"]);

    bus.onRunFinished({ runId: runs[0]!.runId, status: "completed", text: "done" });
    await until(() => runs.length >= 4);
    expect(runs).toHaveLength(4);
    expect(bus.snapshot("load").agents.find((agent) => agent.id === "reverse")?.state).toBe("working");
  });

  it("wakes the bus from a loopback webhook and rejects a bad token", async () => {
    const { bus, runs } = await harness();
    const url = await bus.startWebhook(0);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{48}$/);

    const denied = await fetch(url.replace(/[0-9a-f]{48}$/, "0".repeat(48)), {
      method: "POST",
      body: JSON.stringify({ text: "nope" }),
    });
    expect(denied.status).toBe(403);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "GitHub issue #12", text: "new RCE report", agent: "research", channel: "triggers" }),
    });
    expect(accepted.status).toBe(202);
    await until(() => runs.length > 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toContain("new RCE report");
    const messages = bus.messages("triggers");
    expect(messages[0]).toMatchObject({ sender: "trigger", kind: "task", recipient: "research" });

    const bad = await fetch(url, { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });
});
