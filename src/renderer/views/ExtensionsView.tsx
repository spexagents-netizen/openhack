import { Box, FolderOpen, Plug, Plus, RefreshCw, Save, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpServerConfig, McpServerStatus, PluginStatus } from "../../shared/contracts";
import { Empty, Modal, Spinner, Toggle } from "../components/ui";
import { McpEditor } from "../components/McpEditor";

export function ExtensionsView(props: {
  servers: McpServerStatus[];
  plugins: PluginStatus[];
  onSaveServer: (server: McpServerConfig) => Promise<void>;
  onConnect: (id: string) => Promise<void>;
  onDisconnect: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onInstallStack: () => void;
  onImportMcp: () => void;
  onImportPlugin: () => Promise<void>;
  onTogglePlugin: (id: string, enabled: boolean) => Promise<void>;
  onOpenPluginFolder: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<McpServerStatus | "new" | null>(null);
  const [pendingRemove, setPendingRemove] = useState<McpServerStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="view-page extensions-view">
      <div className="view-head">
        <div>
          <div className="eyebrow">CAPABILITY LAYER</div>
          <h1>Extensions</h1>
          <p>Connect stdio MCP servers and declarative plugins. Nothing is loaded until you enable it.</p>
        </div>
      </div>

      <section className="extension-section">
        <div className="section-title-row">
          <div>
            <h2><Plug size={17} /> MCP servers</h2>
            <p>Each server runs as an isolated child process. Its tools enter the same approval path as built-ins.</p>
          </div>
          <div className="button-row">
            <button type="button" className="button" onClick={() => void props.onInstallStack()}><Box size={14} /> Install stack</button>
            <button type="button" className="button" onClick={() => void props.onImportMcp()}><RefreshCw size={14} /> Import OpenCode</button>
            <button type="button" className="button" onClick={() => setEditing("new")}><Plus size={14} /> Add server</button>
          </div>
        </div>
        {props.servers.length ? (
          <div className="extension-list">
            {props.servers.map((server) => (
              <div className="extension-card" key={server.id}>
                <div className="extension-main">
                  <div className="extension-icon"><Plug size={18} /></div>
                  <div className="extension-copy">
                    <div className="extension-name-row">
                      <h3>{server.name}</h3>
                      <span className={`connection-state state-${server.state}`}>{server.state}</span>
                    </div>
                    <code>{server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")}</code>
                    <div className="extension-meta">
                      <span>{server.tools.length} tools</span>
                      {server.envKeys.length > 0 && <span>{server.envKeys.length} env keys</span>}
                      {server.cwd && <span>cwd set</span>}
                    </div>
                    {server.error && <div className="extension-error">{server.error}{server.state === "failed" ? " · check the server command and stderr" : ""}</div>}
                    {server.tools.length > 0 && (
                      <div className="tool-chips">{server.tools.slice(0, 8).map((tool) => <span key={tool.name}>{tool.name.replace(/^mcp_[^_]+_/, "")}</span>)}{server.tools.length > 8 && <span>+{server.tools.length - 8}</span>}</div>
                    )}
                  </div>
                </div>
                <div className="extension-actions">
                  {server.state === "ready" ? (
                    <button type="button" className="button small" disabled={busy === server.id} onClick={async () => { setBusy(server.id); try { await props.onDisconnect(server.id); } finally { setBusy(null); } }}><Unplug size={13} /> Disconnect</button>
                  ) : (
                    <button type="button" className="button small" disabled={busy === server.id} onClick={async () => { setBusy(server.id); try { await props.onConnect(server.id); } finally { setBusy(null); } }}>
                      {busy === server.id ? <Spinner label="Connecting" /> : <RefreshCw size={13} />} Connect
                    </button>
                  )}
                  <button type="button" className="button small ghost" onClick={() => setEditing(server)}>Edit</button>
                  <button type="button" className="icon-button danger-hover" onClick={() => setPendingRemove(server)} aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={<Plug size={22} />} title="No MCP servers configured" body="Add a stdio server by command and arguments. You will see its full tool inventory before the agent can call it." action={<button type="button" className="button" onClick={() => setEditing("new")}>Add your first server</button>} />
        )}
      </section>

      <section className="extension-section">
        <div className="section-title-row">
          <div>
            <h2><Box size={17} /> Manifest plugins</h2>
            <p>Plugins contribute prompts and commands as data. This build does not execute third-party plugin code.</p>
          </div>
          <div className="button-row">
            <button type="button" className="button small" onClick={() => void props.onOpenPluginFolder()}><FolderOpen size={13} /> Folder</button>
            <button type="button" className="button small" onClick={() => void props.onImportPlugin()}><Plus size={13} /> Import</button>
          </div>
        </div>
        {props.plugins.length ? (
          <div className="extension-list">
            {props.plugins.map((plugin) => (
              <div className="extension-card plugin-card" key={plugin.id}>
                <div className="extension-main">
                  <div className="extension-icon plugin-icon"><Box size={18} /></div>
                  <div className="extension-copy">
                    <div className="extension-name-row"><h3>{plugin.name}</h3><span className="version-label">v{plugin.version}</span></div>
                    <p>{plugin.description || "No description provided."}</p>
                    <div className="extension-meta">
                      <code>{plugin.id}</code>
                      {plugin.permissions?.map((permission) => <span key={permission}>{permission}</span>)}
                      {plugin.commands?.length ? <span>{plugin.commands.length} commands</span> : null}
                    </div>
                  </div>
                </div>
                <Toggle checked={plugin.enabled} onChange={(enabled) => void props.onTogglePlugin(plugin.id, enabled)} label={`Toggle ${plugin.name}`} />
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={<Box size={22} />} title="No manifest plugins installed" body="Import a folder containing openhack-plugin.json. Manifest content is validated and shown before it can shape an agent prompt." action={<button type="button" className="button" onClick={() => void props.onImportPlugin()}>Import plugin folder</button>} />
        )}
      </section>

      {editing && (
        <McpEditor
          server={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (server) => {
            await props.onSaveServer(server);
            setEditing(null);
          }}
        />
      )}
      {pendingRemove && (
        <Modal
          eyebrow="REMOVE INTEGRATION"
          title={`Remove ${pendingRemove.name}?`}
          onClose={() => setPendingRemove(null)}
          width="sm"
          footer={<><button type="button" className="button ghost" onClick={() => setPendingRemove(null)}>Cancel</button><button type="button" className="button danger" onClick={async () => { await props.onRemove(pendingRemove.id); setPendingRemove(null); }}>Remove server</button></>}
        >
          <p className="modal-copy">The server process will stop and its configuration will be deleted. Tool inventory and credentials for this server are removed from OpenHack.</p>
        </Modal>
      )}
    </div>
  );
}
