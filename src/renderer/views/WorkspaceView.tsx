import { FileCode2, FileText, FolderOpen, FolderTree, ShieldCheck, X } from "lucide-react";
import { Empty, Spinner } from "../components/ui";
import { baseName } from "../utils";

export interface TreeEntry { path: string; kind: "file" | "directory"; size?: number }
export interface FilePreview { path: string; content: string; totalLines: number; truncated: boolean }

export function WorkspaceView(props: {
  root?: string;
  entries: TreeEntry[];
  file?: FilePreview;
  loading: boolean;
  onOpenWorkspace: () => void;
  onRead: (path: string) => void;
  onCloseFile: () => void;
}) {
  return (
    <div className="view-page workspace-view">
      <div className="view-head">
        <div>
          <div className="eyebrow">AUTHORIZED ROOT</div>
          <h1>Workspace</h1>
          <p>Inspect the exact directory the agent can reach. Reads are automatic; writes follow the active permission profile.</p>
        </div>
        <button type="button" className="button" onClick={props.onOpenWorkspace}><FolderOpen size={14} /> Change workspace</button>
      </div>
      <div className="workspace-boundary">
        <ShieldCheck size={14} />
        <span className="boundary-path">{props.root ?? "No workspace authorized"}</span>
        {props.root && <span className="boundary-badge">SCOPED</span>}
      </div>
      {!props.root ? (
        <Empty
          icon={<FolderTree size={24} />}
          title="No workspace on the bench"
          body="Authorize a directory before starting a session. OpenHack will refuse file and command operations outside it."
          action={<button type="button" className="button primary" onClick={props.onOpenWorkspace}>Authorize directory</button>}
        />
      ) : (
        <div className="workspace-split">
          <div className="workspace-browser">
            <div className="browser-head">
              <span>{props.loading ? <Spinner label="Loading files" /> : `${props.entries.length} entries`}</span>
              <span className="browser-limit" title="Indexed four levels deep; build output and dependency folders are skipped.">depth-limited · builds ignored</span>
            </div>
            <div className="browser-list" data-scrollable>
              {props.entries.map((entry) => {
                const depth = Math.min(entry.path.split("/").length - 1, 6);
                return (
                  <button
                    type="button"
                    key={entry.path}
                    className={`browser-row ${entry.kind === "directory" ? "is-directory" : ""} ${props.file?.path === entry.path ? "is-active" : ""}`}
                    style={{ paddingLeft: `${10 + depth * 14}px` }}
                    title={entry.path}
                    onClick={() => entry.kind === "file" && props.onRead(entry.path)}
                    disabled={entry.kind === "directory"}
                  >
                    {entry.kind === "directory" ? <FolderOpen size={13} /> : <FileCode2 size={13} />}
                    <span className="browser-name">{baseName(entry.path)}</span>
                    {entry.size !== undefined && <span className="browser-size">{formatSize(entry.size)}</span>}
                  </button>
                );
              })}
              {!props.entries.length && !props.loading && <div className="browser-empty">The directory is empty or fully ignored.</div>}
            </div>
          </div>
          {props.file ? (
            <div className="workspace-file">
              <div className="workspace-file-head">
                <FileCode2 size={13} />
                <span className="workspace-file-path">{props.file.path}</span>
                <button type="button" className="icon-button" onClick={props.onCloseFile} aria-label="Close file"><X size={13} /></button>
              </div>
              <pre className="workspace-file-body" data-scrollable>{props.file.content}</pre>
              <div className="file-preview-foot">
                <span>{props.file.totalLines} lines</span>
                {props.file.truncated && <span>preview capped at 4,000 lines</span>}
              </div>
            </div>
          ) : (
            <div className="workspace-void">
              <FileText size={22} />
              <p>Select a file to inspect it.</p>
              <span>Read-only preview. Writes are performed by the agent through the approval path.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
