import type { ToolDefinition } from "../../shared/contracts";
import type { ToolDirectory } from "./directory";
import type { SkillRegistry } from "../skills/registry";

export interface SwitchboardContext {
  directory?: ToolDirectory;
  skills?: SkillRegistry;
  callTool: (name: string, args: unknown) => Promise<string>;
}

export const SWITCHBOARD_TOOLS = ["tool_search", "tool_describe", "tool_call", "skill_search", "skill_load"] as const;

export function isSwitchboardTool(name: string): boolean {
  return (SWITCHBOARD_TOOLS as readonly string[]).includes(name.replace(/\./g, "_"));
}

/**
 * The model's front door. Five verbs replace an unbounded tool catalog: search
 * for a capability, read its schema, call it, and pull a workflow playbook when
 * the job needs one. Schemas and skill bodies cost tokens only when used.
 */
export function switchboardDefinitions(): ToolDefinition[] {
  return [
    {
      name: "tool_search",
      description:
        "Find a capability OpenHack can call but that is not exposed directly: MCP servers, the agent bus, anything installed later. Call this first when no visible tool fits. Returns tool names with a one-line summary and backend; then call tool_describe for the exact schema, then tool_call to run it.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to do, in plain words. Include the target type, e.g. '.NET assembly decompile' or 'sql injection check'." },
          limit: { type: "integer", minimum: 1, maximum: 12, default: 6 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
    },
    {
      name: "tool_describe",
      description: "Return the full JSON schema for one tool found with tool_search. Do this before calling a tool whose arguments you are unsure about.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Exact tool name from tool_search." } },
        required: ["name"],
        additionalProperties: false,
      },
      risk: "read",
    },
    {
      name: "tool_call",
      description:
        "Execute a tool by exact name with a JSON argument object. Use it for any capability found through tool_search. The call follows the same approval policy and audit log as a directly exposed tool, and its result is returned verbatim.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact tool name from tool_search or tool_describe." },
          arguments: { type: "object", description: "Arguments object matching the tool schema. Omit when the tool takes none." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      risk: "execute",
    },
    {
      name: "skill_search",
      description:
        "Search the installed workflow playbooks (skills) for this kind of job: web recon, API testing, binary triage, Electron reversing, exploit reporting, scope rules. Returns names and one-line descriptions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The task you are about to do." },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
    },
    {
      name: "skill_load",
      description:
        "Load one skill by name and follow its workflow. Skills are operator-authored playbooks; loading one is how you match the bench's method instead of improvising.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Exact skill name from skill_search or the system prompt index." } },
        required: ["name"],
        additionalProperties: false,
      },
      risk: "read",
    },
  ];
}

export async function runSwitchboard(name: string, args: unknown, context: SwitchboardContext): Promise<string> {
  const verb = name.replace(/\./g, "_");
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  if (verb === "tool_search") {
    if (!context.directory) throw new Error("No tool directory is loaded");
    const query = typeof input.query === "string" ? input.query : "";
    if (!query.trim()) throw new Error("tool_search needs a query");
    const limit = typeof input.limit === "number" ? input.limit : 6;
    const tools = context.directory.search(query, limit);
    return JSON.stringify({ query, found: tools.length, indexed: context.directory.size, backends: context.directory.backends(), tools });
  }

  if (verb === "tool_describe") {
    if (!context.directory) throw new Error("No tool directory is loaded");
    const target = typeof input.name === "string" ? input.name : "";
    const definition = context.directory.describe(target);
    if (!definition) throw new Error(`Unknown tool: ${target}. Call tool_search first.`);
    return JSON.stringify(definition);
  }

  if (verb === "tool_call") {
    if (!context.directory) throw new Error("No tool directory is loaded");
    const target = typeof input.name === "string" ? input.name : "";
    if (!context.directory.has(target)) throw new Error(`Unknown tool: ${target}. Call tool_search first.`);
    const forwarded = input.arguments && typeof input.arguments === "object" ? input.arguments : {};
    return context.callTool(target, forwarded);
  }

  if (verb === "skill_search") {
    if (!context.skills || !context.skills.size) return JSON.stringify({ found: 0, skills: [], note: "No skills are installed. Put SKILL.md folders under the data directory's skills folder." });
    const query = typeof input.query === "string" ? input.query : "";
    const limit = typeof input.limit === "number" ? input.limit : 5;
    const skills = context.skills.search(query, limit);
    return JSON.stringify({ query, found: skills.length, installed: context.skills.size, skills });
  }

  if (verb === "skill_load") {
    if (!context.skills) throw new Error("No skills are installed");
    const target = typeof input.name === "string" ? input.name : "";
    const skill = context.skills.load(target);
    if (!skill) throw new Error(`Unknown skill: ${target}. Call skill_search first.`);
    return `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
  }

  throw new Error(`Unknown switchboard tool: ${name}`);
}
