import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeBuiltinTool } from "../src/main/agent/builtin-tools";
import { parseUnifiedPatch } from "../src/main/agent/patch";
import { Workspace } from "../src/main/workspace/workspace";

const signal = () => new AbortController().signal;

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "openhack-patch-"));
  const workspace = new Workspace(root);
  await writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "b.txt"), "alpha\nbeta\n");
  return { root, workspace };
}

describe("apply_patch", () => {
  it("applies a multi-file diff after validating every hunk", async () => {
    const { root, workspace } = await harness();
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
    ].join("\n");
    const result = JSON.parse(await executeBuiltinTool("apply_patch", { patch }, workspace, signal())) as { files: Array<{ path: string }> };
    expect(result.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("alpha\nBETA\n");
  });

  it("writes nothing when one file fails to apply", async () => {
    const { root, workspace } = await harness();
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      "-missing",
      "+replaced",
      " beta",
    ].join("\n");
    await expect(executeBuiltinTool("apply_patch", { patch }, workspace, signal())).rejects.toThrow(/does not apply/u);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("refuses traversal, absolute paths and malformed patches", () => {
    expect(() => parseUnifiedPatch("--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1 +1 @@\n-a\n+b")).toThrow(/traverse/u);
    expect(() => parseUnifiedPatch("--- a/C:/Windows/win.ini\n+++ b/C:/Windows/win.ini\n@@ -1 +1 @@\n-a\n+b")).toThrow(/relative/u);
    expect(() => parseUnifiedPatch("++++")).toThrow(/no files/u);
    expect(() => parseUnifiedPatch("--- a/a.txt\n+++ b/a.txt\nnot a hunk")).toThrow(/hunk/u);
  });
});
