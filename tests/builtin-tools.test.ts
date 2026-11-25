import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeBuiltinTool } from "../src/main/agent/builtin-tools";
import { Workspace } from "../src/main/workspace/workspace";

describe("built-in tool execution", () => {
  it("executes every workspace tool and a bounded process without a shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhack-tools-"));
    const workspace = new Workspace(root);
    const signal = new AbortController().signal;
    const write = JSON.parse(await executeBuiltinTool("workspace_write", { path: "deep/dir/note.txt", content: "alpha beta" }, workspace, signal));
    expect(write.bytes).toBe(10);
    expect(JSON.parse(await executeBuiltinTool("workspace_read", { path: "deep/dir/note.txt" }, workspace, signal)).content).toBe("alpha beta");
    expect(JSON.parse(await executeBuiltinTool("workspace_list", { path: ".", depth: 3 }, workspace, signal))).toContainEqual(expect.objectContaining({ path: "deep" }));
    expect(JSON.parse(await executeBuiltinTool("workspace_search", { query: "BETA" }, workspace, signal)).matches).toHaveLength(1);
    await executeBuiltinTool("workspace.replace", { path: "deep/dir/note.txt", oldText: "beta", newText: "gamma" }, workspace, signal);
    expect(await readFile(path.join(root, "deep", "dir", "note.txt"), "utf8")).toBe("alpha gamma");
    const processResult = JSON.parse(await executeBuiltinTool("process_run", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('tool-ok')"],
    }, workspace, signal));
    expect(processResult.stdout).toBe("tool-ok");
    expect(processResult.exitCode).toBe(0);
    await expect(executeBuiltinTool("unknown_tool", {}, workspace, signal)).rejects.toThrow(/Unknown tool/);
    await expect(executeBuiltinTool("workspace_read", { path: "../outside" }, workspace, signal)).rejects.toThrow(/outside/);
  });
});
