import { describe, expect, it } from "vitest";
import { importOpenCodeProviders } from "../src/main/config/opencode";

describe("OpenCode provider import", () => {
  it("imports only the two selected Modal providers and preserves secrets inside the private result", () => {
    const result = importOpenCodeProviders({
      providers: {
        "modal-kimi": {
          name: "Kimi",
          compatibility: { maxTokensField: "max_tokens" },
          models: { "moonshotai/Kimi-K3.1-Pro": { name: "Kimi K3.1 Pro", capabilities: { tools: true } } },
          settings: { baseURL: "http://127.0.0.1:20200/v1", apiKey: "private-key", headerTimeout: 300000, chunkTimeout: 180000 },
        },
        "modal-ep": {
          name: "DeepSeek",
          models: { "deepseek-ai/DeepSeek-V4.1-Flash-1017": { name: "DeepSeek" } },
          settings: { baseURL: "http://127.0.0.1:20199/v1", apiKey: "private-key-2" },
        },
        other: { settings: { baseURL: "https://example.invalid", apiKey: "do-not-import" } },
      },
    });
    expect(result.providers.map((provider) => provider.id)).toEqual(["modal-kimi", "modal-ep"]);
    expect(result.providers[0]?.apiKey).toBe("private-key");
    expect(result.providers[0]?.maxTokensField).toBe("max_tokens");
    expect(result.providers[0]?.models[0]?.id).toBe("moonshotai/Kimi-K3.1-Pro");
    expect(JSON.stringify(result.publicProviders)).not.toContain("private-key");
    expect(JSON.stringify(result.publicProviders)).not.toContain("do-not-import");
  });

  it("accepts JSONC without evaluating configuration code", () => {
    expect(() => importOpenCodeProviders('{"providers":{},"run":"process.exit()"}')).not.toThrow();
  });

  it("rejects an invalid provider endpoint instead of registering it", () => {
    expect(() => importOpenCodeProviders({ providers: { "modal-kimi": { settings: { baseURL: "not a URL" }, models: {} } } })).toThrow();
    expect(importOpenCodeProviders({ providers: { "modal-kimi": { settings: { baseURL: "http://127.0.0.1:1/v1" }, models: {}, compatibility: { maxTokensField: "max_completion_tokens" } } } }).providers[0]?.maxTokensField).toBe("max_completion_tokens");
  });

  it("anchors relative OpenCode file credential references to the config directory", () => {
    const imported = importOpenCodeProviders({
      providers: { "modal-kimi": { settings: { baseURL: "http://127.0.0.1:20200/v1", apiKey: "{file:secrets/modal.key}" }, models: {} } },
    }, { baseDir: "C:\\Users\\operator\\.config\\opencode" });
    expect(imported.providers[0]?.apiKey).toBe("{file:C:\\Users\\operator\\.config\\opencode\\secrets\\modal.key}");
  });
});
