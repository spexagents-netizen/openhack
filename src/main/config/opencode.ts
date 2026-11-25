import path from "node:path";
import type { McpServerConfig, ProviderConfig, PublicProviderConfig } from "../../shared/contracts";

export function importOpenCodeProviders(source: unknown, options?: { baseDir?: string }): { providers: ProviderConfig[]; publicProviders: PublicProviderConfig[] } {
  const root = typeof source === "string" ? JSON.parse(stripJsonComments(source)) : source;
  if (!root || typeof root !== "object") throw new Error("OpenCode config must be an object");
  const configured = (root as { providers?: unknown }).providers;
  if (!configured || typeof configured !== "object") return { providers: [], publicProviders: [] };

  const providers = ["modal-kimi", "modal-ep"].flatMap((id): ProviderConfig[] => {
    const entry = (configured as Record<string, unknown>)[id];
    if (!entry || typeof entry !== "object") return [];
    const provider = entry as Record<string, unknown>;
    const settings = object(provider.settings);
    const models = Object.entries(object(provider.models)).map(([modelId, value]) => {
      const model = object(value);
      const capabilities = object(model.capabilities);
      const limit = object(model.limit);
      return {
        id: modelId,
        name: typeof model.name === "string" ? model.name : modelId,
        tools: capabilities.tools === true || model.tool_call === true,
        ...(typeof limit.context === "number" ? { context: limit.context } : {}),
        ...(typeof limit.output === "number" ? { output: limit.output } : {}),
        ...(capabilities.reasoning ? { reasoning: true } : {}),
      };
    });
    const baseURL = typeof settings.baseURL === "string" ? settings.baseURL.replace(/\/$/, "") : "";
    if (!isAllowedProviderUrl(baseURL)) throw new Error(`${id} must use HTTPS or a loopback HTTP endpoint`);
    const maxTokensField = object(provider.compatibility).maxTokensField;
    return [{
      id,
      name: typeof provider.name === "string" ? provider.name : id,
      baseURL,
      ...(typeof settings.apiKey === "string" ? { apiKey: resolveFileReference(settings.apiKey, options?.baseDir) } : {}),
      models,
      maxTokensField: maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
      headerTimeoutMs: numberOr(settings.headerTimeout, 120000),
      chunkTimeoutMs: numberOr(settings.chunkTimeout, 120000),
      source: "opencode",
    }];
  });
  return { providers, publicProviders: providers.map(toPublicProvider) };
}

/**
 * Import stdio MCP servers from an OpenCode config. Remote (HTTP) servers are
 * reported separately because OpenHack launches stdio processes today.
 */
export function importOpenCodeMcp(source: unknown): { servers: McpServerConfig[]; skipped: string[] } {
  const root = typeof source === "string" ? JSON.parse(stripJsonComments(source)) : source;
  const configured = object(object(object(root).mcp).servers);
  const servers: McpServerConfig[] = [];
  const skipped: string[] = [];
  for (const [id, value] of Object.entries(configured)) {
    const entry = object(value);
    if (typeof entry.url === "string" || entry.type === "remote") {
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) {
        skipped.push(`${id} (invalid remote url)`);
        continue;
      }
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
        skipped.push(`${id} (unsupported id)`);
        continue;
      }
      const remoteHeaders = Object.entries(object(entry.headers)).filter((pair): pair is [string, string] => typeof pair[1] === "string");
      servers.push({
        id,
        name: id,
        url,
        enabled: entry.disabled !== true,
        ...(remoteHeaders.length ? { headers: Object.fromEntries(remoteHeaders) } : {}),
      });
      continue;
    }
    const command = Array.isArray(entry.command) ? entry.command.map(String) : [];
    if (!command.length || !command[0]) {
      skipped.push(`${id} (no command)`);
      continue;
    }
    const env = object(entry.environment);
    const envEntries = Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === "string");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      skipped.push(`${id} (unsupported id)`);
      continue;
    }
    servers.push({
      id,
      name: id,
      command: command[0],
      args: command.slice(1),
      enabled: entry.disabled !== true,
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}),
    });
  }
  return { servers, skipped };
}

export function toPublicProvider(provider: ProviderConfig): PublicProviderConfig {
  return {
    id: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    models: provider.models,
    maxTokensField: provider.maxTokensField,
    headerTimeoutMs: provider.headerTimeoutMs,
    chunkTimeoutMs: provider.chunkTimeoutMs,
    hasApiKey: Boolean(provider.apiKey),
    ...(provider.source ? { source: provider.source } : {}),
  };
}

export function stripJsonComments(input: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; output += char; continue; }
    if (char === "/" && next === "/") { while (index < input.length && input[index] !== "\n") index += 1; output += "\n"; continue; }
    if (char === "/" && next === "*") { index += 2; while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1; index += 1; continue; }
    output += char;
  }
  return output.replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveFileReference(reference: string, baseDir?: string): string {
  const match = /^\{file:([^}]+)\}$/.exec(reference);
  if (!match || !baseDir) return reference;
  const file = match[1]!.trim();
  if (file.startsWith("~") || path.isAbsolute(file)) return reference;
  return `{file:${path.resolve(baseDir, file)}}`;
}

function isAllowedProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
