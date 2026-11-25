import type { ChatMessage } from "../shared/contracts";

export function timeAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function baseName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

export function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function toolArgumentSummary(name: string, raw: string): string {
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(args.tasks)) {
      return `${args.tasks.length} worker${args.tasks.length === 1 ? "" : "s"}`;
    }
    // "." is the workspace root; printing it reads as stray punctuation.
    const path = typeof args.path === "string" && args.path !== "." ? args.path : "";
    if (/write|replace|read/.test(name) && path) return path;
    if (/process|run/.test(name) && typeof args.executable === "string") {
      const rest = Array.isArray(args.args) ? args.args.join(" ") : "";
      return `${args.executable}${rest ? ` ${rest}` : ""}`.slice(0, 180);
    }
    if (typeof args.query === "string") return args.query;
    if (typeof args.path === "string") return path;
    return Object.keys(args).slice(0, 3).join(", ") || "no arguments";
  } catch {
    return "unreadable arguments";
  }
}

export function toolResultFor(sessionMessages: ChatMessage[], callId: string): ChatMessage | undefined {
  return sessionMessages.find((message) => message.role === "tool" && message.tool_call_id === callId);
}

export function shortPath(value: string, max = 46): string {
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
