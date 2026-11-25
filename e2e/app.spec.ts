import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

let server: Server;
let app: ElectronApplication;
let page: Page;
let dataDir: string;
let workspace: string;
let serverPort = 0;
let failNext = false;
let requestCount = 0;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Preview Target</title></head><body><h1>preview ok</h1></body></html>");
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestCount += 1;
      if (failNext) {
        failNext = false;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Mock provider failure for recovery test" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const hasToolResult = parsed.messages.some((message) => message.role === "tool");
      const parentSystem = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      if (parentSystem.includes("a worker spawned by the lead agent")) {
        const brief = parsed.messages.at(-1)?.content ?? "";
        const report = brief.includes("ALPHA") ? "SPAWN-REPORT ALPHA" : "SPAWN-REPORT BETA";
        setTimeout(() => {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: report } }] })}\n\ndata: [DONE]\n\n`);
          response.end();
        }, 160);
        return;
      }
      if (body.includes("bus-fixture")) {
        setTimeout(() => {
          response.write('data: {"choices":[{"delta":{"content":"BUS-ACK target mapped. Ports 22 and 443 are exposed."}}]}\n\ndata: [DONE]\n\n');
          response.end();
        }, 120);
        return;
      }
      if (body.includes("patch-fixture")) {
        const done = parsed.messages.at(-1)?.role === "tool";
        setTimeout(() => {
          if (done) {
            response.write('data: {"choices":[{"delta":{"content":"patched"}}]}\n\ndata: [DONE]\n\n');
          } else {
            const patch = [
              "--- a/patch-target.txt",
              "+++ b/patch-target.txt",
              "@@ -1,2 +1,2 @@",
              " alpha",
              "-beta",
              "+BETA",
            ].join("\n");
            const args = JSON.stringify({ patch });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Patching.", tool_calls: [{ index: 0, id: "call-patch", type: "function", function: { name: "apply_patch", arguments: args } }] } }] })}\n\ndata: [DONE]\n\n`);
          }
          response.end();
        }, 60);
        return;
      }
      if (body.includes("spawn-fixture")) {
        const hasResult = parsed.messages.at(-1)?.role === "tool";
        setTimeout(() => {
          if (hasResult) {
            response.write('data: {"choices":[{"delta":{"content":"army done"}}]}\n\ndata: [DONE]\n\n');
          } else {
            const args = JSON.stringify({ tasks: [
              { name: "ALPHA", role: "probe", brief: "ALPHA task: enumerate the target" },
              { name: "BETA", role: "probe", brief: "BETA task: check the second surface" },
            ] });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Deploying.", tool_calls: [{ index: 0, id: "call-army", type: "function", function: { name: "agent_spawn", arguments: args } }] } }] })}\n\ndata: [DONE]\n\n`);
          }
          response.end();
        }, 60);
        return;
      }
      setTimeout(() => {
        if (!hasToolResult) {
          response.write('data: {"choices":[{"delta":{"reasoning_content":"Plan the smallest safe proof."}}]}\n\n');
          response.write('data: {"choices":[{"delta":{"content":"I will create the proof file, then verify it."}}]}\n\n');
          response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-proof","type":"function","function":{"name":"workspace.write","arguments":"{\\"path\\":\\"proof.txt\\",\\"content\\":\\"verified by OpenHack\\"}"}}]}}]}\n\n');
          response.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
        } else {
          response.write('data: {"choices":[{"delta":{"content":"Created `proof.txt` and verified the workspace mutation. The approval boundary held for the write."}}]}\n\ndata: [DONE]\n\n');
        }
        response.end();
      }, 180);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind");
  serverPort = address.port;
  const root = await mkdtemp(path.join(tmpdir(), "openhack-e2e-"));
  dataDir = path.join(root, "data");
  workspace = path.join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "index.ts"), "export const proof = 'local';\n");
  await writeFile(path.join(workspace, "patch-target.txt"), "alpha\nbeta\n");
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({
    version: 1,
    providers: [{
      id: "mock",
      name: "Mock Lab",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "mock-agent", name: "Mock Agent", tools: true }],
      maxTokensField: "max_tokens",
      headerTimeoutMs: 30000,
      chunkTimeoutMs: 30000,
      source: "manual",
    }],
    settings: {
      permission: "supervised",
      systemPrompt: "You are the OpenHack E2E agent.",
      lastWorkspace: workspace,
      activeProviderId: "mock",
      activeModel: "mock-agent",
    },
    mcpServers: [],
    enabledPlugins: [],
    installedPlugins: [],
  }, null, 2));
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, OPENHACK_DATA_DIR: dataDir, OPENHACK_DEFAULT_WORKSPACE: workspace },
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForSelector(".app-shell", { timeout: 30000 });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("empty state renders as a real workspace entry surface", async () => {
  await expect(page.getByRole("heading", { name: /Break something/ })).toBeVisible();
  await expect(page.locator(".sidebar-foot")).toContainText("workspace");
  await page.screenshot({ path: "artifacts/ui-empty-1440.png" });
});

test("streams a tool call, enforces approval, writes the workspace, and recovers from provider failure", async () => {
  await expect(page.locator(".agent-state")).toContainText("ready", { timeout: 30000 });
  const composer = page.getByLabel("Message the agent");
  await composer.fill("Create proof.txt and verify it.");
  await page.getByLabel("Send message").click();
  await page.screenshot({ path: "artifacts/ui-loading-1440.png" });
  await page.waitForTimeout(800);
  const errorLocator = page.locator(".run-error");
  const runError = (await errorLocator.count()) > 0 ? await errorLocator.first().innerText() : null;
  if (runError) {
    const transcript = await page.locator(".chat-scroll").innerText();
    await writeFile("artifacts/e2e-failure.txt", `runError: ${runError}\n\n${transcript}\n\npageErrors: ${pageErrors.join(" | ")}\nrequests: ${requestCount}\n`);
  }
  expect(runError, `requestCount=${requestCount} pageErrors=${pageErrors.join(" | ")}`).toBeNull();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("workspace.write")).toBeVisible();
  await expect(page.locator(".approval-note")).toContainText("digest");
  await page.screenshot({ path: "artifacts/ui-approval-1440.png" });
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".message-assistant .markdown").last()).toContainText("proof.txt", { timeout: 15000 });
  await expect(page.locator(".message-assistant .markdown").last()).toContainText("approval boundary held");
  expect(await readFile(path.join(workspace, "proof.txt"), "utf8")).toBe("verified by OpenHack");
  expect(requestCount).toBe(2);
  await expect(page.locator(".agent-state")).toContainText("ready");
  await page.screenshot({ path: "artifacts/ui-complete-1440.png" });

  if (!(await page.locator(".side-panel").isVisible().catch(() => false))) {
    await page.getByLabel("Toggle review panel").click();
  }
  await expect(page.locator(".side-panel")).toBeVisible();
  await expect(page.locator(".checkpoint-file").first()).toContainText("proof.txt");
  await page.locator(".checkpoint-file").first().click();
  await expect(page.locator(".diff-line.add").first()).toContainText("verified by OpenHack");
  await page.screenshot({ path: "artifacts/ui-diff-1440.png" });
  await page.locator(".diff-line.add").first().click();
  await expect(page.locator(".diff-comment")).toBeVisible();
  await page.getByLabel("Line comment").fill("Tighten this.");
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByLabel("Message the agent")).toHaveValue(/Review proof.txt/);

  await page.getByRole("button", { name: "Restore file" }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByText("Restored proof.txt")).toBeVisible({ timeout: 10000 });
  await expect(readFile(path.join(workspace, "proof.txt"), "utf8")).rejects.toThrow();

  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Plan mode: read-only.")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "Act", exact: true }).click();
  await expect(page.getByRole("button", { name: "Act", exact: true })).toHaveAttribute("aria-pressed", "true");

  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  failNext = true;
  await composer.fill("Trigger a provider failure.");
  await page.getByLabel("Send message").click();
  await expect(page.locator(".run-error")).toContainText("Mock provider failure", { timeout: 15000 });
  await page.screenshot({ path: "artifacts/ui-error-1440.png" });
  expect(consoleErrors.filter((message) => message.includes("Mock provider failure"))).toHaveLength(0);
  await page.getByRole("button", { name: "Dismiss" }).click();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1040, 720));
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Load recent" }).click();
  await expect(page.locator(".audit-list")).toContainText("approval.requested", { timeout: 5000 });
  await expect(page.locator(".audit-list")).toContainText("tool.completed");
  await page.screenshot({ path: "artifacts/ui-settings-1040.png" });
});

test("runs a delegated task through the agent bus and keeps it out of chat history", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 920));
  await page.getByRole("button", { name: "Agent bus" }).click();
  await expect(page.getByRole("heading", { name: "Shared channel" })).toBeVisible();
  await expect(page.locator(".agent-chip").filter({ hasText: "GHOST" })).toBeVisible();
  await page.getByLabel("Route to agent").selectOption("recon");
  await page.getByLabel("Message the bus").fill("bus-fixture map the target");
  await page.getByRole("button", { name: "Send to bus" }).click();
  await expect(page.locator(".bus-row.from-agent").last()).toContainText("BUS-ACK", { timeout: 20000 });
  await expect(page.locator(".bus-row.from-operator")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/ui-bus-1440.png" });

  await page.getByRole("button", { name: /memory/ }).click();
  await expect(page.locator(".webhook-box")).toContainText("127.0.0.1");
  await page.screenshot({ path: "artifacts/ui-bus-memory-1440.png" });

  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.locator(".session-row")).toHaveCount(1);
});

test("spawns a parallel worker army inside the same session", async () => {
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const before = await page.locator(".session-row").count();
  await page.getByRole("button", { name: /New session/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.locator(".session-row")).toHaveCount(before + 1);
  await expect(page.getByLabel("Message the agent")).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Message the agent").fill("spawn-fixture deploy the army");
  await page.getByLabel("Send message").click();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".message-worker")).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator(".chat-head-meta")).toContainText("2 workers");
  await expect(page.locator(".message-worker").first()).toContainText("SPAWN-REPORT");
  await expect(page.locator(".message-assistant .markdown").last()).toContainText("army done", { timeout: 20000 });
  // Decorative: a closed page must not fail a test whose assertions passed.
  if (!page.isClosed()) await page.screenshot({ path: "artifacts/ui-spawn-1440.png" }).catch(() => undefined);
  await expect(page.locator(".session-row")).toHaveCount(before + 1);
});

test("applies a multi-file patch through the approval gate", async () => {
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const before = await page.locator(".session-row").count();
  await page.getByRole("button", { name: /New session/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.locator(".session-row")).toHaveCount(before + 1);
  await expect(page.getByLabel("Message the agent")).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Message the agent").fill("patch-fixture update the target");
  await page.getByLabel("Send message").click();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("apply_patch")).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".message-assistant .markdown").last()).toContainText("patched", { timeout: 20000 });
  expect(await readFile(path.join(workspace, "patch-target.txt"), "utf8")).toBe("alpha\nBETA\n");
});

test("loads a page in the isolated browser pane and rejects file URLs", async () => {
  await page.getByRole("button", { name: "Session", exact: true }).click();
  if (!(await page.locator(".side-panel").isVisible().catch(() => false))) {
    await page.getByLabel("Toggle review panel").click();
  }
  await expect(page.locator(".side-panel")).toBeVisible();
  await page.getByRole("tab", { name: "Browser" }).click();
  await page.getByLabel("Browser URL").fill(`http://127.0.0.1:${serverPort}/page`);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page.locator(".browser-foot")).toContainText("Preview Target", { timeout: 15000 });

  const attached = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? 0);
  expect(attached).toBeGreaterThan(0);
  await page.screenshot({ path: "artifacts/ui-browser-1440.png" });
  // capturePage can return an empty buffer for a frame that has not painted
  // yet, so poll instead of racing the compositor.
  let viewPng = "";
  await expect.poll(async () => {
    viewPng = await page.evaluate(() => window.openhack.invoke("browser.snapshot") as Promise<string>);
    return viewPng.length;
  }, { timeout: 15000, intervals: [250, 500, 1000] }).toBeGreaterThan(1000);
  await writeFile("artifacts/ui-browser-window.png", Buffer.from(viewPng, "base64"));

  await page.getByLabel("Browser URL").fill("file:///C:/Windows/win.ini");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForTimeout(400);
  await expect(page.locator(".browser-foot")).toContainText("Preview Target");

  await page.getByRole("tab", { name: "Changes" }).click();
  await page.waitForTimeout(300);
  const detached = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? 0);
  expect(detached).toBeLessThan(attached);
});

test("keeps renderer isolated and exposes no Node primitives", async () => {
  const exposure = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    bridge: typeof window.openhack,
  }));
  expect(exposure).toEqual({ require: "undefined", process: "undefined", bridge: "object" });
  expect(pageErrors).toEqual([]);
});
