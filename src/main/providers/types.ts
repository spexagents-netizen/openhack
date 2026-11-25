import type { ChatMessage, ModelEvent, ToolDefinition } from "../../shared/contracts";

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  /** "off" omits the field; anything else is sent as reasoning_effort. */
  reasoningEffort?: string;
}

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
