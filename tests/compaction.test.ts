import { describe, expect, it } from "vitest";
import { compactHistory, estimateChars } from "../src/main/agent/compaction";
import type { ChatMessage } from "../src/shared/contracts";

function conversation(turns: number, filler = 400): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "user", content: `question ${index} ${"x".repeat(filler)}` });
    messages.push({
      role: "assistant",
      content: `answer ${index}`,
      tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"a.ts\"}" } }],
    });
    messages.push({ role: "tool", content: `result ${index} ${"y".repeat(filler)}`, tool_call_id: `call-${index}`, name: "workspace_read" });
  }
  return messages;
}

describe("context compaction", () => {
  it("leaves a conversation under the trigger untouched", () => {
    const history = conversation(2, 20);
    const result = compactHistory({ history, budgetChars: 100_000 });
    expect(result.compacted).toBe(false);
    expect(result.history).toBe(history);
    expect(result.omitted).toBe(0);
  });

  it("summarizes older turns, keeps recent ones, and returns a durable summary", () => {
    const history = conversation(40, 500);
    const result = compactHistory({ history, budgetChars: 40_000 });
    expect(result.compacted).toBe(true);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.summary).toMatch(/operator asked: question \d+/u);
    expect(result.summary).toContain("workspace_read");
    expect(result.history[0]).toMatchObject({ role: "system" });
    expect(result.history[0]?.content).toContain("Compacted session summary");
    expect(result.history.length).toBeLessThan(history.length);
    expect(result.history.at(-1)?.content).toContain("result 39");
    expect(estimateChars(result.history)).toBeLessThan(estimateChars(history));
  });

  it("merges with an existing summary and caps its size", () => {
    const existing = "prior note ".repeat(900);
    const result = compactHistory({ history: conversation(30, 400), budgetChars: 30_000, summary: existing });
    expect(result.compacted).toBe(true);
    expect(result.summary!.length).toBeLessThanOrEqual(8000);
    expect(result.summary).toContain("prior note");
  });
});
