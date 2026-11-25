export type RunState =
  | { status: "idle"; runId: string }
  | { status: "streaming"; runId: string }
  | { status: "awaiting-approval"; runId: string; callId: string }
  | { status: "tools"; runId: string }
  | { status: "completed"; runId: string }
  | { status: "failed"; runId: string; error: string }
  | { status: "cancelled"; runId: string };

export type RunEvent =
  | { type: "model.started" }
  | { type: "approval.requested"; callId: string }
  | { type: "approval.decided"; approved: boolean }
  | { type: "tools.completed" }
  | { type: "model.finished" }
  | { type: "failed"; error: string }
  | { type: "cancelled" };

export function initialRunState(runId: string): RunState {
  return { status: "idle", runId };
}

export function transitionRun(state: RunState, event: RunEvent): RunState {
  if (event.type === "cancelled" && !["completed", "failed", "cancelled"].includes(state.status)) {
    return { status: "cancelled", runId: state.runId };
  }
  if (event.type === "failed" && !["completed", "failed", "cancelled"].includes(state.status)) {
    return { status: "failed", runId: state.runId, error: event.error };
  }
  switch (state.status) {
    case "idle":
      return event.type === "model.started" ? { status: "streaming", runId: state.runId } : state;
    case "streaming":
      if (event.type === "approval.requested") return { status: "awaiting-approval", runId: state.runId, callId: event.callId };
      if (event.type === "model.finished") return { status: "completed", runId: state.runId };
      return state;
    case "awaiting-approval":
      return event.type === "approval.decided" ? { status: "tools", runId: state.runId } : state;
    case "tools":
      return event.type === "tools.completed" ? { status: "streaming", runId: state.runId } : state;
    default:
      return state;
  }
}
