import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/main/storage/sessions";

describe("SessionStore", () => {
  it("durably stores sessions, streamed messages, tool calls and interrupted runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-sessions-"));
    const store = await SessionStore.open(directory);
    const session = await store.createSession({ id: "session-1", workspacePath: "C:\\workspace", providerId: "modal-kimi", model: "kimi", mode: "plan" });
    expect(session.title).toBe("New investigation");
    expect(session.mode).toBe("plan");
    await store.updateSession(session.id, { title: "Proof run", mode: "act" });
    await store.appendMessage(session.id, { id: "user-1", role: "user", content: "Inspect" });
    await store.appendMessage(session.id, { id: "assistant-1", role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"a\"}" } }] });
    store.appendDelta("assistant-1", "content", "Reading");
    await store.startRun("run-1", session.id, "kimi");
    await store.flush();
    await store.close();

    const reopened = await SessionStore.open(directory);
    try {
      const loaded = reopened.getSession(session.id);
      expect(loaded?.title).toBe("Proof run");
      expect(loaded?.mode).toBe("act");
      expect(loaded?.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
      expect(loaded?.messages[1]?.content).toBe("Reading");
      expect(loaded?.messages[1]?.tool_calls?.[0]?.function.name).toBe("workspace_read");
      expect(reopened.listSessions()[0]?.messageCount).toBe(2);
    } finally {
      await reopened.close();
    }
  });

  it("marks stale running jobs interrupted on startup and supports deletion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-recovery-"));
    const store = await SessionStore.open(directory);
    const session = await store.createSession({ workspacePath: "C:\\work", providerId: "p", model: "m" });
    await store.startRun("run", session.id, "m");
    await store.close();
    const reopened = await SessionStore.open(directory);
    await reopened.deleteSession(session.id);
    expect(reopened.getSession(session.id)).toBeNull();
    expect(reopened.listSessions()).toEqual([]);
    await reopened.close();
  });
});
