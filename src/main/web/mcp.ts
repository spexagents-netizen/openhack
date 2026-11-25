import { BROWSER_UA } from "./ua";

/** Minimal Streamable-HTTP MCP client. One tool call, session reused across calls. */
export interface McpCall {
  url: string;
  tool: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  label?: string;
}

interface Session { id: string; at: number }

const SESSION_TTL_MS = 5 * 60 * 1000;
const sessions = new Map<string, Session>();

export function resetMcpSessions(): void {
  sessions.clear();
}

export async function callMcpTool(call: McpCall): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": BROWSER_UA,
    ...call.headers,
  };
  const cached = sessions.get(call.url);
  const usable = cached && Date.now() - cached.at < SESSION_TTL_MS ? cached.id : "";

  if (!usable) await initialize(call, headers);
  try {
    return await invoke(call, headers, sessions.get(call.url)?.id ?? "");
  } catch (error) {
    // A cached session can expire server-side. Re-handshake once, then give up.
    if (usable) {
      sessions.delete(call.url);
      await initialize(call, headers);
      return invoke(call, headers, sessions.get(call.url)?.id ?? "");
    }
    throw error;
  }
}

async function initialize(call: McpCall, headers: Record<string, string>): Promise<void> {
  const response = await call.fetchImpl(call.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: call.label ?? "openhack", version: "0.1.0" },
      },
    }),
    signal: bound(call.signal, call.timeoutMs),
  });
  if (!response.ok) throw new Error(`handshake HTTP ${response.status}`);
  const body = parseBody(await response.text());
  if (!body || typeof body !== "object" || !("result" in body)) throw new Error("handshake rejected");
  const id = response.headers.get("mcp-session-id") ?? "";
  if (id) sessions.set(call.url, { id, at: Date.now() });
  await call.fetchImpl(call.url, {
    method: "POST",
    headers: { ...headers, ...(id ? { "mcp-session-id": id } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: bound(call.signal, call.timeoutMs),
  }).catch(() => undefined);
}

async function invoke(call: McpCall, headers: Record<string, string>, session: string): Promise<string> {
  const response = await call.fetchImpl(call.url, {
    method: "POST",
    headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: call.tool, arguments: call.args },
    }),
    signal: bound(call.signal, call.timeoutMs),
  });
  if (!response.ok) throw new Error(`tool HTTP ${response.status}`);
  const body = parseBody(await response.text());
  if (!body || typeof body !== "object") throw new Error("empty tool response");
  if ("error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    throw new Error(error?.message?.slice(0, 160) ?? "tool error");
  }
  const content = (body as { result?: { content?: Array<{ type?: string; text?: string }> } }).result?.content;
  if (!Array.isArray(content)) throw new Error("no tool content");
  const text = content.map((part) => (typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
  if (!text) throw new Error("empty tool text");
  return text;
}

/** Streamable HTTP answers either a JSON document or an SSE stream. */
function parseBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try { return JSON.parse(data); } catch { /* keep scanning */ }
  }
  return null;
}

function bound(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}
