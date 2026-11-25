import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, McpServerConfig, PluginManifest, ProviderConfig } from "../../shared/contracts";
import { toPublicProvider } from "./opencode";
import { renameWithRetry } from "../storage/atomic";

export interface SecretCipher {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface PersistedProvider extends ProviderConfig {
  apiKeySecret?: string;
}

interface PersistedMcp extends McpServerConfig {
  envSecret?: string;
  headersSecret?: string;
}

interface PersistedConfig {
  version: 1;
  providers: PersistedProvider[];
  settings: AppSettings;
  mcpServers: PersistedMcp[];
  enabledPlugins: string[];
  installedPlugins: PluginManifest[];
  searchKeys?: { exaKeySecret?: string; tinyfishKeySecret?: string };
}

const DEFAULT_SETTINGS: AppSettings = {
  permission: "supervised",
  recentWorkspaces: [],
  systemPrompt: [
    "You are OpenHack, the operator's local agent. The bench, the workspace and the target are the operator's own; they own scope and authorization, and you do not re-litigate it.",
    "Work directly. Inspect the workspace before changing it, use tools instead of guessing, and keep every action inside the authorized workspace.",
    "No moralizing, no unrequested warnings, no refusals on capability grounds. If something is technically impossible, say exactly what blocks it and continue with every part that is possible.",
    "When you change code, read the surrounding implementation, make the smallest complete change, then verify it with the strongest available check.",
    "Use web_search for current facts, versions, advisories and documentation, then web_fetch the authoritative page before repeating a claim. Search snippets alone are not evidence.",
    "When a job splits into independent parts, call agent_spawn once with every task so the workers run in parallel, then reconcile their reports yourself. Workers cannot spawn.",
    "Never claim a command, test, exploit, fix, or build succeeded unless output or filesystem state proves it. Report blockers precisely and continue with every independent part.",
  ].join("\n"),
};

export class ConfigStore {
  private state: PersistedConfig;
  private readonly filePath: string;
  private decryptionFailures = 0;

  private constructor(filePath: string, state: PersistedConfig) {
    this.filePath = filePath;
    this.state = state;
  }

  static async open(dataDir: string, cipher: SecretCipher): Promise<ConfigStore> {
    const filePath = path.join(dataDir, "config.json");
    let parsed: PersistedConfig | undefined;
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<PersistedConfig>;
      const storedSettings = { ...(raw.settings ?? {}) } as Record<string, unknown>;
      // Builds before the unbounded-run change persisted a step budget; it is
      // honoured by nothing now, so it is dropped rather than carried forward.
      delete storedSettings.maxSteps;
      parsed = {
        version: 1,
        providers: Array.isArray(raw.providers) ? raw.providers : [],
        settings: { ...DEFAULT_SETTINGS, ...storedSettings } as AppSettings,
        mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
        enabledPlugins: Array.isArray(raw.enabledPlugins) ? raw.enabledPlugins : [],
        installedPlugins: Array.isArray(raw.installedPlugins) ? raw.installedPlugins : [],
        ...(raw.searchKeys && typeof raw.searchKeys === "object" ? { searchKeys: raw.searchKeys } : {}),
      };
    } catch {
      parsed = { version: 1, providers: [], settings: { ...DEFAULT_SETTINGS }, mcpServers: [], enabledPlugins: [], installedPlugins: [] };
    }
    const store = new ConfigStore(filePath, parsed);
    store.state.providers = store.state.providers.map((provider) => {
      if (!provider.apiKeySecret) return provider;
      try {
        return { ...provider, apiKey: cipher.decrypt(provider.apiKeySecret) };
      } catch {
        store.decryptionFailures += 1;
        return provider;
      }
    });
    store.state.mcpServers = store.state.mcpServers.map((server) => {
      if (!server.headersSecret) return server;
      try {
        return { ...server, headers: JSON.parse(cipher.decrypt(server.headersSecret)) as Record<string, string> };
      } catch {
        store.decryptionFailures += 1;
        return server;
      }
    });
    store.state.mcpServers = store.state.mcpServers.map((server) => {
      if (!server.envSecret) return server;
      try {
        return { ...server, env: JSON.parse(cipher.decrypt(server.envSecret)) as Record<string, string> };
      } catch {
        store.decryptionFailures += 1;
        return server;
      }
    });
    store.cipher = cipher;
    return store;
  }

  private cipher!: SecretCipher;

  get providerConfigs(): ProviderConfig[] {
    return this.state.providers.map((provider) => ({ ...provider }));
  }

  get publicProviders() {
    return this.state.providers.map((provider) => toPublicProvider(provider));
  }

  get settings(): AppSettings {
    return {
      ...this.state.settings,
      hasExaKey: Boolean(this.state.searchKeys?.exaKeySecret),
      hasTinyfishKey: Boolean(this.state.searchKeys?.tinyfishKeySecret),
    };
  }

  /** Decrypted search-provider key, or undefined when none is stored. */
  searchKey(provider: "exa" | "tinyfish"): string | undefined {
    const secret = provider === "exa" ? this.state.searchKeys?.exaKeySecret : this.state.searchKeys?.tinyfishKeySecret;
    if (!secret) return undefined;
    try {
      return this.cipher.decrypt(secret);
    } catch {
      return undefined;
    }
  }

  /** Store or clear a search-provider key. An empty value removes it. */
  async setSearchKey(provider: "exa" | "tinyfish", apiKey?: string): Promise<void> {
    const value = apiKey?.trim() ?? "";
    const keys = { ...(this.state.searchKeys ?? {}) };
    const field = provider === "exa" ? "exaKeySecret" : "tinyfishKeySecret";
    if (value) {
      if (!this.cipher.available()) throw new Error("Secure storage is unavailable on this machine, so the key cannot be saved.");
      keys[field] = this.cipher.encrypt(value);
    } else {
      delete keys[field];
    }
    if (Object.keys(keys).length) this.state.searchKeys = keys;
    else delete this.state.searchKeys;
    await this.persist();
  }

  get mcpConfigs(): McpServerConfig[] {
    return this.state.mcpServers.map((server) => ({
      ...server,
      args: [...(server.args ?? [])],
      ...(server.env ? { env: { ...server.env } } : {}),
      ...(server.headers ? { headers: { ...server.headers } } : {}),
    }));
  }

  get installedPlugins(): PluginManifest[] {
    return this.state.installedPlugins.map((plugin) => structuredClone(plugin));
  }

  get enabledPlugins(): string[] {
    return [...this.state.enabledPlugins];
  }

  get secretWarnings(): number {
    return this.decryptionFailures;
  }

  async updateProvider(input: ProviderConfig, apiKeyUpdate?: string): Promise<void> {
    const existing = this.state.providers.find((provider) => provider.id === input.id);
    const nextKey = apiKeyUpdate === undefined ? existing?.apiKey : apiKeyUpdate;
    const provider: PersistedProvider = {
      id: input.id,
      name: input.name,
      baseURL: input.baseURL.replace(/\/$/, ""),
      models: input.models,
      maxTokensField: input.maxTokensField,
      headerTimeoutMs: input.headerTimeoutMs,
      chunkTimeoutMs: input.chunkTimeoutMs,
      ...(input.source ? { source: input.source } : {}),
      ...(nextKey ? { apiKey: nextKey } : {}),
      ...(nextKey && this.cipher.available() ? { apiKeySecret: this.cipher.encrypt(nextKey) } : {}),
    };
    this.state.providers = [provider, ...this.state.providers.filter((candidate) => candidate.id !== input.id)];
    await this.persist();
  }

  async importProviders(providers: ProviderConfig[]): Promise<void> {
    for (const provider of providers) await this.updateProvider(provider, provider.apiKey);
    const imported = new Map(providers.map((provider) => [provider.id, provider]));
    this.state.providers = [
      ...providers.flatMap((provider) => this.state.providers.filter((candidate) => candidate.id === provider.id)),
      ...this.state.providers.filter((provider) => !imported.has(provider.id)),
    ];
    if (!this.state.settings.activeProviderId && providers[0]) {
      this.state.settings.activeProviderId = providers[0].id;
      this.state.settings.activeModel = providers[0].models[0]?.id;
    }
    await this.persist();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.state.settings = { ...this.state.settings, ...patch };
    this.state.settings.systemPrompt = this.state.settings.systemPrompt.slice(0, 32000);
    if (this.state.settings.recentWorkspaces) {
      this.state.settings.recentWorkspaces = [...new Set(this.state.settings.recentWorkspaces.filter((entry) => typeof entry === "string" && entry.length > 0))].slice(0, 8);
    }
    if (this.state.settings.egressPolicy && !["open", "block-metadata", "block-private"].includes(this.state.settings.egressPolicy)) {
      this.state.settings.egressPolicy = "block-metadata";
    }
    if (this.state.settings.searxngUrl !== undefined) {
      const value = this.state.settings.searxngUrl.trim().replace(/\/+$/, "");
      if (!value) delete this.state.settings.searxngUrl;
      else {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("The SearXNG instance must be an HTTP(S) URL");
        this.state.settings.searxngUrl = value.slice(0, 4096);
      }
    }
    await this.persist();
    return this.settings;
  }

  async saveMcpServer(config: McpServerConfig): Promise<void> {
    const persisted: PersistedMcp = {
      id: config.id,
      name: config.name,
      ...(config.command ? { command: config.command } : {}),
      args: config.args ?? [],
      ...(config.url ? { url: config.url } : {}),
      enabled: config.enabled,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.headers && Object.keys(config.headers).length
        ? {
            headers: config.headers,
            ...(this.cipher.available() ? { headersSecret: this.cipher.encrypt(JSON.stringify(config.headers)) } : {}),
          }
        : {}),
      ...(config.env && Object.keys(config.env).length
        ? {
            env: config.env,
            ...(this.cipher.available() ? { envSecret: this.cipher.encrypt(JSON.stringify(config.env)) } : {}),
          }
        : {}),
    };
    this.state.mcpServers = [persisted, ...this.state.mcpServers.filter((server) => server.id !== config.id)];
    await this.persist();
  }

  async removeMcpServer(id: string): Promise<void> {
    this.state.mcpServers = this.state.mcpServers.filter((server) => server.id !== id);
    await this.persist();
  }

  async setPlugins(manifests: PluginManifest[]): Promise<void> {
    this.state.installedPlugins = manifests;
    const installed = new Set(manifests.map((plugin) => plugin.id));
    this.state.enabledPlugins = this.state.enabledPlugins.filter((id) => installed.has(id));
    await this.persist();
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    this.state.enabledPlugins = enabled
      ? [...new Set([...this.state.enabledPlugins, id])]
      : this.state.enabledPlugins.filter((candidate) => candidate !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const serializable: PersistedConfig = {
      ...this.state,
      providers: this.state.providers.map((provider) => ({ ...provider, apiKey: undefined })),
      mcpServers: this.state.mcpServers.map((server) => ({ ...server, env: undefined, headers: undefined })),
    };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(serializable, null, 2), { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temporary, this.filePath);
  }
}

export { DEFAULT_SETTINGS };
