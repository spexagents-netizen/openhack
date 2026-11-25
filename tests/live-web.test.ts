import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { webFetch, webSearch } from "../src/main/web";

const live = process.env.OPENHACK_LIVE_WEB === "1";

describe.skipIf(!live)("live web toolchain", () => {
  it("returns real results from the keyless chain and renders the top page", async () => {
    const signal = new AbortController().signal;
    const started = Date.now();
    const search = await webSearch({ query: "CVE-2024-3094 xz-utils advisory", maxResults: 5, signal, timeoutMs: 8000 });
    const searchMs = Date.now() - started;
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]?.url).toMatch(/^https?:\/\//);

    const page = await webFetch({ url: search.results[0]!.url, signal, maxChars: 12000, timeoutMs: 25000 });
    expect(page.status).toBeLessThan(400);
    expect(page.text.length).toBeGreaterThan(200);
    expect(page.finalUrl).toBe(search.results[0]!.url);

    const plain = await webFetch({ url: "https://example.com", signal, maxChars: 4000, timeoutMs: 20000 });
    expect(plain.backend).toBe("direct");
    expect(plain.text.trim().length).toBeGreaterThan(20);

    await mkdir("artifacts", { recursive: true });
    await writeFile(path.join("artifacts", "web-live.json"), JSON.stringify({
      backend: search.backend,
      searchMs,
      attempts: search.attempts,
      results: search.results.map((result) => ({ title: result.title, url: result.url })),
      fetch: { finalUrl: page.finalUrl, status: page.status, backend: page.backend, title: page.title, chars: page.text.length, head: page.text.slice(0, 400) },
      directFetch: { backend: plain.backend, status: plain.status, chars: plain.text.length, head: plain.text.slice(0, 120) },
    }, null, 2));
  }, 60000);
});
