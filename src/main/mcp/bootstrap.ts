import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { McpServerConfig } from "../../shared/contracts";

const run = promisify(execFile);

export interface PresetServer {
  id: string;
  name: string;
  tier: "core" | "re" | "web" | "breadth";
  run?: { command: string; args: string[] };
  requires?: string[];
  env?: Record<string, string>;
  manual?: string;
  docs?: string;
  reason?: string;
}

export interface StackPlan {
  servers: McpServerConfig[];
  report: {
    added: string[];
    /** Runnable, but a prerequisite binary is missing. */
    blocked: Array<{ id: string; requires: string[]; docs?: string }>;
    /** Needs a licensed app, a running service or a manual install. */
    manual: Array<{ id: string; reason: string; docs?: string }>;
    /** Already configured, left untouched. */
    existing: string[];
  };
}

export type CommandProbe = (command: string) => Promise<boolean>;

/**
 * Decides what can honestly be provisioned on this machine. A stack entry is
 * added only when its package runner exists; anything needing a licensed
 * binary, a running proxy or a database is reported instead of faked.
 */
export async function planStack(
  preset: { servers: PresetServer[] },
  existing: McpServerConfig[],
  probe: CommandProbe = commandExists,
): Promise<StackPlan> {
  const known = new Set(existing.map((server) => server.id));
  const plan: StackPlan = { servers: [], report: { added: [], blocked: [], manual: [], existing: [] } };

  for (const entry of preset.servers) {
    if (known.has(entry.id)) {
      plan.report.existing.push(entry.id);
      continue;
    }
    if (entry.manual || !entry.run) {
      plan.report.manual.push({ id: entry.id, reason: entry.manual ?? "No automatic install path", ...(entry.docs ? { docs: entry.docs } : {}) });
      continue;
    }
    const missing: string[] = [];
    for (const requirement of entry.requires ?? []) {
      if (!(await probe(requirement))) missing.push(requirement);
    }
    if (missing.length) {
      plan.report.blocked.push({ id: entry.id, requires: missing, ...(entry.docs ? { docs: entry.docs } : {}) });
      continue;
    }
    plan.servers.push({
      id: entry.id,
      name: entry.name,
      command: entry.run.command,
      args: entry.run.args,
      enabled: true,
      ...(entry.env ? { env: entry.env } : {}),
    });
    plan.report.added.push(entry.id);
  }
  return plan;
}

export async function loadPreset(file: string): Promise<{ servers: PresetServer[] }> {
  const raw = JSON.parse(await readFile(file, "utf8")) as { servers?: PresetServer[] };
  if (!Array.isArray(raw.servers)) throw new Error("Preset is missing a servers array");
  return { servers: raw.servers.filter((entry) => entry && typeof entry.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(entry.id)) };
}

export async function commandExists(command: string): Promise<boolean> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    await run(locator, [command], { timeout: 4000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
