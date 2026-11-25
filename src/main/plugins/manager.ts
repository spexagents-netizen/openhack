import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginManifest, PluginStatus } from "../../shared/contracts";
import type { ConfigStore } from "../config/store";

const PluginSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  description: z.string().max(2000).default(""),
  systemPrompt: z.string().max(16000).optional(),
  commands: z.array(z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    prompt: z.string().min(1).max(16000),
  })).max(64).optional(),
  permissions: z.array(z.string().max(120)).max(64).optional(),
});

export class PluginManager {
  constructor(readonly directory: string, private readonly config: ConfigStore) {}

  async scan(): Promise<PluginStatus[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const manifests: PluginManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.directory, entry.name);
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink()) continue;
        const manifestPath = path.join(directory, "openhack-plugin.json");
        const manifestInfo = await lstat(manifestPath);
        if (!manifestInfo.isFile() || manifestInfo.size > 64 * 1024) continue;
        const raw = JSON.parse(await readFile(manifestPath, "utf8"));
        manifests.push(PluginSchema.parse(raw));
      } catch {
        // A malformed plugin is ignored, not executed.
      }
    }
    await this.config.setPlugins(manifests);
    return this.statuses(manifests);
  }

  async statuses(manifests = this.config.installedPlugins): Promise<PluginStatus[]> {
    const enabled = new Set(this.config.enabledPlugins);
    return manifests.map((manifest) => ({
      ...manifest,
      enabled: enabled.has(manifest.id),
      path: path.join(this.directory, manifest.id),
    }));
  }

  async importDirectory(source: string): Promise<PluginStatus[]> {
    const info = await lstat(source);
    if (!info.isDirectory()) throw new Error("Select a plugin folder");
    const raw = await readFile(path.join(source, "openhack-plugin.json"), "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Plugin manifest exceeds 64 KiB");
    const manifest = PluginSchema.parse(JSON.parse(raw));
    const destination = path.join(this.directory, manifest.id);
    if (path.resolve(destination) === path.resolve(source)) return this.scan();
    const files = await walk(source, 0);
    if (files.count > 100 || files.bytes > 5 * 1024 * 1024) throw new Error("Manifest plugin payload exceeds 100 files or 5 MiB");
    await cp(source, destination, { recursive: true, force: false, errorOnExist: false, dereference: false });
    await this.config.setPluginEnabled(manifest.id, true);
    return this.scan();
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus[]> {
    await this.config.setPluginEnabled(id, enabled);
    return this.statuses();
  }

  enabledPrompt(): string {
    const enabled = new Set(this.config.enabledPlugins);
    return this.config.installedPlugins
      .filter((plugin) => enabled.has(plugin.id) && plugin.systemPrompt)
      .map((plugin) => `Plugin ${plugin.name} (${plugin.id}):\n${plugin.systemPrompt}`)
      .join("\n\n");
  }
}

async function walk(directory: string, depth: number): Promise<{ count: number; bytes: number }> {
  if (depth > 8) throw new Error("Plugin directory nesting exceeds 8 levels");
  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Plugin folders may not contain symbolic links");
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await walk(target, depth + 1);
      count += nested.count;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      const info = await lstat(target);
      count += 1;
      bytes += info.size;
    }
  }
  return { count, bytes };
}
