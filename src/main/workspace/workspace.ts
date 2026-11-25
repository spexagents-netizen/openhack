import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const IGNORED = new Set([".git", "node_modules", "dist", "out", "release", "coverage", ".next", "target"]);

export interface WorkspaceOptions {
  /** Called with the resolved target immediately before a write mutates it. */
  beforeChange?: (relativePath: string, absolutePath: string) => Promise<void>;
}

export class Workspace {
  readonly root: string;
  private readonly options: WorkspaceOptions;

  constructor(root: string, options: WorkspaceOptions = {}) {
    // Windows may hand us an 8.3 short path; canonicalize once so every later
    // containment check compares against the same final path spelling.
    this.root = realpathSync.native(path.resolve(root));
    this.options = options;
  }

  async read(relativePath: string, offset = 0, limit = 2000): Promise<{ path: string; content: string; totalLines: number; truncated: boolean }> {
    const target = await this.resolveExisting(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Only regular files can be read");
    if (info.size > 2 * 1024 * 1024) throw new Error("File exceeds the 2 MiB read limit");
    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new Error("Binary files are not read as text");
    const lines = buffer.toString("utf8").split(/\r?\n/);
    return {
      path: this.display(target),
      content: lines.slice(offset, offset + limit).join("\n"),
      totalLines: lines.length,
      truncated: offset + limit < lines.length,
    };
  }

  async readFull(relativePath: string): Promise<{ path: string; content: string }> {
    const target = await this.resolveExisting(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Only regular files can be read");
    if (info.size > 4 * 1024 * 1024) throw new Error("File exceeds the 4 MiB checkpoint read limit");
    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new Error("Binary files are not read as text");
    return { path: this.display(target), content: buffer.toString("utf8") };
  }

  async remove(relativePath: string): Promise<void> {
    const target = await this.resolveExisting(relativePath);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error("Only regular files can be deleted");
    await unlink(target);
  }

  async list(relativePath = ".", depth = 3, maxEntries = 400): Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>> {
    const target = await this.resolveExisting(relativePath);
    const entries: Array<{ path: string; kind: "file" | "directory"; size?: number }> = [];
    const walk = async (directory: string, remaining: number): Promise<void> => {
      if (entries.length >= maxEntries || remaining < 0) return;
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= maxEntries || IGNORED.has(child.name)) continue;
        const absolute = path.join(directory, child.name);
        await this.assertInside(absolute);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          entries.push({ path: this.display(absolute), kind: "directory" });
          await walk(absolute, remaining - 1);
        } else if (child.isFile()) {
          entries.push({ path: this.display(absolute), kind: "file", size: (await stat(absolute)).size });
        }
      }
    };
    await walk(target, depth);
    return entries;
  }

  async search(query: string, maxResults = 100, relativePath = "."): Promise<{ matches: Array<{ path: string; line: number; column: number; text: string }>; truncated: boolean }> {
    if (!query) throw new Error("Search query cannot be empty");
    const target = await this.resolveExisting(relativePath);
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
    let truncated = false;
    const files = (await stat(target)).isFile() ? [target] : (await this.list(relativePath, 8, 2000)).filter((entry) => entry.kind === "file").map((entry) => path.join(this.root, entry.path));
    for (const file of files) {
      const info = await stat(file);
      if (info.size > 1024 * 1024) continue;
      const buffer = await readFile(file);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index]!.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (column < 0) continue;
        if (matches.length >= maxResults) { truncated = true; return { matches, truncated }; }
        matches.push({ path: this.display(file), line: index + 1, column: column + 1, text: lines[index]!.slice(0, 500) });
      }
    }
    return { matches, truncated };
  }

  async write(relativePath: string, content: string): Promise<{ path: string; sha256: string; bytes: number }> {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Write exceeds the 2 MiB limit");
    const target = await this.resolveForWrite(relativePath);
    await this.options.beforeChange?.(relativePath, target);
    const temporary = `${target}.openhack-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await this.assertInside(temporary);
    await rename(temporary, target);
    return { path: this.display(target), sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) };
  }

  async replace(relativePath: string, oldText: string, newText: string): Promise<{ path: string; sha256: string; bytes: number }> {
    if (!oldText) throw new Error("oldText cannot be empty");
    const current = await this.read(relativePath, 0, Number.MAX_SAFE_INTEGER);
    const first = current.content.indexOf(oldText);
    if (first < 0) throw new Error("The exact text to replace was not found");
    if (current.content.indexOf(oldText, first + oldText.length) >= 0) throw new Error("The text to replace is ambiguous; provide more context");
    return this.write(relativePath, current.content.slice(0, first) + newText + current.content.slice(first + oldText.length));
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.candidate(relativePath);
    await this.assertInside(candidate);
    const resolved = await realpath(candidate);
    await this.assertInside(resolved);
    const info = await lstat(resolved);
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not followed by default");
    return resolved;
  }

  private async resolveForWrite(relativePath: string): Promise<string> {
    const candidate = this.candidate(relativePath);
    await this.assertInside(candidate);
    const relativeParent = path.relative(this.root, path.dirname(candidate));
    let current = this.root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      const next = path.join(current, segment);
      try {
        const info = await lstat(next);
        if (info.isSymbolicLink()) throw new Error("Symbolic links are not followed by default");
        if (!info.isDirectory()) throw new Error("A parent path is not a directory");
        const resolved = await realpath(next);
        await this.assertInside(resolved);
        current = resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(next);
        await this.assertInside(next);
        current = next;
      }
    }
    const target = path.join(current, path.basename(candidate));
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Symbolic links are not followed by default");
      if (info.isDirectory()) throw new Error("The target path is a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return target;
  }

  private candidate(relativePath: string): string {
    if (path.isAbsolute(relativePath)) return path.resolve(relativePath);
    return path.resolve(this.root, relativePath);
  }

  private async assertInside(candidate: string): Promise<void> {
    const relative = path.relative(this.root, path.resolve(candidate));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    throw new Error("Path is outside the authorized workspace");
  }

  private display(candidate: string): string {
    return path.relative(this.root, candidate).split(path.sep).join("/") || ".";
  }
}
