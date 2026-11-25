import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Kbd } from "./ui";

export interface PaletteAction {
  id: string;
  label: string;
  detail: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return needle ? actions.filter((action) => `${action.label} ${action.detail}`.toLowerCase().includes(needle)) : actions;
  }, [actions, query]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") { event.preventDefault(); setIndex((value) => Math.min(value + 1, filtered.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
      if (event.key === "Enter") {
        event.preventDefault();
        const action = filtered[index];
        if (action) { onClose(); action.run(); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, index, onClose]);
  return (
    <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={16} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands and sessions" aria-label="Search commands" />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list" data-scrollable>
          {filtered.map((action, actionIndex) => (
            <button
              type="button"
              key={action.id}
              className={`palette-row ${actionIndex === index ? "is-active" : ""}`}
              onMouseEnter={() => setIndex(actionIndex)}
              onClick={() => { onClose(); action.run(); }}
            >
              <span className="palette-icon">{action.icon}</span>
              <span className="palette-copy"><strong>{action.label}</strong><span>{action.detail}</span></span>
              {actionIndex === index && <Kbd>Enter</Kbd>}
            </button>
          ))}
          {!filtered.length && <div className="palette-empty">No matching command.</div>}
        </div>
        <div className="palette-foot"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span><span><Kbd>Enter</Kbd> run</span></div>
      </div>
    </div>
  );
}
