import { ArrowUp, ShieldCheck, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PermissionMode } from "../../shared/contracts";
import { Kbd } from "./ui";

export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  permission: PermissionMode;
  onOpenSettings: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [props.value]);
  const submit = () => {
    if (props.running) return;
    props.onSend();
  };
  return (
    <div className="composer-wrap">
      <div className={`composer ${props.disabled ? "is-disabled" : ""}`}>
        <textarea
          ref={ref}
          rows={1}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={props.disabled ? "Configure a provider and authorize a workspace to begin" : "Direct the agent. Be specific about the target and the proof you want."}
          aria-label="Message the agent"
          disabled={props.disabled}
        />
        <div className="composer-bar">
          <button type="button" className="permission-chip" onClick={props.onOpenSettings} title="Open agent permissions">
            <ShieldCheck size={13} />
            {props.permission}
          </button>
          <div className="composer-hint"><Kbd>Enter</Kbd> send <span /> <Kbd>Shift Enter</Kbd> newline</div>
          {props.running ? (
            <button type="button" className="send-button stop" onClick={props.onStop} aria-label="Stop agent">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-button" onClick={submit} disabled={!props.value.trim() || props.disabled} aria-label="Send message">
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
