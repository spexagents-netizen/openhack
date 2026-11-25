import type { ToolDefinition } from "../../shared/contracts";
import { webFetch, type FetchOptions } from "./fetch";
import { webSearch, type SearchOptions } from "./search";
import type { EgressPolicy } from "../security/egress";

export interface WebRuntimeConfig {
  searxngUrl?: string;
  exaApiKey?: string;
  tinyfishApiKey?: string;
  readerPrefix?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  egressPolicy?: EgressPolicy;
}

export interface WebRuntime {
  search(options: Omit<SearchOptions, "fetchImpl" | "env" | "searxngUrl">): ReturnType<typeof webSearch>;
  fetch(options: Omit<FetchOptions, "fetchImpl" | "readerPrefix">): ReturnType<typeof webFetch>;
}

export function createWebRuntime(config: WebRuntimeConfig = {}): WebRuntime {
  return {
    search: (options) => webSearch({
      ...options,
      ...(config.searxngUrl ? { searxngUrl: config.searxngUrl } : {}),
      ...(config.exaApiKey ? { exaApiKey: config.exaApiKey } : {}),
      ...(config.tinyfishApiKey ? { tinyfishApiKey: config.tinyfishApiKey } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.env ? { env: config.env } : {}),
    }),
    fetch: (options) => webFetch({
      ...options,
      ...(config.readerPrefix ? { readerPrefix: config.readerPrefix } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      policy: config.egressPolicy ?? "block-metadata",
    }),
  };
}

export function webToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "web_search",
      description: "Search the live web. Primary path is a hosted keyless search provider (Exa, then TinyFish, then Parallel), raced so the first usable answer wins; Brave or Tavily are used first when their environment key exists. DuckDuckGo HTML and a public SearXNG rotation are only the net. Returns ranked results with URLs and snippets. Use it for current facts, versions, advisories, CVEs and documentation, then verify the important claim with web_fetch.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query. Include product, version or CVE identifiers when known." },
          maxResults: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
    },
    {
      name: "web_fetch",
      description: "Fetch one HTTP(S) page or document and return readable text (HTML is converted to Markdown-ish text). Follows up to 5 redirects, caps size, and refuses binary media. Use it to confirm a claim at the source instead of trusting a search snippet.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute HTTP(S) URL to read." },
          maxChars: { type: "integer", minimum: 500, maximum: 120000, default: 24000 },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 60000, default: 20000 },
        },
        required: ["url"],
        additionalProperties: false,
      },
      risk: "read",
    },
  ];
}

export { webSearch, webFetch };
export type { SearchReport, SearchResult } from "./search";
export type { FetchReport } from "./fetch";
