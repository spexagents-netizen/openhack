// Proves first-run provisioning on a clean profile: what got added, what was held back.
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "openhack-firstrun-"));
const dataDir = path.join(root, "data");
await mkdir(dataDir, { recursive: true });
const app = await electron.launch({ args: ["out/main/index.js"], env: { ...process.env, OPENHACK_DATA_DIR: dataDir } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 40000 });
  await page.waitForTimeout(6000);
} finally {
  await app.close();
}
const config = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8"));
process.stdout.write(`providers imported: ${(config.providers ?? []).length}\n`);
process.stdout.write(`mcp entries: ${(config.mcpServers ?? []).map((server) => server.id).join(", ") || "none"}\n`);
const report = await readFile(path.join(dataDir, "stack-bootstrap.json"), "utf8").then(JSON.parse).catch(() => null);
if (report) {
  process.stdout.write(`added: ${report.added.join(", ") || "none"}\n`);
  process.stdout.write(`blocked: ${report.blocked.map((entry) => entry.id + "(" + entry.requires.join("+") + ")").join(", ") || "none"}\n`);
  process.stdout.write(`manual: ${report.manual.map((entry) => entry.id).join(", ") || "none"}\n`);
} else {
  process.stdout.write("no bootstrap report\n");
}
