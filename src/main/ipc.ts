import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AgentService } from "./agent/service";
import type { AppSettings } from "../shared/contracts";
import type { BusService } from "./bus/bus";
import type { BrowserPane } from "./browser/pane";
import type { CheckpointStore } from "./checkpoints/store";
import type { ConfigStore } from "./config/store";
import { importOpenCodeMcp, importOpenCodeProviders } from "./config/opencode";
import type { McpManager } from "./mcp/manager";
import { loadPreset, planStack } from "./mcp/bootstrap";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { PluginManager } from "./plugins/manager";
import type { SessionStore } from "./storage/sessions";
import type { AuditLog } from "./security/audit";
import { Workspace } from "./workspace/workspace";

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const empty = z.undefined().or(z.null()).transform(() => undefined);
const id = z.string().min(1).max(200);
const shortText = z.string().max(4096);
const modelSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  tools: z.boolean(),
  context: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
});
const providerSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(160),
  baseURL: z.string().url().max(4096),
  models: z.array(modelSchema).min(1).max(128),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]),
  headerTimeoutMs: z.number().int().min(1000).max(600000),
  chunkTimeoutMs: z.number().int().min(1000).max(600000),
  source: z.enum(["opencode", "manual"]).optional(),
});
const mcpSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(160),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(32768)).max(128),
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string().max(120), z.string().max(32768)).optional(),
  enabled: z.boolean(),
});

export interface IpcContext {
  config: ConfigStore;
  sessions: SessionStore;
  mcp: McpManager;
  plugins: PluginManager;
  agent: AgentService;
  bus: BusService;
  audit: AuditLog;
  checkpoints: CheckpointStore;
  browser: BrowserPane;
  dataDir: string;
  resourceRoot: string;
  version: string;
  broadcast: (payload: unknown) => void;
}

export function registerIpc(context: IpcContext): void {
  const handle = <T>(channel: string, schema: z.ZodType, action: (input: unknown) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, raw): Promise<Reply<T>> => {
      try {
        assertSender(event);
        const input = schema.parse(raw);
        return { ok: true, data: await action(input) };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
  };

  handle("bootstrap", empty, async () => {
    const plugins = await context.plugins.scan();
    return {
      app: { name: "OpenHack", version: context.version, platform: process.platform, dataDir: context.dataDir },
      providers: context.config.publicProviders,
      sessions: context.sessions.listSessions(),
      settings: context.config.settings,
      mcpServers: context.mcp.statuses(),
      plugins,
    };
  });

  const rememberWorkspace = async (workspacePath: string): Promise<string> => {
    const settings = context.config.settings;
    const recent = [workspacePath, ...(settings.recentWorkspaces ?? []).filter((entry) => entry !== workspacePath)].slice(0, 8);
    const next = await context.config.updateSettings({ lastWorkspace: workspacePath, recentWorkspaces: recent });
    return next.lastWorkspace ?? workspacePath;
  };

  handle("workspace.open", empty, async () => {
    const result = await dialog.showOpenDialog({ title: "Choose or create a project folder", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return rememberWorkspace(result.filePaths[0]);
  });

  handle("workspace.tree", z.object({ path: z.string().max(4096).default("."), depth: z.number().int().min(0).max(8).default(3) }), async (raw) => {
    const input = raw as { path: string; depth: number };
    const root = context.config.settings.lastWorkspace;
    if (!root) throw new Error("Authorize a workspace first");
    const workspace = new Workspace(root);
    return { root, entries: await workspace.list(input.path, input.depth) };
  });

  handle("workspace.read", z.object({ path: z.string().min(1).max(4096) }), async (raw) => {
    const input = raw as { path: string };
    const root = context.config.settings.lastWorkspace;
    if (!root) throw new Error("Authorize a workspace first");
    return new Workspace(root).read(input.path, 0, 4000);
  });

  handle("session.create", z.object({ workspacePath: z.string().max(4096).optional() }), async (raw) => {
    const settings = context.config.settings;
    const requested = (raw as { workspacePath?: string }).workspacePath;
    let workspacePath = requested ?? settings.lastWorkspace;
    if (!workspacePath) throw new Error("Authorize a workspace first");
    if (workspacePath !== settings.lastWorkspace) {
      const info = await stat(workspacePath).catch(() => null);
      if (!info?.isDirectory()) throw new Error("Project folder does not exist");
      workspacePath = await rememberWorkspace(workspacePath);
    }
    const provider = context.config.providerConfigs.find((candidate) => candidate.id === settings.activeProviderId) ?? context.config.providerConfigs[0];
    if (!provider) throw new Error("Configure a provider first");
    const model = provider.models.find((candidate) => candidate.id === settings.activeModel) ?? provider.models[0];
    if (!model) throw new Error("Provider has no models");
    return context.sessions.createSession({
      id: crypto.randomUUID(),
      workspacePath,
      providerId: provider.id,
      model: model.id,
    });
  });

  handle("session.list", empty, () => context.sessions.listSessions());
  handle("session.get", z.object({ id }), (raw) => {
    const session = context.sessions.getSession((raw as { id: string }).id);
    if (!session) throw new Error("Session not found");
    return session;
  });
  handle("session.setMode", z.object({ id, mode: z.enum(["plan", "act"]) }), async (raw) => {
    const input = raw as { id: string; mode: "plan" | "act" };
    await context.sessions.updateSession(input.id, { mode: input.mode });
    const session = context.sessions.getSession(input.id);
    if (!session) throw new Error("Session not found");
    return session;
  });
  handle("session.delete", z.object({ id }), async (raw) => {
    await context.sessions.deleteSession((raw as { id: string }).id);
    return true;
  });

  handle("approvals.pending", z.object({ sessionId: id.optional() }), (raw) => {
    const input = raw as { sessionId?: string };
    return context.sessions.pendingApprovals(input.sessionId);
  });
  handle("approvals.resolve", z.object({ id, approved: z.boolean() }), (raw) => {
    const input = raw as { id: string; approved: boolean };
    return context.agent.resolveApproval(input.id, input.approved);
  });
  handle("run.start", z.object({ sessionId: id, input: z.string().min(1).max(200000), providerId: id.optional(), model: z.string().max(300).optional() }), (raw) => {
    const input = raw as { sessionId: string; input: string; providerId?: string; model?: string };
    return context.agent.start(input);
  });
  handle("run.cancel", z.object({ runId: id }), (raw) => context.agent.cancel((raw as { runId: string }).runId));
  handle("approval.decide", z.object({ approvalId: id, approved: z.boolean() }), (raw) => {
    const input = raw as { approvalId: string; approved: boolean };
    return context.agent.decideApproval(input.approvalId, input.approved);
  });

  handle("provider.save", z.object({ provider: providerSchema, apiKey: z.string().max(8192).optional() }), async (raw) => {
    const input = raw as { provider: z.infer<typeof providerSchema>; apiKey?: string };
    if (!isAllowedProviderUrl(input.provider.baseURL)) throw new Error("Providers must use HTTPS or a loopback HTTP endpoint");
    await context.config.updateProvider({ ...input.provider }, input.apiKey);
    const settings = context.config.settings;
    if (!settings.activeProviderId) {
      await context.config.updateSettings({ activeProviderId: input.provider.id, activeModel: input.provider.models[0]?.id });
    }
    return context.config.publicProviders;
  });

  handle("provider.test", z.object({ id }), async (raw) => {
    const provider = context.config.providerConfigs.find((candidate) => candidate.id === (raw as { id: string }).id);
    if (!provider) throw new Error("Provider not found");
    return new OpenAICompatibleProvider(provider).test();
  });

  handle("provider.import", empty, async () => {
    const defaults = path.join(homedir(), ".config", "opencode", "opencode.json");
    let configPath = defaults;
    try {
      await readFile(defaults, "utf8");
    } catch {
      const picked = await dialog.showOpenDialog({ title: "Select OpenCode config", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json", "jsonc"] }] });
      if (picked.canceled || !picked.filePaths[0]) return { imported: 0, providers: context.config.publicProviders };
      configPath = picked.filePaths[0];
    }
    const imported = importOpenCodeProviders(await readFile(configPath, "utf8"), { baseDir: path.dirname(configPath) });
    if (!imported.providers.length) throw new Error("No modal-kimi or modal-ep provider was found");
    await context.config.importProviders(imported.providers);
    return { imported: imported.providers.length, providers: context.config.publicProviders };
  });

  handle("settings.searchKey", z.object({
    provider: z.enum(["exa", "tinyfish"]),
    apiKey: z.string().max(400).optional(),
  }), async (raw) => {
    const input = raw as { provider: "exa" | "tinyfish"; apiKey?: string };
    await context.config.setSearchKey(input.provider, input.apiKey);
    return context.config.settings;
  });
  handle("settings.update", z.object({
    permission: z.enum(["supervised", "workspace", "autonomous"]).optional(),
    systemPrompt: z.string().max(32000).optional(),
    activeProviderId: z.string().max(80).optional(),
    activeModel: z.string().max(300).optional(),
    searxngUrl: z.string().max(4096).optional(),
    egressPolicy: z.enum(["open", "block-metadata", "block-private"]).optional(),
    reasoningEffort: z.enum(["off", "low", "medium", "high"]).optional(),
  }), (raw) => context.config.updateSettings(raw as Partial<AppSettings>));

  handle("mcp.save", mcpSchema, async (raw) => {
    const config = raw as z.infer<typeof mcpSchema>;
    await context.config.saveMcpServer(config);
    if (config.enabled) return context.mcp.connect(config);
    await context.mcp.disconnect(config.id);
    return context.mcp.statuses().find((server) => server.id === config.id);
  });
  handle("mcp.bootstrap", empty, async () => {
    const preset = await loadPreset(path.join(context.resourceRoot, "presets", "mcp-stack.json"));
    const plan = await planStack(preset, context.config.mcpConfigs);
    for (const server of plan.servers) await context.config.saveMcpServer(server);
    const connected: string[] = [];
    for (const server of plan.servers) {
      try {
        const status = await context.mcp.connect(server);
        if (status.state === "ready") connected.push(server.id);
      } catch {
        // A failed server keeps its error in the extensions view.
      }
    }
    return { ...plan.report, connected };
  });
  handle("mcp.importOpenCode", empty, async () => {
    const file = path.join(homedir(), ".config", "opencode", "opencode.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error("No OpenCode config found at ~/.config/opencode/opencode.json");
    }
    const { servers, skipped } = importOpenCodeMcp(raw);
    const existing = new Set(context.config.mcpConfigs.map((server) => server.id));
    const added = servers.filter((server) => !existing.has(server.id));
    for (const server of added) await context.config.saveMcpServer(server);
    for (const server of added.filter((entry) => entry.enabled)) {
      void context.mcp.connect(server).catch(() => undefined);
    }
    return { found: servers.length, added: added.map((server) => server.id), skipped };
  });
  handle("mcp.connect", z.object({ id }), async (raw) => {
    const config = context.config.mcpConfigs.find((server) => server.id === (raw as { id: string }).id);
    if (!config) throw new Error("MCP server not found");
    return context.mcp.connect(config);
  });
  handle("mcp.disconnect", z.object({ id }), async (raw) => {
    await context.mcp.disconnect((raw as { id: string }).id);
    return context.mcp.statuses();
  });
  handle("mcp.remove", z.object({ id }), async (raw) => {
    await context.mcp.disconnect((raw as { id: string }).id);
    await context.config.removeMcpServer((raw as { id: string }).id);
    return context.mcp.statuses();
  });
  handle("mcp.list", empty, () => context.mcp.statuses());

  handle("bus.snapshot", z.object({ channel: z.string().max(64).optional() }), (raw) => {
    const input = raw as { channel?: string };
    const snapshot = context.bus.snapshot(input.channel);
    return { ...snapshot, ...(context.bus.url ? { webhookUrl: context.bus.url } : {}) };
  });
  handle("bus.send", z.object({
    channel: z.string().max(64).optional(),
    content: z.string().min(1).max(20000),
    to: z.string().max(80).optional(),
  }), (raw) => context.bus.postFromOperator(raw as { channel?: string; content: string; to?: string }));
  handle("bus.messages", z.object({ channel: z.string().min(1).max(64), limit: z.number().int().min(1).max(500).default(200) }), (raw) => {
    const input = raw as { channel: string; limit: number };
    return context.bus.messages(input.channel, input.limit);
  });
  handle("bus.memory.delete", z.object({ key: z.string().min(1).max(120) }), async (raw) => {
    await context.sessions.deleteBusMemory((raw as { key: string }).key);
    return context.bus.snapshot();
  });
  handle("bus.agents.save", z.object({
    agents: z.array(z.object({
      id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/),
      name: z.string().min(1).max(40),
      role: z.string().min(1).max(80),
      systemPrompt: z.string().min(1).max(16000),
      enabled: z.boolean(),
      providerId: z.string().max(80).optional(),
      model: z.string().max(300).optional(),
    })).min(1).max(24).refine((list) => new Set(list.map((agent) => agent.id)).size === list.length, "Agent ids must be unique"),
  }), async (raw) => {
    await context.config.updateSettings({ busAgents: (raw as { agents: AppSettings["busAgents"] }).agents });
    return context.bus.snapshot();
  });

  handle("plugins.list", empty, () => context.plugins.scan());  handle("plugins.import", empty, async () => {
    const result = await dialog.showOpenDialog({ title: "Select an OpenHack plugin folder", properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return context.plugins.statuses();
    return context.plugins.importDirectory(result.filePaths[0]);
  });
  handle("plugins.toggle", z.object({ id, enabled: z.boolean() }), (raw) => {
    const input = raw as { id: string; enabled: boolean };
    return context.plugins.setEnabled(input.id, input.enabled);
  });
  handle("plugins.openFolder", empty, async () => {
    await shell.openPath(context.plugins.directory);
    return true;
  });
  handle("app.openDataDir", empty, async () => {
    await shell.openPath(context.dataDir);
    return true;
  });
  handle("browser.show", z.object({
    url: z.string().max(8192).optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  }), async (raw) => context.browser.show(raw as { url?: string; bounds: { x: number; y: number; width: number; height: number } }));
  handle("browser.bounds", z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }), (raw) => {
    context.browser.setBounds(raw as { x: number; y: number; width: number; height: number });
    return true;
  });
  handle("browser.hide", empty, () => { context.browser.hide(); return true; });
  handle("browser.snapshot", empty, () => context.browser.snapshot());
  handle("browser.navigate", z.object({ url: z.string().min(1).max(8192) }), (raw) => context.browser.navigate((raw as { url: string }).url));
  handle("browser.action", z.object({ action: z.enum(["back", "forward", "reload"]) }), (raw) => context.browser.action((raw as { action: "back" | "forward" | "reload" }).action));
  handle("security.auditTail", z.object({ lines: z.number().int().min(1).max(500).optional() }), async (raw) => {
    const input = raw as { lines?: number };
    return context.audit.tail(input.lines ?? 40);
  });

  handle("checkpoints.list", z.object({ sessionId: id }), async (raw) => {
    const sessionId = (raw as { sessionId: string }).sessionId;
    const session = context.sessions.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return context.checkpoints.list(sessionId, new Workspace(session.workspacePath));
  });
  handle("checkpoints.diff", z.object({ sessionId: id, runId: id, path: z.string().min(1).max(4096) }), async (raw) => {
    const input = raw as { sessionId: string; runId: string; path: string };
    const session = context.sessions.getSession(input.sessionId);
    if (!session) throw new Error("Session not found");
    return context.checkpoints.diff(input.sessionId, input.runId, input.path, new Workspace(session.workspacePath));
  });
  handle("checkpoints.restore", z.object({ sessionId: id, runId: id, path: z.string().min(1).max(4096) }), async (raw) => {
    const input = raw as { sessionId: string; runId: string; path: string };
    const session = context.sessions.getSession(input.sessionId);
    if (!session) throw new Error("Session not found");
    return context.checkpoints.restore(input.sessionId, input.runId, input.path, new Workspace(session.workspacePath));
  });
  handle("app.openExternal", z.object({ url: z.string().url().max(4096) }), async (raw) => {
    const url = new URL((raw as { url: string }).url);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only HTTP links can be opened externally");
    await shell.openExternal(url.toString());
    return true;
  });
}

function assertSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  const devOrigin = process.env.ELECTRON_RENDERER_URL ?? "";
  if (url.startsWith("file://") || (devOrigin && url.startsWith(devOrigin))) return;
  if (!BrowserWindow.fromWebContents(event.sender)) throw new Error("Rejected IPC sender");
  throw new Error("Rejected IPC origin");
}

function isAllowedProviderUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[a-zA-Z0-9_-]{8,}/g, "[redacted]").slice(0, 8000);
}
