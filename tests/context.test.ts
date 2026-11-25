import { describe, expect, it } from "vitest";
import { boundContext } from "../src/main/agent/context";
import type { ChatMessage } from "../src/shared/contracts";

describe("context bounding", () => {
  it("keeps the system prompt and whole recent tool exchanges within a character budget", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old ".repeat(10000) },
      { role: "assistant", content: "old answer ".repeat(5000) },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "workspace_read", arguments: "{}" } }] },
      { role: "tool", content: "recent result", tool_call_id: "c" },
    ];
    const bounded = boundContext(messages, 8000);
    expect(bounded[0]?.content).toBe("system");
    expect(bounded.some((message) => message.content === "recent question")).toBe(true);
    expect(bounded.some((message) => message.role === "tool")).toBe(true);
    expect(bounded.some((message) => message.content.startsWith("old answer"))).toBe(false);
  });

  it("truncates a single huge tool response instead of sending unlimited output", () => {
    const bounded = boundContext([{ role: "tool", content: "x".repeat(500000), tool_call_id: "c" }]);
    expect(bounded[0]!.content.length).toBeLessThan(500000);
    expect(bounded[0]!.content).toContain("truncated");
  });
});
