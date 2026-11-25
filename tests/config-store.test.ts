import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, type SecretCipher } from "../src/main/config/store";
import type { ProviderConfig } from "../src/shared/contracts";

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => `sealed:${Buffer.from(value).toString("base64")}`,
  decrypt: (value) => Buffer.from(value.replace(/^sealed:/, ""), "base64").toString("utf8"),
};

const provider: ProviderConfig = {
  id: "modal-kimi",
  name: "Kimi",
  baseURL: "http://127.0.0.1:20200/v1",
  apiKey: "real-secret",
  models: [{ id: "moonshotai/Kimi-K3.1-Pro", name: "Kimi K3.1 Pro", tools: true }],
  maxTokensField: "max_tokens",
  headerTimeoutMs: 300000,
  chunkTimeoutMs: 180000,
  source: "opencode",
};

describe("ConfigStore", () => {
  it("encrypts provider and MCP secrets at rest and decrypts them on reopen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-config-"));
    const store = await ConfigStore.open(directory, cipher);
    await store.updateProvider(provider, provider.apiKey);
    await store.saveMcpServer({ id: "mcp", name: "MCP", command: "npx", args: ["-y", "server"], env: { TOKEN: "mcp-secret" }, enabled: true });
    await store.updateSettings({ permission: "workspace", systemPrompt: "operator" });
    const raw = await readFile(path.join(directory, "config.json"), "utf8");
    expect(raw).not.toContain("real-secret");
    expect(raw).not.toContain("mcp-secret");
    expect(JSON.stringify(store.publicProviders)).not.toContain("real-secret");
    expect(store.publicProviders[0]?.hasApiKey).toBe(true);

    const reopened = await ConfigStore.open(directory, cipher);
    expect(reopened.providerConfigs[0]?.apiKey).toBe("real-secret");
    expect(reopened.mcpConfigs[0]?.env).toEqual({ TOKEN: "mcp-secret" });
    expect(reopened.settings.permission).toBe("workspace");
  });

  it("stores search keys encrypted and reports only their presence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-searchkey-"));
    const store = await ConfigStore.open(directory, cipher);
    expect(store.settings.hasExaKey).toBe(false);
    expect(store.settings.hasTinyfishKey).toBe(false);
    expect(store.searchKey("exa")).toBeUndefined();
    await store.setSearchKey("exa", "exa-secret-value");
    await store.setSearchKey("tinyfish", "tf-secret-value");
    expect(store.settings.hasExaKey).toBe(true);
    expect(store.settings.hasTinyfishKey).toBe(true);
    expect(store.searchKey("exa")).toBe("exa-secret-value");
    expect(store.searchKey("tinyfish")).toBe("tf-secret-value");
    const raw = await readFile(path.join(directory, "config.json"), "utf8");
    expect(raw).not.toContain("exa-secret-value");
    expect(raw).not.toContain("tf-secret-value");
    expect(JSON.stringify(store.settings)).not.toContain("secret-value");
    const reopened = await ConfigStore.open(directory, cipher);
    expect(reopened.searchKey("exa")).toBe("exa-secret-value");
    expect(reopened.searchKey("tinyfish")).toBe("tf-secret-value");
    await reopened.setSearchKey("exa");
    expect(reopened.settings.hasExaKey).toBe(false);
    expect(reopened.searchKey("tinyfish")).toBe("tf-secret-value");
  });

  it("refuses to store a key when the OS cipher is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-key-nocipher-"));
    const unavailable: SecretCipher = { available: () => false, encrypt: () => { throw new Error("no"); }, decrypt: () => { throw new Error("no"); } };
    const store = await ConfigStore.open(directory, unavailable);
    await expect(store.setSearchKey("exa", "value")).rejects.toThrow(/Secure storage/u);
  });

  it("retains a key only in memory when the OS cipher is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-nocipher-"));
    const unavailable: SecretCipher = { available: () => false, encrypt: () => { throw new Error("no"); }, decrypt: () => { throw new Error("no"); } };
    const store = await ConfigStore.open(directory, unavailable);
    await store.updateProvider(provider, provider.apiKey);
    expect(store.providerConfigs[0]?.apiKey).toBe("real-secret");
    const raw = await readFile(path.join(directory, "config.json"), "utf8");
    expect(raw).not.toContain("real-secret");
  });

  it("drops the retired per-run step budget from a stored config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-legacy-"));
    await writeFile(path.join(directory, "config.json"), JSON.stringify({
      version: 1,
      providers: [],
      // Builds before unbounded runs wrote this; loading must not carry it forward.
      settings: { permission: "supervised", maxSteps: 12 },
      mcpServers: [],
      enabledPlugins: [],
      installedPlugins: [],
    }));
    const store = await ConfigStore.open(directory, cipher);
    expect("maxSteps" in store.settings).toBe(false);
    await store.updateSettings({ permission: "workspace" });
    const raw = await readFile(path.join(directory, "config.json"), "utf8");
    expect(JSON.parse(raw).settings.maxSteps).toBeUndefined();
  });

  it("normalizes a SearXNG instance and rejects a non-HTTP one", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-searx-"));
    const store = await ConfigStore.open(directory, cipher);
    expect(await store.updateSettings({ searxngUrl: "https://searx.example.org///" })).toMatchObject({
      searxngUrl: "https://searx.example.org",
    });
    await expect(store.updateSettings({ searxngUrl: "file:///etc/passwd" })).rejects.toThrow(/HTTP/u);
    const cleared = await store.updateSettings({ searxngUrl: "  " });
    expect(cleared.searxngUrl).toBeUndefined();
    expect((await store.updateSettings({ egressPolicy: "block-private" })).egressPolicy).toBe("block-private");
    const reset = await store.updateSettings({ egressPolicy: "bogus" as never });
    expect(reset.egressPolicy).toBe("block-metadata");
  });
});
