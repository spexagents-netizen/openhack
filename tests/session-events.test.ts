import { describe, expect, it } from "vitest";
import { applyAgentEvent } from "../src/renderer/session-events";
import type { SessionRecord } from "../src/shared/contracts";

const session: SessionRecord = {
  id: "s",
  title: "Test",
  workspacePath: "C:\\work",
  providerId: "p",
  model: "m",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  messages: [],
};

describe("renderer agent event reduction", () => {
  it("streams text and merges tool lifecycle without duplicate rows", () => {
    let current = applyAgentEvent(session, { type: "message.started", messageId: "a" });
    current = applyAgentEvent(current, { type: "text.delta", messageId: "a", text: "Reading" });
    current = applyAgentEvent(current, { type: "tool.started", messageId: "a", callId: "c", name: "workspace_read", argumentsJson: "{}", risk: "read" });
    current = applyAgentEvent(current, { type: "tool.completed", callId: "c", name: "workspace_read", result: "{\"ok\":true}" });
    const again = applyAgentEvent(current, { type: "tool.completed", callId: "c", name: "workspace_read", result: "duplicate" });
    expect(again.messages).toHaveLength(2);
    expect(again.messages[0]?.content).toBe("Reading");
    expect(again.messages[0]?.tool_calls?.[0]?.id).toBe("c");
    expect(again.messages[1]?.role).toBe("tool");
  });
});
