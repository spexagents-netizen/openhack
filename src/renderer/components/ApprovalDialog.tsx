import { ShieldAlert, Terminal, X } from "lucide-react";
import type { ToolRisk } from "../../shared/contracts";
import { prettyJson } from "../utils";

export interface ApprovalView {
  approvalId: string;
  runId: string;
  callId: string;
  name: string;
  argumentsJson: string;
  risk: ToolRisk;
  digest?: string;
  expiresAt?: string;
  agentName?: string;
}

export function ApprovalDialog({ approval, onDecide }: { approval: ApprovalView; onDecide: (approved: boolean) => void }) {
  let detail = prettyJson(approval.argumentsJson);
  try {
    const args = JSON.parse(approval.argumentsJson) as Record<string, unknown>;
    if (args.executable) detail = `$ ${String(args.executable)}${Array.isArray(args.args) ? ` ${args.args.join(" ")}` : ""}`;
  } catch {
    // The raw argument text remains visible for malformed requests.
  }
  return (
    <div className="modal-backdrop approval-backdrop">
      <div className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-desc">
        <div className="approval-head">
          <div className="approval-icon"><ShieldAlert size={20} /></div>
          <div>
            <div className="eyebrow">OPERATOR APPROVAL / {approval.risk.toUpperCase()}</div>
            <h2 id="approval-title">The agent wants to {approval.risk === "execute" ? "run a command" : "change the workspace"}.</h2>
          </div>
        </div>
        <p id="approval-desc">Review the exact action. Approval applies to this call only and expires with the run.</p>
        <div className="approval-action">
          <div className="approval-tool"><Terminal size={14} /> {approval.name}</div>
          <pre>{detail}</pre>
        </div>
        <div className="approval-note">
          {approval.agentName ? `Requested by ${approval.agentName}. ` : ""}
          The action digest is bound to this request; editing or replaying it requires a new approval.
          {approval.digest ? ` digest ${approval.digest.slice(0, 12)}…` : ""}
          {approval.expiresAt ? ` · expires ${new Date(approval.expiresAt).toLocaleTimeString()}` : ""}
        </div>
        <div className="approval-actions">
          <button type="button" className="button ghost" onClick={() => onDecide(false)}><X size={14} /> Deny</button>
          <button type="button" className="button primary" onClick={() => onDecide(true)}>Allow once</button>
        </div>
      </div>
    </div>
  );
}
