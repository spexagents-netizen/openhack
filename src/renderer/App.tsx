import {
  Box,
  FolderOpen,
  FolderTree,
  MessageSquareText,
  PanelRight,
  Plug,
  Radio,
  RefreshCw,
  Settings,
  SquarePen,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  BootstrapData,
  BusSnapshot,
  ChatMessage,
  McpServerConfig,
  McpServerStatus,
  PermissionMode,
  PersistedApproval,
  PluginStatus,
  ProviderConfig,
  PublicProviderConfig,
  SessionRecord,
  SessionSummary,
} from "../shared/contracts";
import { api, type AgentPush, type PushPayload } from "./api";
import { ActivityRail, type AppView } from "./components/ActivityRail";
import { ApprovalDialog, type ApprovalView } from "./components/ApprovalDialog";
import { ChatTimeline } from "./components/ChatTimeline";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { ModelPicker } from "./components/ModelPicker";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { Sidebar } from "./components/Sidebar";
import { SidePanel } from "./components/SidePanel";
import { TitleBar } from "./components/TitleBar";
import { Logo, Modal, Spinner } from "./components/ui";
import { optimisticUserMessage, applyAgentEvent } from "./session-events";
import { baseName, errorMessage } from "./utils";
import { BusView } from "./views/BusView";
import { ExtensionsView } from "./views/ExtensionsView";
import { SettingsView } from "./views/SettingsView";
import { WorkspaceView, type FilePreview, type TreeEntry } from "./views/WorkspaceView";

interface Toast { id: number; type: "ok" | "error" | "info"; text: string }

const STARTERS = [
  { key: "map", label: "map the surface", hint: "Architecture, entrypoints, trust boundaries.", prompt: "Map this workspace. Identify the architecture, entrypoints, trust boundaries and the three highest-value areas to investigate. Read before concluding." },
  { key: "flow", label: "trace a data flow", hint: "Follow input to impact, with evidence.", prompt: "Trace the most security-sensitive data flow in this workspace. Cite exact files and lines, then propose the strongest safe verification." },
  { key: "assume", label: "break an assumption", hint: "Find the weakest assumption and break it.", prompt: "Find the assumption this codebase is least able to defend. Prove it with a concrete failure, then propose the smallest fix." },
] as const;

export function App() {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [providers, setProviders] = useState<PublicProviderConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [view, setView] = useState<AppView>("chat");
  const [runs, setRuns] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [bus, setBus] = useState<BusSnapshot | null>(null);
  const [busChannel, setBusChannel] = useState("general");
  const [busSending, setBusSending] = useState(false);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [workspaceEntries, setWorkspaceEntries] = useState<TreeEntry[]>([]);
  const [workspaceFile, setWorkspaceFile] = useState<FilePreview | undefined>();
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [interrupted, setInterrupted] = useState<PersistedApproval[]>([]);
  const [bootError, setBootError] = useState("");
  const activeIdRef = useRef<string | undefined>(undefined);
  activeIdRef.current = activeSession?.id;
  const busChannelRef = useRef(busChannel);
  busChannelRef.current = busChannel;

  const pushToast = useCallback((text: string, type: Toast["type"] = "info") => {
    const toast = { id: Date.now() + Math.random(), type, text };
    // One message at a time: a stack of toasts covers the composer and the
    // settings cards. The newest message replaces the previous one.
    setToasts([toast]);
    window.setTimeout(() => setToasts((current) => current.filter((candidate) => candidate.id !== toast.id)), 4200);
  }, []);

  const refreshSessions = useCallback(async () => {
    setSessions(await api.listSessions());
  }, []);

  const refreshBus = useCallback(async (channel = busChannelRef.current) => {
    try {
      setBus(await api.busSnapshot(channel));
    } catch {
      // The bus is optional UI state; a failed refresh must not surface as a run error.
    }
  }, []);

  const loadWorkspace = useCallback(async (root?: string) => {
    if (!root) { setWorkspaceEntries([]); return; }
    setWorkspaceLoading(true);
    try {
      setWorkspaceEntries((await api.workspaceTree(".", 4)).entries);
    } catch (loadError) {
      pushToast(errorMessage(loadError), "error");
    } finally {
      setWorkspaceLoading(false);
    }
  }, [pushToast]);

  const loadSession = useCallback(async (id: string) => {
    const session = await api.getSession(id);
    setActiveSession(session);
    setView("chat");
    setUnread((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    localStorage.setItem("openhack.activeSession", id);
    void api.pendingApprovals(id).then(setInterrupted).catch(() => setInterrupted([]));
    return session;
  }, []);

  useEffect(() => {
    let alive = true;
    api.bootstrap().then(async (data) => {
      if (!alive) return;
      setBoot(data);
      setProviders(data.providers);
      setSettings(data.settings);
      setSessions(data.sessions);
      setMcpServers(data.mcpServers);
      setPlugins(data.plugins);
      const stored = localStorage.getItem("openhack.activeSession");
      const target = data.sessions.find((session) => session.id === stored) ?? data.sessions[0];
      if (target && alive) await loadSession(target.id);
      void refreshBus();
    }).catch((loadError) => {
      if (alive) setBootError(errorMessage(loadError));
    });
    return () => { alive = false; };
  }, [loadSession, refreshBus]);

  useEffect(() => {
    const unsubscribe = api.onPush((payload: PushPayload) => {
      if (payload.kind === "bus.message" || payload.kind === "bus.changed") {
        void refreshBus();
        return;
      }
      if (payload.kind === "browser.state") return;
      if (payload.kind === "approval.requested") {
        const request = payload.request;
        setApproval({
          approvalId: request.id,
          runId: request.runId,
          callId: request.callId,
          name: request.name,
          argumentsJson: request.argumentsJson,
          risk: request.risk,
          ...(request.digest ? { digest: request.digest } : {}),
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
          ...(request.agentName ? { agentName: request.agentName } : {}),
        });
        return;
      }
      if (payload.kind === "integrations.changed") {
        void api.listMcp().then(setMcpServers).catch(() => undefined);
        void api.listPlugins().then(setPlugins).catch(() => undefined);
        return;
      }
      if (payload.kind === "run.finished") {
        setRuns((current) => {
          const next = { ...current };
          const matching = Object.entries(next).find(([, runId]) => runId === payload.runId);
          if (matching) delete next[matching[0]];
          return next;
        });
        if (payload.sessionId !== activeIdRef.current) {
          setUnread((current) => new Set(current).add(payload.sessionId));
        } else {
          void api.pendingApprovals(payload.sessionId).then(setInterrupted).catch(() => undefined);
        }
        void refreshSessions();
        if (payload.sessionId === activeIdRef.current) {
          void api.getSession(payload.sessionId).then((session) => {
            if (activeIdRef.current === payload.sessionId) setActiveSession(session);
          }).catch(() => undefined);
        }
        return;
      }
      const agentPush = payload as AgentPush;
      const { sessionId, runId, event } = agentPush;
      if (event.type === "run.started") {
        setRuns((current) => current[sessionId] ? current : { ...current, [sessionId]: runId });
      }
      if (event.type === "tool.approval") {
        setApproval({
          approvalId: event.approvalId,
          runId,
          callId: event.callId,
          name: event.name,
          argumentsJson: event.argumentsJson,
          risk: event.risk,
        });
      }
      if (sessionId === activeIdRef.current) {
        if (event.type === "run.failed") setError(event.error);
        if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "run.completed") {
          setReviewRevision((value) => value + 1);
        }
        setActiveSession((current) => current ? applyAgentEvent(current, event) : current);
      } else if (event.type === "run.failed") {
        pushToast(`Background run failed: ${event.error}`, "error");
      }
      if (event.type === "run.completed" || event.type === "run.failed") {
        setRuns((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
    });
    return unsubscribe;
  }, [pushToast, refreshBus, refreshSessions]);

  useEffect(() => {
    if (view === "bus") void refreshBus();
    if ((view === "workspace" || (view === "chat" && panelOpen)) && settings?.lastWorkspace) void loadWorkspace(settings.lastWorkspace);
  }, [view, panelOpen, refreshBus, loadWorkspace, settings?.lastWorkspace]);

  const handleOpenWorkspace = useCallback(async (): Promise<string | null> => {
    try {
      const root = await api.openWorkspace();
      if (!root) return null;
      setSettings((current) => current ? { ...current, lastWorkspace: root } : current);
      await loadWorkspace(root);
      pushToast(`Workspace authorized · ${root}`, "ok");
      return root;
    } catch (openError) {
      pushToast(errorMessage(openError), "error");
      return null;
    }
  }, [loadWorkspace, pushToast]);

  const createSession = useCallback(async (workspacePath?: string): Promise<SessionRecord | null> => {
    try {
      if (!providers.length) {
        setView("settings");
        pushToast("Configure a provider before starting a session.", "error");
        return null;
      }
      const session = await api.createSession(workspacePath);
      setActiveSession(session);
      activeIdRef.current = session.id;
      setView("chat");
      localStorage.setItem("openhack.activeSession", session.id);
      await refreshSessions();
      return session;
    } catch (createError) {
      setError(errorMessage(createError));
      return null;
    }
  }, [providers.length, pushToast, refreshSessions]);

  const handleNewSession = useCallback(() => setNewSessionOpen(true), []);

  const handleNewSessionRef = useRef(handleNewSession);
  handleNewSessionRef.current = handleNewSession;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setNewSessionOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sendPrompt = useCallback(async (override?: string) => {
    const text = (override ?? drafts[activeSession?.id ?? "new"] ?? "").trim();
    if (!text) return;
    let session = activeSession;
    if (!session) {
      session = await createSession();
      if (!session) return;
    }
    if (runs[session.id]) return;
    setError("");
    const optimistic = optimisticUserMessage(text);
    const nextTitle = session.title === "New investigation" ? text.replace(/\s+/g, " ").trim().slice(0, 72) : session.title;
    setActiveSession({ ...session, title: nextTitle, messages: [...session.messages, optimistic], updatedAt: new Date().toISOString() });
    setDrafts((current) => ({ ...current, [session.id]: "" }));
    try {
      const { runId } = await api.startRun({
        sessionId: session.id,
        input: text,
        providerId: session.providerId,
        model: session.model,
      });
      setRuns((current) => ({ ...current, [session.id]: runId }));
      setTimeout(() => void refreshSessions(), 120);
    } catch (runError) {
      setError(errorMessage(runError));
      setActiveSession(session);
      setDrafts((current) => ({ ...current, [session.id]: text }));
    }
  }, [activeSession, createSession, drafts, refreshSessions, runs]);

  const resolveInterrupted = useCallback(async (id: string, approved: boolean) => {
    try {
      const result = await api.resolveApproval(id, approved);
      if (activeSession) {
        if (result.runId) setRuns((current) => ({ ...current, [activeSession.id]: result.runId! }));
        setInterrupted(await api.pendingApprovals(activeSession.id));
      }
      pushToast(approved ? "Approved and resumed." : "Denied and resumed.", approved ? "ok" : "info");
    } catch (error) {
      pushToast(errorMessage(error), "error");
    }
  }, [activeSession, pushToast]);

  const changeMode = useCallback(async (mode: "plan" | "act") => {
    if (!activeSession) return;
    setActiveSession({ ...activeSession, mode });
    try {
      const updated = await api.setSessionMode(activeSession.id, mode);
      setActiveSession(updated);
      pushToast(mode === "plan" ? "Plan mode: read-only." : "Act mode: tools enabled.", "info");
    } catch (modeError) {
      pushToast(errorMessage(modeError), "error");
    }
  }, [activeSession, pushToast]);

  const changeModel = useCallback((providerId: string, model: string) => {
    setActiveSession((current) => current ? { ...current, providerId, model } : current);
    setSettings((current) => current ? { ...current, activeProviderId: providerId, activeModel: model } : current);
    void api.updateSettings({ activeProviderId: providerId, activeModel: model }).catch((modelError) => pushToast(errorMessage(modelError), "error"));
  }, [pushToast]);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await api.updateSettings(patch);
    setSettings(next);
    pushToast("Configuration saved.", "ok");
  }, [pushToast]);

  const importProviders = useCallback(async () => {
    try {
      const result = await api.importProviders();
      const data = await api.bootstrap();
      setProviders(data.providers);
      setSettings(data.settings);
      pushToast(`Imported ${result.imported} provider${result.imported === 1 ? "" : "s"} from OpenCode.`, "ok");
    } catch (importError) {
      pushToast(errorMessage(importError), "error");
    }
  }, [pushToast]);

  const saveProvider = useCallback(async (provider: ProviderConfig, apiKey?: string) => {
    const updated = await api.saveProvider(provider, apiKey);
    setProviders(updated);
    const data = await api.bootstrap();
    setSettings(data.settings);
    if (!data.settings.activeProviderId) {
      await api.updateSettings({ activeProviderId: provider.id, activeModel: provider.models[0]?.id });
      setSettings((await api.bootstrap()).settings);
    }
    pushToast(`${provider.name} saved.`, "ok");
  }, [pushToast]);

  const decideApproval = useCallback(async (approved: boolean) => {
    if (!approval) return;
    const current = approval;
    setApproval(null);
    try {
      await api.decideApproval(current.approvalId, approved);
      pushToast(approved ? "Approved for this call." : "Denied.", approved ? "ok" : "info");
    } catch (decisionError) {
      pushToast(errorMessage(decisionError), "error");
    }
  }, [approval, pushToast]);

  const saveMcp = useCallback(async (server: McpServerConfig) => {
    const result = await api.saveMcp(server);
    setMcpServers(await api.listMcp());
    pushToast(result?.state === "ready" ? `${server.name} connected · ${result.tools.length} tools.` : `${server.name} saved.`, result?.state === "failed" ? "error" : "ok");
  }, [pushToast]);
  const installStack = useCallback(async () => {
    try {
      const result = await api.installStack();
      setMcpServers(await api.listMcp());
      const parts = [
        result.added.length ? `${result.added.length} added` : "",
        result.blocked.length ? `${result.blocked.length} need a prerequisite` : "",
        result.manual.length ? `${result.manual.length} need a manual install` : "",
      ].filter(Boolean).join(" ? ");
      pushToast(parts ? `Stack: ${parts}` : "Stack already installed.", result.added.length ? "ok" : "info");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const importMcp = useCallback(async () => {
    try {
      const result = await api.importOpenCodeMcp();
      setMcpServers(await api.listMcp());
      const skipped = result.skipped.length ? ` ? skipped ${result.skipped.join(", ")}` : "";
      pushToast(`Imported ${result.added.length} MCP server${result.added.length === 1 ? "" : "s"} from OpenCode${skipped}`, result.added.length ? "ok" : "info");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const connectMcp = useCallback(async (id: string) => {
    try {
      const result = await api.connectMcp(id);
      setMcpServers(await api.listMcp());
      if (result.state === "ready") pushToast(`${result.name} connected · ${result.tools.length} tools.`, "ok");
      else pushToast(result.error ?? "MCP connection failed.", "error");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const disconnectMcp = useCallback(async (id: string) => {
    try {
      setMcpServers(await api.disconnectMcp(id));
      pushToast("MCP server disconnected.", "info");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const removeMcp = useCallback(async (id: string) => {
    try {
      setMcpServers(await api.removeMcp(id));
      pushToast("MCP server removed.", "info");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const importPlugin = useCallback(async () => {
    try {
      setPlugins(await api.importPlugin());
      pushToast("Plugin imported.", "ok");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);
  const togglePlugin = useCallback(async (id: string, enabled: boolean) => {
    try { setPlugins(await api.togglePlugin(id, enabled)); }
    catch (errorValue) { pushToast(errorMessage(errorValue), "error"); }
  }, [pushToast]);
  const openPluginFolder = useCallback(async () => {
    try { await api.openPluginFolder(); }
    catch (errorValue) { pushToast(errorMessage(errorValue), "error"); }
  }, [pushToast]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteSession(deleteTarget.id);
      setDeleteTarget(null);
      await refreshSessions();
      if (activeSession?.id === deleteTarget.id) {
        setActiveSession(null);
        localStorage.removeItem("openhack.activeSession");
      }
      pushToast("Session deleted.", "info");
    } catch (deleteError) {
      pushToast(errorMessage(deleteError), "error");
    }
  }, [activeSession?.id, deleteTarget, pushToast, refreshSessions]);

  const readWorkspaceFile = useCallback(async (filePath: string) => {
    try {
      setWorkspaceFile(await api.workspaceRead(filePath));
    } catch (readError) {
      pushToast(errorMessage(readError), "error");
    }
  }, [pushToast]);

  const commentToAgent = useCallback((prompt: string) => {
    setDrafts((current) => ({ ...current, [activeSession?.id ?? "new"]: prompt }));
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Message the agent"]')?.focus(), 0);
  }, [activeSession?.id]);

  const sendBus = useCallback(async (input: { content: string; to?: string }) => {
    setBusSending(true);
    try {
      const result = await api.busSend({ ...input, channel: busChannelRef.current });
      await refreshBus();
      if (result.dispatchedTo) pushToast(`Dispatched to ${result.dispatchedTo}.`, "ok");
    } catch (busError) {
      pushToast(errorMessage(busError), "error");
    } finally {
      setBusSending(false);
    }
  }, [pushToast, refreshBus]);

  const openBusChannel = useCallback((channel: string) => {
    setBusChannel(channel);
    busChannelRef.current = channel;
    void refreshBus(channel);
  }, [refreshBus]);

  const deleteBusMemory = useCallback(async (key: string) => {
    try {
      setBus(await api.deleteBusMemory(key));
      pushToast(`Memory key ${key} deleted.`, "info");
    } catch (errorValue) {
      pushToast(errorMessage(errorValue), "error");
    }
  }, [pushToast]);

  const providerForSession = providers.find((provider) => provider.id === (activeSession?.providerId ?? settings?.activeProviderId)) ?? providers[0];
  const activeModel = activeSession?.model ?? settings?.activeModel ?? providerForSession?.models[0]?.id;
  const isRunning = Boolean(activeSession && runs[activeSession.id]);
  const anyRunning = Object.keys(runs).length > 0;
  const currentDraft = drafts[activeSession?.id ?? "new"] ?? "";

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: "New session", detail: "Clean context", icon: <SquarePen size={15} />, run: () => setNewSessionOpen(true) },
    { id: "bus", label: "Agent bus", detail: "Shared channel with every agent", icon: <Radio size={15} />, run: () => setView("bus") },
    { id: "workspace", label: "Authorize workspace", detail: settings?.lastWorkspace ?? "Choose a directory", icon: <FolderOpen size={15} />, run: () => void handleOpenWorkspace() },
    { id: "files", label: "Browse workspace", detail: "Files and previews", icon: <FolderTree size={15} />, run: () => setView("workspace") },
    { id: "extensions", label: "Extensions", detail: "MCP servers and plugins", icon: <Plug size={15} />, run: () => setView("extensions") },
    { id: "settings", label: "Settings", detail: "Providers, permissions, bus", icon: <Settings size={15} />, run: () => setView("settings") },
    { id: "import", label: "Import OpenCode providers", detail: "Read modal-kimi and modal-ep", icon: <RefreshCw size={15} />, run: () => void importProviders() },
    ...plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.commands ?? []).map((command): PaletteAction => ({
      id: `plugin-${plugin.id}-${command.name}`,
      label: `/${command.name} · ${plugin.name}`,
      detail: command.description || "Plugin prompt",
      icon: <Box size={15} />,
      run: () => {
        setView("chat");
        setDrafts((current) => ({ ...current, [activeSession?.id ?? "new"]: command.prompt }));
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Message the agent"]')?.focus(), 0);
      },
    }))),
    ...sessions.slice(0, 8).map((session): PaletteAction => ({
      id: `session-${session.id}`,
      label: session.title,
      detail: session.workspacePath,
      icon: <MessageSquareText size={15} />,
      run: () => void loadSession(session.id),
    })),
  ], [handleOpenWorkspace, importProviders, loadSession, plugins, sessions, settings?.lastWorkspace, activeSession?.id]);

  if (!boot && !bootError) return <StartupScreen />;
  if (bootError || !boot || !settings) {
    return (
      <div className="fatal-screen">
        <Logo size={40} />
        <div className="eyebrow">STARTUP FAILURE</div>
        <h1>OpenHack could not initialize.</h1>
        <p>{bootError || "The local configuration did not load."}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>Retry startup</button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar
        running={anyRunning}
        workspace={settings.lastWorkspace}
        onOpenWorkspace={() => void handleOpenWorkspace()}
        onPalette={() => setPaletteOpen(true)}
        onSettings={() => setView("settings")}
        providerName={providerForSession?.name}
      />
      <div className="app-body">
        <ActivityRail view={view} onChange={setView} busActive={Boolean(bus?.agents.some((agent) => agent.state === "working"))} />
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSession?.id}
          workspace={settings.lastWorkspace}
          unread={unread}
          onSelect={(id) => void loadSession(id)}
          onNew={() => setNewSessionOpen(true)}
          onDelete={setDeleteTarget}
        />
        <main className="main-pane" data-running={isRunning ? "true" : "false"}>
          {view === "chat" && (
            <ChatPane
              session={activeSession}
              workspace={activeSession?.workspacePath ?? settings.lastWorkspace}
              provider={providerForSession}
              providers={providers}
              model={activeModel}
              mode={activeSession?.mode ?? "act"}
              onModeChange={(mode) => void changeMode(mode)}
              running={isRunning}
              draft={currentDraft}
              error={error}
              permission={settings.permission}
              interrupted={interrupted}
              onResolveInterrupted={(id, approved) => void resolveInterrupted(id, approved)}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((value) => !value)}
              onDraft={(value) => setDrafts((current) => ({ ...current, [activeSession?.id ?? "new"]: value }))}
              onSend={() => void sendPrompt()}
              onStop={() => {
                const runId = activeSession ? runs[activeSession.id] : undefined;
                if (runId) void api.cancelRun(runId).catch((cancelError) => pushToast(errorMessage(cancelError), "error"));
              }}
              onModelChange={changeModel}
              onOpenWorkspace={() => void handleOpenWorkspace()}
              onOpenSettings={() => setView("settings")}
              onPrompt={(prompt) => void sendPrompt(prompt)}
              onNewSession={() => setNewSessionOpen(true)}
              onDismissError={() => setError("")}
            />
          )}
          {view === "bus" && (
            <BusView
              snapshot={bus}
              sending={busSending}
              onSend={sendBus}
              onSelectChannel={openBusChannel}
              onDeleteMemory={deleteBusMemory}
            />
          )}
          {view === "workspace" && (
            <WorkspaceView
              root={settings.lastWorkspace}
              entries={workspaceEntries}
              file={workspaceFile}
              loading={workspaceLoading}
              onOpenWorkspace={() => void handleOpenWorkspace()}
              onRead={(filePath) => void readWorkspaceFile(filePath)}
              onCloseFile={() => setWorkspaceFile(undefined)}
            />
          )}
          {view === "extensions" && (
            <ExtensionsView
              servers={mcpServers}
              plugins={plugins}
              onSaveServer={saveMcp}
              onConnect={connectMcp}
              onDisconnect={disconnectMcp}
              onRemove={removeMcp}
              onInstallStack={() => void installStack()}
              onImportMcp={() => void importMcp()}
              onImportPlugin={importPlugin}
              onTogglePlugin={togglePlugin}
              onOpenPluginFolder={openPluginFolder}
            />
          )}
          {view === "settings" && (
            <SettingsView
              providers={providers}
              settings={settings}
              busAgents={bus?.agents ?? []}
              dataDir={boot.app.dataDir}
              onSaveSettings={saveSettings}
              onSaveSearchKey={async (provider, apiKey) => {
                try {
                  setSettings(await api.setSearchKey(provider, apiKey));
                  pushToast(apiKey ? "Search key stored." : "Search key cleared.", "ok");
                } catch (keyError) {
                  pushToast(errorMessage(keyError), "error");
                  throw keyError;
                }
              }}
              onImportProviders={importProviders}
              onSaveProvider={saveProvider}
              onTestProvider={api.testProvider}
              onOpenDataDir={async () => { await api.openDataDir(); }}
              onLoadAudit={() => api.auditTail(40)}
              onSaveBusAgents={async (agents) => { setBus(await api.saveBusAgents(agents)); }}
            />
          )}
        </main>
        {view === "chat" && panelOpen && (
          <SidePanel
            sessionId={activeSession?.id}
            root={settings.lastWorkspace}
            entries={workspaceEntries}
            file={workspaceFile}
            loading={workspaceLoading}
            revision={reviewRevision}
            onRead={(filePath) => void readWorkspaceFile(filePath)}
            onCloseFile={() => setWorkspaceFile(undefined)}
            onCollapse={() => setPanelOpen(false)}
            onComment={commentToAgent}
          />
        )}
      </div>
      {newSessionOpen && (
        <NewSessionDialog
          current={settings.lastWorkspace}
          recent={settings.recentWorkspaces ?? []}
          onChoose={async () => {
            const root = await api.openWorkspace();
            if (root) {
              setSettings((current) => current ? {
                ...current,
                lastWorkspace: root,
                recentWorkspaces: [root, ...(current.recentWorkspaces ?? []).filter((entry) => entry !== root)].slice(0, 8),
              } : current);
            }
            return root;
          }}
          onStart={(workspacePath) => { setNewSessionOpen(false); void createSession(workspacePath); }}
          onClose={() => setNewSessionOpen(false)}
        />
      )}
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
      {approval && <ApprovalDialog approval={approval} onDecide={(approved) => void decideApproval(approved)} />}
      {deleteTarget && (
        <Modal
          eyebrow="DELETE SESSION"
          title={`Delete “${deleteTarget.title}”?`}
          onClose={() => setDeleteTarget(null)}
          width="sm"
          footer={<><button type="button" className="button ghost" onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="button danger" onClick={() => void confirmDelete()}>Delete permanently</button></>}
        >
          <p className="modal-copy">This removes the session and every message from the local database. It cannot be undone.</p>
        </Modal>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.type}`}>{toast.text}</div>)}
      </div>
    </div>
  );
}

function ChatPane(props: {
  session: SessionRecord | null;
  workspace?: string;
  provider?: PublicProviderConfig;
  providers: PublicProviderConfig[];
  model?: string;
  mode: "plan" | "act";
  onModeChange: (mode: "plan" | "act") => void;
  running: boolean;
  draft: string;
  error: string;
  permission: PermissionMode;
  interrupted: PersistedApproval[];
  onResolveInterrupted: (id: string, approved: boolean) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onModelChange: (providerId: string, model: string) => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onPrompt: (prompt: string) => void;
  onNewSession: () => void;
  onDismissError: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const workers = new Set((props.session?.messages ?? []).filter((message) => message.agentName).map((message) => message.agentName!));
  const contextChars = (props.session?.messages ?? []).reduce((total, message) => total + message.content.length + (message.reasoning?.length ?? 0) + (message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0), 0);
  const contextTokens = Math.round(contextChars / 4);
  const contextLimit = props.provider?.models.find((model) => model.id === props.model)?.context;
  useLayoutEffect(() => {
    if (!follow.current) return;
    const node = scroll.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [props.session?.messages, props.running]);
  useEffect(() => { follow.current = true; }, [props.session?.id]);

  return (
    <>
      <div className="chat-head">
        <div className="chat-head-copy">
          <h2>{props.session?.title ?? "New session"}</h2>
          <span className="chat-head-meta">
            {props.workspace ? baseName(props.workspace) : "no workspace"}
            {workers.size > 0 ? ` · ${workers.size} worker${workers.size === 1 ? "" : "s"}` : ""}
            {contextTokens > 0 ? ` · ~${contextTokens >= 1000 ? `${Math.round(contextTokens / 1000)}k` : contextTokens} ctx${contextLimit ? ` / ${Math.round(contextLimit / 1000)}k` : ""}` : ""}
          </span>
        </div>
        <div className="chat-head-actions">
          <div className="mode-switch" role="group" aria-label="Agent mode">
            <button type="button" className={props.mode === "plan" ? "is-active" : ""} aria-pressed={props.mode === "plan"} onClick={() => props.onModeChange("plan")}>Plan</button>
            <button type="button" className={props.mode === "act" ? "is-active" : ""} aria-pressed={props.mode === "act"} onClick={() => props.onModeChange("act")}>Act</button>
          </div>
          <ModelPicker providers={props.providers} providerId={props.provider?.id} model={props.model} onChange={props.onModelChange} />
          <button type="button" className={`icon-button ${props.panelOpen ? "is-active" : ""}`} onClick={props.onTogglePanel} aria-label="Toggle review panel" title="Review panel">
            <PanelRight size={16} />
          </button>
        </div>
      </div>
      {props.interrupted.length > 0 && (
        <div className="approval-banner">
          <div className="approval-banner-head">
            <strong>{props.interrupted.length} approval{props.interrupted.length === 1 ? "" : "s"} interrupted by restart</strong>
            <span>The run stopped before this action was decided.</span>
          </div>
          {props.interrupted.map((entry) => (
            <div className="approval-banner-row" key={entry.id}>
              <code>{entry.tool}</code>
              <span className="approval-banner-args" title={entry.argumentsJson}>{entry.argumentsJson.slice(0, 120)}</span>
              <button type="button" className="button small ghost" onClick={() => props.onResolveInterrupted(entry.id, false)}>Deny</button>
              <button type="button" className="button small primary" onClick={() => props.onResolveInterrupted(entry.id, true)}>Allow once</button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`chat-scroll ${!props.session || !props.session.messages.length ? "is-empty" : ""}`}
        ref={scroll}
        data-scrollable
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 140;
        }}
      >
        {!props.session || !props.session.messages.length ? (
          <EmptyChat
            workspace={props.workspace}
            providerName={props.provider?.name}
            modelName={props.provider?.models.find((model) => model.id === props.model)?.name}
            onOpenWorkspace={props.onOpenWorkspace}
            onOpenSettings={props.onOpenSettings}
            onPrompt={props.onPrompt}
            onNewSession={props.onNewSession}
          />
        ) : (
          <ChatTimeline messages={props.session.messages} running={props.running} activeSession />
        )}
      </div>
      {props.error && (
        <div className="run-error" role="alert">
          <span>{props.error}</span>
          <button type="button" className="button small ghost" onClick={props.onDismissError}>Dismiss</button>
        </div>
      )}
      <Composer
        value={props.draft}
        onChange={props.onDraft}
        onSend={props.onSend}
        onStop={props.onStop}
        running={props.running}
        disabled={!props.providers.length}
        permission={props.permission}
        onOpenSettings={props.onOpenSettings}
      />
    </>
  );
}

function EmptyChat(props: {
  workspace?: string;
  providerName?: string;
  modelName?: string;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onPrompt: (prompt: string) => void;
  onNewSession: () => void;
}) {
  const ready = Boolean(props.workspace && props.providerName);
  return (
    <section className="chat-empty">
      <div className="empty-glow" aria-hidden="true" />
      <div className="empty-kicker"><span />OPERATOR CHANNEL / LOCAL RUNTIME</div>
      <h1>Break something.</h1>
      <p className="empty-copy">
        One agent, full control of this machine. It reads, writes, runs and shows the proof — then
        splits into a parallel army when the job does.
      </p>
      {!ready && (
        <div className="setup-inline">
          <button type="button" className={props.workspace ? "setup-ready" : "setup-action"} onClick={props.onOpenWorkspace}>
            <span>01</span>{props.workspace ?? "Authorize a workspace"}
          </button>
          <button type="button" className={props.providerName ? "setup-ready" : "setup-action"} onClick={props.onOpenSettings}>
            <span>02</span>{props.modelName ?? props.providerName ?? "Connect a provider"}
          </button>
        </div>
      )}
      <div className="starter-list">
        {STARTERS.map((starter) => (
          <button type="button" key={starter.key} className="starter-row" onClick={() => props.onPrompt(starter.prompt)}>
            <span className="starter-caret">›</span>
            <span className="starter-label">{starter.label}</span>
            <span className="starter-hint">{starter.hint}</span>
            <span className="starter-go">run</span>
          </button>
        ))}
      </div>
      <div className="empty-footnote">Tools run locally. Writes and commands follow the active permission profile.</div>
    </section>
  );
}

function StartupScreen() {
  return (
    <div className="startup-screen">
      <Logo size={44} />
      <div className="startup-word">OPENHACK</div>
      <Spinner label="Starting OpenHack" />
      <span className="startup-note">LOCKING THE BENCH</span>
    </div>
  );
}
