import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ApprovalRequest,
  ChatMessage,
  ProviderConfig,
  ProviderToolCall,
  SpawnWorkerResult,
  ToolDefinition,
} from "../../shared/contracts";
import type { ConfigStore } from "../config/store";
import type { McpManager } from "../mcp/manager";
import type { PluginManager } from "../plugins/manager";
import type { SessionStore } from "../storage/sessions";
import { Workspace } from "../workspace/workspace";
import { OpenAICompatibleProvider } from "../providers/openai-compatible";
import { AgentEngine, type ApprovalPrompt } from "./engine";
import { createWebRuntime } from "../web";
import { BusService } from "../bus/bus";
import { ApprovalGate, hashArguments } from "../security/approval";
import { executeBuiltinTool } from "./builtin-tools";
import { compactHistory } from "./compaction";
import { ToolDirectory } from "./directory";
import type { SkillRegistry } from "../skills/registry";
import type { AuditLog } from "../security/audit";
import type { CheckpointStore } from "../checkpoints/store";

interface ActiveRun {
  runId: string;
  sessionId: string;
  controller: AbortController;
}

interface PendingApproval {
  request: ApprovalRequest;
  runId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MessageState {
  content: string;
  reasoning: string;
  calls: ProviderToolCall[];
}

export interface StartRunInput {
  sessionId: string;
  input: string;
  providerId?: string;
  model?: string;
  /** Extra system instruction appended after the global prompt (bus personas). */
  systemExtra?: string;
}

export interface RunOutcome {
  runId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
}

export interface AgentHooks {
  onRunFinished?: (outcome: RunOutcome) => void;
}

export interface AgentServiceOptions {
  gate?: ApprovalGate;
  audit?: AuditLog;
  policyVersion?: string;
  checkpoints?: CheckpointStore;
  skills?: SkillRegistry;
}

export class AgentService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly workerPool = new Semaphore(6);
  private readonly gate: ApprovalGate;
  private readonly audit?: AuditLog;
  private readonly checkpoints?: CheckpointStore;
  private readonly skills?: SkillRegistry;

  constructor(
    private readonly config: ConfigStore,
    private readonly sessions: SessionStore,
    private readonly mcp: McpManager,
    private readonly plugins: PluginManager,
    private readonly broadcast: (payload: unknown) => void,
    private readonly bus?: BusService,
    private readonly hooks: AgentHooks = {},
    options: AgentServiceOptions = {},
  ) {
    this.gate = options.gate ?? new ApprovalGate(options.policyVersion ?? "openhack-0.1");
    this.audit = options.audit;
    this.checkpoints = options.checkpoints;
    this.skills = options.skills;
  }

  start(input: StartRunInput): { runId: string } {
    if (!input.input.trim()) throw new Error("Prompt cannot be empty");
    if (input.input.length > 200000) throw new Error("Prompt exceeds 200,000 characters");
    const session = this.sessions.getSession(input.sessionId);
    if (!session) throw new Error("Session not found");
    if ([...this.active.values()].some((run) => run.sessionId === session.id)) throw new Error("This session already has an active run");
    const providerId = input.providerId ?? session.providerId;
    const providerConfig = this.config.providerConfigs.find((provider) => provider.id === providerId);
    if (!providerConfig) throw new Error("No provider is configured for this session");
    const model = input.model ?? (providerId === session.providerId ? session.model : providerConfig.models[0]?.id);
    if (!model || !providerConfig.models.some((candidate) => candidate.id === model)) throw new Error("Selected model is not configured");

    const runId = randomUUID();
    const controller = new AbortController();
    this.active.set(runId, { runId, sessionId: session.id, controller });
    const history = session.messages;
    void this.execute({
      runId,
      session,
      providerConfig,
      model,
      input: input.input,
      history,
      controller,
      ...(input.systemExtra ? { systemExtra: input.systemExtra } : {}),
    });
    return { runId };
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.controller.abort();
    this.gate.cancelRun(runId);
    for (const [approvalId, pending] of this.approvals) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.approvals.delete(approvalId);
      void this.sessions.finishApproval(approvalId, "cancelled");
    }
    this.audit?.record("run.cancelled", { runId, sessionId: active.sessionId });
    return true;
  }

  decideApproval(approvalId: string, approved: boolean): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending) {
      this.audit?.record("approval.unknown", { approvalId });
      return false;
    }
    clearTimeout(pending.timer);
    this.approvals.delete(approvalId);
    const consumed = this.gate.consume(approvalId);
    if (!consumed.ok) {
      this.audit?.record("approval.rejected", { approvalId, reason: consumed.reason });
      pending.resolve(false);
      return false;
    }
    void this.sessions.finishApproval(approvalId, approved ? "approved" : "denied");
    this.audit?.record("approval.decided", {
      approvalId,
      digest: consumed.record.digest,
      tool: consumed.record.tool,
      approved,
    });
    pending.resolve(approved);
    return true;
  }

  cancelAll(): void {
    for (const active of this.active.values()) active.controller.abort();
  }

  async shutdown(): Promise<void> {
    this.cancelAll();
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async execute(options: {
    runId: string;
    session: NonNullable<ReturnType<SessionStore["getSession"]>>;
    providerConfig: ProviderConfig;
    model: string;
    input: string;
    history: ChatMessage[];
    controller: AbortController;
    systemExtra?: string;
  }): Promise<void> {
    const { runId, session, providerConfig, model, input, history, controller } = options;
    let failureEmitted = false;
    let finalText = "";
    const messageStates = new Map<string, MessageState>();
    try {
      if (session.title === "New investigation") {
        const title = input.replace(/\s+/g, " ").trim().slice(0, 72);
        await this.sessions.updateSession(session.id, { title: title || "New investigation", providerId: providerConfig.id, model });
      } else if (session.providerId !== providerConfig.id || session.model !== model) {
        await this.sessions.updateSession(session.id, { providerId: providerConfig.id, model });
      }
      await this.sessions.appendMessage(session.id, { role: "user", content: input });
      await this.sessions.startRun(runId, session.id, model);

      const provider = new OpenAICompatibleProvider(providerConfig);
      const pluginPrompt = this.plugins.enabledPrompt();
      const planMode = session.mode === "plan";
      const system = [
        this.config.settings.systemPrompt,
        ...(planMode ? ["PLAN MODE: this session is read-only. Investigate, reason and propose the plan. Do not attempt file writes, commands or agent spawning; they are removed from your tool list and refused by the runtime."] : []),
        ...(options.systemExtra ? [options.systemExtra] : []),
        pluginPrompt ? `Enabled OpenHack plugins:\n${pluginPrompt}` : "",
        this.skills?.size
          ? `Installed skills. Call skill_search when a job matches one, then skill_load to read it before acting:\n${this.skills.indexText()}`
          : "",
        `Authorized workspace: ${session.workspacePath}`,
      ].filter(Boolean).join("\n\n");
      const engine = new AgentEngine({
        permission: this.config.settings.permission,
        requestApproval: (prompt) => this.requestApproval(runId, prompt, session.workspacePath, session.id),
      });

      const emit = (event: AgentEvent) => {
        if (event.type === "run.failed") failureEmitted = true;
        if (event.type === "run.completed") finalText = event.text;
        this.handleEvent(session.id, event, messageStates);
        this.auditEvent(runId, session.id, event);
        this.broadcast({ kind: "agent.event", runId, sessionId: session.id, event });
      };

      const bus = this.bus;
      const externalTools: ToolDefinition[] = [
        ...this.mcp.tools(),
        ...(bus ? bus.toolDefinitions() : []),
        spawnToolDefinition(),
      ];
      const backendOf = (tool: ToolDefinition): string => {
        const tagged = /^\[([^\]]+)\]/.exec(tool.description ?? "");
        return tagged ? `mcp:${tagged[1]}` : "external";
      };
      const directory = new ToolDirectory(externalTools, backendOf);
      const childTools = externalTools.filter((tool) => tool.name !== "agent_spawn");
      // Children get their own index so tool_call cannot reach agent_spawn.
      const childDirectory = new ToolDirectory(childTools, backendOf);
      const childCall = (name: string, args: unknown, signal: AbortSignal) => {
        if (bus && BusService.isBusTool(name)) return bus.callTool(name, args, runId);
        return this.mcp.callTool(name, args, signal);
      };
      const selectedModel = providerConfig.models.find((candidate) => candidate.id === model);
      const compacted = compactHistory({
        history,
        budgetChars: selectedModel?.context ? selectedModel.context * 3 : 240_000,
        ...(session.summary ? { summary: session.summary } : {}),
      });
      if (compacted.compacted && compacted.summary) {
        await this.sessions.setSessionSummary(session.id, compacted.summary);
        this.audit?.record("session.compacted", { sessionId: session.id, runId, omitted: compacted.omitted });
      }
      const web = createWebRuntime({
        ...(this.config.settings.searxngUrl ? { searxngUrl: this.config.settings.searxngUrl } : {}),
        ...(this.config.searchKey("exa") ? { exaApiKey: this.config.searchKey("exa") } : {}),
        ...(this.config.searchKey("tinyfish") ? { tinyfishApiKey: this.config.searchKey("tinyfish") } : {}),
        ...(process.env.OPENHACK_READER_PREFIX ? { readerPrefix: process.env.OPENHACK_READER_PREFIX } : {}),
        egressPolicy: this.config.settings.egressPolicy ?? "block-metadata",
      });
      const result = await engine.run({
        provider,
        model,
        input,
        history: [{ role: "system", content: system }, ...compacted.history],
        ...(this.config.settings.reasoningEffort ? { reasoningEffort: this.config.settings.reasoningEffort } : {}),
        workspace: new Workspace(session.workspacePath, this.checkpointHook(session.id, runId)),
        signal: controller.signal,
        tools: externalTools,
        directory,
        ...(this.skills ? { skills: this.skills } : {}),
        callExternalTool: (name, args, signal, callId) => {
          if (name.replace(/\./g, "_") === "agent_spawn") {
            return this.spawnWorkers(args, {
              session,
              providerConfig,
              model,
              tools: childTools,
              directory: childDirectory,
              callTool: childCall,
              signal,
              parentCallId: callId,
              parentRunId: runId,
              web,
            });
          }
          return childCall(name, args, signal);
        },
        runId,
        mode: session.mode ?? "act",
        ...(selectedModel?.context ? { contextLimit: selectedModel.context } : {}),
        ...(selectedModel?.output ? { maxOutputTokens: Math.min(selectedModel.output, 32768) } : {}),
        web,
      }, emit);
      finalText = result.text;
      await this.sessions.finishRun(runId, "completed");
      this.hooks.onRunFinished?.({ runId, sessionId: session.id, status: "completed", text: finalText });
    } catch (error) {
      const message = controller.signal.aborted ? "Run cancelled" : error instanceof Error ? error.message : String(error);
      if (!failureEmitted) {
        this.broadcast({ kind: "agent.event", runId, sessionId: session.id, event: { type: "run.failed", runId, error: message } });
      }
      const status = controller.signal.aborted ? "cancelled" : "failed";
      await this.sessions.finishRun(runId, status, message).catch(() => undefined);
      this.hooks.onRunFinished?.({ runId, sessionId: session.id, status, text: finalText, error: message });
    } finally {
      this.active.delete(runId);
      this.broadcast({ kind: "run.finished", runId, sessionId: session.id });
    }
  }

  /**
   * The dynamic army: one tool call fans out N model runs in parallel, all inside
   * the parent session. Workers cannot spawn, the pool is capped, and every
   * worker message is attributed so the transcript shows who produced it.
   */
  private async spawnWorkers(
    rawArgs: unknown,
    context: {
      session: NonNullable<ReturnType<SessionStore["getSession"]>>;
      providerConfig: ProviderConfig;
      model: string;
      tools: ToolDefinition[];
      directory: ToolDirectory;
      callTool: (name: string, args: unknown, signal: AbortSignal) => Promise<string>;
      signal: AbortSignal;
      parentCallId: string;
      parentRunId: string;
      web: ReturnType<typeof createWebRuntime>;
    },
  ): Promise<string> {
    const args = rawArgs as { tasks?: unknown; parentCallId?: unknown };
    const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
    if (!tasks.length) throw new Error("agent_spawn requires at least one task");
    if (tasks.length > 8) throw new Error("agent_spawn accepts at most 8 tasks per call");
    const usedWorkers = this.sessions.countSessionWorkers(context.session.id);
    if (usedWorkers + tasks.length > 24) throw new Error(`This session already spawned ${usedWorkers} workers; the cap is 24`);

    const provider = new OpenAICompatibleProvider(context.providerConfig);
    const selectedModel = context.providerConfig.models.find((candidate) => candidate.id === context.model);
    const names = new Set<string>();
    const specs = tasks.map((value, index) => {
      const task = (value ?? {}) as { name?: unknown; role?: unknown; brief?: unknown; model?: unknown };
      const brief = typeof task.brief === "string" ? task.brief.trim() : "";
      if (!brief) throw new Error(`Task ${index + 1} is missing a brief`);
      if (brief.length > 8000) throw new Error(`Task ${index + 1} brief exceeds 8,000 characters`);
      let name = typeof task.name === "string" ? task.name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 24) : "";
      if (!name) name = `WORKER-${index + 1}`;
      let suffix = 2;
      const base = name;
      while (names.has(name.toLowerCase())) name = `${base}-${suffix++}`;
      names.add(name.toLowerCase());
      const role = typeof task.role === "string" && task.role.trim() ? task.role.trim().slice(0, 60) : "Worker";
      const model = typeof task.model === "string" && context.providerConfig.models.some((entry) => entry.id === task.model)
        ? task.model
        : context.model;
      return { id: randomUUID(), name, role, model, brief };
    });

    const results: SpawnWorkerResult[] = await Promise.all(specs.map(async (spec) => {
      this.broadcast({
        kind: "agent.event",
        runId: context.parentRunId,
        sessionId: context.session.id,
        event: { type: "subagent.started", workerId: spec.id, name: spec.name, role: spec.role, model: spec.model, parentCallId: context.parentCallId, taskCount: specs.length },
      });
      const release = await this.workerPool.acquire();
      const controller = new AbortController();
      const relay = () => controller.abort();
      context.signal.addEventListener("abort", relay, { once: true });
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      const startedAt = Date.now();
      const childRunId = randomUUID();
      const childStates = new Map<string, MessageState>();
      const childEmit = (event: AgentEvent) => {
        if (event.type === "run.started" || event.type === "run.completed" || event.type === "run.failed") return;
        const tagged = {
          ...event,
          agentId: spec.id,
          agentName: spec.name,
          agentRole: spec.role,
          parentCallId: context.parentCallId,
        } as AgentEvent;
        this.handleEvent(context.session.id, tagged, childStates);
        this.auditEvent(childRunId, context.session.id, tagged, spec.name);
        this.broadcast({ kind: "agent.event", runId: childRunId, sessionId: context.session.id, event: tagged });
      };
      try {
        const engine = new AgentEngine({
          permission: this.config.settings.permission,
          requestApproval: (prompt) => this.requestApproval(context.parentRunId, prompt, context.session.workspacePath, context.session.id, spec.name),
        });
        const system = [
          `You are ${spec.name}, a worker spawned by the lead agent inside this session. Role: ${spec.role}.`,
          `You share the operator's authorized workspace at ${context.session.workspacePath}. Act; do not ask questions back.`,
          "You cannot spawn further agents. Complete the brief with tools and return a compact report (300 words max) that cites the exact paths, commands, URLs or outputs that prove each claim.",
          "If part of the brief is impossible, name the blocker precisely and finish the rest.",
        ].join("\n");
        const outcome = await engine.run({
          provider,
          model: spec.model,
          input: spec.brief,
          history: [{ role: "system", content: system }],
          ...(this.config.settings.reasoningEffort ? { reasoningEffort: this.config.settings.reasoningEffort } : {}),
          workspace: new Workspace(context.session.workspacePath, this.checkpointHook(context.session.id, childRunId)),
          signal: controller.signal,
          tools: context.tools,
          directory: context.directory,
          ...(this.skills ? { skills: this.skills } : {}),
          callExternalTool: context.callTool,
          runId: childRunId,
          ...(selectedModel?.context ? { contextLimit: selectedModel.context } : {}),
          ...(selectedModel?.output ? { maxOutputTokens: Math.min(selectedModel.output, 32768) } : {}),
          web: context.web,
        }, childEmit);
        const summary = outcome.text.trim().slice(0, 6000);
        this.broadcast({
          kind: "agent.event",
          runId: context.parentRunId,
          sessionId: context.session.id,
          event: { type: "subagent.completed", workerId: spec.id, name: spec.name, status: "completed", summary: summary.slice(0, 400), durationMs: Date.now() - startedAt },
        });
        return { id: spec.id, name: spec.name, role: spec.role, model: spec.model, status: "completed" as const, summary };
      } catch (error) {
        const message = controller.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error);
        if (!controller.signal.aborted) {
          const failed: ChatMessage = {
            id: randomUUID(),
            role: "assistant",
            content: `Worker failed: ${message}`,
            createdAt: new Date().toISOString(),
            agentId: spec.id,
            agentName: spec.name,
            agentRole: spec.role,
            parentCallId: context.parentCallId,
          };
          await this.sessions.appendMessage(context.session.id, failed);
          this.broadcast({ kind: "agent.event", runId: childRunId, sessionId: context.session.id, event: { type: "message.started", messageId: failed.id!, agentId: spec.id, agentName: spec.name, agentRole: spec.role, parentCallId: context.parentCallId } });
          this.broadcast({ kind: "agent.event", runId: childRunId, sessionId: context.session.id, event: { type: "text.delta", messageId: failed.id!, text: failed.content, agentId: spec.id, agentName: spec.name } });
        }
        this.broadcast({
          kind: "agent.event",
          runId: context.parentRunId,
          sessionId: context.session.id,
          event: { type: "subagent.completed", workerId: spec.id, name: spec.name, status: controller.signal.aborted ? "cancelled" : "failed", summary: message.slice(0, 400), durationMs: Date.now() - startedAt },
        });
        return { id: spec.id, name: spec.name, role: spec.role, model: spec.model, status: controller.signal.aborted ? "cancelled" as const : "failed" as const, summary: "", error: message };
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", relay);
        release();
      }
    }));

    return JSON.stringify({
      workers: results,
      completed: results.filter((worker) => worker.status === "completed").length,
      failed: results.filter((worker) => worker.status !== "completed").length,
      note: "Worker reports are above. Reconcile them before answering; do not repeat their work.",
    });
  }

  private checkpointHook(sessionId: string, runId: string): { beforeChange: (relativePath: string, absolutePath: string) => Promise<void> } {
    const store = this.checkpoints;
    if (!store) return { beforeChange: async () => undefined };
    return {
      beforeChange: async (relativePath, absolutePath) => {
        await store.capture({ sessionId, runId, relativePath, absolutePath });
      },
    };
  }

  private auditEvent(runId: string, sessionId: string, event: AgentEvent, agent?: string): void {
    if (!this.audit) return;
    const label = agent ?? ("agentName" in event ? event.agentName : undefined);
    if (event.type === "tool.started") {
      this.audit.record("tool.started", {
        runId,
        sessionId,
        tool: event.name,
        risk: event.risk,
        argsHash: hashArguments(event.argumentsJson),
        ...(label ? { agent: label } : {}),
      });
    } else if (event.type === "tool.completed") {
      this.audit.record("tool.completed", {
        runId,
        sessionId,
        tool: event.name,
        bytes: event.result.length,
        ...(label ? { agent: label } : {}),
      });
    } else if (event.type === "tool.failed") {
      this.audit.record("tool.failed", {
        runId,
        sessionId,
        tool: event.name,
        error: event.error,
        ...(label ? { agent: label } : {}),
      });
    } else if (event.type === "run.failed") {
      this.audit.record("run.failed", { runId, sessionId, error: event.error });
    }
  }

  /**
   * Resolves an approval from either live memory or the durable record left by a
   * previous process. A restarted approval executes the exact saved call once,
   * appends its result to the session, and continues the model loop.
   */
  async resolveApproval(id: string, approved: boolean): Promise<{ ok: boolean; runId?: string; resumed: boolean }> {
    if (this.approvals.has(id)) return { ok: this.decideApproval(id, approved), resumed: false };
    const record = this.sessions.getApproval(id);
    if (!record || record.status !== "pending") return { ok: false, resumed: false };
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.sessions.finishApproval(id, "expired");
      return { ok: false, resumed: false };
    }
    const session = this.sessions.getSession(record.sessionId);
    if (!session) {
      await this.sessions.finishApproval(id, "denied");
      return { ok: false, resumed: false };
    }
    await this.sessions.finishApproval(id, approved ? "approved" : "denied");
    const content = approved
      ? await this.executePersisted(record)
      : JSON.stringify({ ok: false, error: "Denied by operator" });
    await this.sessions.appendMessage(session.id, {
      role: "tool",
      content,
      tool_call_id: record.callId,
      name: record.tool,
    });
    this.audit?.record("approval.resumed", {
      approvalId: id,
      tool: record.tool,
      digest: record.digest,
      approved,
    });
    try {
      const { runId } = this.start({ sessionId: session.id, input: "Continue after the operator-resolved action." });
      return { ok: true, runId, resumed: true };
    } catch {
      return { ok: true, resumed: true };
    }
  }

  private async executePersisted(record: { tool: string; argumentsJson: string; workspace: string; runId: string }): Promise<string> {
    try {
      const args: unknown = JSON.parse(record.argumentsJson || "{}");
      if (/^(workspace|process|web)[._]/.test(record.tool)) {
        return await executeBuiltinTool(record.tool, args, new Workspace(record.workspace), AbortSignal.timeout(120_000));
      }
      if (this.bus && BusService.isBusTool(record.tool)) {
        return await this.bus.callTool(record.tool, args, record.runId);
      }
      return await this.mcp.callTool(record.tool, args, AbortSignal.timeout(120_000));
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private requestApproval(runId: string, prompt: ApprovalPrompt, workspace: string, sessionId: string, agentName?: string): Promise<boolean> {
    const record = this.gate.open({
      id: prompt.approvalId,
      runId,
      callId: prompt.callId,
      tool: prompt.name,
      argumentsJson: prompt.argumentsJson,
      risk: prompt.risk,
      workspace,
      ...(agentName ? { agentName } : {}),
    });
    this.sessions.saveApproval({
      id: record.id,
      sessionId,
      runId,
      callId: prompt.callId,
      tool: prompt.name,
      argumentsJson: prompt.argumentsJson,
      risk: prompt.risk,
      digest: record.digest,
      ...(agentName ? { agentName } : {}),
      workspace,
      policyVersion: record.policyVersion,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      status: "pending",
    });
    void this.sessions.flush();
    this.audit?.record("approval.requested", {
      approvalId: record.id,
      digest: record.digest,
      tool: record.tool,
      risk: record.risk,
      argsHash: record.argsHash,
      runId,
      agent: agentName ?? "lead",
    });
    return new Promise<boolean>((resolve) => {
      const request: ApprovalRequest = {
        id: record.id,
        runId,
        callId: prompt.callId,
        name: prompt.name,
        argumentsJson: prompt.argumentsJson,
        risk: prompt.risk,
        digest: record.digest,
        expiresAt: record.expiresAt,
        ...(agentName ? { agentName } : {}),
      };
      this.broadcast({ kind: "approval.requested", request });
      const timer = setTimeout(() => {
        if (!this.approvals.delete(record.id)) return;
        this.gate.consume(record.id);
        void this.sessions.finishApproval(record.id, "expired");
        this.audit?.record("approval.expired", { approvalId: record.id, digest: record.digest, tool: record.tool });
        resolve(false);
      }, Math.max(1000, Date.parse(record.expiresAt) - Date.now()));
      this.approvals.set(record.id, { request, runId, resolve, timer });
    });
  }

  private handleEvent(sessionId: string, event: AgentEvent, states: Map<string, MessageState>): void {
    if (event.type === "message.started") {
      const state: MessageState = { content: "", reasoning: "", calls: [] };
      states.set(event.messageId, state);
      void this.sessions.appendMessage(sessionId, {
        id: event.messageId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.agentRole ? { agentRole: event.agentRole } : {}),
        ...(event.parentCallId ? { parentCallId: event.parentCallId } : {}),
      });
      return;
    }
    if (event.type === "text.delta") {
      const state = states.get(event.messageId);
      if (!state) return;
      state.content += event.text;
      this.sessions.appendDelta(event.messageId, "content", event.text);
      return;
    }
    if (event.type === "reasoning.delta") {
      const state = states.get(event.messageId);
      if (!state) return;
      state.reasoning += event.text;
      this.sessions.appendDelta(event.messageId, "reasoning", event.text);
      return;
    }
    if (event.type === "tool.started") {
      const state = states.get(event.messageId);
      if (!state) return;
      state.calls.push({
        id: event.callId,
        type: "function",
        function: { name: event.name, arguments: event.argumentsJson },
      });
      void this.sessions.setMessage(event.messageId, { toolCalls: state.calls });
      return;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const content = event.type === "tool.completed"
        ? event.result
        : JSON.stringify({ ok: false, error: event.error });
      void this.sessions.appendMessage(sessionId, {
        role: "tool",
        content,
        tool_call_id: event.callId,
        name: event.name,
        createdAt: new Date().toISOString(),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
      });
      return;
    }
    if (event.type === "message.completed") {
      const state = states.get(event.messageId);
      if (state) {
        void this.sessions.setMessage(event.messageId, {
          content: state.content,
          ...(state.reasoning ? { reasoning: state.reasoning } : {}),
          ...(state.calls.length ? { toolCalls: state.calls } : {}),
        });
      }
      return;
    }
    if (event.type === "run.completed") void this.sessions.finishRun(event.runId, "completed");
    if (event.type === "run.failed") void this.sessions.finishRun(event.runId, "failed", event.error);
  }
}

function spawnToolDefinition(): ToolDefinition {
  return {
    name: "agent_spawn",
    description:
      "Spawn parallel workers inside this session. Each task becomes its own agent run with the same workspace and tools; all tasks execute at the same time and every report returns in one result. Put every independent job in ONE call so they actually run in parallel. Workers cannot spawn further agents. Max 8 tasks per call, 24 workers per session.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short worker label, e.g. RECON-1." },
              role: { type: "string", description: "One-line specialization, e.g. 'port scan and service fingerprint'." },
              brief: { type: "string", description: "Self-contained task: target, method, required evidence, and stopping condition." },
              model: { type: "string", description: "Optional model id from the active provider." },
            },
            required: ["brief"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    risk: "execute",
  };
}

/**
 * Counting semaphore that transfers a reserved slot to the next waiter, so a
 * concurrent acquire can never overshoot the limit between release and resume.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => resolve(this.releaser()));
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        this.active += 1;
        next();
      }
    };
  }
}
