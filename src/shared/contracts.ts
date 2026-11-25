export type PermissionMode = "supervised" | "workspace" | "autonomous";
export type ToolRisk = "read" | "write" | "execute";
export type SessionKind = "chat" | "bus";
export type AgentMode = "plan" | "act";

export type BusMessageKind = "message" | "task" | "result" | "system";
export type BusAgentState = "idle" | "queued" | "working" | "error" | "disabled";

export interface BusAgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  enabled: boolean;
  providerId?: string;
  model?: string;
}

export interface BusAgentStatus extends BusAgentConfig {
  state: BusAgentState;
  detail?: string;
  lastAt?: string;
}

export interface BusMessage {
  id: string;
  channel: string;
  sender: string;
  recipient?: string;
  kind: BusMessageKind;
  content: string;
  hops?: number;
  runId?: string;
  createdAt?: string;
}

export interface BusChannel {
  channel: string;
  messageCount: number;
  lastAt?: string;
}

export interface BusMemoryEntry {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
}

export interface CheckpointFileStatus {
  path: string;
  existedBefore: boolean;
  changed: boolean;
  capturedAt: string;
}

export interface CheckpointStatus {
  sessionId: string;
  runId: string;
  createdAt: string;
  files: CheckpointFileStatus[];
}

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface CheckpointDiff {
  path: string;
  existedBefore: boolean;
  added: number;
  removed: number;
  truncated: boolean;
  lines: DiffLine[];
}

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface BusSnapshot {
  channels: BusChannel[];
  agents: BusAgentStatus[];
  memory: BusMemoryEntry[];
  messages: BusMessage[];
  activeChannel: string;
  maxHops: number;
  concurrency: number;
  webhookUrl?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  tools: boolean;
  context?: number;
  output?: number;
  reasoning?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models: ProviderModel[];
  maxTokensField: "max_tokens" | "max_completion_tokens";
  headerTimeoutMs: number;
  chunkTimeoutMs: number;
  source?: "opencode" | "manual";
}

export type PublicProviderConfig = Omit<ProviderConfig, "apiKey"> & { hasApiKey: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: ToolRisk;
}

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  createdAt?: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Set on messages produced by a dynamically spawned worker. */
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  parentCallId?: string;
}

export interface SpawnTaskSpec {
  name?: string;
  role?: string;
  brief: string;
  model?: string;
}

export interface SpawnWorkerResult {
  id: string;
  name: string;
  role: string;
  model: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  error?: string;
}

export type ModelEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.completed"; callId: string; name: string; argumentsJson: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "finished"; reason: "stop" | "tool_calls" | "length" | "other" };

export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.started"; messageId: string; agentId?: string; agentName?: string; agentRole?: string; parentCallId?: string }
  | { type: "text.delta"; messageId: string; text: string; agentId?: string; agentName?: string }
  | { type: "reasoning.delta"; messageId: string; text: string; agentId?: string; agentName?: string }
  | { type: "tool.started"; messageId: string; callId: string; name: string; argumentsJson: string; risk: ToolRisk; agentId?: string; agentName?: string }
  | { type: "tool.approval"; callId: string; approvalId: string; name: string; argumentsJson: string; risk: ToolRisk; agentId?: string; agentName?: string }
  | { type: "tool.completed"; callId: string; name: string; result: string; agentId?: string; agentName?: string }
  | { type: "tool.failed"; callId: string; name: string; error: string; agentId?: string; agentName?: string }
  | { type: "message.completed"; messageId: string; agentId?: string; agentName?: string }
  | { type: "subagent.started"; workerId: string; name: string; role: string; model: string; parentCallId: string; taskCount: number }
  | { type: "subagent.completed"; workerId: string; name: string; status: "completed" | "failed" | "cancelled"; summary: string; durationMs: number }
  | { type: "run.completed"; runId: string; text: string }
  | { type: "run.failed"; runId: string; error: string };

export interface SessionSummary {
  id: string;
  title: string;
  workspacePath: string;
  providerId: string;
  model: string;
  kind?: SessionKind;
  mode?: AgentMode;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface SessionRecord extends SessionSummary {
  messages: ChatMessage[];
  /** Durable compacted summary of older turns, if any. */
  summary?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  /** stdio transport: the executable to launch. Omit for a remote server. */
  command?: string;
  args?: string[];
  /** Streamable HTTP transport: the MCP endpoint. Takes precedence over command. */
  url?: string;
  /** Extra request headers for a remote server; encrypted at rest like env. */
  headers?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpServerStatus extends Omit<McpServerConfig, "env"> {
  state: "stopped" | "starting" | "ready" | "failed";
  tools: ToolDefinition[];
  error?: string;
  envKeys: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  systemPrompt?: string;
  commands?: Array<{ name: string; description: string; prompt: string }>;
  permissions?: string[];
}

export interface PluginStatus extends PluginManifest {
  enabled: boolean;
  path: string;
}

export interface AppSettings {
  permission: PermissionMode;
  systemPrompt: string;
  lastWorkspace?: string;
  activeProviderId?: string;
  activeModel?: string;
  /** Optional self-hosted or trusted SearXNG instance used before the public rotation. */
  searxngUrl?: string;
  /** Outbound fetch policy for agent-driven requests. */
  egressPolicy?: "open" | "block-metadata" | "block-private";
  /** Reasoning effort forwarded to providers that support it. */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  /** Most recent project folders, newest first. */
  recentWorkspaces?: string[];
  hasExaKey?: boolean;
  hasTinyfishKey?: boolean;
  /** Agent roster and per-agent model bindings for the bus. */
  busAgents?: BusAgentConfig[];
  /** Shared webhook entry point so external events can wake the bus. */
  busWebhookToken?: string;
}

export interface BootstrapData {
  app: { name: string; version: string; platform: string; dataDir: string };
  providers: PublicProviderConfig[];
  sessions: SessionSummary[];
  settings: AppSettings;
  mcpServers: McpServerStatus[];
  plugins: PluginStatus[];
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  callId: string;
  name: string;
  argumentsJson: string;
  risk: ToolRisk;
  /** SHA-256 over actor, run, call, tool, normalized args, workspace, policy version. */
  digest?: string;
  expiresAt?: string;
  agentName?: string;
}

export interface PersistedApproval {
  id: string;
  sessionId: string;
  runId: string;
  callId: string;
  tool: string;
  argumentsJson: string;
  risk: string;
  digest: string;
  agentName?: string;
  workspace: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  decidedAt?: string;
}
