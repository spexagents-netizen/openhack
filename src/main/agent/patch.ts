import { applyPatch } from "diff";

export interface PatchFile {
  path: string;
  section: string;
}

const MAX_FILES = 8;
const MAX_PATCH_BYTES = 1024 * 1024;

/**
 * Parses a multi-file unified diff into per-file sections. Paths are normalized
 * to workspace-relative form; absolute paths and traversal are refused before
 * anything is read or written.
 */
export function parseUnifiedPatch(raw: string): PatchFile[] {
  if (!raw.trim()) throw new Error("Patch is empty");
  if (Buffer.byteLength(raw) > MAX_PATCH_BYTES) throw new Error("Patch exceeds the 1 MiB limit");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^---\s+/.test(lines[index]!)) { index += 1; continue; }
    if (!/^\+\+\+\s+/.test(lines[index + 1] ?? "")) throw new Error("Patch is missing the +++ header");
    const start = index;
    const path = cleanPath(lines[index + 1]!.replace(/^\+\+\+\s+/, ""));
    index += 2;
    while (index < lines.length && !/^---\s+/.test(lines[index]!)) index += 1;
    const section = lines.slice(start, index).join("\n");
    if (!section.includes("@@")) throw new Error(`Patch for ${path} has no hunk`);
    files.push({ path, section });
    if (files.length > MAX_FILES) throw new Error(`Patch touches more than ${MAX_FILES} files`);
  }
  if (!files.length) throw new Error("Patch contains no files");
  return files;
}

export function applySection(before: string, section: string): string | null {
  const result = applyPatch(before, section, { fuzzFactor: 0 });
  return typeof result === "string" ? result : null;
}

function cleanPath(value: string): string {
  const withoutTimestamp = value.split("\t")[0]!.trim();
  const withoutPrefix = withoutTimestamp.replace(/^[ab]\//, "");
  if (!withoutPrefix) throw new Error("Patch has an empty path");
  if (withoutPrefix.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(withoutPrefix)) throw new Error("Patch paths must be workspace-relative");
  if (withoutPrefix.split(/[\\/]/).includes("..")) throw new Error("Patch paths may not traverse outside the workspace");
  return withoutPrefix.replace(/\\/g, "/");
}
