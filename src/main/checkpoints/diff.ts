import { diffLines } from "diff";

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_LINES = 4000;

/**
 * Line diff for the review panel. jsdiff handles the algorithm; this wrapper
 * turns chunks into addressed lines and caps output so a giant generated file
 * cannot freeze the renderer.
 */
export function buildDiff(before: string, after: string): DiffResult {
  const chunks = diffLines(before, after);
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  let truncated = false;

  for (const chunk of chunks) {
    const raw = chunk.value.split("\n");
    if (raw.at(-1) === "") raw.pop();
    for (const text of raw) {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        break;
      }
      if (chunk.added) {
        lines.push({ type: "add", text, newLine });
        newLine += 1;
        added += 1;
      } else if (chunk.removed) {
        lines.push({ type: "del", text, oldLine });
        oldLine += 1;
        removed += 1;
      } else {
        lines.push({ type: "ctx", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
    if (truncated) break;
  }

  return { lines, added, removed, truncated };
}
