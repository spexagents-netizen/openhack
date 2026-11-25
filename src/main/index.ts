import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from "electron";
import { AgentService } from "./agent/service";
import { BrowserPane } from "./browser/pane";
import { BusService } from "./bus/bus";
import { CheckpointStore } from "./checkpoints/store";
import { ConfigStore, type SecretCipher } from "./config/store";
import { SkillRegistry } from "./skills/registry";
import { importOpenCodeMcp, importOpenCodeProviders } from "./config/opencode";
import { registerIpc } from "./ipc";
import { McpManager } from "./mcp/manager";
import { loadPreset, planStack } from "./mcp/bootstrap";
import { PluginManager } from "./plugins/manager";
import { AuditLog } from "./security/audit";
import { SessionStore } from "./storage/sessions";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.OPENHACK_DATA_DIR || path.join(app.getPath("appData"), "OpenHack"));
// Bundled resources live beside the repo in dev and in resources/ when packaged.
// app.getAppPath() is the entry file's folder for a dev launch, so it is not used.
const resourceRoot = app.isPackaged ? process.resourcesPath : path.resolve(currentDir, "../..");
app.setName("OpenHack");
app.setPath("userData", dataDir);
app.setAppUserModelId("ai.openhack.desktop");

let mainWindow: BrowserWindow | null = null;
let cleanup: (() => Promise<void>) | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox("OpenHack could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const cipher = electronCipher();
  const config = await ConfigStore.open(dataDir, cipher);
  if (!config.providerConfigs.length) await autoImportOpenCode(config);
  if (config.settings.lastWorkspace) {
    try {
      const canonical = await realpath(config.settings.lastWorkspace);
      if (canonical !== config.settings.lastWorkspace) await config.updateSettings({ lastWorkspace: canonical });
    } catch {
      // A stale workspace stays visible so the operator can authorize another.
    }
  }
  if (!config.settings.lastWorkspace && process.env.OPENHACK_DEFAULT_WORKSPACE) {
    try {
      const workspace = await realpath(process.env.OPENHACK_DEFAULT_WORKSPACE);
      await config.updateSettings({ lastWorkspace: workspace });
    } catch {
      // The explicit environment workspace is optional and must exist.
    }
  }
  const sessions = await SessionStore.open(dataDir);
  const mcp = new McpManager(() => config.mcpConfigs);

  // First launch on a clean machine: stage the curated stack, adding only what
  // this host can actually run. The report stays on disk so the UI can explain
  // what was skipped instead of pretending everything installed.
  const presetFile = path.join(resourceRoot, "presets", "mcp-stack.json");
  const markerFile = path.join(dataDir, "stack-bootstrap.json");
  // Re-plan when the build changes, not only on the first ever launch, so an
  // upgrade picks up new preset entries and import rules.
  let needsBootstrap = !existsSync(markerFile);
  if (!needsBootstrap) {
    try {
      const prior = JSON.parse(await readFile(markerFile, "utf8")) as { version?: string };
      if (prior.version !== app.getVersion()) needsBootstrap = true;
    } catch {
      needsBootstrap = true;
    }
  }
  if (needsBootstrap && existsSync(presetFile)) {
    try {
      const preset = await loadPreset(presetFile);
      const plan = await planStack(preset, config.mcpConfigs);
      for (const server of plan.servers) await config.saveMcpServer(server);
      for (const server of plan.servers) void mcp.connect(server).catch(() => undefined);

      // The operator's existing OpenCode servers come along too: nothing new is
      // invented, and ids already present are left untouched.
      let opencode: { added: string[]; skipped: string[] } = { added: [], skipped: [] };
      try {
        const imported = importOpenCodeMcp(await readFile(path.join(homedir(), ".config", "opencode", "opencode.json"), "utf8"));
        const known = new Set(config.mcpConfigs.map((server) => server.id));
        const fresh = imported.servers.filter((server) => !known.has(server.id));
        for (const server of fresh) await config.saveMcpServer(server);
        for (const server of fresh.filter((entry) => entry.enabled)) void mcp.connect(server).catch(() => undefined);
        opencode = { added: fresh.map((server) => server.id), skipped: imported.skipped };
      } catch {
        // No OpenCode config is a normal state.
      }
      await writeFile(markerFile, JSON.stringify({ version: app.getVersion(), at: new Date().toISOString(), ...plan.report, opencode }, null, 2), "utf8");
    } catch {
      // A preset failure must never block startup.
    }
  }
  const plugins = new PluginManager(path.join(dataDir, "plugins"), config);
  await plugins.scan();
  const broadcast = (payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("openhack:push", payload);
    }
  };
  await sessions.expireApprovals();
  const bus = new BusService({ sessions, config, broadcast });
  const audit = new AuditLog(path.join(dataDir, "audit.log"), () => [
    ...config.providerConfigs.map((provider) => provider.apiKey ?? ""),
    ...config.mcpConfigs.flatMap((server) => Object.values(server.env ?? {})),
  ]);
  const checkpoints = new CheckpointStore(path.join(dataDir, "checkpoints"));
  // Share the skill libraries already on this machine instead of shipping a
  // private format: Claude Code and OpenCode both use <root>/<name>/SKILL.md.
  const skillRoots = [...new Set([
    path.join(dataDir, "skills"),
    path.join(homedir(), ".claude", "skills"),
    path.join(homedir(), ".config", "opencode", "skills"),
    path.join(resourceRoot, "skills"),
  ])];
  const skills = await SkillRegistry.load(skillRoots);
  const browserPane = new BrowserPane(() => mainWindow, broadcast);
  const agent = new AgentService(config, sessions, mcp, plugins, broadcast, bus, {
    onRunFinished: (outcome) => bus.onRunFinished(outcome),
  }, { audit, policyVersion: app.getVersion(), checkpoints, skills });
  bus.attachRunner({
    start: (request) => agent.start({
      sessionId: request.sessionId,
      input: request.input,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      systemExtra: request.systemExtra,
    }),
  });
  registerIpc({ config, sessions, mcp, plugins, agent, bus, audit, checkpoints, browser: browserPane, dataDir, resourceRoot, version: app.getVersion(), broadcast });
  hardenSession();
  Menu.setApplicationMenu(null);
  createWindow();
  void bus.startWebhook().catch(() => broadcast({ kind: "bus.changed" }));
  // A broken MCP server must never delay the main window or block work that
  // does not depend on it. Configuration load remains independent.
  void mcp.startAll()
    .then(() => broadcast({ kind: "integrations.changed" }))
    .catch(() => broadcast({ kind: "integrations.changed" }));
  cleanup = async () => {
    await agent.shutdown();
    browserPane.destroy();
    await bus.close();
    await mcp.closeAll();
    await sessions.close();
  };
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    const current = cleanup;
    if (!current) return;
    event.preventDefault();
    cleanup = undefined;
    void current().finally(() => app.quit());
  });
}

function createWindow(): void {
  const preloadCjs = path.join(currentDir, "../preload/index.cjs");
  const preloadJs = path.join(currentDir, "../preload/index.js");
  const icon = path.join(currentDir, "../../assets/icon.png");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#0e0e0f",
    title: "OpenHack",
    ...(existsSync(icon) ? { icon } : {}),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0e0e0f", symbolColor: "#b6b1a8", height: 52 },
    webPreferences: {
      preload: existsSync(preloadCjs) ? preloadCjs : preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged || process.env.OPENHACK_DEVTOOLS === "1",
      spellcheck: false,
      // A streaming agent must keep painting while the operator is in another
      // window; Chromium otherwise throttles timers and rendering to 1 Hz.
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? "";
    if (url !== current) {
      event.preventDefault();
      if (isSafeExternal(url)) void shell.openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(currentDir, "../renderer/index.html"));
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"],
          "X-Content-Type-Options": ["nosniff"],
        },
      });
    });
  }
}

function electronCipher(): SecretCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
}

async function autoImportOpenCode(config: ConfigStore): Promise<void> {
  const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const imported = importOpenCodeProviders(await readFile(configPath, "utf8"), { baseDir: path.dirname(configPath) });
    if (imported.providers.length) await config.importProviders(imported.providers);
  } catch {
    // OpenCode is an optional provider source; manual setup remains available.
  }
}

function isSafeExternal(value: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
