import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../shared/contracts";
import { runWorkspaceProcess } from "../workspace/process";
import type { Workspace } from "../workspace/workspace";
import { createWebRuntime, webToolDefinitions, type WebRuntime } from "../web";
import { applySection, parseUnifiedPatch } from "./patch";

const pathSchema = z.string().min(1).max(4096);
const defaultWeb = createWebRuntime();

export function builtinToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "workspace_list",
      description: "List bounded files and directories in the current workspace. Use before guessing project structure.",
      parameters: { type: "object", properties: { path: { type: "string", default: "." }, depth: { type: "integer", minimum: 0, maximum: 8, default: 3 } }, additionalProperties: false },
      risk: "read",
    },
    {
      name: "workspace_read",
      description: "Read a UTF-8 text file with optional zero-based line offset and bounded line count.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 4000, default: 2000 } }, required: ["path"], additionalProperties: false },
      risk: "read",
    },
    {
      name: "workspace_search",
      description: "Search literal, case-insensitive text across bounded workspace text files and return exact lines.",
      parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string", default: "." }, maxResults: { type: "integer", minimum: 1, maximum: 200, default: 100 } }, required: ["query"], additionalProperties: false },
      risk: "read",
    },
    {
      name: "workspace_write",
      description: "Atomically create or replace a UTF-8 file inside the workspace. The complete file content is required.",
      parameters: { type: "object", properties: { path: pathSchema as never, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      risk: "write",
    },
    {
      name: "workspace_replace",
      description: "Replace one unique exact text span in a UTF-8 file. Include enough context to make oldText unique.",
      parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false },
      risk: "write",
    },
    {
      name: "screenshot",
      description: "Capture the operator's screen and return it as an image the chat renders inline, plus a PNG saved under .openhack/screenshots in the workspace. Use it to see a UI, a terminal error or anything the operator is looking at.",
      parameters: {
        type: "object",
        properties: {
          display: { type: "integer", minimum: 0, maximum: 3, default: 0 },
          maxWidth: { type: "integer", minimum: 320, maximum: 3840, default: 1440 },
        },
        additionalProperties: false,
      },
      risk: "execute",
    },
    {
      name: "apply_patch",
      description: "Apply a multi-file unified diff to existing workspace files. Every hunk is validated before anything is written; if one file fails, nothing changes. Max 8 files, 1 MiB.",
      parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
      risk: "write",
    },
    {
      name: "process_run",
      description: "Run an executable with an argument array in the workspace, without shell interpolation, and capture bounded output.",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" }, default: [] },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 60000 },
        },
        required: ["executable"],
        additionalProperties: false,
      },
      risk: "execute",
    },
    ...webToolDefinitions(),
  ];
}

export async function executeBuiltinTool(
  name: string,
  args: unknown,
  workspace: Workspace,
  signal: AbortSignal,
  web: WebRuntime = defaultWeb,
): Promise<string> {
  const normalized = name.replace(/\./g, "_");
  if (normalized === "workspace_list") {
    const input = z.object({ path: z.string().default("."), depth: z.number().int().min(0).max(8).default(3) }).parse(args);
    return JSON.stringify(await workspace.list(input.path, input.depth));
  }
  if (normalized === "workspace_read") {
    const input = z.object({ path: pathSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(4000).default(2000) }).parse(args);
    return JSON.stringify(await workspace.read(input.path, input.offset, input.limit));
  }
  if (normalized === "workspace_search") {
    const input = z.object({ query: z.string().min(1).max(1000), path: z.string().default("."), maxResults: z.number().int().min(1).max(200).default(100) }).parse(args);
    return JSON.stringify(await workspace.search(input.query, input.maxResults, input.path));
  }
  if (normalized === "workspace_write") {
    const input = z.object({ path: pathSchema, content: z.string().max(2 * 1024 * 1024) }).parse(args);
    return JSON.stringify(await workspace.write(input.path, input.content));
  }
  if (normalized === "workspace_replace") {
    const input = z.object({ path: pathSchema, oldText: z.string().min(1).max(1024 * 1024), newText: z.string().max(2 * 1024 * 1024) }).parse(args);
    return JSON.stringify(await workspace.replace(input.path, input.oldText, input.newText));
  }
  if (normalized === "screenshot") {
    const input = z.object({
      display: z.number().int().min(0).max(3).optional(),
      maxWidth: z.number().int().min(320).max(3840).optional(),
    }).parse(args);
    const width = input.maxWidth ?? 1440;
    const { desktopCapturer } = await import("electron");
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height: Math.round((width * 9) / 16) },
      fetchWindowIcons: false,
    });
    const source = sources[input.display ?? 0] ?? sources[0];
    if (!source) throw new Error("No screen available to capture");
    const image = source.thumbnail;
    const size = image.getSize();
    const png = image.toPNG();
    const dataUrl = png.length <= 1_200_000
      ? `data:image/png;base64,${png.toString("base64")}`
      : `data:image/jpeg;base64,${image.toJPEG(72).toString("base64")}`;
    const relative = `.openhack/screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const target = path.join(workspace.root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, png);
    return JSON.stringify({ ok: true, path: relative, width: size.width, height: size.height, image: dataUrl });
  }
  if (normalized === "apply_patch") {
    const input = z.object({ patch: z.string().min(1).max(1024 * 1024) }).parse(args);
    const files = parseUnifiedPatch(input.patch);
    const staged: Array<{ path: string; before: string; after: string }> = [];
    for (const file of files) {
      const current = await workspace.readFull(file.path);
      const next = applySection(current.content, file.section);
      if (next === null) throw new Error(`Patch does not apply to ${file.path}`);
      staged.push({ path: file.path, before: current.content, after: next });
    }
    const written: Array<{ path: string; before: string }> = [];
    try {
      const results = [];
      for (const file of staged) {
        const result = await workspace.write(file.path, file.after);
        written.push({ path: file.path, before: file.before });
        results.push({ path: file.path, bytes: result.bytes, sha256: result.sha256 });
      }
      return JSON.stringify({ files: results });
    } catch (error) {
      for (const file of written.reverse()) {
        await workspace.write(file.path, file.before).catch(() => undefined);
      }
      throw error;
    }
  }
  if (normalized === "process_run") {
    const input = z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(32768)).max(128).default([]), timeoutMs: z.number().int().min(1000).max(600000).default(60000) }).parse(args);
    return JSON.stringify(await runWorkspaceProcess({ executable: input.executable, args: input.args, cwd: workspace.root, timeoutMs: input.timeoutMs, signal }));
  }
  if (normalized === "web_search") {
    const input = z.object({ query: z.string().min(1).max(2000), maxResults: z.number().int().min(1).max(20).default(8) }).parse(args);
    const report = await web.search({ query: input.query, maxResults: input.maxResults, signal });
    if (!report.results.length) {
      return JSON.stringify({
        query: report.query,
        backend: report.backend,
        results: [],
        error: "No engine returned results. The network may be offline, or every keyless backend is rate-limited.",
        attempts: report.attempts,
      });
    }
    return JSON.stringify(report);
  }
  if (normalized === "web_fetch") {
    const input = z.object({ url: z.string().min(1).max(8192), maxChars: z.number().int().min(500).max(120000).default(24000), timeoutMs: z.number().int().min(1000).max(60000).default(20000) }).parse(args);
    return JSON.stringify(await web.fetch({ url: input.url, maxChars: input.maxChars, timeoutMs: input.timeoutMs, signal }));
  }
  throw new Error(`Unknown tool: ${name}`);
}
