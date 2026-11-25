import { describe, expect, it } from "vitest";
import { initialRunState, transitionRun } from "../src/main/agent/run-machine";

describe("run state machine", () => {
  it("moves through model, approval, tools and completion without impossible transitions", () => {
    const idle = initialRunState("run-1");
    const streaming = transitionRun(idle, { type: "model.started" });
    expect(streaming.status).toBe("streaming");
    const approval = transitionRun(streaming, { type: "approval.requested", callId: "call-1" });
    expect(approval).toMatchObject({ status: "awaiting-approval", callId: "call-1" });
    const tools = transitionRun(approval, { type: "approval.decided", approved: true });
    expect(tools.status).toBe("tools");
    const next = transitionRun(tools, { type: "tools.completed" });
    expect(next.status).toBe("streaming");
    const done = transitionRun(next, { type: "model.finished" });
    expect(done.status).toBe("completed");
    expect(transitionRun(done, { type: "model.started" })).toBe(done);
  });

  it("cancellation is terminal from active states", () => {
    const running = transitionRun(initialRunState("run-2"), { type: "model.started" });
    expect(transitionRun(running, { type: "cancelled" }).status).toBe("cancelled");
  });
});
