import { ArrowUp, Brain, Hash, Radio, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BusAgentStatus, BusMessage, BusSnapshot } from "../../shared/contracts";
import { timeAgo } from "../utils";
import { Spinner } from "../components/ui";

export function BusView(props: {
  snapshot: BusSnapshot | null;
  sending: boolean;
  onSend: (input: { content: string; to?: string }) => Promise<void>;
  onSelectChannel: (channel: string) => void;
  onDeleteMemory: (key: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const snapshot = props.snapshot;

  useEffect(() => {
    const node = scroll.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot?.messages.length, snapshot?.activeChannel]);

  const roster = snapshot?.agents ?? [];
  const working = roster.filter((agent) => agent.state === "working" || agent.state === "queued");
  const memoryCount = snapshot?.memory.length ?? 0;
  const channelOptions = useMemo(() => {
    const base = snapshot?.channels.map((entry) => entry.channel) ?? ["general"];
    return [...new Set([...base, "general", "triggers"])];
  }, [snapshot?.channels]);

  const send = async () => {
    const content = draft.trim();
    if (!content || props.sending) return;
    setDraft("");
    await props.onSend({ content, ...(target ? { to: target } : {}) });
  };

  return (
    <div className="bus-view">
      <header className="bus-head">
        <div className="bus-title">
          <span className="eyebrow">AGENT BUS</span>
          <h1>Shared channel</h1>
        </div>
        <div className="bus-head-right">
          <span className={`bus-presence ${working.length ? "is-live" : ""}`}>
            <Radio size={12} /> {working.length ? `${working.length} on task` : "all idle"}
          </span>
          <button type="button" className={`ghost-button ${memoryOpen ? "is-on" : ""}`} onClick={() => setMemoryOpen((value) => !value)}>
            <Brain size={13} /> memory <span className="count">{memoryCount}</span>
          </button>
        </div>
      </header>

      <div className="bus-channels">
        {channelOptions.map((channel) => (
          <button
            key={channel}
            type="button"
            className={`channel-chip ${snapshot?.activeChannel === channel ? "is-active" : ""}`}
            onClick={() => props.onSelectChannel(channel)}
          >
            <Hash size={11} /> {channel}
          </button>
        ))}
      </div>

      <div className="agent-strip" data-scrollable>
        {roster.map((agent) => <AgentChip key={agent.id} agent={agent} />)}
        {!roster.length && <span className="bus-muted">No agents configured.</span>}
      </div>

      <div className={`bus-body ${memoryOpen ? "with-memory" : ""}`}>
        <div className="bus-transcript" ref={scroll} data-scrollable>
          {(snapshot?.messages ?? []).map((message) => <BusRow key={message.id} message={message} agents={roster} />)}
          {!snapshot?.messages.length && (
            <div className="bus-empty">
              <div className="bus-empty-mark">#</div>
              <p>Nothing on this channel yet.</p>
              <span>Send a task, or address an agent: <code>@ghost map the target</code></span>
            </div>
          )}
        </div>
        {memoryOpen && snapshot && (
          <aside className="memory-drawer">
            <div className="memory-head">
              <span><Brain size={12} /> shared memory</span>
              <button type="button" className="icon-button" onClick={() => setMemoryOpen(false)} aria-label="Close memory"><X size={13} /></button>
            </div>
            <div className="memory-list" data-scrollable>
              {snapshot.memory.map((entry) => (
                <div className="memory-row" key={entry.key}>
                  <div className="memory-key">{entry.key}</div>
                  <div className="memory-value">{entry.value}</div>
                  <div className="memory-meta">
                    <span>{entry.updatedBy} · {timeAgo(entry.updatedAt)}</span>
                    <button type="button" className="icon-button danger" onClick={() => void props.onDeleteMemory(entry.key)} aria-label={`Delete ${entry.key}`}><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
              {!snapshot.memory.length && <p className="bus-muted">Agents write durable facts here with <code>bus_memory_write</code>.</p>}
            </div>
            {snapshot.webhookUrl && (
              <div className="webhook-box">
                <span className="eyebrow">TRIGGER</span>
                <code>{snapshot.webhookUrl}</code>
                <small>POST {"{ text, agent?, channel? }"}. Loopback only, token-bound.</small>
              </div>
            )}
          </aside>
        )}
      </div>

      <footer className="bus-composer">
        <select className="bus-target" value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Route to agent">
          <option value="">broadcast</option>
          {roster.filter((agent) => agent.enabled).map((agent) => (
            <option key={agent.id} value={agent.id}>@{agent.id} · {agent.name}</option>
          ))}
        </select>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={target ? `Task the ${target} agent…` : "Message the bus, or @mention an agent…"}
          aria-label="Message the bus"
        />
        <button type="button" className="bus-send" onClick={() => void send()} disabled={!draft.trim() || props.sending} aria-label="Send to bus">
          {props.sending ? <Spinner label="Dispatching" /> : <ArrowUp size={15} />}
        </button>
      </footer>
    </div>
  );
}

function AgentChip({ agent }: { agent: BusAgentStatus }) {
  return (
    <div className={`agent-chip state-${agent.state}`} title={agent.detail ?? agent.role}>
      <span className="agent-dot" />
      <span className="agent-id">{agent.name}</span>
      <span className="agent-role">{agent.role}</span>
    </div>
  );
}

function BusRow({ message, agents }: { message: BusMessage; agents: BusAgentStatus[] }) {
  const agent = agents.find((entry) => entry.id === message.sender);
  const label = message.sender === "operator" ? "operator" : message.sender === "trigger" ? "trigger" : message.sender === "system" ? "system" : agent?.name ?? message.sender;
  const isAgent = Boolean(agent);
  return (
    <article className={`bus-row from-${message.sender === "operator" ? "operator" : message.sender === "system" ? "system" : message.sender === "trigger" ? "trigger" : "agent"}`}>
      <div className="bus-row-rail">
        <span className="bus-mono">{isAgent ? (agent?.name.slice(0, 2) ?? "AG") : message.sender === "operator" ? "OP" : message.sender === "trigger" ? "TR" : "--"}</span>
      </div>
      <div className="bus-row-body">
        <div className="bus-row-head">
          <strong>{label}</strong>
          {message.recipient && <span className="bus-arrow">→ {message.recipient}</span>}
          <span className={`bus-kind kind-${message.kind}`}>{message.kind}</span>
          <span className="bus-time">{message.createdAt ? timeAgo(message.createdAt) : "now"}</span>
        </div>
        {isAgent && message.kind === "result" ? (
          <div className="markdown bus-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
        ) : (
          <p className="bus-copy">{message.content}</p>
        )}
      </div>
    </article>
  );
}
