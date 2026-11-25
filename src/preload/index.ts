import { contextBridge, ipcRenderer } from "electron";

const channels = new Set([
  "bootstrap",
  "workspace.open",
  "workspace.tree",
  "workspace.read",
  "session.create",
  "session.list",
  "session.get",
  "session.delete",
  "session.setMode",
  "approvals.pending",
  "approvals.resolve",
  "run.start",
  "run.cancel",
  "approval.decide",
  "provider.save",
  "provider.test",
  "provider.import",
  "settings.update",
  "settings.searchKey",
  "mcp.save",
  "mcp.importOpenCode",
  "mcp.bootstrap",
  "mcp.connect",
  "mcp.disconnect",
  "mcp.remove",
  "mcp.list",
  "bus.snapshot",
  "bus.send",
  "bus.messages",
  "bus.memory.delete",
  "bus.agents.save",
  "plugins.list",
  "plugins.import",
  "plugins.toggle",
  "plugins.openFolder",
  "app.openDataDir",
  "app.openExternal",
  "security.auditTail",
  "checkpoints.list",
  "checkpoints.diff",
  "checkpoints.restore",
  "browser.show",
  "browser.bounds",
  "browser.hide",
  "browser.navigate",
  "browser.snapshot",
  "browser.action",
]);

contextBridge.exposeInMainWorld("openhack", {
  platform: process.platform,
  invoke: async (channel: string, payload?: unknown) => {
    if (!channels.has(channel)) throw new Error("Unknown application channel");
    const reply = await ipcRenderer.invoke(channel, payload) as { ok: boolean; data?: unknown; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "Application request failed");
    return reply.data;
  },
  onPush: (listener: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("openhack:push", handler);
    return () => ipcRenderer.removeListener("openhack:push", handler);
  },
});
