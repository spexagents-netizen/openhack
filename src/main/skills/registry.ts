import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  source: string;
}

export interface SkillSummary {
  name: string;
  description: string;
}

const MAX_BODY = 24_000;
const MAX_INDEX = 60;
const MAX_DESCRIPTION = 110;

/**
 * Workflow playbooks on disk, discovered once and loaded only when a run asks
 * for one. The prompt carries a compact index; the body costs tokens only after
 * `skill_load`. This is the progressive-disclosure side of the switchboard.
 */
export class SkillRegistry {
  private readonly byName = new Map<string, SkillEntry>();

  get size(): number {
    return this.byName.size;
  }

  static async load(directories: string[]): Promise<SkillRegistry> {
    const registry = new SkillRegistry();
    for (const root of directories) await registry.scan(root);
    return registry;
  }

  private async scan(root: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const directory = path.join(root, entry);
      const info = await stat(directory).catch(() => null);
      if (!info?.isDirectory()) continue;
      const file = path.join(directory, "SKILL.md");
      const raw = await readFile(file, "utf8").catch(() => null);
      if (!raw) continue;
      const parsed = parseSkill(raw, entry);
      if (parsed && !this.byName.has(parsed.name)) this.byName.set(parsed.name, parsed);
    }
  }

  list(): SkillSummary[] {
    return [...this.byName.values()]
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string, limit = 5): SkillSummary[] {
    const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1))];
    const scored = [...this.byName.values()].map((skill) => {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (skill.name.toLowerCase().includes(term)) score += 5;
        if (haystack.includes(term)) score += 1;
      }
      return { skill, score };
    });
    const relevant = terms.length ? scored.filter((row) => row.score > 0) : scored;
    return relevant
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, Math.min(Math.max(limit, 1), 10))
      .map(({ skill }) => ({ name: skill.name, description: skill.description }));
  }

  load(name: string): SkillEntry | undefined {
    return this.byName.get(name);
  }

  /** One line per skill for the system prompt. Bodies stay on disk until asked for. */
  indexText(): string {
    const skills = this.list().slice(0, MAX_INDEX);
    if (!skills.length) return "";
    return skills.map((skill) => `- ${skill.name}: ${skill.description.slice(0, MAX_DESCRIPTION)}`).join("\n");
  }
}

/** Minimal frontmatter reader: `key: value` lines between --- fences. */
export function parseSkill(raw: string, fallbackName: string): SkillEntry | undefined {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    meta[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^["']|["']$/g, "");
  }
  const name = (meta.name || fallbackName).trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/i.test(name)) return undefined;
  const description = meta.description?.trim() ?? "";
  if (!description) return undefined;
  return {
    name,
    description,
    body: match[2]!.trim().slice(0, MAX_BODY),
    source: fallbackName,
  };
}
