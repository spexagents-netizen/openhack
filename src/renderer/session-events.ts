import type { AgentEvent, ChatMessage, SessionRecord } from "../shared/contracts";

export function applyAgentEvent(session: SessionRecord, event: AgentEvent): SessionRecord {
  if (event.type === "message.started") {
    if (session.messages.some((message) => message.id === event.messageId)) return session;
    return {
      ...session,
      messages: [...session.messages, {
        id: event.messageId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.agentRole ? { agentRole: event.agentRole } : {}),
        ...(event.parentCallId ? { parentCallId: event.parentCallId } : {}),
      }],
      updatedAt: new Date().toISOString(),
    };
  }
  if (event.type === "text.delta") {
    return {
      ...session,
      messages: session.messages.map((message) => message.id === event.messageId
        ? { ...message, content: message.content + event.text }
        : message),
    };
  }
  if (event.type === "reasoning.delta") {
    return {
      ...session,
      messages: session.messages.map((message) => message.id === event.messageId
        ? { ...message, reasoning: (message.reasoning ?? "") + event.text }
        : message),
    };
  }
  if (event.type === "tool.started") {
    return {
      ...session,
      messages: session.messages.map((message) => {
        if (message.id !== event.messageId) return message;
        if (message.tool_calls?.some((call) => call.id === event.callId)) return message;
        return {
          ...message,
          tool_calls: [
            ...(message.tool_calls ?? []),
            { id: event.callId, type: "function", function: { name: event.name, arguments: event.argumentsJson } },
          ],
        };
      }),
    };
  }
  if (event.type === "tool.completed" || event.type === "tool.failed") {
    if (session.messages.some((message) => message.role === "tool" && message.tool_call_id === event.callId)) return session;
    const content = event.type === "tool.completed" ? event.result : JSON.stringify({ ok: false, error: event.error });
    return {
      ...session,
      messages: [...session.messages, {
        id: `tool-${event.callId}`,
        role: "tool",
        content,
        tool_call_id: event.callId,
        name: event.name,
        createdAt: new Date().toISOString(),
      }],
    };
  }
  return session;
}

export function optimisticUserMessage(content: string): ChatMessage {
  return { id: `local-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() };
}
