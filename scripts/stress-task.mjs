// Real stress test: a local vulnerable lab, a live provider, the shipped agent.
// Not part of the suite; run explicitly and read artifacts/stress-report.json.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "openhack-stress-"));
const dataDir = path.join(root, "data");
const workspace = path.join(root, "bench");
await mkdir(dataDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir("artifacts", { recursive: true });

// ── lab: two users, invoices that leak across identities, reflected XSS ──────
const users = { alice: "tok-alice", bob: "tok-bob" };
const invoices = [
  { id: 1, owner: "alice", amount: 4200, note: "Q3 retainer" },
  { id: 2, owner: "bob", amount: 900, note: "expenses" },
  { id: 3, owner: "alice", amount: 12000, note: "annual" },
];
const lab = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const who = Object.entries(users).find(([, value]) => value === token)?.[0];
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/login") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const user = JSON.parse(body || "{}").user;
      return users[user] ? json(200, { token: users[user] }) : json(401, { error: "unknown user" });
    });
    return;
  }
  if (url.pathname === "/api/me") return who ? json(200, { user: who }) : json(401, { error: "auth" });
  const invoice = /^\/api\/invoices\/(\d+)$/.exec(url.pathname);
  if (invoice) {
    if (!who) return json(401, { error: "auth" });
    const found = invoices.find((entry) => entry.id === Number(invoice[1]));
    // The bug: no ownership check. Any valid token reads any invoice.
    return found ? json(200, found) : json(404, { error: "not found" });
  }
  if (url.pathname === "/search") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><body><h1>Results</h1><p>${url.searchParams.get("q") ?? ""}</p></body></html>`);
  }
  json(404, { error: "no route" });
});
await new Promise((resolve) => lab.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${lab.address().port}`;

await writeFile(path.join(dataDir, "config.json"), JSON.stringify({
  version: 1,
  providers: [],
  settings: {
    permission: "autonomous",
    activeProviderId: "modal-ep",
    activeModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    lastWorkspace: workspace,
  },
  mcpServers: [],
  enabledPlugins: [],
  installedPlugins: [],
}, null, 2));

const prompt = [
  `Authorized lab. Target: ${target} — this host only, nothing else in scope.`,
  "",
  "Task: find broken object-level authorization, prove it, and write the finding.",
  "Sign in with POST /api/login taking {\"user\":\"alice\"} and separately {\"user\":\"bob\"} to get tokens.",
  "Call GET /api/me with a token to confirm which identity you hold.",
  "Then test GET /api/invoices/1, /2 and /3 as each identity and compare.",
  "",
  "Deliver: the exact requests and responses that prove the bug, then a report with title, impact, steps, evidence and the fix.",
].join("\n");

let app;
const report = { target, startedAt: new Date().toISOString(), steps: [], finalText: "", toolCalls: [], error: "" };
try {
  app = await electron.launch({ args: ["out/main/index.js"], env: { ...process.env, OPENHACK_DATA_DIR: dataDir } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 40000 });
  await page.getByRole("button", { name: "New session" }).click();
  const composer = page.getByLabel("Message the agent");
  await composer.waitFor({ state: "visible", timeout: 20000 });
  await composer.fill(prompt);
  await page.getByLabel("Send message").click();
  report.steps.push("prompt sent");

  const deadline = Date.now() + 240000;
  let last = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    const state = await page.locator(".agent-state").innerText().catch(() => "");
    const text = await page.locator(".chat-scroll").innerText().catch(() => "");
    if (text !== last) { last = text; report.steps.push(`transcript ${text.length} chars at ${new Date().toISOString()}`); }
    if (/ready/i.test(state) && text.length > 200) break;
  }

  report.finalText = (await page.locator(".message-assistant .markdown").last().innerText().catch(() => "")).slice(0, 6000);
  report.toolCalls = await page.locator(".tool-name").allInnerTexts().catch(() => []);
  await page.screenshot({ path: "artifacts/stress-run.png", fullPage: false });
  const errors = await page.locator(".run-error").allInnerTexts().catch(() => []);
  if (errors.length) report.error = errors.join(" | ");
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  await app?.close().catch(() => undefined);
  lab.close();
  report.finishedAt = new Date().toISOString();
  await writeFile("artifacts/stress-report.json", JSON.stringify(report, null, 2));
  process.stdout.write(`target ${target}\nerror: ${report.error || "none"}\ntools: ${report.toolCalls.join(", ") || "none"}\n--- final ---\n${report.finalText.slice(0, 2200)}\n`);
}
