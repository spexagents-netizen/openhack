// One-off visual check against the real config: proves the stored keys show up
// as "stored" in Settings. Not part of the test suite.
import { mkdir } from "node:fs/promises";
import { _electron as electron } from "@playwright/test";

const app = await electron.launch({ args: ["out/main/index.js"], env: { ...process.env } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".search-backends").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await mkdir("artifacts/shots", { recursive: true });
  await page.screenshot({ path: "artifacts/shots/08-real-settings.png" });
  const labels = await page.locator(".search-backends").evaluate((node) => node.parentElement?.textContent?.slice(0, 400) ?? "");
  process.stdout.write(`settings text: ${labels.replace(/\s+/g, " ").slice(0, 260)}\n`);
} finally {
  await app.close();
}
