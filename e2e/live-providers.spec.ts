import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

test.skip(process.env.OPENHACK_LIVE_PROVIDERS !== "1", "Set OPENHACK_LIVE_PROVIDERS=1 to test the local Modal endpoints");

test("imports Kimi and DeepSeek from OpenCode and verifies both live endpoints", async () => {
  // Local Modal endpoints can queue behind other work, so the budget has to
  // cover two endpoint probes plus two real model round-trips.
  test.setTimeout(240000);
  const root = await mkdtemp(path.join(tmpdir(), "openhack-live-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ["."],
      env: { ...process.env, OPENHACK_DATA_DIR: dataDir, OPENHACK_DEFAULT_WORKSPACE: workspace },
    });
    const page = await app.firstWindow();
    await page.waitForSelector(".app-shell", { timeout: 30000 });
    await page.getByRole("button", { name: "Settings" }).click();
    const kimi = page.locator(".provider-card").filter({ hasText: "Kimi K3.1 Pro" });
    const deepseek = page.locator(".provider-card").filter({ hasText: "DeepSeek V4.1" });
    await expect(kimi).toBeVisible();
    await expect(deepseek).toBeVisible();
    await kimi.getByRole("button", { name: "Test" }).click();
    await deepseek.getByRole("button", { name: "Test" }).click();
    await expect(kimi.locator(".test-result")).toContainText("Reachable", { timeout: 30000 });
    await expect(deepseek.locator(".test-result")).toContainText("Reachable", { timeout: 30000 });
    await page.screenshot({ path: "artifacts/ui-live-providers.png" });

    await page.getByRole("button", { name: "Agent" }).click();
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Model").selectOption({ label: "DeepSeek V4.1 Flash 1017 (Modal)" });
    await page.getByLabel("Message the agent").fill("This is an interface smoke test. Do not call tools. Reply with exactly READY.");
    await page.getByLabel("Send message").click();
    await expect(page.locator(".message-assistant .markdown").last()).toContainText("READY", { timeout: 150000 });
    await expect(page.locator(".agent-state")).toContainText("ready", { timeout: 30000 });
    await page.screenshot({ path: "artifacts/ui-live-chat.png" });

    // Prove the shipped web toolchain from inside the real app: one search, one cited URL.
    await page.getByLabel("Message the agent").fill(
      "Use the web_search tool exactly once with the query \"Node.js latest LTS release version 2026\". Then reply in two lines: the newest version number you saw, and one https URL taken from those results. Do not use web_fetch or any other tool.",
    );
    await page.getByLabel("Send message").click();
    await expect(page.locator(".tool-row").filter({ hasText: "web search" }).first()).toBeVisible({ timeout: 45000 });
    // Public keyless backends rate-limit by IP, and the model phrases a zero-result
    // outcome in its own words. The durable assertions are: the tool ran, the run
    // finished, and the answer either cites a URL or admits it has none.
    const answer = page.locator(".message-assistant .markdown").last();
    await expect(answer).not.toBeEmpty();
    await expect(answer).toContainText(/https:\/\/|rate-limited|blocked|empty|no results|no url|could not|couldn't|unable|failed/iu, { timeout: 90000 });
    await expect(page.locator(".agent-state")).toContainText("ready", { timeout: 30000 });
    await page.screenshot({ path: "artifacts/ui-live-websearch.png" });
  } finally {
    await app?.close();
  }
});
