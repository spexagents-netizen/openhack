import type { ChatMessage } from "../../shared/contracts";

const MAX_SINGLE_MESSAGE = 128000;

export function boundContext(messages: ChatMessage[], contextLimit?: number): ChatMessage[] {
  const normalized = messages.map((message) => ({
    ...message,
    content: message.content.length > MAX_SINGLE_MESSAGE
      ? `${message.content.slice(0, MAX_SINGLE_MESSAGE)}\n[older output truncated by OpenHack context control]`
      : message.content,
  }));
  if (!contextLimit || contextLimit <= 0) return normalized;

  const system = normalized.filter((message) => message.role === "system");
  const conversation = normalized.filter((message) => message.role !== "system");
  const units: ChatMessage[][] = [];
  for (let index = 0; index < conversation.length; index += 1) {
    const message = conversation[index]!;
    const unit = [message];
    if (message.role === "assistant" && message.tool_calls?.length) {
      while (conversation[index + 1]?.role === "tool") {
        index += 1;
        unit.push(conversation[index]!);
      }
    }
    units.push(unit);
  }
  const budget = Math.max(24000, Math.floor(contextLimit * 3.1));
  const kept: ChatMessage[][] = [];
  let used = estimate(system);
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    const size = estimate(unit);
    if (kept.length > 0 && used + size > budget) break;
    used += size;
    kept.unshift(unit);
  }
  return [...system, ...kept.flat()];
}

function estimate(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const argumentsSize = message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0;
    return total + message.content.length + (message.reasoning?.length ?? 0) + argumentsSize + 32;
  }, 0);
}
