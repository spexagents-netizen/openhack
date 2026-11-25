import { callMcpTool } from "./mcp";
import type { SearchResult } from "./search";
import { stripTags } from "./html";

export interface ProviderContext {
  query: string;
  maxResults: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  exaApiKey?: string;
  tinyfishApiKey?: string;
}

export interface Candidate {
  id: string;
  run(context: ProviderContext, signal: AbortSignal): Promise<SearchResult[]>;
}

/**
 * Keyless MCP search providers. These are the same endpoints OpenCode's
 * WebSearch plugins call: a real search API that answers in about a second,
 * instead of scraping an HTML results page that rate-limits without warning.
 */
export const MCP_PROVIDERS = {
  exa: "https://mcp.exa.ai/mcp",
  tinyfish: "https://agent.tinyfish.ai/mcp",
  parallel: "https://search.parallel.ai/mcp",
} as const;

export function exaCandidate(): Candidate {
  return {
    id: "exa",
    async run(context, signal) {
      // Exa's canonical MCP auth is the x-api-key header. A key in the URL
      // would end up in logs, so it is never sent as a query parameter.
      const key = context.exaApiKey?.trim() || context.env.EXA_API_KEY?.trim() || "";
      const text = await callMcpTool({
        url: MCP_PROVIDERS.exa,
        tool: "web_search_exa",
        args: { query: context.query, numResults: Math.min(Math.max(context.maxResults, 1), 20) },
        ...(key ? { headers: { "x-api-key": key } } : {}),
        signal,
        fetchImpl: context.fetchImpl,
        timeoutMs: context.timeoutMs,
        label: "openhack",
      });
      return parseSearchText(text).slice(0, context.maxResults);
    },
  };
}

export function tinyfishCandidate(): Candidate {
  return {
    id: "tinyfish",
    async run(context, signal) {
      const key = context.tinyfishApiKey?.trim() || context.env.TINYFISH_API_KEY?.trim() || "";
      if (key) {
        // Keyed search runs on the gateway REST endpoint: one GET, measured at
        // ~250 ms here, against three round trips for the same query over MCP.
        const url = new URL("https://agent.tinyfish.ai/v1/search");
        url.searchParams.set("query", context.query);
        const response = await context.fetchImpl(url.toString(), {
          headers: { "X-API-Key": key, accept: "application/json", "user-agent": "openhack/0.1" },
          signal: deadline(signal, context.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseSearchText(await response.text()).slice(0, context.maxResults);
      }
      // No key: the MCP endpoint serves a keyless tier.
      const text = await callMcpTool({
        url: MCP_PROVIDERS.tinyfish,
        tool: "search",
        args: { query: context.query },
        headers: { "x-tinyfish-access-mode": "keyless" },
        signal,
        fetchImpl: context.fetchImpl,
        timeoutMs: context.timeoutMs,
        label: "openhack",
      });
      return parseSearchText(text).slice(0, context.maxResults);
    },
  };
}

function deadline(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parallelCandidate(): Candidate {
  return {
    id: "parallel",
    async run(context, signal) {
      const text = await callMcpTool({
        url: MCP_PROVIDERS.parallel,
        tool: "web_search",
        args: { objective: context.query, search_queries: [context.query], model_name: "speed" },
        signal,
        fetchImpl: context.fetchImpl,
        timeoutMs: context.timeoutMs,
        label: "openhack",
      });
      return parseSearchText(text).slice(0, context.maxResults);
    },
  };
}

/**
 * Providers answer in one of three shapes: an Exa-style `URL:`/`Title:` block
 * document, a JSON array of results, or a JSON envelope with `results` or
 * `data.web`. Everything else is treated as no results rather than guessed at.
 */
export function parseSearchText(text: string): SearchResult[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const asJson = tryJson(trimmed);
  if (asJson) {
    const rows = extractRows(asJson);
    if (rows.length) return dedupe(rows);
  }
  return dedupe(parseBlocks(trimmed));
}

function tryJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function extractRows(payload: unknown): SearchResult[] {
  const list = findArray(payload);
  if (!list) return [];
  const output: SearchResult[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : typeof record.link === "string" ? record.link : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const title = firstString(record.title, record.name, url);
    const snippet = firstString(record.snippet, record.content, record.description, record.text, record.excerpt, "");
    output.push({ title: stripTags(title).slice(0, 300), url, snippet: stripTags(snippet).slice(0, 900) });
  }
  return output;
}

/** Accepts `{results}`, `{data:{results}}`, `{data:{web}}`, `{web:{results}}` and bare arrays. */
function findArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["results", "web", "items", "documents"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = findArray(value);
      if (nested) return nested;
    }
  }
  const data = record.data;
  if (data && typeof data === "object") return findArray(data);
  return null;
}

function parseBlocks(text: string): SearchResult[] {
  const blocks = text.split(/\n{2,}\s*-{3,}\s*\n{2,}/);
  const output: SearchResult[] = [];
  for (const block of blocks) {
    const url = /^\s*URL:\s*(\S+)\s*$/im.exec(block)?.[1] ?? /^\s*(https?:\/\/\S+)\s*$/im.exec(block)?.[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = /^\s*Title:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? url;
    const snippet = block
      .replace(/^\s*URL:.*$/im, "")
      .replace(/^\s*Title:.*$/im, "")
      .replace(/^\s*(Published|Author|Score):.*$/gim, "")
      .replace(/^\s*Highlights:\s*$/gim, "")
      .replace(/\s+/g, " ")
      .trim();
    output.push({
      title: stripTags(title).slice(0, 300),
      url,
      snippet: stripTags(snippet).slice(0, 900),
    });
  }
  return output;
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return "";
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const output: SearchResult[] = [];
  for (const result of results) {
    const key = result.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}
