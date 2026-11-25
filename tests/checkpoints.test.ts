import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/main/checkpoints/store";
import { Workspace } from "../src/main/workspace/workspace";

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "openhack-checkpoints-"));
  const workspaceDir = path.join(root, "workspace");
  await writeFile(path.join(root, "placeholder"), "");
  const store = new CheckpointStore(path.join(root, "checkpoints"));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspaceDir, { recursive: true }));
  const workspace = new Workspace(workspaceDir, {
    beforeChange: (relativePath, absolutePath) => store.capture({ sessionId: "session", runId: "run", relativePath, absolutePath }),
  });
  return { store, workspace, workspaceDir, root };
}

describe("checkpoints", () => {
  it("captures the before-image, diffs it, and restores the original bytes", async () => {
    const { store, workspace, workspaceDir } = await harness();
    await writeFile(path.join(workspaceDir, "app.txt"), "one\ntwo\nthree\n");
    await workspace.write("app.txt", "one\nchanged\nthree\nfour\n");

    const list = await store.list("session", workspace);
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toHaveLength(1);
    expect(list[0]?.files[0]).toMatchObject({ path: "app.txt", existedBefore: true, changed: true });

    const diff = await store.diff("session", "run", "app.txt", workspace);
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);
    expect(diff.lines.some((line) => line.type === "del" && line.text === "two")).toBe(true);
    expect(diff.lines.some((line) => line.type === "add" && line.text === "four")).toBe(true);

    const restored = await store.restore("session", "run", "app.txt", workspace);
    expect(restored).toEqual({ path: "app.txt", action: "restored" });
    expect(await readFile(path.join(workspaceDir, "app.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    const after = await store.list("session", workspace);
    expect(after[0]?.files[0]?.changed).toBe(false);
  });

  it("records a created file and deletes it on restore", async () => {
    const { store, workspace, workspaceDir } = await harness();
    await workspace.write("generated/tool.txt", "payload");
    const list = await store.list("session", workspace);
    expect(list[0]?.files[0]).toMatchObject({ path: "generated/tool.txt", existedBefore: false, changed: true });

    const result = await store.restore("session", "run", "generated/tool.txt", workspace);
    expect(result.action).toBe("deleted");
    await expect(readFile(path.join(workspaceDir, "generated", "tool.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps one manifest per run and refuses unknown paths", async () => {
    const { store, workspace } = await harness();
    await writeFile(path.join(path.dirname(workspace.root), "other.txt"), "");
    await workspace.write("a.txt", "a");
    await workspace.write("b.txt", "b");
    const list = await store.list("session", workspace);
    expect(list[0]?.files.map((file) => file.path).sort()).toEqual(["a.txt", "b.txt"]);
    await expect(store.diff("session", "run", "missing.txt", workspace)).rejects.toThrow(/not found/u);
    await expect(store.restore("session", "missing-run", "a.txt", workspace)).rejects.toThrow(/not found/u);
    await expect(workspace.remove(".")).rejects.toThrow(/regular files/u);
    await expect(workspace.readFull("missing.txt")).rejects.toThrow();
    expect(await store.list("no-such-session")).toEqual([]);
    await store.prune("no-such-session", 1);
  });

  it("refuses to diff a binary before-image", async () => {
    const { store, workspace, workspaceDir } = await harness();
    await writeFile(path.join(workspaceDir, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    await store.capture({ sessionId: "session", runId: "bin", relativePath: "blob.bin", absolutePath: path.join(workspaceDir, "blob.bin") });
    await expect(store.diff("session", "bin", "blob.bin", workspace)).rejects.toThrow(/Binary/u);
  });

  it("prunes all but the newest checkpoints", async () => {
    const { store, workspace, root, workspaceDir } = await harness();
    await writeFile(path.join(workspaceDir, "a.txt"), "one");
    await store.capture({ sessionId: "session", runId: "older", relativePath: "a.txt", absolutePath: path.join(workspaceDir, "a.txt") });
    await workspace.write("a.txt", "two");
    await store.prune("session", 1);
    const remaining = await (await import("node:fs/promises")).readdir(path.join(root, "checkpoints", "session"));
    expect(remaining).toEqual(["run"]);
  });
});
