import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, test, type ElectronApplication, type Page } from "@playwright/test";

// Visual harness: boots the real app against a mock provider with an authorized
// workspace and autonomous permissions, then captures every surface so design
// passes can be compared frame by frame.

let server: Server;
let app: ElectronApplication;
let page: Page;
let workspace = "";

interface WireMessage { role?: string; content?: unknown }

const ANSWER = [
  "The workspace is a two-file TypeScript shim over a single trust boundary.",
  "",
  "**What matters**",
  "",
  "- `src/index.ts` wires the IPC bridge and is the only entrypoint with a writable surface.",
  "- `src/engine.ts` is pure, so it is safe to execute in isolation.",
  "- Nothing here reads the environment, so there is no credential path to escalate.",
  "",
  "```ts",
  "export const boot = (): number => {",
  "  const bridge = openBridge();   // sole privileged handle",
  "  return bridge.pid;",
  "};",
  "```",
  "",
  "Next move: trace `openBridge` into the preload contract before touching the write path.",
].join("\n");

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let parsed: { messages?: WireMessage[] } = {};
      try { parsed = JSON.parse(body) as { messages?: WireMessage[] }; } catch { /* keep default */ }
      const messages = parsed.messages ?? [];
      const last = messages.at(-1);
      const toolMessages = messages.filter((message) => message.role === "tool");

      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: unknown) => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
        response.end();
      };
      const call = (name: string, args: unknown, id: string) => send({
        content: "",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });

      if (last?.role === "user") {
        const text = typeof last.content === "string" ? last.content : "";
        if (text.includes("write")) {
          call("workspace.write", { path: "notes.md", content: "# Surface\n\n- ipc bridge\n- pure engine\n" }, "call-write");
          return;
        }
        call("workspace.list", { path: "." }, "call-list");
        return;
      }
      if (toolMessages.length >= 2) {
        send({ content: "Wrote `notes.md` and captured a checkpoint. The review panel has the diff." });
        return;
      }
      setTimeout(() => send({ content: ANSWER }), 420);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server failed");

  const root = await mkdtemp(path.join(tmpdir(), "openhack-visual-"));
  workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(root, "userdata"), { recursive: true });
  await mkdir("artifacts/shots", { recursive: true });
  await writeFile(path.join(workspace, "src", "index.ts"), "import { openBridge } from \"./engine\";\n\nexport const boot = () => openBridge().pid;\n");
  await writeFile(path.join(workspace, "src", "engine.ts"), "export function openBridge() {\n  return { pid: process.pid };\n}\n");
  await writeFile(path.join(workspace, "README.md"), "# Target\n\nA local lab for the bench.\n");

  await writeFile(path.join(root, "userdata", "config.json"), JSON.stringify({
    version: 1,
    providers: [{
      id: "mock",
      name: "Modal",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "kimi-k3", name: "Kimi K3.1 Pro", tools: true, context: 200000 }],
      maxTokensField: "max_tokens",
      headerTimeoutMs: 30000,
      source: "manual",
    }],
    settings: {
      permission: "autonomous",
      activeProviderId: "mock",
      activeModel: "kimi-k3",
      lastWorkspace: workspace,
    },
    mcpServers: [],
    enabledPlugins: [],
    installedPlugins: [],
  }, null, 2));

  app = await electron.launch({
    args: ["out/main/index.js"],
    env: { ...process.env, OPENHACK_DATA_DIR: path.join(root, "userdata"), OPENHACK_E2E: "1" },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1600);
});

test.afterAll(async () => {
  await app?.close();
  server?.close();
});

test("captures every surface", async () => {
  await page.locator(".composer textarea").focus();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "artifacts/shots/01-empty.png" });

  await page.getByLabel("Toggle review panel").click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "artifacts/shots/01b-panel-empty.png" });
  await page.getByLabel("Toggle review panel").click();
  await page.waitForTimeout(400);

  const composer = page.getByLabel("Message the agent");
  await composer.fill("map the surface of this workspace");
  await page.getByLabel("Send message").click();
  await page.waitForTimeout(280);
  await page.screenshot({ path: "artifacts/shots/02a-running.png" });
  await page.waitForTimeout(1600);
  await composer.fill("write the notes file");
  await page.getByLabel("Send message").click();
  await page.waitForTimeout(2200);
  await page.locator(".composer textarea").blur();
  await page.mouse.move(700, 300);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "artifacts/shots/02-conversation.png" });

  const metrics = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), right: Math.round(rect.right), w: Math.round(rect.width) };
    };
    return {
      user: box(".message-user .user-copy"),
      userRule: box(".message-user"),
      assistant: box(".message-assistant .markdown"),
      tool: box(".tool-group"),
      code: box(".code-block"),
      composer: box(".composer"),
    };
  });
  await writeFile("artifacts/shots/metrics.json", JSON.stringify(metrics, null, 2));

  await page.getByLabel("Toggle review panel").click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "artifacts/shots/03-review.png" });

  const file = page.locator(".checkpoint-file").first();
  if (await file.isVisible().catch(() => false)) {
    await file.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: "artifacts/shots/03b-diff.png" });
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);
  const saveState = await page.evaluate(() => {
    const button = document.querySelector(".view-head .button.primary");
    if (!button) return null;
    const style = getComputedStyle(button);
    return { dirty: button.getAttribute("data-dirty"), disabled: (button as HTMLButtonElement).disabled, opacity: style.opacity, background: style.backgroundColor };
  });
  await writeFile("artifacts/shots/settings-state.json", JSON.stringify(saveState, null, 2));
  await page.screenshot({ path: "artifacts/shots/04-settings.png" });

  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "artifacts/shots/04b-extensions.png" });

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "artifacts/shots/04c-workspace.png" });

  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "artifacts/shots/05-palette.png" });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "artifacts/shots/06-1280.png" });

  await page.setViewportSize({ width: 1120, height: 800 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "artifacts/shots/07-narrow.png" });
});
