import type { ModelEvent } from "../../shared/contracts";

interface PendingCall { callId: string; name: string; argumentsJson: string }

export class OpenAIStreamParser {
  private buffer = "";
  private readonly calls = new Map<number, PendingCall>();
  private finished = false;

  push(chunk: string): ModelEvent[] {
    this.buffer += chunk;
    const events: ModelEvent[] = [];
    let boundary = this.buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      events.push(...this.consumeBlock(block));
      boundary = this.buffer.search(/\r?\n\r?\n/);
    }
    return events;
  }

  finish(): ModelEvent[] {
    const events: ModelEvent[] = [];
    if (this.buffer.trim()) {
      events.push(...this.consumeBlock(this.buffer));
      this.buffer = "";
    }
    events.push(...(this.finished ? [] : this.complete("stop")));
    return events;
  }

  private consumeBlock(block: string): ModelEvent[] {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return [];
    if (data.trim() === "[DONE]") return this.complete("stop");
    const payload = JSON.parse(data) as Record<string, unknown>;
    if (payload.error) throw new Error(extractError(payload.error));
    const events: ModelEvent[] = [];
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const record = choice as Record<string, unknown>;
      const delta = record.delta && typeof record.delta === "object" ? record.delta as Record<string, unknown> : {};
      const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : delta;
      if (typeof message.content === "string" && message.content) events.push({ type: "text.delta", text: message.content });
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string" && reasoning) events.push({ type: "reasoning.delta", text: reasoning });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) this.accumulateToolCall(call);
      if (typeof record.finish_reason === "string") {
        const reason = record.finish_reason === "tool_calls" ? "tool_calls" : record.finish_reason === "stop" ? "stop" : record.finish_reason === "length" ? "length" : "other";
        events.push(...this.completeTools(), { type: "finished", reason });
        this.finished = true;
      }
    }
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : undefined;
    if (usage) {
      events.push({
        type: "usage",
        ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
        ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
      });
    }
    return events;
  }

  private accumulateToolCall(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const call = value as Record<string, unknown>;
    const index = typeof call.index === "number" ? call.index : 0;
    const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
    const current = this.calls.get(index) ?? { callId: `call_${index}`, name: "", argumentsJson: "" };
    if (typeof call.id === "string" && call.id) current.callId = call.id;
    if (typeof fn.name === "string" && fn.name) current.name = fn.name;
    if (typeof fn.arguments === "string") current.argumentsJson += fn.arguments;
    this.calls.set(index, current);
  }

  private completeTools(): ModelEvent[] {
    const events = [...this.calls.values()].map((call): ModelEvent => {
      if (!call.name) throw new Error("Tool call is missing a function name");
      let parsed: unknown;
      try { parsed = JSON.parse(call.argumentsJson || "{}"); } catch { throw new Error(`Malformed tool arguments for ${call.name}`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Tool arguments for ${call.name} must be a JSON object`);
      return { type: "tool.completed", callId: call.callId, name: call.name, argumentsJson: call.argumentsJson || "{}" };
    });
    this.calls.clear();
    return events;
  }

  private complete(reason: "stop" | "tool_calls" | "length" | "other"): ModelEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [...this.completeTools(), { type: "finished", reason }];
  }
}

function extractError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "Provider stream failed";
}
