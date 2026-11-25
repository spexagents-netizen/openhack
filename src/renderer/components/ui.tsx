import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-mark">
      <path d="M9 6v10.5a7 7 0 0 0 14 0V6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
      <circle cx="13.1" cy="13.2" r="1.6" fill="currentColor" />
      <circle cx="18.9" cy="13.2" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Spinner({ label = "Agent working" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Modal(props: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  width?: "sm" | "md" | "lg";
  footer?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key !== "Tab") return;
      const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!nodes?.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div ref={ref} className={`modal modal-${props.width ?? "md"}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div>
            {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
            <h2 id={titleId}>{props.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close dialog"><X size={16} /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-footer">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function StatusDot({ state }: { state: "ready" | "busy" | "idle" | "error" }) {
  return <span className={`status-dot status-${state}`} aria-hidden="true" />;
}
