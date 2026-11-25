import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpServerStatus, ToolDefinition } from "../../shared/contracts";
import { redact } from "../security/redact";

interface LiveServer {
  client: Client;
  transport: Transport;
  tools: ToolDefinition[];
  toolNames: Map<string, string>;
  state: "starting" | "ready" | "failed";
  error?: string;
  envKeys: string[];
  stderr: string;
}

export class McpManager {
  private readonly live = new Map<string, LiveServer>();

  constructor(private readonly configs: () => McpServerConfig[]) {}

  async startAll(): Promise<void> {
    await Promise.allSettled(this.configs().filter((server) => server.enabled).map((server) => this.connect(server)));
  }

  async connect(config: McpServerConfig): Promise<McpServerStatus> {
    await this.disconnect(config.id);
    const stderrChunks: Buffer[] = [];
    // A url means Streamable HTTP; otherwise launch a stdio process.
    const transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          ...(config.headers && Object.keys(config.headers).length
            ? { requestInit: { headers: config.headers } }
            : {}),
        })
      : new StdioClientTransport({
          command: config.command ?? "",
          args: config.args ?? [],
          cwd: config.cwd,
          env: buildEnvironment(config.env),
          stderr: "pipe",
        });
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        const total = stderrChunks.reduce((sum, item) => sum + item.length, 0);
        while (total > 16384 && stderrChunks.length > 1) stderrChunks.shift();
      });
    }
    const live: LiveServer = {
      client: new Client({ name: "openhack", version: "0.1.0" }),
      transport,
      tools: [],
      toolNames: new Map(),
      state: "starting",
      envKeys: Object.keys(config.env ?? {}),
      stderr: "",
    };
    this.live.set(config.id, live);
    try {
      // A package runner may have to fetch the server before it answers: REA took
      // 43 s cold from npx. Local binaries get a tighter budget.
      const runner = /^(npx|pnpx|bunx|uvx)(\.cmd|\.exe)?$/i.test(path.basename(config.command ?? "").toLowerCase());
      const startupBudget = runner ? 180000 : 30000;
      await withTimeout(live.client.connect(transport), startupBudget, `MCP server did not initialize in ${Math.round(startupBudget / 1000)} seconds`);
      // Servers may paginate the catalog; walk the cursor instead of taking page one.
      const discovered: Awaited<ReturnType<typeof live.client.listTools>>["tools"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const listed = await withTimeout(live.client.listTools(cursor ? { cursor } : undefined), 15000, "MCP tool discovery timed out");
        discovered.push(...listed.tools);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      live.tools = discovered.slice(0, 256).map((tool) => {
        const exposed = `mcp_${safeName(config.id)}_${safeName(tool.name)}`;
        live.toolNames.set(exposed, tool.name);
        return {
          name: exposed,
          description: `[${config.name}] ${tool.description ?? tool.name}`.slice(0, 4000),
          parameters: tool.inputSchema as Record<string, unknown>,
          risk: tool.annotations?.readOnlyHint === true ? "read" : "execute",
        };
      });
      live.state = "ready";
      live.stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-8192);
      return this.status(config, live);
    } catch (error) {
      live.state = "failed";
      live.error = redact(error instanceof Error ? error.message : String(error), Object.values(config.env ?? {}));
      live.stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-8192);
      await transport.close().catch(() => undefined);
      return this.status(config, live);
    }
  }

  async disconnect(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    await Promise.race([live.transport.close(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => undefined);
  }

  async callTool(exposedName: string, args: unknown, signal: AbortSignal): Promise<string> {
    for (const live of this.live.values()) {
      const original = live.toolNames.get(exposedName);
      if (!original || live.state !== "ready") continue;
      const result = await live.client.callTool({ name: original, arguments: args as Record<string, unknown> }, undefined, { signal });
      return normalizeMcpResult(result);
    }
    throw new Error(`MCP tool is not connected: ${exposedName}`);
  }

  tools(): ToolDefinition[] {
    return [...this.live.values()].filter((live) => live.state === "ready").flatMap((live) => live.tools);
  }

  statuses(): McpServerStatus[] {
    return this.configs().map((config) => this.status(config, this.live.get(config.id)));
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  private status(config: McpServerConfig, live?: LiveServer): McpServerStatus {
    return {
      id: config.id,
      name: config.name,
      command: config.command,
      args: config.args,
      enabled: config.enabled,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      envKeys: live?.envKeys ?? Object.keys(config.env ?? {}),
      state: live?.state ?? "stopped",
      tools: live?.tools ?? [],
      ...(live?.error ? { error: live.error } : {}),
    };
  }
}

function buildEnvironment(extra?: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries([
    "PATH", "Path", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME",
  ].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])) as Record<string, string>;
  return { ...base, ...(extra ?? {}), OPENHACK_MCP: "1" };
}

function normalizeMcpResult(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const record = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const pieces: string[] = [];
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") pieces.push(part.text);
      else if (part.type === "resource" && part.resource && typeof part.resource === "object") {
        const text = (part.resource as Record<string, unknown>).text;
        if (typeof text === "string") pieces.push(text);
      } else pieces.push(JSON.stringify(part));
    }
  }
  if (!pieces.length && record.structuredContent !== undefined) pieces.push(JSON.stringify(record.structuredContent));
  const text = pieces.join("\n").slice(0, 1024 * 1024) || JSON.stringify({ ok: !record.isError });
  if (record.isError) throw new Error(text);
  return text;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
