import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, type SecretCipher } from "../src/main/config/store";
import { importOpenCodeProviders } from "../src/main/config/opencode";
import { OpenAIStreamParser } from "../src/main/providers/sse";
import { runWorkspaceProcess } from "../src/main/workspace/process";
import { Workspace } from "../src/main/workspace/workspace";

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).toString("base64"),
  decrypt: (value) => {
    if (value === "broken") throw new Error("cannot decrypt");
    return Buffer.from(value, "base64").toString("utf8");
  },
};

describe("provider parser edge cases", () => {
  it("finishes buffered data, reports lengths, rejects invalid args, and surfaces provider errors", () => {
    const parser = new OpenAIStreamParser();
    expect(parser.push('data: {"choices":[{"delta":{"content":"tail"}}]}')).toEqual([]);
    expect(parser.finish()).toEqual([{ type: "text.delta", text: "tail" }, { type: "finished", reason: "stop" }]);
    expect(parser.finish()).toEqual([]);
    const length = new OpenAIStreamParser();
    expect(length.push('data: {"choices":[{"finish_reason":"length"}]}\n\n')).toContainEqual({ type: "finished", reason: "length" });
    expect(() => new OpenAIStreamParser().push('data: {"error":{"message":"upstream failed"}}\n\n')).toThrow(/upstream/u);
    expect(() => new OpenAIStreamParser().push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x","arguments":"[]"}}]}}]}\n\ndata: [DONE]\n\n')).toThrow(/object/u);
    expect(() => new OpenAIStreamParser().push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n')).toThrow(/name/u);
  });
});

describe("workspace boundaries and limits", () => {
  it("rejects binary, oversized, escaped and symlinked reads without writing through a link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-edge-ws-"));
    const outside = await mkdtemp(path.join(tmpdir(), "openhack-edge-outside-"));
    await writeFile(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(path.join(root, "lines.txt"), "one\ntwo\nthree");
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(root, "link"), "junction");
    const workspace = new Workspace(root);
    await expect(workspace.read("binary.bin")).rejects.toThrow(/Binary/u);
    await expect(workspace.read("large.txt")).rejects.toThrow(/2 MiB/u);
    await expect(workspace.read("link/secret.txt")).rejects.toThrow(/outside|symbolic/iu);
    await expect(workspace.write("link/new.txt", "no")).rejects.toThrow(/symbolic|outside/iu);
    await expect(readFile(path.join(outside, "new.txt"), "utf8")).rejects.toThrow();
    const partial = await workspace.read("lines.txt", 1, 1);
    expect(partial).toMatchObject({ content: "two", truncated: true, totalLines: 3 });
    await expect(workspace.search("")).rejects.toThrow(/empty/u);
    await expect(workspace.write("huge.txt", "x".repeat(2 * 1024 * 1024 + 1))).rejects.toThrow(/2 MiB/u);
    await expect(workspace.replace("lines.txt", "absent", "x")).rejects.toThrow(/not found/u);
  });
});

describe("process execution edges", () => {
  it("captures timeouts, cancellation, huge output and unavailable executables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-process-"));
    const timeout = await runWorkspaceProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 5000)"],
      cwd: root,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    expect(timeout.timedOut).toBe(true);
    const controller = new AbortController();
    const pending = runWorkspaceProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 5000)"],
      cwd: root,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    expect((await pending).exitCode).not.toBe(0);
    const huge = await runWorkspaceProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1100000))"],
      cwd: root,
      timeoutMs: 10000,
      signal: new AbortController().signal,
    });
    expect(huge.truncated).toBe(true);
    await expect(runWorkspaceProcess({ executable: "not-a-real-executable-xyz", args: [], cwd: root, signal: new AbortController().signal })).rejects.toThrow();
  });
});

describe("provider import and config edge paths", () => {
  it("rejects insecure remote endpoints and handles empty or corrupt stored secrets", async () => {
    expect(() => importOpenCodeProviders({
      providers: {
        "modal-kimi": { settings: { baseURL: "http://remote.example/v1" }, models: {} },
        "modal-ep": { settings: { baseURL: "https://example.test/v1" }, models: {} },
      },
    })).toThrow(/HTTPS|loopback/u);
    expect(importOpenCodeProviders({}).providers).toEqual([]);
    expect(() => importOpenCodeProviders("null")).toThrow(/object/u);
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-config-edge-"));
    await writeFile(path.join(directory, "config.json"), JSON.stringify({
      version: 1,
      providers: [{
        id: "p", name: "P", baseURL: "https://example.test", models: [{ id: "m", name: "M", tools: true }],
        maxTokensField: "max_tokens", headerTimeoutMs: 1000, chunkTimeoutMs: 1000, apiKeySecret: "broken",
      }],
      settings: { permission: "supervised", systemPrompt: "x" },
      mcpServers: [{ id: "m", name: "M", command: "x", args: [], enabled: true, envSecret: "broken" }],
      installedPlugins: [{ id: "a", name: "A", version: "1", description: "" }, { id: "b", name: "B", version: "1", description: "" }],
      enabledPlugins: ["a", "missing"],
    }));
    const store = await ConfigStore.open(directory, cipher);
    expect(store.secretWarnings).toBe(2);
    expect(store.providerConfigs[0]?.apiKey).toBeUndefined();
    await store.importProviders([{
      id: "second", name: "Second", baseURL: "https://example.test", models: [{ id: "m", name: "M", tools: true }],
      maxTokensField: "max_tokens", headerTimeoutMs: 1000, chunkTimeoutMs: 1000,
    }]);
    expect(store.settings.activeProviderId).toBeTruthy();
    await store.setPlugins([{ id: "a", name: "A", version: "1", description: "" }]);
    expect(store.enabledPlugins).toEqual(["a"]);
    await store.removeMcpServer("m");
    expect(store.mcpConfigs).toEqual([]);
  });
});
