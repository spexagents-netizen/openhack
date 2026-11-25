import { Check, Database, Globe, KeyRound, Pencil, Plus, Radio, RefreshCw, Save, ScrollText, Shield, Terminal, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings, BusAgentStatus, PermissionMode, ProviderConfig, PublicProviderConfig } from "../../shared/contracts";
import { Modal, Spinner, Toggle } from "../components/ui";

export function SettingsView(props: {
  providers: PublicProviderConfig[];
  settings: AppSettings;
  busAgents: BusAgentStatus[];
  dataDir: string;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onSaveSearchKey: (provider: "exa" | "tinyfish", apiKey: string) => Promise<void>;
  onImportProviders: () => Promise<void>;
  onSaveProvider: (provider: ProviderConfig, apiKey?: string) => Promise<void>;
  onTestProvider: (id: string) => Promise<{ ok: boolean; detail: string }>;
  onOpenDataDir: () => Promise<void>;
  onSaveBusAgents: (agents: BusAgentStatus[]) => Promise<void>;
  onLoadAudit: () => Promise<string[]>;
}) {
  const [permission, setPermission] = useState<PermissionMode>(props.settings.permission);
  const [reasoning, setReasoning] = useState<NonNullable<AppSettings["reasoningEffort"]>>(props.settings.reasoningEffort ?? "off");
  const [systemPrompt, setSystemPrompt] = useState(props.settings.systemPrompt);
  const [searxngUrl, setSearxngUrl] = useState(props.settings.searxngUrl ?? "");
  const [egressPolicy, setEgressPolicy] = useState<NonNullable<AppSettings["egressPolicy"]>>(props.settings.egressPolicy ?? "block-metadata");
  const [exaKey, setExaKey] = useState("");
  const [tinyfishKey, setTinyfishKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [auditLines, setAuditLines] = useState<string[]>([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<PublicProviderConfig | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [tests, setTests] = useState<Record<string, { state: "testing" | "ok" | "failed"; detail: string }>>({});
  useEffect(() => {
    setPermission(props.settings.permission);
    setReasoning(props.settings.reasoningEffort ?? "off");
    setSystemPrompt(props.settings.systemPrompt);
    setSearxngUrl(props.settings.searxngUrl ?? "");
    setEgressPolicy(props.settings.egressPolicy ?? "block-metadata");
  }, [props.settings]);
  const dirty = permission !== props.settings.permission
    || reasoning !== (props.settings.reasoningEffort ?? "off")
    || systemPrompt !== props.settings.systemPrompt
    || searxngUrl.trim().replace(/\/+$/, "") !== (props.settings.searxngUrl ?? "")
    || egressPolicy !== (props.settings.egressPolicy ?? "block-metadata");
  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await props.onSaveSettings({ permission, reasoningEffort: reasoning, systemPrompt, searxngUrl: searxngUrl.trim(), egressPolicy });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };
  const saveKeys = async () => {
    setKeyBusy(true);
    try {
      if (exaKey.trim()) await props.onSaveSearchKey("exa", exaKey.trim());
      if (tinyfishKey.trim()) await props.onSaveSearchKey("tinyfish", tinyfishKey.trim());
      setExaKey("");
      setTinyfishKey("");
    } finally {
      setKeyBusy(false);
    }
  };
  const clearKeys = async () => {
    setKeyBusy(true);
    try {
      if (props.settings.hasExaKey) await props.onSaveSearchKey("exa", "");
      if (props.settings.hasTinyfishKey) await props.onSaveSearchKey("tinyfish", "");
    } finally {
      setKeyBusy(false);
    }
  };
  return (
    <div className="view-page settings-view">
      <div className="view-head">
        <div>
          <div className="eyebrow">LOCAL CONFIGURATION</div>
          <h1>Settings</h1>
          <p>Providers, execution policy, and the data boundary for this installation.</p>
        </div>
        <button type="button" className="button primary" disabled={!dirty || saving} data-dirty={dirty ? "true" : "false"} onClick={() => void save()}>
          {saving ? <Spinner label="Saving" /> : saved ? <Check size={14} /> : <Save size={14} />}{saved ? "Saved" : "Save changes"}
        </button>
      </div>

      <section className="settings-section">
        <div className="section-title-row">
          <div><h2><KeyRound size={17} /> Model providers</h2><p>OpenAI-compatible endpoints. API keys stay in the main process and are encrypted at rest with Windows DPAPI.</p></div>
          <div className="button-row">
            <button type="button" className="button small" disabled={importing} onClick={async () => { setImporting(true); try { await props.onImportProviders(); } finally { setImporting(false); } }}>
              {importing ? <Spinner label="Importing" /> : <RefreshCw size={13} />} Import OpenCode
            </button>
            <button type="button" className="button small" onClick={() => setEditing("new")}><Plus size={13} /> Add provider</button>
          </div>
        </div>
        <div className="provider-list">
          {props.providers.map((provider) => (
            <div className="provider-card" key={provider.id}>
              <div className="provider-mark">{provider.name.slice(0, 2).toUpperCase()}</div>
              <div className="provider-body">
                <div className="provider-name-row">
                  <h3>{provider.name}</h3>
                  <span className="provider-id">{provider.id}</span>
                  {provider.source === "opencode" && <span className="source-badge">OPENCODE</span>}
                  <span className={`key-state ${provider.hasApiKey ? "is-set" : ""}`}>{provider.hasApiKey ? "KEY STORED" : "NO KEY"}</span>
                </div>
                <code className="provider-url">{provider.baseURL}</code>
                <div className="model-tags">{provider.models.map((model) => <span key={model.id}>{model.name}</span>)}</div>
                {tests[provider.id] && <div className={`test-result ${tests[provider.id]?.state}`}>{tests[provider.id]?.state === "testing" ? "Checking endpoint…" : tests[provider.id]?.detail}</div>}
              </div>
              <div className="provider-actions">
                <button type="button" className="button small" onClick={async () => {
                  setTests((current) => ({ ...current, [provider.id]: { state: "testing", detail: "" } }));
                  const result = await props.onTestProvider(provider.id).catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
                  setTests((current) => ({ ...current, [provider.id]: { state: result.ok ? "ok" : "failed", detail: result.detail } }));
                }}><Unplug size={13} /> Test</button>
                <button type="button" className="button small ghost" onClick={() => setEditing(provider)}><Pencil size={13} /> Edit</button>
              </div>
            </div>
          ))}
          {!props.providers.length && <div className="settings-empty">No provider configured. Import OpenCode or add an OpenAI-compatible endpoint.</div>}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title-row">
          <div><h2><Shield size={17} /> Agent authority</h2><p>The runtime enforces this profile. Prompt instructions cannot override it.</p></div>
        </div>
        <div className="permission-grid">
          {([
            ["supervised", "Supervised", "Reads run automatically. Writes and commands require approval.", <Shield size={17} />],
            ["workspace", "Workspace", "File writes inside the authorized root run automatically. Commands still require approval.", <Database size={17} />],
            ["autonomous", "Autonomous", "All workspace operations use the model's judgment. Highest blast radius.", <Terminal size={17} />],
          ] as const).map(([value, label, description, icon]) => (
            <button type="button" key={value} className={`permission-card ${permission === value ? "is-active" : ""}`} onClick={() => setPermission(value)}>
              <span className="permission-icon">{icon}</span>
              <strong>{label}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>
        <div className="settings-grid">
          <div className="field setting-readout">
            <span>Run policy</span>
            <strong>Unbounded · stop from the composer</strong>
            <small>A run ends when the model returns a final answer or you press stop. There is no step ceiling, and spawned workers follow the same rule.</small>
          </div>
          <label className="field compact-field">
            <span>Reasoning effort</span>
            <select value={reasoning} onChange={(event) => setReasoning(event.target.value as NonNullable<AppSettings["reasoningEffort"]>)}>
              <option value="off">Off — fastest</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High — deepest</option>
            </select>
            <small>Forwarded as <code>reasoning_effort</code> to providers that support it. Ignored by endpoints that do not.</small>
          </label>
          <div className="field setting-readout">
            <span>Active model</span>
            <strong>{props.providers.find((provider) => provider.id === props.settings.activeProviderId)?.name ?? "None"} / {props.settings.activeModel ?? "—"}</strong>
            <small>Switch models from the session header. Changes are applied to the next run.</small>
          </div>
        </div>
        <label className="field field-wide system-prompt-field">
          <span>System instruction</span>
          <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={8} />
          <small>OpenHack appends authorized-workspace context and enabled plugin prompts. Secrets are never inserted here.</small>
        </label>
      </section>

      <section className="settings-section">
        <div className="section-title-row">
          <div><h2><Radio size={17} /> Agent bus</h2><p>Agents share one channel, one memory, and bounded delegation. Disable anyone you do not want answering.</p></div>
        </div>
        <div className="agent-settings-list">
          {props.busAgents.map((agent) => (
            <div className="agent-settings-row" key={agent.id}>
              <div className="agent-settings-id">
                <span className="mono">{agent.id}</span>
                <strong>{agent.name}</strong>
                <span className="agent-role">{agent.role}</span>
              </div>
              <Toggle
                checked={agent.enabled}
                label={`Enable ${agent.name}`}
                onChange={(enabled) => {
                  const next = props.busAgents.map((entry) => entry.id === agent.id ? { ...entry, enabled } : entry);
                  void props.onSaveBusAgents(next);
                }}
              />
            </div>
          ))}
          {!props.busAgents.length && <div className="settings-empty">No bus agents loaded yet.</div>}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title-row">
          <div><h2><Globe size={17} /> Web research</h2><p>Hosted search first — keyed when a key is stored, otherwise the shared keyless tier. Candidates race for the fastest answer; scraped engines are only the net.</p></div>
        </div>
        <div className="search-backends">
          <span className="backend-chip is-primary">Exa · {props.settings.hasExaKey ? "keyed" : "keyless"}</span>
          <span className="backend-chip is-primary">TinyFish · {props.settings.hasTinyfishKey ? "keyed" : "keyless"}</span>
          <span className="backend-chip">Parallel · fallback</span>
          <span className="backend-chip">DuckDuckGo · net</span>
          <span className="backend-chip is-optional">Brave · env key</span>
          <span className="backend-chip is-optional">Tavily · env key</span>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>Exa API key · {props.settings.hasExaKey ? "stored" : "optional"}</span>
            <input
              type="password"
              value={exaKey}
              onChange={(event) => setExaKey(event.target.value)}
              placeholder={props.settings.hasExaKey ? "Stored encrypted — enter a new key to replace" : "Paste an Exa key to leave the shared pool"}
              autoComplete="off"
              spellCheck={false}
              aria-label="Exa API key"
            />
            <small>Sent only as the <code>x-api-key</code> header to Exa's MCP endpoint. Never a URL parameter.</small>
          </label>
          <label className="field">
            <span>TinyFish API key · {props.settings.hasTinyfishKey ? "stored" : "optional"}</span>
            <input
              type="password"
              value={tinyfishKey}
              onChange={(event) => setTinyfishKey(event.target.value)}
              placeholder={props.settings.hasTinyfishKey ? "Stored encrypted — enter a new key to replace" : "Paste a TinyFish key to use the gateway search"}
              autoComplete="off"
              spellCheck={false}
              aria-label="TinyFish API key"
            />
            <small>Keyed search is a single <code>GET /v1/search</code> call on the gateway. Without a key the keyless MCP tier is used.</small>
          </label>
        </div>
        <div className="button-row key-actions">
          <button
            type="button"
            className="button small"
            disabled={keyBusy || (!exaKey.trim() && !tinyfishKey.trim())}
            onClick={() => void saveKeys()}
          >
            {keyBusy ? <Spinner label="Saving key" /> : <Save size={13} />} Save search keys
          </button>
          {(props.settings.hasExaKey || props.settings.hasTinyfishKey) && (
            <button type="button" className="button small ghost" disabled={keyBusy} onClick={() => void clearKeys()}>
              Clear stored keys
            </button>
          )}
        </div>
        <label className="field field-wide searx-field">
          <span>SearXNG instance · optional</span>
          <input
            value={searxngUrl}
            onChange={(event) => setSearxngUrl(event.target.value)}
            placeholder="https://searx.example.org"
            spellCheck={false}
            aria-label="SearXNG instance"
          />
          <small>
            Leave blank to rotate through public instances. Set your own instance to remove rate limits and third-party
            dependency. The instance must allow <code>format=json</code>. <code>BRAVE_SEARCH_API_KEY</code> and{" "}
            <code>TAVILY_API_KEY</code> in the environment add keyed backends ahead of the public fallbacks.
          </small>
        </label>
        <label className="field field-wide">
          <span>Outbound fetch policy</span>
          <select value={egressPolicy} onChange={(event) => setEgressPolicy(event.target.value as typeof egressPolicy)} aria-label="Outbound fetch policy">
            <option value="block-metadata">Block cloud metadata · default</option>
            <option value="block-private">Strict · block private networks and loopback</option>
            <option value="open">Open · no address filtering</option>
          </select>
          <small>
            Applies to <code>web_fetch</code> and every redirect hop. Metadata endpoints are never a legitimate target;
            strict mode also refuses RFC1918, CGNAT, link-local and loopback.
          </small>
        </label>
      </section>

      <section className="settings-section">
        <div className="section-title-row">
          <div><h2><ScrollText size={17} /> Security log</h2><p>Approvals, denials and tool executions. Redacted, append-only, local.</p></div>
          <button
            type="button"
            className="button small"
            disabled={auditBusy}
            onClick={async () => {
              setAuditBusy(true);
              try { setAuditLines(await props.onLoadAudit()); }
              finally { setAuditBusy(false); }
            }}
          >
            {auditBusy ? <Spinner label="Loading log" /> : <ScrollText size={13} />} Load recent
          </button>
        </div>
        <div className="audit-list" data-scrollable>
          {auditLines.length ? auditLines.slice().reverse().map((line, index) => {
            let entry: Record<string, unknown> | null = null;
            try { entry = JSON.parse(line) as Record<string, unknown>; } catch { entry = null; }
            if (!entry) return <div className="audit-entry" key={index}><span className="audit-detail">{line}</span></div>;
            const detail = [
              typeof entry.tool === "string" ? entry.tool : "",
              entry.approved === true ? "approved" : entry.approved === false ? "denied" : "",
              typeof entry.agent === "string" ? entry.agent : "",
              typeof entry.reason === "string" ? entry.reason : "",
            ].filter(Boolean).join(" · ");
            return (
              <div className="audit-entry" key={index} title={line}>
                <span className="audit-time">{typeof entry.ts === "string" ? new Date(entry.ts).toLocaleTimeString() : "--"}</span>
                <span className="audit-event">{String(entry.event ?? "entry")}</span>
                <span className="audit-detail">{detail}</span>
              </div>
            );
          }) : <div className="audit-empty">Nothing loaded yet. Entries appear after the next approval or tool call.</div>}
        </div>      </section>

      <section className="settings-section data-section">
        <div className="section-title-row">
          <div><h2><Database size={17} /> Local data</h2><p>Sessions and messages are stored in SQLite under the user profile. Nothing in this directory is uploaded by OpenHack.</p></div>
          <button type="button" className="button small" onClick={() => void props.onOpenDataDir()}>Open folder</button>
        </div>
        <code className="data-path">{props.dataDir}</code>
      </section>

      {editing && (
        <ProviderEditor
          provider={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (provider, apiKey) => {
            await props.onSaveProvider(provider, apiKey);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ProviderEditor(props: { provider?: PublicProviderConfig; onClose: () => void; onSave: (provider: ProviderConfig, apiKey?: string) => Promise<void> }) {
  const [id, setId] = useState(props.provider?.id ?? "");
  const [name, setName] = useState(props.provider?.name ?? "");
  const [baseURL, setBaseURL] = useState(props.provider?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState(props.provider?.models.map((model) => `${model.id}${model.name !== model.id ? ` | ${model.name}` : ""}`).join("\n") ?? "");
  const [maxTokensField, setMaxTokensField] = useState<"max_tokens" | "max_completion_tokens">(props.provider?.maxTokensField ?? "max_tokens");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const parsedModels = models.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [modelId, modelName] = line.split("|").map((part) => part.trim());
        if (!modelId) throw new Error("Each model line needs a model ID");
        return { id: modelId, name: modelName || modelId, tools: true };
      });
      if (!parsedModels.length) throw new Error("Add at least one model ID");
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Provider ID may use letters, digits, dots, underscores and dashes");
      await props.onSave({
        id,
        name: name || id,
        baseURL,
        models: parsedModels,
        maxTokensField,
        headerTimeoutMs: props.provider?.headerTimeoutMs ?? 300000,
        chunkTimeoutMs: props.provider?.chunkTimeoutMs ?? 180000,
        source: props.provider?.source ?? "manual",
      }, apiKey === "" ? undefined : apiKey);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setBusy(false);
    }
  };
  return (
    <Modal
      eyebrow="OPENAI-COMPATIBLE ENDPOINT"
      title={props.provider ? `Edit ${props.provider.name}` : "Add provider"}
      onClose={props.onClose}
      width="md"
      footer={<><button type="button" className="button ghost" onClick={props.onClose}>Cancel</button><button type="button" className="button primary" onClick={() => void save()} disabled={busy || !id || !baseURL || !models}>{busy ? <Spinner label="Saving" /> : <Save size={14} />} Save provider</button></>}
    >
      <div className="form-grid">
        <label className="field"><span>Display name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Modal Kimi" autoFocus /></label>
        <label className="field"><span>Provider ID</span><input value={id} onChange={(event) => setId(event.target.value)} placeholder="modal-kimi" disabled={Boolean(props.provider)} spellCheck={false} /></label>
        <label className="field field-wide"><span>Base URL</span><input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="http://127.0.0.1:20200/v1" spellCheck={false} /></label>
        <label className="field field-wide"><span>API key {props.provider?.hasApiKey ? "· leave blank to keep stored key" : ""}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={props.provider?.hasApiKey ? "Stored securely — enter only to replace" : "Endpoint key if required"} autoComplete="off" /></label>
        <label className="field field-wide"><span>Models · id | display name</span><textarea value={models} onChange={(event) => setModels(event.target.value)} rows={4} spellCheck={false} placeholder={"moonshotai/Kimi-K3.1-Pro | Kimi K3.1 Pro\nmoonshotai/Kimi-K3.1-Fast | Kimi Fast"} /></label>
        <label className="field"><span>Token field</span><select value={maxTokensField} onChange={(event) => setMaxTokensField(event.target.value as typeof maxTokensField)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <div className="field setting-readout"><span>Endpoint policy</span><strong>HTTPS or loopback HTTP</strong><small>Credentials use fixed redirect handling and never enter renderer state.</small></div>
      </div>
      <div className="form-note">Models are registered as tool-capable. Provider compatibility beyond the OpenAI chat-completions surface is not assumed.</div>
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
