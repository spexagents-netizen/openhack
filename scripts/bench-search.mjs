// Latency comparison: the current OpenHack chain (DuckDuckGo HTML + public
// SearXNG race) against the keyless MCP providers OpenCode calls.
import { performance } from "node:perf_hooks";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const QUERIES = [
  "Node.js latest LTS release",
  "CVE-2024-3094 xz backdoor analysis",
  "windows kernel driver manual mapping detection",
];
const SEARX = ["https://searx.be", "https://search.inetol.net", "https://baresearch.org", "https://opnxng.com", "https://search.rhscz.eu"];

const cap = (ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

async function timed(fn) {
  const t0 = performance.now();
  try {
    const count = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), count };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(error.message ?? error).slice(0, 60) };
  }
}

async function ddg(query) {
  const { signal, done } = cap(8000);
  try {
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (/anomaly|unusual traffic|captcha/i.test(html)) throw new Error("blocked");
    return (html.match(/result__a/g) ?? []).length / 2;
  } finally { done(); }
}

async function searxOne(base, query) {
  const { signal, done } = cap(5000);
  try {
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    const response = await fetch(url.toString(), { signal, headers: { accept: "application/json", "user-agent": UA } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.results ?? []).length;
  } finally { done(); }
}

async function searxRace(query) {
  return Promise.any(SEARX.map((base) => searxOne(base, query).then((count) => {
    if (!count) throw new Error("empty");
    return count;
  })));
}

async function exa(query) {
  const { signal, done } = cap(20000);
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "Mozilla/5.0" };
    const init = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST", signal, headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }),
    });
    const session = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    const extra = session ? { "mcp-session-id": session } : {};
    await fetch("https://mcp.exa.ai/mcp", {
      method: "POST", signal, headers: { ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
    const call = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST", signal, headers: { ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search_exa", arguments: { query, numResults: 8 } } }),
    });
    const text = await call.text();
    return (text.match(/URL:/g) ?? []).length;
  } finally { done(); }
}

const rows = [];
for (const query of QUERIES) {
  rows.push({ query, ddg: await timed(() => ddg(query)), searx: await timed(() => searxRace(query)), exa: await timed(() => exa(query)) });
}

for (const row of rows) {
  const cell = (r) => `${r.ok ? String(r.ms).padStart(5) + "ms" : "  FAIL"} ${r.ok ? `${Math.round(r.count)} res` : r.error}`;
  console.log(`${row.query.slice(0, 34).padEnd(36)} ddg ${cell(row.ddg).padEnd(14)} searx-race ${cell(row.searx).padEnd(14)} exa ${cell(row.exa)}`);
}
