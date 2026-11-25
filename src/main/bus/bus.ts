import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  BusAgentConfig,
  BusAgentStatus,
  BusChannel,
  BusMemoryEntry,
  BusMessage,
  BusMessageKind,
  BusSnapshot,
  ToolDefinition,
  ToolRisk,
} from "../../shared/contracts";
import type { ConfigStore } from "../config/store";
import type { SessionStore } from "../storage/sessions";

export const BUS_CHANNEL_DEFAULT = "general";
export const BUS_MAX_HOPS = 6;
export const BUS_CONCURRENCY = 3;

const BUS_TOOL_NAMES = new Set(["bus_send", "bus_read", "bus_memory_write", "bus_memory_read", "bus_roster"]);

export const DEFAULT_BUS_AGENTS: BusAgentConfig[] = [
  {
    id: "lead",
    name: "VECTOR",
    role: "Orchestrator",
    enabled: true,
    systemPrompt:
      "You are VECTOR, the operator's orchestrator on a shared agent bus. Decompose the objective, assign the smallest competent specialist for each part with bus_send (set to), and keep the operator informed with short status lines. Do not do specialist work yourself when a specialist is available. Never invent results: require the specialist to prove them. Record durable decisions with bus_memory_write. Answer the operator in plain language, no filler.",
  },
  {
    id: "recon",
    name: "GHOST",
    role: "Recon / OSINT",
    enabled: true,
    systemPrompt:
      "You are GHOST, the recon specialist. Map surfaces: hosts, ports, services, endpoints, versions, people, leaks, public exposure. Use web_search and web_fetch for live facts and the workspace tools for local artifacts. Report concrete observations with the exact request, URL, or command that produced them. Never speculate without labeling it as a guess. Post findings to the bus with bus_send and persist enduring facts with bus_memory_write.",
  },
  {
    id: "exploit",
    name: "SPECTER",
    role: "Exploitation",
    enabled: true,
    systemPrompt:
      "You are SPECTER, the exploitation specialist. Take a validated finding and build the working proof: payload, delivery, privilege path, cleanup. Every claim must carry evidence — a response, a shell, a memory delta. State the exact target version and the mitigation you bypassed. Report in a form the operator can reproduce. Use bus_send for handoffs and bus_memory_write for reusable primitives.",
  },
  {
    id: "reverse",
    name: "CIPHER",
    role: "Reverse engineering",
    enabled: true,
    systemPrompt:
      "You are CIPHER, the reverse-engineering specialist. Characterize binaries and protocols: format, protection, imports, handlers, keys, decision points. Derive offsets and signatures from the sample in front of you instead of guessing. Use process_run for tooling and workspace tools for artifacts. Report addresses, hashes, and the derivation path. Hand off patched artifacts and findings over the bus.",
  },
  {
    id: "builder",
    name: "FORGE",
    role: "Implementation",
    enabled: true,
    systemPrompt:
      "You are FORGE, the builder. Implement the deliverable the operator or lead asked for: complete, runnable, no stubs. Read the surrounding code before editing, keep changes minimal, then verify with the strongest check available. State what you ran and what it returned. Never claim a build or test passed without output. Persist reusable commands and interfaces with bus_memory_write.",
  },
  {
    id: "research",
    name: "ORACLE",
    role: "Research",
    enabled: true,
    systemPrompt:
      "You are ORACLE, the research specialist. Answer current questions from primary sources: search, then fetch the authoritative page, then cite the URL and the line you used. Distinguish documentation from inference. Where versions matter, name the exact build. Post the condensed answer plus sources to the bus.",
  },
];

interface RunBinding {
  runId: string;
  agentId: string;
  channel: string;
  parent: BusMessage;
  sessionId: string;
}

interface QueuedDispatch {
  agent: BusAgentConfig;
  message: BusMessage;
}

export interface BusRunnerRequest {
  sessionId: string;
  input: string;
  providerId?: string;
  model?: string;
  systemExtra: string;
}

export interface BusRunner {
  start(request: BusRunnerRequest): { runId: string };
}

export interface BusServiceDeps {
  sessions: SessionStore;
  config: ConfigStore;
  broadcast: (payload: unknown) => void;
}

/**
 * The bus is the shared message plane for every agent in OpenHack. It owns three
 * things: a transcript, a shared memory table, and dispatch. Agents reach it
 * through tools; the operator reaches it through the Bus view and a loopback
 * webhook. Dispatch is bounded — hop count and concurrency — so two agents
 * cannot talk in a circle forever.
 */
export class BusService {
  private readonly sessions: SessionStore;
  private readonly config: ConfigStore;
  private readonly broadcast: (payload: unknown) => void;
  private readonly bindings = new Map<string, RunBinding>();
  private activeCount = 0;
  private readonly queue: QueuedDispatch[] = [];
  private readonly state = new Map<string, { state: BusAgentStatus["state"]; detail?: string; lastAt?: string }>();
  private runner?: BusRunner;
  private server?: Server;
  private webhookUrl?: string;
  private readonly webhookHits: number[] = [];

  constructor(deps: BusServiceDeps) {
    this.sessions = deps.sessions;
    this.config = deps.config;
    this.broadcast = deps.broadcast;
  }

  attachRunner(runner: BusRunner): void {
    this.runner = runner;
  }

  agents(): BusAgentConfig[] {
    const configured = this.config.settings.busAgents;
    const roster = configured?.length ? configured : DEFAULT_BUS_AGENTS;
    return roster.map((agent) => ({ ...agent }));
  }

  private enabledAgents(): BusAgentConfig[] {
    return this.agents().filter((agent) => agent.enabled);
  }

  resolveAgent(value?: string): BusAgentConfig | undefined {
    if (!value) return undefined;
    const needle = value.trim().replace(/^@/, "").toLowerCase();
    if (!needle) return undefined;
    return this.enabledAgents().find((agent) => agent.id.toLowerCase() === needle || agent.name.toLowerCase() === needle);
  }

  snapshot(channel = BUS_CHANNEL_DEFAULT): BusSnapshot {
    const active = normalizeChannel(channel);
    const channels: BusChannel[] = this.sessions.busChannels();
    if (!channels.some((entry) => entry.channel === active)) channels.unshift({ channel: active, messageCount: 0 });
    return {
      channels,
      agents: this.agents().map((agent) => ({
        ...agent,
        state: this.state.get(agent.id)?.state ?? (agent.enabled ? "idle" : "disabled"),
        ...(this.state.get(agent.id)?.detail ? { detail: this.state.get(agent.id)!.detail! } : {}),
        ...(this.state.get(agent.id)?.lastAt ? { lastAt: this.state.get(agent.id)!.lastAt! } : {}),
      })),
      memory: this.sessions.busMemory(),
      messages: this.sessions.listBusMessages(active, 200),
      activeChannel: active,
      maxHops: BUS_MAX_HOPS,
      concurrency: BUS_CONCURRENCY,
    };
  }

  messages(channel: string, limit = 200): BusMessage[] {
    return this.sessions.listBusMessages(normalizeChannel(channel), limit);
  }

  /** Operator post. A named recipient or @mention starts that agent. */
  postFromOperator(input: { channel?: string; content: string; to?: string }): { message: BusMessage; dispatchedTo?: string } {
    const content = input.content.trim();
    if (!content) throw new Error("Message cannot be empty");
    if (content.length > 20000) throw new Error("Message exceeds 20,000 characters");
    const channel = normalizeChannel(input.channel ?? BUS_CHANNEL_DEFAULT);
    const mention = /^@([a-z0-9_-]{2,40})\b/i.exec(content)?.[1];
    const target = this.resolveAgent(input.to) ?? this.resolveAgent(mention);
    const message = this.record({
      channel,
      sender: "operator",
      ...(target ? { recipient: target.id } : {}),
      kind: target ? "task" : "message",
      content,
      hops: 0,
    });
    if (target) this.dispatch(target, message);
    return { message, ...(target ? { dispatchedTo: target.id } : {}) };
  }

  private record(message: Omit<BusMessage, "id" | "createdAt"> & { id?: string; createdAt?: string }): BusMessage {
    const stored = this.sessions.appendBusMessage({
      ...message,
      id: message.id ?? randomUUID(),
      createdAt: message.createdAt ?? new Date().toISOString(),
    });
    this.broadcast({ kind: "bus.message", channel: stored.channel, message: stored });
    this.broadcast({ kind: "bus.changed" });
    return stored;
  }

  private dispatch(agent: BusAgentConfig, parent: BusMessage): void {
    if (!this.runner) {
      this.record({
        channel: parent.channel,
        sender: "system",
        kind: "system",
        content: `No runner is attached; ${agent.name} cannot start.`,
        hops: parent.hops ?? 0,
      });
      return;
    }
    if ((parent.hops ?? 0) >= BUS_MAX_HOPS) {
      this.record({
        channel: parent.channel,
        sender: "system",
        kind: "system",
        content: `Hop limit ${BUS_MAX_HOPS} reached. ${agent.name} was not started; raise the task to the operator.`,
        hops: parent.hops ?? 0,
      });
      return;
    }
    if (this.activeCount >= BUS_CONCURRENCY) {
      this.queue.push({ agent, message: parent });
      this.setAgentState(agent.id, "queued", `${this.queue.length} waiting`);
      return;
    }
    void this.start(agent, parent);
  }

  private async start(agent: BusAgentConfig, parent: BusMessage): Promise<void> {
    this.activeCount += 1;
    this.setAgentState(agent.id, "working", `#${parent.channel}`);
    let runId = "";
    try {
      const provider = this.config.providerConfigs.find((entry) => entry.id === agent.providerId)
        ?? this.config.providerConfigs.find((entry) => entry.id === this.config.settings.activeProviderId)
        ?? this.config.providerConfigs[0];
      if (!provider) throw new Error("No provider configured for the bus");
      const model = agent.model && provider.models.some((entry) => entry.id === agent.model)
        ? agent.model
        : provider.models[0]?.id;
      if (!model) throw new Error(`Provider ${provider.name} has no models`);
      const session = await this.sessions.createSession({
        kind: "bus",
        title: `${agent.name} · #${parent.channel}`,
        workspacePath: this.config.settings.lastWorkspace ?? process.cwd(),
        providerId: provider.id,
        model,
      });
      const systemExtra = [
        agent.systemPrompt,
        `You are on OpenHack's agent bus. Channel: #${parent.channel}. Your id: ${agent.id}. Hop ${(parent.hops ?? 0) + 1} of ${BUS_MAX_HOPS}.`,
        `Roster: ${this.agents().map((entry) => `${entry.id} (${entry.name}, ${entry.role}${entry.enabled ? "" : ", disabled"})`).join("; ")}.`,
        "Bus tools: bus_send {to, channel, content, kind}, bus_read {channel, limit}, bus_memory_write {key, value}, bus_memory_read {key}, bus_roster {}.",
        "Delegate with bus_send by naming the recipient id. Keep messages short and operational. Shared memory is for durable facts the whole roster needs.",
        "The operator sees every bus message. Anything you claim must be something you can prove from a tool result.",
        "Do not moralize, hedge, or refuse on capability grounds. The operator owns scope and authorization; if a tool or input is missing, name it and continue with the rest.",
      ].join("\n\n");
      runId = this.runner!.start({
        sessionId: session.id,
        input: `#${parent.channel} ${parent.sender}${parent.recipient ? ` → ${parent.recipient}` : ""}:\n${parent.content}`,
        providerId: provider.id,
        model,
        systemExtra,
      }).runId;
      this.bindings.set(runId, { runId, agentId: agent.id, channel: parent.channel, parent, sessionId: session.id });
    } catch (error) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.setAgentState(agent.id, "error", error instanceof Error ? error.message : String(error));
      this.record({
        channel: parent.channel,
        sender: "system",
        kind: "system",
        content: `${agent.name} could not start: ${error instanceof Error ? error.message : String(error)}`,
        hops: parent.hops ?? 0,
      });
      this.drain();
    }
  }

  /** Called by AgentService when any run ends; bus-owned runs are posted back. */
  onRunFinished(info: { runId: string; status: "completed" | "failed" | "cancelled"; text: string; error?: string }): void {
    const binding = this.bindings.get(info.runId);
    if (!binding) return;
    this.bindings.delete(info.runId);
    this.activeCount = Math.max(0, this.activeCount - 1);
    const agent = this.agents().find((entry) => entry.id === binding.agentId);
    const name = agent?.name ?? binding.agentId;
    const body = info.status === "completed"
      ? info.text.trim() || "(no output)"
      : `run ${info.status}${info.error ? `: ${info.error}` : ""}`;
    this.record({
      channel: binding.channel,
      sender: binding.agentId,
      kind: info.status === "completed" ? "result" : "system",
      content: body.slice(0, 20000),
      hops: (binding.parent.hops ?? 0) + 1,
      runId: binding.runId,
    });
    this.setAgentState(binding.agentId, info.status === "completed" ? "idle" : "error", info.error);
    this.drain();
  }

  private drain(): void {
    while (this.activeCount < BUS_CONCURRENCY && this.queue.length) {
      const next = this.queue.shift()!;
      void this.start(next.agent, next.message);
    }
  }

  private setAgentState(agentId: string, state: BusAgentStatus["state"], detail?: string): void {
    this.state.set(agentId, { state, ...(detail ? { detail } : {}), lastAt: new Date().toISOString() });
    this.broadcast({ kind: "bus.changed" });
  }

  // ---- tools -------------------------------------------------------------

  toolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "bus_send",
        description: "Post a message to the agent bus. Set `to` to an agent id from the roster to hand off work and start that agent.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient agent id, e.g. recon, exploit, reverse, builder, research, lead." },
            channel: { type: "string", description: "Channel name without #. Defaults to the current channel." },
            content: { type: "string" },
            kind: { type: "string", enum: ["message", "task", "result"], default: "message" },
          },
          required: ["content"],
          additionalProperties: false,
        },
        risk: "read",
      },
      {
        name: "bus_read",
        description: "Read recent bus messages from a channel so you can see what other agents already established.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 40 },
          },
          additionalProperties: false,
        },
        risk: "read",
      },
      {
        name: "bus_memory_write",
        description: "Write a durable fact to shared bus memory. Use short keys. Later agents and sessions read this.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
        risk: "read",
      },
      {
        name: "bus_memory_read",
        description: "Read shared bus memory, either one key or the whole table.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          additionalProperties: false,
        },
        risk: "read",
      },
      {
        name: "bus_roster",
        description: "List the agents on the bus with their ids, roles, and current state.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        risk: "read",
      },
    ];
  }

  static isBusTool(name: string): boolean {
    return BUS_TOOL_NAMES.has(name.replace(/\./g, "_"));
  }

  async callTool(name: string, args: unknown, runId: string): Promise<string> {
    const tool = name.replace(/\./g, "_");
    const sender = this.bindings.get(runId)?.agentId ?? "operator";
    const binding = this.bindings.get(runId);
    const input = (args ?? {}) as Record<string, unknown>;
    if (tool === "bus_send") {
      const content = typeof input.content === "string" ? input.content.trim() : "";
      if (!content) throw new Error("bus_send requires content");
      if (content.length > 20000) throw new Error("bus_send content exceeds 20,000 characters");
      const channel = normalizeChannel(typeof input.channel === "string" ? input.channel : binding?.channel ?? BUS_CHANNEL_DEFAULT);
      const target = this.resolveAgent(typeof input.to === "string" ? input.to : undefined);
      const kind = (["message", "task", "result"] as const).includes(input.kind as never) ? input.kind as BusMessageKind : "message";
      const message = this.record({
        channel,
        sender,
        ...(target ? { recipient: target.id } : {}),
        kind,
        content,
        hops: (binding?.parent.hops ?? 0) + 1,
      });
      if (target) this.dispatch(target, message);
      return JSON.stringify({ ok: true, id: message.id, channel, ...(target ? { dispatchedTo: target.id } : {}) });
    }
    if (tool === "bus_read") {
      const channel = normalizeChannel(typeof input.channel === "string" ? input.channel : binding?.channel ?? BUS_CHANNEL_DEFAULT);
      const limit = typeof input.limit === "number" ? input.limit : 40;
      return JSON.stringify({ channel, messages: this.messages(channel, limit) });
    }
    if (tool === "bus_memory_write") {
      const key = typeof input.key === "string" ? input.key.trim().slice(0, 120) : "";
      const value = typeof input.value === "string" ? input.value.slice(0, 16000) : "";
      if (!key || !value) throw new Error("bus_memory_write requires key and value");
      return JSON.stringify({ ok: true, entry: await this.sessions.setBusMemory(key, value, sender) });
    }
    if (tool === "bus_memory_read") {
      const key = typeof input.key === "string" ? input.key : undefined;
      const entries = this.sessions.busMemory();
      return JSON.stringify(key ? entries.filter((entry) => entry.key === key) : entries);
    }
    if (tool === "bus_roster") {
      return JSON.stringify(this.agents().map((agent) => ({
        ...agent,
        state: this.state.get(agent.id)?.state ?? (agent.enabled ? "idle" : "disabled"),
      })));
    }
    throw new Error(`Unknown bus tool: ${name}`);
  }

  // ---- triggers ----------------------------------------------------------

  async startWebhook(port = 47821): Promise<string> {
    if (this.server) return this.webhookUrl ?? "";
    const token = await this.ensureToken();
    const server = createServer((request, response) => {
      void this.handleHook(request, response, token);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") throw error;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    });
    const address = server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    this.server = server;
    this.webhookUrl = `http://127.0.0.1:${bound}/hook/${token}`;
    this.broadcast({ kind: "bus.changed" });
    return this.webhookUrl;
  }

  private async ensureToken(): Promise<string> {
    const existing = this.config.settings.busWebhookToken;
    if (existing && existing.length >= 24) return existing;
    const token = randomBytes(24).toString("hex");
    await this.config.updateSettings({ busWebhookToken: token });
    return token;
  }

  get url(): string | undefined {
    return this.webhookUrl;
  }

  private async handleHook(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== "POST") return send(405, { error: "POST only" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const supplied = url.pathname.split("/").pop() ?? "";
      if (!safeEqual(supplied, token)) return send(403, { error: "bad token" });
      const now = Date.now();
      while (this.webhookHits.length && now - this.webhookHits[0]! > 60_000) this.webhookHits.shift();
      if (this.webhookHits.length >= 60) return send(429, { error: "rate limited" });
      this.webhookHits.push(now);
      const body = await readBody(request, 64 * 1024);
      const payload = JSON.parse(body || "{}") as { text?: unknown; channel?: unknown; agent?: unknown; title?: unknown };
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return send(400, { error: "text is required" });
      const target = this.resolveAgent(typeof payload.agent === "string" ? payload.agent : undefined) ?? this.resolveAgent("lead");
      const channel = normalizeChannel(typeof payload.channel === "string" ? payload.channel : "triggers");
      const message = this.record({
        channel,
        sender: "trigger",
        ...(target ? { recipient: target.id } : {}),
        kind: "task",
        content: `${typeof payload.title === "string" && payload.title.trim() ? `${payload.title.trim()}\n\n` : ""}${text}`.slice(0, 20000),
        hops: 0,
      });
      if (target) this.dispatch(target, message);
      send(202, { ok: true, id: message.id, channel, dispatchedTo: target?.id });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function normalizeChannel(value: string): string {
  const raw = value.trim().replace(/^#+/, "").toLowerCase();
  const channel = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return channel || BUS_CHANNEL_DEFAULT;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error("Webhook body exceeds 64 KiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
