import { createHash, randomUUID } from "node:crypto";

export interface ApprovalInput {
  /** The id already announced to the UI; keeps the dialog and the gate in sync. */
  id?: string;
  runId: string;
  callId: string;
  tool: string;
  argumentsJson: string;
  risk: string;
  workspace: string;
  /** Short label shown in the dialog, e.g. the worker that requested it. */
  agentName?: string;
}

export interface ApprovalRecord extends ApprovalInput {
  id: string;
  digest: string;
  argsHash: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
}

export type ConsumeResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: "unknown" | "expired" | "already-consumed" };

/**
 * Approvals are capabilities, not booleans. Each record is bound to the actor,
 * run, tool call, exact arguments, workspace and policy version, expires, and is
 * consumed atomically before execution so a replayed id can never authorize a
 * second action.
 */
export class ApprovalGate {
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(
    private readonly policyVersion: string,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  open(input: ApprovalInput): ApprovalRecord {
    const argsHash = hashArguments(input.argumentsJson);
    const issued = this.now();
    const digest = createHash("sha256")
      .update(canonicalJson({
        v: 1,
        policy: this.policyVersion,
        runId: input.runId,
        callId: input.callId,
        tool: input.tool,
        risk: input.risk,
        argsHash,
        workspace: input.workspace,
        agent: input.agentName ?? "",
      }))
      .digest("hex");
    const record: ApprovalRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      digest,
      argsHash,
      policyVersion: this.policyVersion,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + this.ttlMs).toISOString(),
    };
    this.records.set(record.id, record);
    return record;
  }

  /** Verifies and consumes in one step. Denial consumes too — one decision per record. */
  consume(id: string): ConsumeResult {
    const record = this.records.get(id);
    if (!record) return { ok: false, reason: "unknown" };
    this.records.delete(id);
    if (this.now() >= Date.parse(record.expiresAt)) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  cancelRun(runId: string): string[] {
    const removed: string[] = [];
    for (const [id, record] of this.records) {
      if (record.runId !== runId) continue;
      this.records.delete(id);
      removed.push(id);
    }
    return removed;
  }

  pending(runId?: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (runId && record.runId !== runId) continue;
      count += 1;
    }
    return count;
  }
}

/** Deterministic JSON for hashing: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Hashes parsed arguments so key order and whitespace cannot change the digest. */
export function hashArguments(argumentsJson: string): string {
  let normalized: string;
  try {
    normalized = canonicalJson(JSON.parse(argumentsJson || "{}"));
  } catch {
    normalized = argumentsJson;
  }
  return createHash("sha256").update(normalized).digest("hex");
}
