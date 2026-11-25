import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  PermissionMode,
  ProviderToolCall,
  ToolDefinition,
  ToolRisk,
} from "../../shared/contracts";
import type { ModelProvider } from "../providers/types";
import type { Workspace } from "../workspace/workspace";
import { builtinToolDefinitions, executeBuiltinTool } from "./builtin-tools";
import { boundContext } from "./context";
import type { WebRuntime } from "../web";
import type { ToolDirectory } from "./directory";
import type { SkillRegistry } from "../skills/registry";
import { isSwitchboardTool, runSwitchboard, switchboardDefinitions } from "./switchboard";

export interface ApprovalPrompt {
  approvalId: string;
  callId: string;
  name: string;
  argumentsJson: string;
  risk: ToolRisk;
}

export interface AgentRunRequest {
  provider: ModelProvider;
  model: string;
  input: string;
  history: ChatMessage[];
  workspace: Workspace;
  signal: AbortSignal;
  tools?: ToolDefinition[];
  callExternalTool?: (name: string, args: unknown, signal: AbortSignal, callId: string) => Promise<string>;
  runId?: string;
  contextLimit?: number;
  maxOutputTokens?: number;
  web?: WebRuntime;
  /** Plan mode removes every mutating tool before the model ever sees it. */
  mode?: AgentMode;
  /** When present, external tools are reachable through the switchboard instead of being injected. */
  directory?: ToolDirectory;
  /** Workflow playbooks the run can search and load on demand. */
  skills?: SkillRegistry;
  /** Reasoning effort for this run, forwarded to the provider. */
  reasoningEffort?: string;
}

export interface AgentRunResult {
  runId: string;
  text: string;
  messages: ChatMessage[];
}

export class AgentEngine {
  private readonly permission: PermissionMode;
  private readonly requestApproval?: (prompt: ApprovalPrompt) => Promise<boolean>;

  constructor(options: {
    permission: PermissionMode;
    requestApproval?: (prompt: ApprovalPrompt) => Promise<boolean>;
  }) {
    this.permission = options.permission;
    this.requestApproval = options.requestApproval;
  }

  async run(request: AgentRunRequest, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    const runId = request.runId ?? randomUUID();
    const produced: ChatMessage[] = [];
    const working: ChatMessage[] = [...request.history, { role: "user", content: request.input }];
    const planMode = request.mode === "plan";
    // With a directory, MCP and bus tools stay behind tool_search/tool_call so a
    // 229-tool server costs five verbs instead of megabytes of schema. Plan mode
    // keeps tool_call visible because the target's own risk decides the block.
    const direct = request.directory
      ? [
          ...builtinToolDefinitions(),
          ...switchboardDefinitions(),
          ...(request.tools ?? []).filter((tool) => tool.name.replace(/\./g, "_") === "agent_spawn"),
        ]
      : [...builtinToolDefinitions(), ...(request.tools ?? [])];
    const definitions = deduplicateTools(direct)
      .filter((tool) => !planMode || tool.risk === "read" || tool.name === "tool_call");
    const riskByName = new Map(definitions.map((tool) => [tool.name, tool.risk]));
    for (const tool of builtinToolDefinitions()) {
      riskByName.set(tool.name, tool.risk);
      riskByName.set(tool.name.replace(/_/g, "."), tool.risk);
    }
    let finalText = "";

    emit({ type: "run.started", runId });
    try {
      // No step ceiling: a run ends when the model returns a final answer or
      // the operator cancels it. A model that keeps calling tools keeps running.
      for (;;) {
        if (request.signal.aborted) throw new Error("Run cancelled");
        const messageId = randomUUID();
        const assistant: ChatMessage = { id: messageId, role: "assistant", content: "", createdAt: new Date().toISOString() };
        working.push(assistant);
        produced.push(assistant);
        emit({ type: "message.started", messageId });

        const calls: ProviderToolCall[] = [];
        for await (const event of request.provider.stream({
          model: request.model,
          messages: boundContext(
            working.filter((message) => message.role !== "assistant" || message.content || message.tool_calls?.length),
            request.contextLimit,
          ),
          tools: definitions,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
        }, request.signal)) {
          if (request.signal.aborted) throw new Error("Run cancelled");
          if (event.type === "text.delta") {
            assistant.content += event.text;
            emit({ type: "text.delta", messageId, text: event.text });
          } else if (event.type === "reasoning.delta") {
            assistant.reasoning = (assistant.reasoning ?? "") + event.text;
            emit({ type: "reasoning.delta", messageId, text: event.text });
          } else if (event.type === "tool.completed") {
            calls.push({
              id: event.callId,
              type: "function",
              function: { name: event.name, arguments: event.argumentsJson },
            });
          }
        }
        if (calls.length) assistant.tool_calls = calls;
        emit({ type: "message.completed", messageId });
        if (!calls.length) {
          finalText = assistant.content;
          emit({ type: "run.completed", runId, text: finalText });
          return { runId, text: finalText, messages: produced };
        }

        for (const call of calls) {
          if (request.signal.aborted) throw new Error("Run cancelled");
          const name = call.function.name;
          // A routed call is approved for what it will actually do, not for the
          // router verb. tool_call carries the real target's risk.
          let risk = riskByName.get(name) ?? "execute";
          if (name.replace(/\./g, "_") === "tool_call" && request.directory) {
            try {
              const probe = JSON.parse(call.function.arguments || "{}") as { name?: unknown };
              risk = request.directory.risk(typeof probe.name === "string" ? probe.name : "") ?? "execute";
            } catch {
              risk = "execute";
            }
          }
          const approvalId = randomUUID();
          emit({ type: "tool.started", messageId, callId: call.id, name, argumentsJson: call.function.arguments, risk });
          if (planMode && risk !== "read") {
            const reason = "Plan mode is read-only. Switch the session to Act to execute this tool.";
            const blocked = toolResultMessage(call, JSON.stringify({ ok: false, error: reason }));
            working.push(blocked);
            produced.push(blocked);
            emit({ type: "tool.failed", callId: call.id, name, error: reason });
            continue;
          }
          if (this.requiresApproval(risk)) {
            emit({ type: "tool.approval", callId: call.id, approvalId, name, argumentsJson: call.function.arguments, risk });
            const approved = this.requestApproval
              ? await this.requestApproval({ approvalId, callId: call.id, name, argumentsJson: call.function.arguments, risk })
              : false;
            if (!approved) {
              const denied = JSON.stringify({ ok: false, error: "Denied by operator" });
              const toolMessage = toolResultMessage(call, denied);
              working.push(toolMessage);
              produced.push(toolMessage);
              emit({ type: "tool.failed", callId: call.id, name, error: "Denied by operator" });
              continue;
            }
          }
          try {
            const args: unknown = JSON.parse(call.function.arguments || "{}");
            const result = isSwitchboardTool(name)
              ? await runSwitchboard(name, args, {
                  ...(request.directory ? { directory: request.directory } : {}),
                  ...(request.skills ? { skills: request.skills } : {}),
                  callTool: (target, targetArgs) => this.executeExternal(target, targetArgs, request, definitions, call.id),
                })
              : isBuiltin(name)
                ? await executeBuiltinTool(name, args, request.workspace, request.signal, request.web)
                : await this.executeExternal(name, args, request, definitions, call.id);
            const toolMessage = toolResultMessage(call, result);
            working.push(toolMessage);
            produced.push(toolMessage);
            emit({ type: "tool.completed", callId: call.id, name, result });
          } catch (error) {
            const message = safeMessage(error);
            const failed = toolResultMessage(call, JSON.stringify({ ok: false, error: message }));
            working.push(failed);
            produced.push(failed);
            emit({ type: "tool.failed", callId: call.id, name, error: message });
          }
        }
      }
    } catch (error) {
      const message = request.signal.aborted ? "Run cancelled" : safeMessage(error);
      emit({ type: "run.failed", runId, error: message });
      throw new Error(message);
    }
  }

  private requiresApproval(risk: ToolRisk): boolean {
    if (this.permission === "autonomous") return false;
    if (this.permission === "workspace") return risk === "execute";
    return risk !== "read";
  }

  private async executeExternal(name: string, args: unknown, request: AgentRunRequest, definitions: ToolDefinition[], callId: string): Promise<string> {
    const exposed = definitions.some((tool) => tool.name === name && !isBuiltin(name));
    if (!exposed && !request.directory?.has(name)) throw new Error(`Tool is not available: ${name}`);
    if (!request.callExternalTool) throw new Error(`External tool bridge is unavailable for ${name}`);
    return request.callExternalTool(name, args, request.signal, callId);
  }
}

function toolResultMessage(call: ProviderToolCall, content: string): ChatMessage {
  return {
    id: randomUUID(),
    role: "tool",
    content,
    tool_call_id: call.id,
    name: call.function.name,
    createdAt: new Date().toISOString(),
  };
}

function isBuiltin(name: string): boolean {
  return /^(workspace|process|web)[._]/.test(name) || name.replace(/\./g, "_") === "apply_patch";
}

function deduplicateTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
