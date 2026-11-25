// Keyless provider probe: mirrors the endpoints OpenCode's WebSearch plugins call.
// Read-only measurements, no credentials, values never printed.
import { performance } from "node:perf_hooks";

const QUERY = "Node.js latest LTS release";
const LIMIT_MS = 20000;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const count = await fn();
    return { label, ok: true, ms: Math.round(performance.now() - t0), count };
  } catch (error) {
    return { label, ok: false, ms: Math.round(performance.now() - t0), error: String(error.message ?? error).slice(0, 90) };
  }
}

function parseMcp(text) {
  const events = text.split(/\n\n/);
  for (const event of events) {
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        try { return JSON.parse(line.slice(5).trim()); } catch { /* next */ }
      }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function mcpSearch(url, tool, args, headers = {}) {
  const { signal, done } = withTimeout(LIMIT_MS);
  try {
    const init = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "Mozilla/5.0", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhack-bench", version: "0.0.0" } } }),
    });
    const session = init.headers.get("mcp-session-id") ?? "";
    const initBody = parseMcp(await init.text());
    if (!init.ok) throw new Error(`init HTTP ${init.status}`);
    if (!initBody?.result) throw new Error("init rejected");
    const extra = session ? { "mcp-session-id": session } : {};
    await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
    const call = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    if (!call.ok) throw new Error(`call HTTP ${call.status}`);
    const body = parseMcp(await call.text());
    if (body?.error) throw new Error(body.error.message ?? "tool error");
    const content = body?.result?.content;
    if (!Array.isArray(content)) throw new Error("no content");
    const text = content.map((part) => part.text ?? "").join("\n");
    return (text.match(/https?:\/\//g) ?? []).length;
  } finally {
    done();
  }
}

const results = [];

results.push(await timed("tavily-keyless", async () => {
  const { signal, done } = withTimeout(LIMIT_MS);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
        "x-client-name": "opencode2",
        "x-tavily-access-mode": "keyless",
      },
      body: JSON.stringify({ query: QUERY, search_depth: "basic", chunks_per_source: 3, max_results: 8 }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.results ?? []).length;
  } finally { done(); }
}));

results.push(await timed("exa-mcp-keyless", () => mcpSearch("https://mcp.exa.ai/mcp", "web_search_exa", { query: QUERY, numResults: 8 })));
results.push(await timed("tinyfish-mcp-keyless", () => mcpSearch("https://agent.tinyfish.ai/mcp", "search", { query: QUERY }, { "x-tinyfish-access-mode": "keyless" })));
results.push(await timed("parallel-mcp-keyless", () => mcpSearch("https://search.parallel.ai/mcp", "web_search", { objective: QUERY, search_queries: [QUERY], model_name: "speed" })));
results.push(await timed("firecrawl-mcp-keyless", () => mcpSearch("https://mcp.firecrawl.dev/v2/mcp", "firecrawl_search", { query: QUERY, limit: 8 })));

for (const row of results) {
  console.log(`${row.ok ? "OK  " : "FAIL"} ${row.label.padEnd(22)} ${String(row.ms).padStart(6)}ms  ${row.ok ? `${row.count} urls` : row.error}`);
}
