import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointFileStatus, CheckpointStatus } from "../../shared/contracts";
import type { Workspace } from "../workspace/workspace";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

interface ManifestFile {
  path: string;
  existedBefore: boolean;
  beforeSha?: string;
  beforeBytes?: number;
  capturedAt: string;
}

interface Manifest {
  sessionId: string;
  runId: string;
  createdAt: string;
  files: ManifestFile[];
}

export interface CheckpointRestoreResult {
  path: string;
  action: "restored" | "deleted";
}

import { buildDiff } from "./diff";
import type { CheckpointDiff } from "../../shared/contracts";

/**
 * A checkpoint is the before-image of every file a run mutates. The blob is
 * content-addressed and stored once, the manifest ties it to a run, and restore
 * writes the before-image back through the workspace boundary.
 */
export class CheckpointStore {
  constructor(private readonly root: string) {}

  async capture(input: { sessionId: string; runId: string; relativePath: string; absolutePath: string }): Promise<void> {
    const directory = this.runDir(input.sessionId, input.runId);
    const manifest = await this.readManifest(input.sessionId, input.runId) ?? {
      sessionId: input.sessionId,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      files: [],
    };
    const relativePath = input.relativePath.replace(/\\/g, "/");
    if (manifest.files.some((file) => file.path === relativePath)) return;

    let existedBefore = false;
    let beforeSha: string | undefined;
    let beforeBytes: number | undefined;
    try {
      const info = await lstat(input.absolutePath);
      if (info.isFile() && info.size <= MAX_CAPTURE_BYTES) {
        const content = await readFile(input.absolutePath);
        beforeSha = createHash("sha256").update(content).digest("hex");
        beforeBytes = content.byteLength;
        existedBefore = true;
        const blobDir = path.join(directory, "blobs");
        await mkdir(blobDir, { recursive: true });
        await writeFile(path.join(blobDir, beforeSha), content);
      }
    } catch {
      // A new file has no before-image; the manifest still records its creation.
    }

    manifest.files.push({
      path: relativePath,
      existedBefore,
      ...(beforeSha ? { beforeSha } : {}),
      ...(beforeBytes ? { beforeBytes } : {}),
      capturedAt: new Date().toISOString(),
    });
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `manifest.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
    await rename(temporary, path.join(directory, "manifest.json"));
  }

  async list(sessionId: string, workspace?: Workspace): Promise<CheckpointStatus[]> {
    const base = path.join(this.root, safe(sessionId));
    let entries: string[];
    try {
      entries = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    const checkpoints: CheckpointStatus[] = [];
    for (const runId of entries) {
      const manifest = await this.readManifest(sessionId, runId);
      if (!manifest) continue;
      const files: CheckpointFileStatus[] = [];
      for (const file of manifest.files) {
        files.push({
          path: file.path,
          existedBefore: file.existedBefore,
          changed: workspace ? await this.hasChanged(workspace, file) : true,
          capturedAt: file.capturedAt,
        });
      }
      if (!files.length) continue;
      checkpoints.push({ sessionId, runId, createdAt: manifest.createdAt, files });
    }
    return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 40);
  }

  async beforeText(sessionId: string, runId: string, relativePath: string): Promise<string | null> {
    const manifest = await this.readManifest(sessionId, runId);
    const file = manifest?.files.find((entry) => entry.path === relativePath.replace(/\\/g, "/"));
    if (!file) throw new Error("Checkpoint file not found");
    if (!file.existedBefore || !file.beforeSha) return null;
    const blob = path.join(this.runDir(sessionId, runId), "blobs", file.beforeSha);
    const content = await readFile(blob);
    if (content.includes(0)) throw new Error("Binary files cannot be diffed");
    return content.toString("utf8");
  }

  async diff(sessionId: string, runId: string, relativePath: string, workspace: Workspace): Promise<CheckpointDiff> {
    const manifest = await this.readManifest(sessionId, runId);
    const file = manifest?.files.find((entry) => entry.path === relativePath.replace(/\\/g, "/"));
    if (!file) throw new Error("Checkpoint file not found");
    const before = await this.beforeText(sessionId, runId, file.path) ?? "";
    let after = "";
    try {
      after = (await workspace.readFull(file.path)).content;
    } catch {
      after = "";
    }
    const diff = buildDiff(before, after);
    return {
      path: file.path,
      existedBefore: file.existedBefore,
      added: diff.added,
      removed: diff.removed,
      truncated: diff.truncated,
      lines: diff.lines,
    };
  }

  async restore(sessionId: string, runId: string, relativePath: string, workspace: Workspace): Promise<CheckpointRestoreResult> {
    const manifest = await this.readManifest(sessionId, runId);
    const file = manifest?.files.find((entry) => entry.path === relativePath.replace(/\\/g, "/"));
    if (!file) throw new Error("Checkpoint file not found");
    if (!file.existedBefore) {
      await workspace.remove(relativePath);
      return { path: file.path, action: "deleted" };
    }
    const before = await this.beforeText(sessionId, runId, file.path);
    if (before === null) throw new Error("Checkpoint has no before-image for this file");
    await workspace.write(relativePath, before);
    return { path: file.path, action: "restored" };
  }

  async prune(sessionId: string, keep = 20): Promise<void> {
    const base = path.join(this.root, safe(sessionId));
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const runs: Array<{ name: string; at: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readManifest(sessionId, entry.name);
      runs.push({ name: entry.name, at: manifest ? Date.parse(manifest.createdAt) : 0 });
    }
    runs.sort((left, right) => right.at - left.at);
    for (const stale of runs.slice(keep)) {
      await rm(path.join(base, stale.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async hasChanged(workspace: Workspace, file: ManifestFile): Promise<boolean> {
    try {
      const current = await workspace.readFull(file.path);
      const sha = createHash("sha256").update(current.content).digest("hex");
      if (!file.existedBefore) return true;
      return sha !== file.beforeSha;
    } catch {
      return file.existedBefore;
    }
  }

  private async readManifest(sessionId: string, runId: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(path.join(this.runDir(sessionId, runId), "manifest.json"), "utf8")) as Manifest;
    } catch {
      return null;
    }
  }

  private runDir(sessionId: string, runId: string): string {
    return path.join(this.root, safe(sessionId), safe(runId));
  }
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
