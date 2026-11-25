import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/main/workspace/workspace";

describe("Workspace", () => {
  it("reads and edits only paths inside the canonical workspace", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhack-workspace-")));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "note.txt"), "alpha beta");
    const workspace = new Workspace(root);
    expect((await workspace.read("src/note.txt")).content).toBe("alpha beta");
    await workspace.replace("src/note.txt", "beta", "gamma");
    expect((await workspace.read("src/note.txt")).content).toBe("alpha gamma");
    await expect(workspace.read("../outside.txt")).rejects.toThrow(/outside/i);
    await expect(workspace.read("src\\..\\..\\outside.txt")).rejects.toThrow(/outside/i);
  });

  it("writes atomically and returns bounded search matches", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhack-search-")));
    const workspace = new Workspace(root);
    await workspace.write("a.txt", "one\ntwo needle\nthree");
    const result = await workspace.search("needle", 10);
    expect(result.matches).toEqual([expect.objectContaining({ path: "a.txt", line: 2 })]);
    expect(await workspace.list()).toContainEqual(expect.objectContaining({ path: "a.txt", kind: "file" }));
  });
});
