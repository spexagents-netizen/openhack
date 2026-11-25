import { FolderTree, MessageSquareText, Plug, Radio, Settings } from "lucide-react";
import type { ReactNode } from "react";

export type AppView = "chat" | "bus" | "workspace" | "extensions" | "settings";

export function ActivityRail({ view, onChange, busActive }: { view: AppView; onChange: (view: AppView) => void; busActive?: boolean }) {
  const items: Array<{ id: AppView; label: string; icon: ReactNode; dot?: boolean }> = [
    { id: "chat", label: "Session", icon: <MessageSquareText size={18} /> },
    { id: "bus", label: "Agent bus", icon: <Radio size={18} />, dot: busActive },
    { id: "workspace", label: "Workspace", icon: <FolderTree size={18} /> },
    { id: "extensions", label: "Extensions", icon: <Plug size={18} /> },
  ];
  return (
    <nav className="activity-rail" aria-label="Primary navigation">
      <div className="rail-top">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rail-button ${view === item.id ? "is-active" : ""}`}
            aria-label={item.label}
            aria-current={view === item.id ? "page" : undefined}
            data-tooltip={item.label}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
            {item.dot && <span className="rail-live" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button
          type="button"
          className={`rail-button ${view === "settings" ? "is-active" : ""}`}
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          data-tooltip="Settings"
          onClick={() => onChange("settings")}
        >
          <Settings size={18} />
        </button>
      </div>
    </nav>
  );
}
