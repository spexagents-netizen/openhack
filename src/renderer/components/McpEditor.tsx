import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpServerConfig, McpServerStatus } from "../../shared/contracts";
import { Modal, Spinner } from "./ui";

/** Handles both transports: a URL makes it a remote MCP, otherwise stdio. */
export function McpEditor({ server, onClose, onSave }: { server?: McpServerStatus; onClose: () => void; onSave: (server: McpServerConfig) => Promise<void> }) {
  const [id, setId] = useState(server?.id ?? "");
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const remote = url.trim().length > 0;

  useEffect(() => {
    if (!server) {
      const generated = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      setId(generated);
    }
  }, [name, server]);

  const parsePairs = (value: string, label: string): Record<string, string> =>
    Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const split = line.indexOf("=");
      if (split < 1) throw new Error(`${label} entries must use KEY=VALUE`);
      return [line.slice(0, split).trim(), line.slice(split + 1)];
    }));

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const parsedEnv = parsePairs(env, "Environment");
      const parsedHeaders = parsePairs(headers, "Header");
      await onSave({
        id,
        name: name || id,
        enabled: true,
        ...(remote
          ? { url: url.trim(), ...(Object.keys(parsedHeaders).length ? { headers: parsedHeaders } : {}) }
          : {
              command,
              args: args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(Object.keys(parsedEnv).length ? { env: parsedEnv } : {}),
            }),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setBusy(false);
    }
  };

  return (
    <Modal
      eyebrow="MCP / STDIO OR HTTP"
      title={server ? `Edit ${server.name}` : "Add MCP server"}
      onClose={onClose}
      width="md"
      footer={<><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => void save()} disabled={busy || !id || (!remote && !command)}>{busy ? <Spinner label="Starting" /> : <Save size={14} />} Save &amp; connect</button></>}
    >
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Security tools" autoFocus /></label>
        <label className="field"><span>Server ID</span><input value={id} onChange={(event) => setId(event.target.value)} placeholder="security-tools" disabled={Boolean(server)} /></label>
        <label className="field field-wide">
          <span>URL — remote MCP, leave blank for stdio</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:9876/mcp" spellCheck={false} />
        </label>
        {!remote && (
          <>
            <label className="field field-wide"><span>Command</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" spellCheck={false} /></label>
            <label className="field field-wide"><span>Arguments — one per line</span><textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} spellCheck={false} placeholder={"-y\n@publisher/mcp-server"} /></label>
            <label className="field field-wide"><span>Working directory — optional</span><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="C:\\tools\\mcp-server" spellCheck={false} /></label>
            <label className="field field-wide">
              <span>Environment — optional — KEY=VALUE</span>
              <textarea
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={server?.envKeys.length ? `Existing keys: ${server.envKeys.join(", ")} — re-enter to replace` : "API_KEY=..."}
              />
            </label>
          </>
        )}
        {remote && (
          <label className="field field-wide">
            <span>Headers — optional — KEY=VALUE</span>
            <textarea value={headers} onChange={(event) => setHeaders(event.target.value)} rows={3} spellCheck={false} placeholder={"Authorization=Bearer ..."} />
          </label>
        )}
      </div>
      <div className="form-note">
        Environment values and remote headers are encrypted with Windows DPAPI before they reach disk; the renderer receives key names only.
        A remote server is contacted directly from the main process. A stdio server runs with your user privileges — review the package before starting it.
      </div>
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
