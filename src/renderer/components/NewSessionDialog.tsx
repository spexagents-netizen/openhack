import { Check, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";
import { baseName } from "../utils";
import { Modal } from "./ui";

/** Pick the project folder a new session runs in, or make a new one. */
export function NewSessionDialog(props: {
  current?: string;
  recent: string[];
  onChoose: () => Promise<string | null>;
  onStart: (workspacePath: string) => void;
  onClose: () => void;
}) {
  const options = [...new Set([...(props.current ? [props.current] : []), ...props.recent])];
  const [selected, setSelected] = useState(options[0] ?? "");
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    setBusy(true);
    try {
      const picked = await props.onChoose();
      if (picked) {
        setSelected(picked);
        if (!options.includes(picked)) options.unshift(picked);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      eyebrow="NEW SESSION"
      title="Where does this session run?"
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <button type="button" className="button ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={!selected || busy} onClick={() => props.onStart(selected)}>
            <Plus size={14} /> Start session
          </button>
        </>
      }
    >
      <div className="folder-list">
        {options.map((entry) => (
          <button
            key={entry}
            type="button"
            className={`folder-row ${selected === entry ? "is-active" : ""}`}
            onClick={() => setSelected(entry)}
            title={entry}
          >
            <FolderOpen size={14} />
            <span className="folder-name">{baseName(entry)}</span>
            <span className="folder-path">{entry}</span>
            {selected === entry && <Check size={13} className="folder-check" />}
          </button>
        ))}
        {!options.length && <div className="folder-empty">No folder authorized yet. Choose one to begin.</div>}
      </div>
      <button type="button" className="button small ghost folder-add" disabled={busy} onClick={() => void choose()}>
        <FolderOpen size={13} /> Choose or create a folder…
      </button>
      <div className="form-note">
        A folder becomes the session's workspace: the only directory the agent can read or write. Creating one uses the
        system dialog, so you can make a new project folder there.
      </div>
    </Modal>
  );
}
