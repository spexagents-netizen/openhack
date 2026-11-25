// One-off: proves the Extensions -> Import OpenCode path against the real config.
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "openhack-import-"));
const dataDir = path.join(root, "data");
await mkdir(dataDir, { recursive: true });
const app = await electron.launch({ args: ["out/main/index.js"], env: { ...process.env, OPENHACK_DATA_DIR: dataDir } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("heading", { name: "Extensions" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /Import OpenCode/ }).click();
  await page.waitForTimeout(2500);
  const toast = await page.locator(".toast").first().textContent().catch(() => "");
  const names = await page.locator(".extension-name-row h3").allTextContents();
  process.stdout.write(`toast: ${(toast ?? "").replace(/\s+/g, " ").trim()}\n`);
  process.stdout.write(`servers in view: ${names.join(", ")}\n`);
} finally {
  await app.close();
}
