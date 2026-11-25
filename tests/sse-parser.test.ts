import { describe, expect, it } from "vitest";
import { OpenAIStreamParser } from "../src/main/providers/sse";

describe("OpenAIStreamParser", () => {
  it("keeps text, reasoning and fragmented tool calls separate across arbitrary chunks", () => {
    const parser = new OpenAIStreamParser();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Inspect ","reasoning_content":"plan"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"workspace.read","arguments":"{\\"path\\":\\"src/"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"index.ts\\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"workspace.list","arguments":"{}"}}]}}]}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    ];
    const events = chunks.flatMap((chunk) => parser.push(chunk));
    expect(events).toContainEqual({ type: "text.delta", text: "Inspect " });
    expect(events).toContainEqual({ type: "reasoning.delta", text: "plan" });
    expect(events).toContainEqual({ type: "tool.completed", callId: "call_1", name: "workspace.read", argumentsJson: '{"path":"src/index.ts"}' });
    expect(events).toContainEqual({ type: "tool.completed", callId: "call_2", name: "workspace.list", argumentsJson: "{}" });
  });

  it("handles CRLF, comments and multiline SSE data", () => {
    const parser = new OpenAIStreamParser();
    const events = parser.push(': heartbeat\r\ndata: {"choices":[{"delta":\r\ndata: {"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(events).toContainEqual({ type: "text.delta", text: "ok" });
    expect(events.at(-1)).toEqual({ type: "finished", reason: "stop" });
  });

  it("rejects malformed final tool arguments instead of executing them", () => {
    const parser = new OpenAIStreamParser();
    expect(() => parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad","function":{"name":"x","arguments":"{broken"}}]}}]}\n\ndata: [DONE]\n\n')).toThrow(/arguments/i);
  });
});
