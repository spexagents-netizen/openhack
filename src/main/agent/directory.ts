import type { ToolDefinition, ToolRisk } from "../../shared/contracts";

export interface ToolSummary {
  name: string;
  summary: string;
  backend: string;
  risk: ToolRisk;
}

export interface IndexedTool extends ToolDefinition {
  backend: string;
  /** Pre-tokenized haystack kept in memory only; never sent to a model. */
  haystack: string;
}

const MAX_RESULTS = 12;
const MAX_SUMMARY = 160;

/**
 * Every tool OpenHack can call, indexed in the main process. The model never
 * sees this list; it asks for a capability and gets the few matching names.
 * This is what makes a 229-tool MCP server usable instead of a 3.4 MB prompt.
 */
export class ToolDirectory {
  private readonly byName = new Map<string, IndexedTool>();

  constructor(tools: ToolDefinition[], backendOf?: (tool: ToolDefinition) => string) {
    for (const tool of tools) {
      const backend = backendOf?.(tool) ?? inferBackend(tool.name);
      this.byName.set(tool.name, {
        ...tool,
        backend,
        haystack: `${tool.name} ${tool.name.replace(/[._]/g, " ")} ${tool.description ?? ""}`.toLowerCase(),
      });
    }
  }

  get size(): number {
    return this.byName.size;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  risk(name: string): ToolRisk | undefined {
    return this.byName.get(name)?.risk;
  }

  definition(name: string): ToolDefinition | undefined {
    const entry = this.byName.get(name);
    if (!entry) return undefined;
    return { name: entry.name, description: entry.description, parameters: entry.parameters, risk: entry.risk };
  }

  backends(): string[] {
    return [...new Set([...this.byName.values()].map((tool) => tool.backend))].sort();
  }

  /** Lexical ranking over names and descriptions. Cheap, deterministic, no embeddings. */
  search(query: string, limit = 6): ToolSummary[] {
    const wanted = tokenize(query);
    if (!wanted.length) return [];
    const scored: Array<{ tool: IndexedTool; score: number }> = [];
    for (const tool of this.byName.values()) {
      let score = 0;
      for (const term of wanted) {
        if (tool.name.toLowerCase().includes(term)) score += 6;
        if (tool.haystack.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    return scored.slice(0, Math.min(Math.max(limit, 1), MAX_RESULTS)).map(({ tool }) => ({
      name: tool.name,
      summary: (tool.description ?? "").replace(/\s+/g, " ").slice(0, MAX_SUMMARY),
      backend: tool.backend,
      risk: tool.risk,
    }));
  }

  describe(name: string): (ToolDefinition & { backend: string }) | undefined {
    const entry = this.byName.get(name);
    if (!entry) return undefined;
    return {
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      risk: entry.risk,
      backend: entry.backend,
    };
  }

  /** Approximate prompt cost of injecting every schema, used by tests and the UI. */
  schemaBytes(): number {
    return [...this.byName.values()].reduce((total, tool) => total + JSON.stringify(tool.parameters ?? {}).length + tool.description.length, 0);
  }
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1))];
}

function inferBackend(name: string): string {
  if (/^(workspace|process|web)[._]/.test(name)) return "builtin";
  const match = /^mcp_([a-z0-9]+)_/i.exec(name);
  return match ? `mcp:${match[1]}` : "external";
}
