import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, resolveApiKey } from "../src/main/providers/openai-compatible";
import type { ModelEvent } from "../src/shared/contracts";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function bind(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("OpenAICompatibleProvider", () => {
  it("normalizes a non-streaming JSON completion", async () => {
    const baseURL = await bind((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "json-answer", tool_calls: [{ id: "c", type: "function", function: { name: "workspace_list", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }));
    });
    const provider = makeProvider(baseURL, "key-value");
    const events: ModelEvent[] = [];
    for await (const event of provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({ type: "text.delta", text: "json-answer" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", name: "workspace_list" }));
    expect(events).toContainEqual({ type: "usage", inputTokens: 4, outputTokens: 3 });
  });

  it("redacts credentials from provider errors and reported test failures", async () => {
    const baseURL = await bind((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("invalid key super-secret-key");
    });
    const provider = makeProvider(baseURL, "super-secret-key");
    await expect(async () => {
      for await (const _event of provider.stream({ model: "m", messages: [], tools: [] }, new AbortController().signal)) { /* consume */ }
    }).rejects.toThrow(/\[redacted\]/);
    const tested = await provider.test();
    expect(tested.ok).toBe(false);
    expect(tested.detail).not.toContain("super-secret-key");
  });

  it("resolves OpenCode file-backed credentials without exposing the file path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-keyfile-"));
    const keyFile = path.join(directory, "key.txt");
    await writeFile(keyFile, "file-secret\n");
    expect(await resolveApiKey(`{file:${keyFile}}`)).toBe("file-secret");
    expect(await resolveApiKey("{env:OPENHACK_TEST_MISSING_KEY}")).toBeUndefined();
    const baseURL = await bind((request, response) => {
      expect(request.headers.authorization).toBe("Bearer file-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "authorized" } }] }));
    });
    const provider = new OpenAICompatibleProvider({
      id: "p", name: "P", baseURL, apiKey: `{file:${keyFile}}`,
      models: [{ id: "m", name: "M", tools: true }], maxTokensField: "max_tokens",
      headerTimeoutMs: 10000, chunkTimeoutMs: 10000,
    });
    const events: ModelEvent[] = [];
    for await (const event of provider.stream({ model: "m", messages: [], tools: [] }, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({ type: "text.delta", text: "authorized" });
    await expect(resolveApiKey(`{file:${path.join(directory, "missing")}}`)).rejects.toThrow(/credential file/u);
  });

  it("times out a stalled header and surfaces cancellation", async () => {
    const baseURL = await bind(() => { /* intentionally never respond */ });
    const provider = makeProvider(baseURL, "key", 40);
    await expect(async () => {
      for await (const _event of provider.stream({ model: "m", messages: [], tools: [] }, new AbortController().signal)) { /* consume */ }
    }).rejects.toThrow(/cancelled|timed out/);
    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _event of provider.stream({ model: "m", messages: [], tools: [] }, controller.signal)) { /* consume */ }
    }).rejects.toThrow(/cancelled|timed out/);
  });
});

function makeProvider(baseURL: string, apiKey: string, headerTimeoutMs = 30000): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "p",
    name: "P",
    baseURL,
    apiKey,
    models: [{ id: "m", name: "M", tools: true }],
    maxTokensField: "max_tokens",
    headerTimeoutMs,
    chunkTimeoutMs: 30000,
  });
}
