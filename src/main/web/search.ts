import { htmlToText, stripTags } from "./html";
import { BROWSER_UA } from "./ua";
import { exaCandidate, parallelCandidate, tinyfishCandidate, type Candidate, type ProviderContext } from "./providers";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface SearchReport {
  query: string;
  backend: string;
  results: SearchResult[];
  attempts: Array<{ backend: string; ok: boolean; note?: string }>;
  cached?: boolean;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
  signal: AbortSignal;
  /** Operator-supplied SearXNG instance; raced against the hosted providers. */
  searxngUrl?: string;
  /** Per-provider budget. A slow provider must not consume the whole tool call. */
  timeoutMs?: number;
  /** Absolute budget for the whole chain, across every tier. */
  deadlineMs?: number;
  /** Stored Exa key, sent as the x-api-key header. Falls back to EXA_API_KEY. */
  exaApiKey?: string;
  /** Stored TinyFish key. Keyed search uses the gateway REST endpoint. */
  tinyfishApiKey?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Public SearXNG instances that sometimes answer `format=json`. As of the live
 * probe on 2026-11-24 every public instance either disabled the JSON API or
 * returned 429, so this list is a last-resort net, never a primary path.
 */
const SEARXNG_ROTATION = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://baresearch.org",
  "https://opnxng.com",
  "https://search.rhscz.eu",
  "https://searx.tiekoetter.com",
  "https://priv.au",
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 120;
const cache = new Map<string, { at: number; report: SearchReport }>();

/**
 * Order matters. Tier one is the fast, high-quality set: a keyed provider if the
 * operator has one, then the keyless MCP providers OpenCode also calls, then the
 * operator's own SearXNG instance. They start together and the first usable
 * answer wins, so a slow host never sets the latency.
 */
export async function webSearch(options: SearchOptions): Promise<SearchReport> {
  const query = options.query.trim();
  if (!query) throw new Error("Search query cannot be empty");
  if (query.length > 2000) throw new Error("Search query exceeds 2,000 characters");
  const maxResults = Math.min(Math.max(options.maxResults ?? 8, 1), 20);
  const doFetch = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const instance = (options.searxngUrl ?? env.OPENHACK_SEARXNG_URL ?? "").trim().replace(/\/+$/, "");
  const cacheKey = `${maxResults}\u0000${instance}\u0000${query.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.report, cached: true };
  }

  const attempts: SearchReport["attempts"] = [];
  const perProvider = Math.min(Math.max(options.timeoutMs ?? 8000, 1000), 30000);
  const deadline = Date.now() + Math.min(Math.max(options.deadlineMs ?? 15000, 2000), 60000);
  const context: ProviderContext = {
    query,
    maxResults,
    signal: options.signal,
    fetchImpl: doFetch,
    env,
    timeoutMs: perProvider,
    ...(options.exaApiKey ? { exaApiKey: options.exaApiKey } : {}),
    ...(options.tinyfishApiKey ? { tinyfishApiKey: options.tinyfishApiKey } : {}),
  };

  const tierOne: Candidate[] = [];
  const braveKey = env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY;
  if (braveKey) tierOne.push({ id: "brave", run: (ctx, signal) => brave(doFetch, braveKey, query, maxResults, ctx.timeoutMs, signal) });
  const tavilyKey = env.TAVILY_API_KEY;
  if (tavilyKey) tierOne.push({ id: "tavily", run: (ctx, signal) => tavily(doFetch, tavilyKey, query, maxResults, ctx.timeoutMs, signal) });
  tierOne.push(exaCandidate(), tinyfishCandidate());
  if (instance) tierOne.push({ id: `searxng:${safeHost(instance)}`, run: (ctx, signal) => searxJson(doFetch, instance, query, maxResults, ctx.timeoutMs, signal) });

  let winner = await runTier(tierOne, context, budget(deadline, perProvider), attempts);

  if (!winner && !options.signal.aborted) {
    // Tier two: the slower hosted provider plus the HTML endpoint as a net.
    const tierTwo: Candidate[] = [
      parallelCandidate(),
      { id: "duckduckgo", run: (ctx, signal) => duckDuckGo(doFetch, query, maxResults, ctx.timeoutMs, signal) },
    ];
    winner = await runTier(tierTwo, context, budget(deadline, perProvider), attempts);
  }

  if (!winner && !instance && !options.signal.aborted) {
    const remaining = Math.min(budget(deadline, perProvider), 5000);
    const raced = await raceSearx(doFetch, query, maxResults, remaining, options.signal, attempts);
    if (raced) winner = { backend: `searxng:${raced.host}`, results: raced.results };
  }

  const report: SearchReport = winner
    ? { query, backend: winner.backend, results: winner.results, attempts }
    : { query, backend: "none", results: [], attempts };
  remember(cacheKey, report);
  return report;
}

function budget(deadline: number, fallback: number): number {
  return Math.max(500, Math.min(deadline - Date.now(), fallback));
}

/**
 * Start every candidate at once; the first non-empty answer wins and the rest
 * are aborted. Bound the tier so a hung host costs one budget, not the sum.
 */
async function runTier(
  candidates: Candidate[],
  context: ProviderContext,
  budgetMs: number,
  attempts: SearchReport["attempts"],
): Promise<{ backend: string; results: SearchResult[] } | null> {
  if (!candidates.length) return null;
  const controller = new AbortController();
  const relay = () => controller.abort();
  context.signal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await new Promise((resolve) => {
      let pending = candidates.length;
      let settled = false;
      for (const candidate of candidates) {
        candidate.run(context, controller.signal)
          .then((results) => {
            attempts.push({ backend: candidate.id, ok: results.length > 0, ...(results.length ? {} : { note: "no results" }) });
            if (!results.length || settled) return;
            settled = true;
            resolve({ backend: candidate.id, results });
            controller.abort();
          })
          .catch((error) => {
            // A loser aborted by a faster winner is not a failure of that host.
            const note = settled ? "cancelled · another provider answered first" : safeNote(error);
            attempts.push({ backend: candidate.id, ok: false, note });
          })
          .finally(() => {
            pending -= 1;
            if (pending === 0 && !settled) {
              settled = true;
              resolve(null);
            }
          });
      }
    });
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", relay);
    controller.abort();
  }
}

/**
 * Public instances fail slowly (timeouts, 429). Racing them in parallel bounds
 * the worst case to a single request budget instead of the sum of every host.
 */
async function raceSearx(
  doFetch: typeof fetch,
  query: string,
  maxResults: number,
  budgetMs: number,
  parentSignal: AbortSignal,
  attempts: SearchReport["attempts"],
): Promise<{ host: string; results: SearchResult[] } | null> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  parentSignal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const candidates = SEARXNG_ROTATION.slice(0, 5);
  const settled: Array<{ base: string; ok: boolean; note?: string }> = [];
  try {
    const winner = await new Promise<{ host: string; results: SearchResult[] } | null>((resolve) => {
      let pending = candidates.length;
      for (const base of candidates) {
        searxJson(doFetch, base, query, maxResults, budgetMs, controller.signal)
          .then((results) => {
            settled.push({ base, ok: results.length > 0, ...(results.length ? {} : { note: "no results" }) });
            if (!results.length) return;
            resolve({ host: safeHost(base), results });
            controller.abort();
          })
          .catch((error) => {
            settled.push({ base, ok: false, note: safeNote(error) });
          })
          .finally(() => {
            pending -= 1;
            if (pending === 0) resolve(null);
          });
      }
    });
    if (winner) {
      attempts.push({ backend: `searxng:${winner.host}`, ok: true, note: "race winner" });
      return winner;
    }
    for (const entry of settled) attempts.push({ backend: `searxng:${safeHost(entry.base)}`, ok: entry.ok, ...(entry.note ? { note: entry.note } : {}) });
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", relay);
    controller.abort();
  }
}

async function searxJson(
  doFetch: typeof fetch,
  base: string,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "all");
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("categories", "general");
  const response = await doFetch(url.toString(), {
    headers: { accept: "application/json", "user-agent": BROWSER_UA },
    redirect: "follow",
    signal: combined(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("instance returned non-JSON (JSON API likely disabled)");
  }
  const rows = (payload as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const urlValue = typeof record.url === "string" ? record.url : "";
    if (!/^https?:\/\//i.test(urlValue)) continue;
    const key = normalizeUrl(urlValue);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title: stripTags(String(record.title ?? urlValue)).slice(0, 300) || urlValue,
      url: urlValue,
      snippet: stripTags(String(record.content ?? "")).slice(0, 900),
      ...(typeof record.engine === "string" ? { engine: record.engine } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function duckDuckGo(
  doFetch: typeof fetch,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const response = await doFetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      "user-agent": BROWSER_UA,
      "accept-language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    redirect: "follow",
    signal: combined(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (/anomaly|unusual traffic|captcha/i.test(html)) throw new Error("blocked by DuckDuckGo");
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  // Split on the result container so the final block on a page is parsed too;
  // a lookahead terminator silently dropped single-result pages.
  for (const chunk of html.split(/<div[^>]+class="[^"]*result__body/i).slice(1)) {
    const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const target = decodeDuckDuckGo(anchor[1]!);
    if (!target) continue;
    const key = normalizeUrl(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk)?.[1]
      ?? /<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk)?.[1]
      ?? "";
    results.push({
      title: stripTags(anchor[2]!).slice(0, 300) || target,
      url: target,
      snippet: stripTags(snippet).slice(0, 900),
      engine: "duckduckgo",
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function brave(
  doFetch: typeof fetch,
  apiKey: string,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));
  url.searchParams.set("safesearch", "off");
  const response = await doFetch(url.toString(), {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
    signal: combined(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return dedupe((payload.web?.results ?? []).slice(0, maxResults).flatMap((row) => {
    if (!row.url || !/^https?:\/\//i.test(row.url)) return [];
    return [{ title: stripTags(row.title ?? row.url).slice(0, 300), url: row.url, snippet: stripTags(row.description ?? "").slice(0, 900), engine: "brave" }];
  }));
}

async function tavily(
  doFetch: typeof fetch,
  apiKey: string | undefined,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const response = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : { "x-tavily-access-mode": "keyless" }),
    },
    body: JSON.stringify({
      ...(apiKey ? { api_key: apiKey } : {}),
      query,
      max_results: maxResults,
      search_depth: "basic",
      chunks_per_source: 3,
    }),
    signal: combined(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return dedupe((payload.results ?? []).slice(0, maxResults).flatMap((row) => {
    if (!row.url || !/^https?:\/\//i.test(row.url)) return [];
    return [{ title: stripTags(row.title ?? row.url).slice(0, 300), url: row.url, snippet: stripTags(row.content ?? "").slice(0, 900), engine: "tavily" }];
  }));
}

function decodeDuckDuckGo(href: string): string {
  const value = href.trim();
  if (value.startsWith("//")) {
    try {
      const parsed = new URL(`https:${value}`);
      const target = parsed.searchParams.get("uddg");
      if (target) return target;
      return parsed.toString();
    } catch {
      return "";
    }
  }
  if (value.startsWith("/l/")) {
    try {
      return new URL(value, "https://duckduckgo.com").searchParams.get("uddg") ?? "";
    } catch {
      return "";
    }
  }
  return /^https?:\/\//i.test(value) ? value : "";
}

function combined(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const output: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|ref_src|mc_cid|mc_eid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function remember(key: string, report: SearchReport): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [entry] of oldest) cache.delete(entry);
  }
  cache.set(key, { at: Date.now(), report });
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.slice(0, 60);
  }
}

function safeNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return "timed out";
  return message.slice(0, 160);
}

export { BROWSER_UA };
export { htmlToText };
