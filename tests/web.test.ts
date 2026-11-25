import { beforeEach, describe, expect, it } from "vitest";
import { builtinToolDefinitions, executeBuiltinTool } from "../src/main/agent/builtin-tools";
import { Workspace } from "../src/main/workspace/workspace";
import { htmlToText, extractTitle } from "../src/main/web/html";
import { webSearch } from "../src/main/web/search";
import { parseSearchText } from "../src/main/web/providers";
import { resetMcpSessions } from "../src/main/web/mcp";
import { webFetch } from "../src/main/web/fetch";
import { createWebRuntime, webToolDefinitions } from "../src/main/web";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const signal = () => new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("html conversion", () => {
  it("drops executable markup, keeps structure and resolves links", () => {
    const html = `<!doctype html><html><head><title>  CVE&#45;2026 &amp; notes </title>
      <style>.x{color:red}</style><script>alert("x")</script></head>
      <body><h1>Report</h1><p>Line&nbsp;one &lt;safe&gt;.</p><ul><li>alpha</li><li>beta</li></ul>
      <a href="/rel/path">read more</a><script>steal()</script></body></html>`;
    const text = htmlToText(html, "https://example.test/docs/page");
    expect(extractTitle(html)).toBe("CVE-2026 & notes");
    expect(text).toContain("# Report");
    expect(text).toContain("Line one <safe>.");
    expect(text).toContain("- alpha");
    expect(text).toContain("[read more](https://example.test/rel/path)");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("steal");
  });
});

describe("web search", () => {
  beforeEach(() => resetMcpSessions());

  it("parses SearXNG JSON, deduplicates tracked URLs and honours maxResults", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.hostname === "searx.local") {
        expect(url.pathname).toBe("/search");
        expect(url.searchParams.get("format")).toBe("json");
        return jsonResponse({
          results: [
            { title: "One", url: "https://a.test/page?utm_source=x", content: "first", engine: "google" },
            { title: "One again", url: "https://a.test/page", content: "duplicate" },
            { title: "<b>Two</b>", url: "https://b.test/", content: "second" },
            { title: "bad", url: "javascript:alert(1)", content: "skip" },
            { title: "Three", url: "https://c.test/", content: "third" },
          ],
        });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const report = await webSearch({ query: "cve", maxResults: 2, signal: signal(), searxngUrl: "https://searx.local", fetchImpl, env: {} });
    expect(report.backend).toBe("searxng:searx.local");
    expect(report.results).toHaveLength(2);
    expect(report.results[0]).toMatchObject({ title: "One", url: "https://a.test/page?utm_source=x" });
    expect(report.results[1]?.title).toBe("Two");
    expect(calls.filter((call) => call.includes("searx.local"))).toHaveLength(1);
  });

  it("answers from the hosted keyless provider and never touches the scrapers", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("mcp.exa.ai")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "exa", version: "1" } } }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
          });
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const text = [
          "URL: https://nodejs.org/en/about/previous-releases",
          "Title: Node.js Previous Releases",
          "Published: 2026-01-01",
          "Node 24 is the Active LTS line.",
          "",
          "---",
          "",
          "URL: https://example.test/second",
          "Title: Second source",
          "Another snippet.",
        ].join("\n");
        const payload = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } };
        return new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const report = await webSearch({ query: "node lts", signal: signal(), fetchImpl, env: {} });
    expect(report.backend).toBe("exa");
    expect(report.results[0]).toMatchObject({ title: "Node.js Previous Releases", url: "https://nodejs.org/en/about/previous-releases" });
    expect(report.results[0]?.snippet).toContain("Active LTS");
    expect(report.results[1]?.url).toBe("https://example.test/second");
    expect(seen.some((url) => url.includes("duckduckgo"))).toBe(false);
    expect(seen.some((url) => url.includes("/search"))).toBe(false);
  });

  it("falls back to a scraped engine only when every hosted provider fails", async () => {
    let ddgCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("html.duckduckgo.com")) {
        ddgCalls += 1;
        return new Response(`
          <div class="result__body">
            <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fadvisory&amp;rut=1">Advisory</a></h2>
            <a class="result__snippet">Fix released in <b>1.2.3</b>.</a>
          </div>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const first = await webSearch({ query: "advisory 1.2.3", maxResults: 5, signal: signal(), fetchImpl, env: {} });
    expect(first.backend).toBe("duckduckgo");
    expect(first.results[0]).toMatchObject({ url: "https://example.test/advisory", snippet: "Fix released in 1.2.3." });
    expect(first.attempts).toContainEqual(expect.objectContaining({ backend: "exa", ok: false }));
    expect(first.attempts).toContainEqual(expect.objectContaining({ backend: "tinyfish", ok: false }));
    const second = await webSearch({ query: "advisory 1.2.3", maxResults: 5, signal: signal(), fetchImpl, env: {} });
    expect(second.cached).toBe(true);
    expect(ddgCalls).toBe(1);
  });

  it("reports exhausted backends instead of inventing results", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const report = await webSearch({ query: "nothing", signal: signal(), fetchImpl, env: {} });
    expect(report.results).toEqual([]);
    expect(report.backend).toBe("none");
    expect(report.attempts.length).toBeGreaterThanOrEqual(6);
    expect(report.attempts.some((attempt) => attempt.backend.startsWith("searxng:"))).toBe(true);
    await expect(webSearch({ query: "   ", signal: signal(), fetchImpl, env: {} })).rejects.toThrow(/empty/u);
  });

  it("uses a keyed backend only when its environment key exists", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        expect(new Headers(init?.headers).get("x-subscription-token")).toBe("brave-key");
        return jsonResponse({ web: { results: [{ title: "Brave hit", url: "https://brave.test/", description: "keyed" }] } });
      }
      return new Response("blocked", { status: 429 });
    }) as typeof fetch;
    const report = await webSearch({
      query: "brave only", signal: signal(), searxngUrl: "https://dead.local", fetchImpl,
      env: { BRAVE_SEARCH_API_KEY: "brave-key" },
    });
    expect(report.backend).toBe("brave");
    expect(report.results[0]?.title).toBe("Brave hit");
  });
});

describe("search payload parsing", () => {
  it("reads block documents and JSON envelopes without inventing rows", () => {
    const blocks = parseSearchText("URL: https://a.test/x\nTitle: A\n\nBody line.\n\n---\n\nURL: https://b.test/y\nTitle: B\nMore.");
    expect(blocks.map((row) => row.url)).toEqual(["https://a.test/x", "https://b.test/y"]);
    expect(blocks[0]?.snippet).toContain("Body line");
    const envelope = parseSearchText(JSON.stringify({ data: { web: [{ url: "https://c.test/z", title: "C", description: "desc" }] } }));
    expect(envelope[0]).toMatchObject({ url: "https://c.test/z", title: "C", snippet: "desc" });
    const list = parseSearchText(JSON.stringify({ results: [{ url: "https://d.test/", title: "D", content: "body" }, { url: "javascript:alert(1)" }] }));
    expect(list).toHaveLength(1);
    expect(parseSearchText("no structured payload here")).toEqual([]);
  });
});

describe("web fetch", () => {
  it("reads HTML as text and follows a relative redirect", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      if (url.endsWith("/final")) {
        return new Response("<html><head><title>Final</title></head><body><p>payload</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const report = await webFetch({ url: "https://example.test/start", signal: signal(), fetchImpl });
    expect(report.finalUrl).toBe("https://example.test/final");
    expect(report.title).toBe("Final");
    expect(report.text).toBe("payload");
    expect(report.truncated).toBe(false);
  });

  it("falls back to a reader when a client-rendered page has no body text", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://reader.test/")) {
        return new Response("Title: NVD\n\nMarkdown Content: rendered advisory body", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("<html><head><title>NVD - Home</title></head><body><app-root></app-root></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const report = await webFetch({ url: "https://nvd.test/vuln", signal: signal(), fetchImpl, readerPrefix: "https://reader.test" });
    expect(report.backend).toBe("reader");
    expect(report.url).toBe("https://nvd.test/vuln");
    expect(report.text).toContain("rendered advisory body");
    const disabled = await webFetch({ url: "https://nvd.test/vuln", signal: signal(), fetchImpl, readerPrefix: "off" });
    expect(disabled.backend).toBe("direct");
  });

  it("refuses binary content, non-HTTP schemes and endless redirects", async () => {
    const binary = (async () => new Response(new Uint8Array([0, 1, 2]), { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(webFetch({ url: "https://example.test/a.pdf", signal: signal(), fetchImpl: binary })).rejects.toThrow(/non-text/u);
    await expect(webFetch({ url: "file:///C:/Windows/win.ini", signal: signal(), fetchImpl: binary })).rejects.toThrow(/HTTP/u);
    const loop = (async (input: string | URL | Request) => new Response(null, { status: 302, headers: { location: String(input) } })) as unknown as typeof fetch;
    await expect(webFetch({ url: "https://example.test/loop", signal: signal(), fetchImpl: loop })).rejects.toThrow(/Too many redirects/u);
  });

  it("truncates oversized bodies and honours cancellation", async () => {
    const huge = (async () => new Response("x".repeat(200000), { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const report = await webFetch({ url: "https://example.test/big", maxChars: 1000, signal: signal(), fetchImpl: huge });
    expect(report.text).toHaveLength(1000);
    expect(report.truncated).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(webFetch({ url: "https://example.test/big", signal: controller.signal, fetchImpl: huge })).rejects.toThrow(/cancelled|timed out/u);
  });
});

describe("web tool surface", () => {
  it("registers both tools as reads and executes them through the runtime", async () => {
    const names = builtinToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(webToolDefinitions().every((tool) => tool.risk === "read")).toBe(true);
    const runtime = createWebRuntime({
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/search")) return jsonResponse({ results: [{ title: "hit", url: "https://hit.test/", content: "snippet" }] });
        return new Response("<p>page body</p>", { status: 200, headers: { "content-type": "text/html" } });
      }) as typeof fetch,
      searxngUrl: "https://searx.local",
    });
    const workspace = new Workspace(await mkdtemp(path.join(tmpdir(), "openhack-web-")));
    const search = JSON.parse(await executeBuiltinTool("web_search", { query: "x" }, workspace, signal(), runtime));
    expect(search.results[0].title).toBe("hit");
    const fetch = JSON.parse(await executeBuiltinTool("web.fetch", { url: "https://hit.test/" }, workspace, signal(), runtime));
    expect(fetch.text).toBe("page body");
  });
});
