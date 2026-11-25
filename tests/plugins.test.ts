import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, type SecretCipher } from "../src/main/config/store";
import { PluginManager } from "../src/main/plugins/manager";

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};

describe("PluginManager", () => {
  it("imports a manifest plugin as data and contributes its prompt only when enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-plugins-"));
    const data = path.join(root, "data");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "openhack-plugin.json"), JSON.stringify({
      id: "fixture-tools",
      name: "Fixture tools",
      version: "1.0.0",
      description: "Adds evidence discipline.",
      systemPrompt: "Always cite exact file lines.",
      commands: [{ name: "map", description: "Map the target", prompt: "Map the target." }],
    }));
    const config = await ConfigStore.open(data, cipher);
    const manager = new PluginManager(path.join(data, "plugins"), config);
    const statuses = await manager.importDirectory(source);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: "fixture-tools", enabled: true });
    expect(manager.enabledPrompt()).toContain("Always cite exact file lines.");
    await manager.setEnabled("fixture-tools", false);
    expect(manager.enabledPrompt()).toBe("");
  });
});
