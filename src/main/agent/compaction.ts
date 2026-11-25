import type { ChatMessage } from "../../shared/contracts";

export interface CompactionInput {
  history: ChatMessage[];
  /** Approximate character budget for the model context. */
  budgetChars: number;
  /** Existing durable summary for this session. */
  summary?: string;
}

export interface CompactionResult {
  history: ChatMessage[];
  summary?: string;
  compacted: boolean;
  omitted: number;
}

const MIN_KEEP = 12;

/**
 * Deterministic, model-free compaction: summarize the older half into durable
 * lines, keep a window of recent complete turns, and let the engine's token
 * bound trim anything that still exceeds the target.
 */
export function compactHistory(input: CompactionInput): CompactionResult {
  const total = estimateChars(input.history);
  const trigger = Math.floor(input.budgetChars * 0.75);
  if (total <= trigger) return { history: input.history, ...(input.summary ? { summary: input.summary } : {}), compacted: false, omitted: 0 };

  const keepTarget = Math.max(Math.floor(trigger * 0.5), 1);
  const kept: ChatMessage[] = [];
  let keptChars = 0;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index]!;
    const size = messageChars(message);
    if (kept.length >= MIN_KEEP && keptChars + size > keepTarget) break;
    kept.unshift(message);
    keptChars += size;
  }
  const omitted = input.history.length - kept.length;
  if (!omitted) return { history: input.history, ...(input.summary ? { summary: input.summary } : {}), compacted: false, omitted: 0 };

  const lines = input.history.slice(0, omitted).map(summaryLine).filter(Boolean);
  const merged = mergeSummary(input.summary, lines);
  return {
    history: [
      ...(merged ? [{ role: "system" as const, content: `Compacted session summary:\n${merged}` }] : []),
      ...kept,
    ],
    ...(merged ? { summary: merged } : {}),
    compacted: true,
    omitted,
  };
}

export function estimateChars(history: ChatMessage[]): number {
  return history.reduce((total, message) => total + messageChars(message), 0);
}

function messageChars(message: ChatMessage): number {
  const calls = message.tool_calls?.reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0) ?? 0;
  return message.content.length + (message.reasoning?.length ?? 0) + calls + 32;
}

function summaryLine(message: ChatMessage): string {
  if (message.role === "user") return `- operator asked: ${clip(message.content, 200)}`;
  if (message.role === "assistant") {
    const tools = message.tool_calls?.map((call) => call.function.name).join(", ");
    return `- assistant${tools ? ` called ${clip(tools, 120)}` : ""}${message.content ? `: ${clip(message.content, 140)}` : ""}`;
  }
  if (message.role === "tool") return `- ${message.name ?? "tool"} returned ${clip(message.content, 120)}`;
  if (message.role === "system") return "";
  return "";
}

function mergeSummary(existing: string | undefined, lines: string[]): string {
  const combined = [...(existing ? [existing] : []), ...lines].join("\n");
  if (combined.length <= 8000) return combined;
  return combined.slice(combined.length - 8000);
}

function clip(value: string, size: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > size ? `${clean.slice(0, size)}…` : clean;
}
