import { Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionSummary } from "../../shared/contracts";
import { baseName, timeAgo } from "../utils";

export function Sidebar(props: {
  sessions: SessionSummary[];
  activeSessionId?: string;
  workspace?: string;
  unread: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (session: SessionSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const visible = props.sessions.filter((session) => `${session.title} ${session.workspacePath}`.toLowerCase().includes(query.toLowerCase()));
    const today: SessionSummary[] = [];
    const yesterday: SessionSummary[] = [];
    const earlier: SessionSummary[] = [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    for (const session of visible) {
      const at = new Date(session.updatedAt).getTime();
      if (at >= startOfToday.getTime()) today.push(session);
      else if (at >= startOfYesterday.getTime()) yesterday.push(session);
      else earlier.push(session);
    }
    return [
      { label: "Today", items: today },
      { label: "Yesterday", items: yesterday },
      { label: "Earlier", items: earlier },
    ].filter((group) => group.items.length > 0);
  }, [props.sessions, query]);

  return (
    <aside className="sidebar">
      <button type="button" className="new-session" onClick={props.onNew}>
        <Plus size={14} />
        <span>New session</span>
        <kbd>Ctrl N</kbd>
      </button>
      <label className="sidebar-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter sessions" aria-label="Filter sessions" />
      </label>
      <div className="session-list" data-scrollable>
        {groups.map((group) => (
          <div key={group.label}>
            <div className="sidebar-group">{group.label}</div>
            {group.items.map((session) => (
              <div key={session.id} className={`session-row ${props.activeSessionId === session.id ? "is-active" : ""}`}>
                <button type="button" className="session-select" onClick={() => props.onSelect(session.id)}>
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    <span>{baseName(session.workspacePath)}</span>
                    <span>{timeAgo(session.updatedAt)}</span>
                  </span>
                </button>
                {props.unread.has(session.id) && <span className="unread-dot" aria-label="Unread run" />}
                <button type="button" className="session-delete" onClick={() => props.onDelete(session)} aria-label={`Delete ${session.title}`} title="Delete session">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
        {!groups.length && (
          <div className="sidebar-empty">
            <span>{props.sessions.length ? "Nothing matches that filter." : "No sessions yet."}</span>
            <small>{props.sessions.length ? "Clear the filter to see everything." : "Ctrl N starts a clean context."}</small>
          </div>
        )}
      </div>
      <div className="sidebar-foot" title={props.workspace}>
        <span className="foot-dot" />
        <span>{props.workspace ? baseName(props.workspace) : "No workspace"}</span>
      </div>
    </aside>
  );
}
