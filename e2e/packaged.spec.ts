import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const executable = path.join(process.cwd(), "release", "win-unpacked", "OpenHack.exe");
test.skip(!existsSync(executable), "Packaged executable is not built");

test("packaged OpenHack launches with the sql.js runtime, creates a session and restores it", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(tmpdir(), "openhack-packaged-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "target.txt"), "packaged workspace");
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({
    version: 1,
    providers: [{
      id: "mock", name: "Packaged Mock", baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "model", name: "Packaged Model", tools: true }],
      maxTokensField: "max_tokens", headerTimeoutMs: 1000, chunkTimeoutMs: 1000,
    }],
    settings: { permission: "supervised", systemPrompt: "Packaged smoke test.", lastWorkspace: workspace, activeProviderId: "mock", activeModel: "model" },
    mcpServers: [], enabledPlugins: [], installedPlugins: [],
  }));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, OPENHACK_DATA_DIR: dataDir } });
    let page = await app.firstWindow();
    await page.waitForSelector(".app-shell", { timeout: 30000 });
    // The composer only enables once a provider with models has loaded.
    await expect(page.getByLabel("Message the agent")).toBeEnabled();
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Message the agent").fill("Packaged persistence check");
    await expect(page.locator(".chat-head h2")).toContainText("New investigation");
    await page.screenshot({ path: "artifacts/ui-packaged.png" });
    await app.close();
    app = undefined;

    app = await electron.launch({ executablePath: executable, env: { ...process.env, OPENHACK_DATA_DIR: dataDir } });
    page = await app.firstWindow();
    await page.waitForSelector(".app-shell", { timeout: 30000 });
    await expect(page.getByText("New investigation").first()).toBeVisible();
    await expect(page.locator(".session-row").first()).toBeVisible();
  } finally {
    await app?.close();
  }
});
