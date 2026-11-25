import { beforeEach, describe, expect, it } from "vitest";
import { callMcpTool, resetMcpSessions } from "../src/main/web/mcp";
import { exaCandidate, parseSearchText, tinyfishCandidate, type ProviderContext } from "../src/main/web/providers";

const signal = () => new AbortController().signal;

function sse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function handshake(session = "s-1"): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), {
    status: 200,
    headers: session ? { "content-type": "application/json", "mcp-session-id": session } : { "content-type": "application/json" },
  });
}

function context(fetchImpl: typeof fetch, env: Record<string, string | undefined> = {}): ProviderContext {
  return { query: "q", maxResults: 5, signal: signal(), fetchImpl, env, timeoutMs: 5000 };
}

describe("MCP search transport", () => {
  beforeEach(() => resetMcpSessions());

  it("handshakes once, reuses the session, and returns the tool text", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      calls.push(body.method ?? "notification");
      if (body.method === "initialize") return handshake("session-9");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "URL: https://a.test/\nTitle: A" }] } });
    }) as typeof fetch;
    const call = { url: "https://mcp.test/mcp", tool: "search", args: { query: "q" }, signal: signal(), fetchImpl, timeoutMs: 5000 };
    expect(await callMcpTool(call)).toContain("https://a.test/");
    expect(calls).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    await callMcpTool(call);
    expect(calls.filter((method) => method === "initialize")).toHaveLength(1);
  });

  it("re-handshakes once when a cached session has expired", async () => {
    let handshakes = 0;
    let toolCalls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") {
        handshakes += 1;
        return handshake(`session-${handshakes}`);
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      // The second call reuses the session and is told it expired; the third
      // call happens after the client re-handshakes with a fresh session.
      if (toolCalls === 2) return new Response("expired", { status: 404 });
      return sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
    }) as typeof fetch;
    const call = { url: "https://mcp.test/mcp", tool: "search", args: {}, signal: signal(), fetchImpl, timeoutMs: 5000 };
    expect(await callMcpTool(call)).toBe("ok");
    expect(await callMcpTool(call)).toBe("ok");
    expect(handshakes).toBe(2);
  });

  it("surfaces a rejected handshake, a tool error and an empty payload", async () => {
    const string = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
    const rejected = (async () => string(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "no" } }))) as unknown as typeof fetch;
    await expect(callMcpTool({ url: "https://mcp.test/a", tool: "t", args: {}, signal: signal(), fetchImpl: rejected, timeoutMs: 5000 }))
      .rejects.toThrow(/handshake rejected/u);

    const failing = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") return handshake("");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return string(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "quota exhausted" } }));
    }) as typeof fetch;
    await expect(callMcpTool({ url: "https://mcp.test/b", tool: "t", args: {}, signal: signal(), fetchImpl: failing, timeoutMs: 5000 }))
      .rejects.toThrow(/quota exhausted/u);

    const empty = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") return handshake("");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return string(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } }));
    }) as typeof fetch;
    await expect(callMcpTool({ url: "https://mcp.test/c", tool: "t", args: {}, signal: signal(), fetchImpl: empty, timeoutMs: 5000 }))
      .rejects.toThrow(/empty tool text/u);
  });
});

describe("hosted provider adapters", () => {
  beforeEach(() => resetMcpSessions());

  it("sends an Exa key as the x-api-key header, never in the URL", async () => {
    let seenUrl = "";
    let seenKey = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") {
        seenUrl = String(input);
        seenKey = new Headers(init?.headers).get("x-api-key") ?? "";
        return handshake("");
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse({ result: { content: [{ text: "URL: https://exa.test/hit\nTitle: Hit\nBody text." }] } });
    }) as typeof fetch;
    const results = await exaCandidate().run(context(fetchImpl, { EXA_API_KEY: "exa-key" }), signal());
    expect(seenUrl).toBe("https://mcp.exa.ai/mcp");
    expect(seenUrl).not.toContain("exa-key");
    expect(seenKey).toBe("exa-key");
    expect(results[0]).toMatchObject({ url: "https://exa.test/hit", title: "Hit" });
  });

  it("prefers the stored key over the environment", async () => {
    let seenKey = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") { seenKey = new Headers(init?.headers).get("x-api-key") ?? ""; return handshake(""); }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse({ result: { content: [{ text: "URL: https://exa.test/x\nTitle: X" }] } });
    }) as typeof fetch;
    const base = context(fetchImpl, { EXA_API_KEY: "env-key" });
    await exaCandidate().run({ ...base, exaApiKey: "stored-key" }, signal());
    expect(seenKey).toBe("stored-key");
  });

  it("sends the keyless header to TinyFish when no key exists", async () => {
    let mode = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const headers = new Headers(init?.headers);
      if (body.method === "initialize") { mode = headers.get("x-tinyfish-access-mode") ?? ""; return handshake(""); }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse({ result: { content: [{ text: JSON.stringify({ results: [{ url: "https://tiny.test/a", title: "T", snippet: "s" }] }) }] } });
    }) as typeof fetch;
    const results = await tinyfishCandidate().run(context(fetchImpl), signal());
    expect(mode).toBe("keyless");
    expect(results[0]?.url).toBe("https://tiny.test/a");
  });

  it("uses the gateway REST search when a TinyFish key is present", async () => {
    let seenUrl = "";
    let seenKey = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenKey = new Headers(init?.headers).get("x-api-key") ?? "";
      return new Response(JSON.stringify({ query: "q", results: [{ title: "Gateway hit", url: "https://tf.test/a", snippet: "s" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const base = context(fetchImpl, {});
    const results = await tinyfishCandidate().run({ ...base, tinyfishApiKey: "tf-key" }, signal());
    expect(seenUrl).toContain("agent.tinyfish.ai/v1/search");
    expect(seenUrl).toContain("query=q");
    expect(seenKey).toBe("tf-key");
    expect(results[0]).toMatchObject({ url: "https://tf.test/a", title: "Gateway hit" });
  });

  it("treats unparseable prose as no results, never as a hit", () => {
    expect(parseSearchText("")).toEqual([]);
    expect(parseSearchText("here are some results I found")).toEqual([]);
    expect(parseSearchText(JSON.stringify({ results: [] }))).toEqual([]);
    const deduped = parseSearchText("URL: https://a.test/x\nTitle: A\n\nOne.\n\n---\n\nURL: https://a.test/x#frag\nTitle: A again");
    expect(deduped).toHaveLength(1);
  });
});
