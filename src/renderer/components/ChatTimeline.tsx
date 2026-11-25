import { Check, ChevronRight, Copy, FileCode2, FolderTree, PencilLine, Search, Terminal, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ProviderToolCall } from "../../shared/contracts";
import { api } from "../api";
import { prettyJson, toolArgumentSummary, toolResultFor } from "../utils";
import { Spinner } from "./ui";

export function ChatTimeline({ messages, running, activeSession }: { messages: ChatMessage[]; running: boolean; activeSession: boolean }) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return (
    <div className="timeline">
      {messages.map((message) => {
        if (message.role === "tool") return null;
        if (message.role === "assistant") {
          const streaming = activeSession && running && message.id === lastAssistant?.id;
          if (!message.content && !message.reasoning && !message.tool_calls?.length && !streaming) return null;
          return <AssistantMessage key={message.id} message={message} messages={messages} streaming={streaming} />;
        }
        if (message.role === "user") return <UserMessage key={message.id} message={message} />;
        return null;
      })}
      {running && activeSession && lastAssistant?.role !== "assistant" && (
        <div className="working-row"><Spinner label="Agent working" /> working</div>
      )}
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <article className="message message-user">
      <div className="message-tag">You</div>
      <div className="message-content"><p className="user-copy">{message.content}</p></div>
    </article>
  );
}

function AssistantMessage({ message, messages, streaming }: { message: ChatMessage; messages: ChatMessage[]; streaming: boolean }) {
  const worker = Boolean(message.agentName);
  return (
    <article className={`message ${worker ? "message-worker" : "message-assistant"}`}>
      {worker && <div className="message-tag agent">{message.agentName!.slice(0, 2)}</div>}
      <div className="message-content">
        {worker && (
          <div className="worker-head">
            <span className="worker-name">{message.agentName}</span>
            {message.agentRole && <span className="worker-role">{message.agentRole}</span>}
            <span className={`worker-state ${streaming ? "is-live" : ""}`}>{streaming ? "working" : "reported"}</span>
          </div>
        )}
        {message.reasoning && (
          <details className="reasoning">
            <summary><ChevronRight size={12} /> reasoning</summary>
            <div>{message.reasoning}</div>
          </details>
        )}
        {message.content ? (
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} onClick={(event) => { event.preventDefault(); if (href) void api.openExternal(href); }}>{children}</a>
                ),
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {message.content}
            </ReactMarkdown>
            {streaming && <span className="stream-caret" aria-hidden="true" />}
          </div>
        ) : streaming ? (
          <div className="working-row"><Spinner label="Agent reasoning" /> thinking</div>
        ) : null}
        {message.tool_calls?.length ? (
          <ToolGroup
            calls={message.tool_calls}
            results={message.tool_calls.map((call) => toolResultFor(messages, call.id))}
          />
        ) : null}
      </div>
    </article>
  );
}

function ToolGroup({ calls, results }: { calls: ProviderToolCall[]; results: Array<ChatMessage | undefined> }) {
  const statuses = calls.map((call, index) => {
    const result = results[index];
    if (!result) return "run" as const;
    return resultLooksFailed(result.content) ? "failed" as const : "ok" as const;
  });
  const failed = statuses.filter((status) => status === "failed").length;
  const running = statuses.filter((status) => status === "run").length;
  const ok = statuses.filter((status) => status === "ok").length;
  const [open, setOpen] = useState(failed > 0 || calls.length === 1);
  // A single call needs no roll-up header: the row already carries its status.
  if (calls.length === 1) {
    return (
      <div className="tool-single">
        <ToolRow call={calls[0]!} result={results[0]} />
      </div>
    );
  }
  return (
    <div className="tool-group">
      <button type="button" className="tool-group-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-group-icon"><Wrench size={13} /></span>
        <span className="tool-group-title">
          <strong>{calls.length}</strong> tool {calls.length === 1 ? "call" : "calls"}
        </span>
        <span className="tool-group-status">
          {running > 0 && <><Spinner label="Tools running" /> {running} running</>}
          {ok > 0 && <span className="ok">{ok} ok</span>}
          {failed > 0 && <span className="failed">{failed} failed</span>}
        </span>
        <ChevronRight size={13} className={`tool-chevron ${open ? "is-open" : ""}`} />
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((call, index) => <ToolRow key={call.id} call={call} result={results[index]} />)}
        </div>
      )}
    </div>
  );
}

function shotFrom(result?: ChatMessage): string {
  if (!result) return "";
  try {
    const value = JSON.parse(result.content) as { image?: unknown };
    return typeof value.image === "string" && value.image.startsWith("data:image/") ? value.image : "";
  } catch {
    return "";
  }
}

function ToolRow({ call, result }: { call: ProviderToolCall; result?: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const shot = shotFrom(result);
  const failed = result ? resultLooksFailed(result.content) : false;
  const status = result ? (failed ? "failed" : "ok") : "run";
  const summary = toolArgumentSummary(call.function.name, call.function.arguments);
  const output = result ? formatToolOutput(result.content) : "";
  return (
    <div className={`tool-row tool-${status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon">{iconFor(call.function.name)}</span>
        <span className="tool-name">{call.function.name.replace(/[._]/g, " ")}</span>
        <code className="tool-summary">{summary}</code>
        <span className={`tool-status status-${status}`}>{status === "run" ? <Spinner label="Tool running" /> : status}</span>
        <ChevronRight size={13} className={`tool-chevron ${open ? "is-open" : ""}`} />
      </button>
      {shot && <img className="tool-shot" src={shot} alt="screenshot" />}
      {open && (
        <div className="tool-detail">
          <pre>{prettyJson(call.function.arguments)}</pre>
          {result && <pre className="tool-output">{output}</pre>}
        </div>
      )}
    </div>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const props = (child as { props?: { className?: string; children?: ReactNode } } | undefined)?.props;
  const language = /language-([\w+-]+)/.exec(props?.className ?? "")?.[1] ?? "text";
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = textOf(props?.children ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be denied; the code stays selectable.
    }
  };
  return (
    <div className={`code-block ${wrap ? "is-wrap" : ""}`}>
      <div className="code-head">
        <span className="code-lang">{language}</span>
        <button type="button" className="code-action" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "copied" : "copy"}
        </button>
        <button type="button" className="code-action" onClick={() => setWrap((value) => !value)} aria-pressed={wrap}>
          {wrap ? "no wrap" : "wrap"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function iconFor(name: string): ReactNode {
  if (/process|terminal|shell|exec|run/.test(name)) return <Terminal size={12} />;
  if (/search|grep|find/.test(name)) return <Search size={12} />;
  if (/list|tree|folder/.test(name)) return <FolderTree size={12} />;
  if (/write|replace|patch|edit/.test(name)) return <PencilLine size={12} />;
  if (/read|file|web|fetch/.test(name)) return <FileCode2 size={12} />;
  return <Wrench size={12} />;
}

function resultLooksFailed(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { ok?: unknown; error?: unknown } | null;
    return Boolean(value && typeof value === "object" && (value.ok === false || (value.error && !("path" in value))));
  } catch {
    return false;
  }
}

function formatToolOutput(raw: string): string {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.error === "string" && record.ok === false) return record.error;
      if (typeof record.stdout === "string" || typeof record.stderr === "string") {
        return [record.stdout, record.stderr].filter((entry) => typeof entry === "string" && entry.trim()).join("\n").trim() || `exit ${String(record.exitCode ?? "unknown")}`;
      }
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return raw;
  }
}
