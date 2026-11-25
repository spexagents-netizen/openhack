import type {
  AgentEvent,
  AppSettings,
  BootstrapData,
  BusAgentConfig,
  BusMessage,
  BrowserPageState,
  BusSnapshot,
  CheckpointDiff,
  CheckpointStatus,
  McpServerConfig,
  McpServerStatus,
  PluginStatus,
  PersistedApproval,
  ProviderConfig,
  PublicProviderConfig,
  SessionRecord,
  SessionSummary,
} from "../shared/contracts";

export interface AgentPush {
  kind: "agent.event";
  runId: string;
  sessionId: string;
  event: AgentEvent;
}

export interface RunFinishedPush {
  kind: "run.finished";
  runId: string;
  sessionId: string;
}

export interface IntegrationsPush {
  kind: "integrations.changed";
}

export interface BusPush {
  kind: "bus.message" | "bus.changed";
  channel?: string;
  message?: BusMessage;
}

export interface BrowserPush {
  kind: "browser.state";
  state: BrowserPageState;
  error?: string;
}

export interface ApprovalPush {
  kind: "approval.requested";
  request: {
    id: string;
    runId: string;
    callId: string;
    name: string;
    argumentsJson: string;
    risk: "read" | "write" | "execute";
    digest?: string;
    expiresAt?: string;
    agentName?: string;
  };
}

export type PushPayload = AgentPush | RunFinishedPush | IntegrationsPush | BusPush | ApprovalPush | BrowserPush;

const invoke = <T>(channel: string, payload?: unknown): Promise<T> => window.openhack.invoke(channel, payload) as Promise<T>;

export const api = {
  platform: window.openhack.platform,
  bootstrap: () => invoke<BootstrapData>("bootstrap"),
  openWorkspace: () => invoke<string | null>("workspace.open"),
  workspaceTree: (path = ".", depth = 3) => invoke<{ root: string; entries: Array<{ path: string; kind: "file" | "directory"; size?: number }> }>("workspace.tree", { path, depth }),
  workspaceRead: (path: string) => invoke<{ path: string; content: string; totalLines: number; truncated: boolean }>("workspace.read", { path }),
  createSession: (workspacePath?: string) => invoke<SessionRecord>("session.create", workspacePath ? { workspacePath } : {}),
  listSessions: () => invoke<SessionSummary[]>("session.list"),
  getSession: (id: string) => invoke<SessionRecord>("session.get", { id }),
  deleteSession: (id: string) => invoke<boolean>("session.delete", { id }),
  setSessionMode: (id: string, mode: "plan" | "act") => invoke<SessionRecord>("session.setMode", { id, mode }),
  startRun: (input: { sessionId: string; input: string; providerId?: string; model?: string }) => invoke<{ runId: string }>("run.start", input),
  cancelRun: (runId: string) => invoke<boolean>("run.cancel", { runId }),
  pendingApprovals: (sessionId?: string) => invoke<PersistedApproval[]>("approvals.pending", sessionId ? { sessionId } : {}),
  resolveApproval: (id: string, approved: boolean) => invoke<{ ok: boolean; runId?: string; resumed: boolean }>("approvals.resolve", { id, approved }),
  decideApproval: (approvalId: string, approved: boolean) => invoke<boolean>("approval.decide", { approvalId, approved }),
  saveProvider: (provider: ProviderConfig, apiKey?: string) => invoke<PublicProviderConfig[]>("provider.save", { provider, ...(apiKey !== undefined ? { apiKey } : {}) }),
  testProvider: (id: string) => invoke<{ ok: boolean; detail: string }>("provider.test", { id }),
  importProviders: () => invoke<{ imported: number; providers: PublicProviderConfig[] }>("provider.import"),
  updateSettings: (patch: Partial<AppSettings>) => invoke<AppSettings>("settings.update", patch),
  setSearchKey: (provider: "exa" | "tinyfish", apiKey?: string) => invoke<AppSettings>("settings.searchKey", { provider, apiKey }),
  saveMcp: (server: McpServerConfig) => invoke<McpServerStatus | undefined>("mcp.save", server),
  importOpenCodeMcp: () => invoke<{ found: number; added: string[]; skipped: string[] }>("mcp.importOpenCode"),
  installStack: () => invoke<{ added: string[]; blocked: Array<{ id: string; requires: string[] }>; manual: Array<{ id: string; reason: string }>; existing: string[]; connected: string[] }>("mcp.bootstrap"),
  connectMcp: (id: string) => invoke<McpServerStatus>("mcp.connect", { id }),
  disconnectMcp: (id: string) => invoke<McpServerStatus[]>("mcp.disconnect", { id }),
  removeMcp: (id: string) => invoke<McpServerStatus[]>("mcp.remove", { id }),
  listMcp: () => invoke<McpServerStatus[]>("mcp.list"),
  listPlugins: () => invoke<PluginStatus[]>("plugins.list"),
  importPlugin: () => invoke<PluginStatus[]>("plugins.import"),
  togglePlugin: (id: string, enabled: boolean) => invoke<PluginStatus[]>("plugins.toggle", { id, enabled }),
  openPluginFolder: () => invoke<boolean>("plugins.openFolder"),
  busSnapshot: (channel?: string) => invoke<BusSnapshot>("bus.snapshot", channel ? { channel } : {}),
  busSend: (input: { channel?: string; content: string; to?: string }) => invoke<{ message: BusMessage; dispatchedTo?: string }>("bus.send", input),
  busMessages: (channel: string, limit = 200) => invoke<BusMessage[]>("bus.messages", { channel, limit }),
  deleteBusMemory: (key: string) => invoke<BusSnapshot>("bus.memory.delete", { key }),
  saveBusAgents: (agents: BusAgentConfig[]) => invoke<BusSnapshot>("bus.agents.save", { agents }),
  openDataDir: () => invoke<boolean>("app.openDataDir"),
  auditTail: (lines = 40) => invoke<string[]>("security.auditTail", { lines }),
  checkpointsList: (sessionId: string) => invoke<CheckpointStatus[]>("checkpoints.list", { sessionId }),
  checkpointDiff: (sessionId: string, runId: string, path: string) => invoke<CheckpointDiff>("checkpoints.diff", { sessionId, runId, path }),
  checkpointRestore: (sessionId: string, runId: string, path: string) => invoke<{ path: string; action: "restored" | "deleted" }>("checkpoints.restore", { sessionId, runId, path }),
  browserShow: (input: { url?: string; bounds: { x: number; y: number; width: number; height: number } }) => invoke<BrowserPageState>("browser.show", input),
  browserBounds: (bounds: { x: number; y: number; width: number; height: number }) => invoke<boolean>("browser.bounds", bounds),
  browserHide: () => invoke<boolean>("browser.hide"),
  browserNavigate: (url: string) => invoke<BrowserPageState>("browser.navigate", { url }),
  browserAction: (action: "back" | "forward" | "reload") => invoke<BrowserPageState>("browser.action", { action }),
  openExternal: (url: string) => invoke<boolean>("app.openExternal", { url }),
  onPush: (listener: (payload: PushPayload) => void) => window.openhack.onPush((payload) => listener(payload as PushPayload)),
};
