import { Command, FolderOpen } from "lucide-react";
import { baseName } from "../utils";
import { Kbd, Logo, StatusDot } from "./ui";

export function TitleBar(props: {
  running: boolean;
  providerName?: string;
  workspace?: string;
  onOpenWorkspace: () => void;
  onPalette: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="titlebar">
      <button type="button" className="brand" onClick={props.onSettings} title="OpenHack settings">
        <Logo size={16} />
        <span className="brand-name">OPENHACK</span>
      </button>
      <span className="titlebar-rule" aria-hidden="true" />
      <button type="button" className="workspace-switch" onClick={props.onOpenWorkspace} title={props.workspace ?? "Authorize a workspace"}>
        <FolderOpen size={12} strokeWidth={1.7} />
        <span>{props.workspace ? baseName(props.workspace) : "Authorize workspace"}</span>
      </button>
      <div className="titlebar-status">
        <button type="button" className="palette-trigger" onClick={props.onPalette} aria-label="Command palette">
          <Command size={12} strokeWidth={1.8} />
          <span>Commands</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <span className={`agent-state ${props.running ? "is-running" : ""}`}>
          <StatusDot state={props.running ? "busy" : props.providerName ? "ready" : "error"} />
          {props.running ? "working" : props.providerName ? "ready" : "no provider"}
        </span>
      </div>
      <div className="window-controls-space" aria-hidden="true" />
    </header>
  );
}
