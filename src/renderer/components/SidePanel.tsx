import { ArrowLeft, ArrowRight, Check, FileCode2, Folder, Globe, History, MessageSquarePlus, PanelRightClose, RotateCcw, RotateCw, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserPageState, CheckpointDiff, CheckpointStatus } from "../../shared/contracts";
import { api } from "../api";
import { baseName, errorMessage, shortPath, timeAgo } from "../utils";
import { Spinner } from "./ui";

export interface TreeEntry { path: string; kind: "file" | "directory"; size?: number }
export interface FilePreview { path: string; content: string; totalLines: number; truncated: boolean }

export function SidePanel(props: {
  sessionId?: string;
  root?: string;
  entries: TreeEntry[];
  file?: FilePreview;
  loading: boolean;
  revision?: number;
  onRead: (path: string) => void;
  onCloseFile: () => void;
  onCollapse: () => void;
  onComment: (prompt: string) => void;
}) {
  const [tab, setTab] = useState<"files" | "diff" | "browser">("diff");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [comment, setComment] = useState("");
  const [address, setAddress] = useState("https://example.com");
  const [page, setPage] = useState<BrowserPageState | null>(null);
  const [browserError, setBrowserError] = useState("");
  const region = useRef<HTMLDivElement>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointStatus[]>([]);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<string>("");
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [browserActive, setBrowserActive] = useState(false);
  const [confirming, setConfirming] = useState<string>("");
  const [notice, setNotice] = useState("");

  const loadCheckpoints = useCallback(async () => {
    if (!props.sessionId) { setCheckpoints([]); return; }
    setCheckpointBusy(true);
    try {
      const list = await api.checkpointsList(props.sessionId);
      setCheckpoints(list);
      if (list.length && !list.some((entry) => entry.runId === activeRun)) setActiveRun(list[0]!.runId);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCheckpointBusy(false);
    }
  }, [props.sessionId, activeRun, props.revision]);

  useEffect(() => { void loadCheckpoints(); }, [loadCheckpoints]);

  const openDiff = useCallback(async (runId: string, filePath: string) => {
    if (!props.sessionId) return;
    setActiveRun(runId);
    setConfirming("");
    setSelection(null);
    setComment("");
    try {
      setDiff(await api.checkpointDiff(props.sessionId, runId, filePath));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [props.sessionId]);

  const restore = useCallback(async () => {
    if (!props.sessionId || !diff || !activeRun) return;
    if (confirming !== diff.path) { setConfirming(diff.path); return; }
    setConfirming("");
    try {
      await api.checkpointRestore(props.sessionId, activeRun, diff.path);
      setNotice(`Restored ${diff.path}`);
      await loadCheckpoints();
      setDiff(null);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [props.sessionId, diff, activeRun, confirming, loadCheckpoints]);

  useEffect(() => {
    const off = api.onPush((payload) => {
      if (payload.kind !== "browser.state") return;
      setPage(payload.state);
      if (payload.error) setBrowserError(payload.error);
    });
    return off;
  }, []);

  useEffect(() => {
    if (tab !== "browser") {
      void api.browserHide().catch(() => undefined);
      setBrowserActive(false);
      return;
    }
    const node = region.current;
    if (!node || !browserActive) return;
    const sync = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      void api.browserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => undefined);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    sync();
    return () => { observer.disconnect(); };
  }, [tab, browserActive]);

  useEffect(() => () => { void api.browserHide().catch(() => undefined); }, []);

  const openPage = useCallback(async () => {
    const node = region.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setBrowserError("");
    try {
      const state = await api.browserShow({
        url: address,
        bounds: { x: rect.x, y: rect.y, width: Math.max(rect.width, 80), height: Math.max(rect.height, 80) },
      });
      setPage(state);
      setBrowserActive(true);
    } catch (error) {
      setBrowserError(errorMessage(error));
    }
  }, [address]);

  const browserAction = useCallback(async (action: "back" | "forward" | "reload") => {
    try { setPage(await api.browserAction(action)); } catch (error) { setBrowserError(errorMessage(error)); }
  }, []);

  const sendSelection = useCallback(() => {
    if (!diff || !selection) return;
    const slice = diff.lines.slice(selection.start, selection.end + 1);
    const body = slice.map((line) => {
      const mark = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      const where = line.newLine ? `L${line.newLine}` : line.oldLine ? `old L${line.oldLine}` : "";
      return `${mark}${where} ${line.text}`;
    }).join("\n");
    props.onComment(`Review ${diff.path} (checkpoint ${activeRun.slice(0, 8)}).\nSelected lines:\n\`\`\`diff\n${body}\n\`\`\`\nOperator note: ${comment.trim() || "explain and fix"}\nPropose the smallest fix and state the evidence needed.`);
    setSelection(null);
    setComment("");
  }, [diff, selection, comment, activeRun, props]);

  const currentCheckpoint = checkpoints.find((entry) => entry.runId === activeRun);

  return (
    <aside className="side-panel">
      <div className="side-head">
        <div className="side-tabs" role="tablist" aria-label="Review panel">
          <button type="button" role="tab" aria-selected={tab === "diff"} className={tab === "diff" ? "is-active" : ""} onClick={() => setTab("diff")}>
            <History size={13} /> Changes
          </button>
          <button type="button" role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>
            <Folder size={13} /> Files
          </button>
          <button type="button" role="tab" aria-selected={tab === "browser"} className={tab === "browser" ? "is-active" : ""} onClick={() => setTab("browser")}>
            <Globe size={13} /> Browser
          </button>
        </div>
        <button type="button" className="icon-button" onClick={props.onCollapse} aria-label="Hide review panel"><PanelRightClose size={15} /></button>
      </div>

      {tab === "files" && (
        <div className="side-files">
          {props.file ? (
            <>
              <div className="side-file-head">
                <FileCode2 size={13} />
                <span title={props.file.path}>{shortPath(props.file.path, 34)}</span>
                <button type="button" className="icon-button" onClick={props.onCloseFile} aria-label="Close file"><X size={13} /></button>
              </div>
              <pre className="side-file-body">{props.file.content}</pre>
              {props.file.truncated && <div className="side-file-foot">{props.file.totalLines} lines · preview capped</div>}
            </>
          ) : (
            <div className="side-tree" data-scrollable>
              {props.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`side-tree-row ${entry.kind === "directory" ? "is-dir" : ""}`}
                  style={{ paddingLeft: `${8 + Math.min(entry.path.split("/").length - 1, 5) * 12}px` }}
                  onClick={() => entry.kind === "file" && props.onRead(entry.path)}
                  disabled={entry.kind === "directory"}
                >
                  {entry.kind === "directory" ? <Folder size={12} /> : <FileCode2 size={12} />}
                  <span>{baseName(entry.path)}</span>
                </button>
              ))}
              {!props.entries.length && !props.loading && (
                <SideEmpty
                  icon={<Folder size={15} />}
                  title={props.root ? "Nothing readable" : "No workspace"}
                  body={props.root ? "This directory has no entries the agent can read." : "Authorize a directory to browse the files the agent can reach."}
                />
              )}
              {props.loading && <div className="side-empty"><Spinner label="Loading files" /></div>}
            </div>
          )}
        </div>
      )}

      {tab === "diff" && (
        <div className="side-diff">
          {!props.sessionId && (
            <SideEmpty icon={<History size={15} />} title="No session open" body="Open a session and its writes, diffs and restore points appear here." />
          )}
          {props.sessionId && checkpointBusy && !checkpoints.length && <div className="side-empty"><Spinner label="Loading changes" /></div>}
          {props.sessionId && !checkpointBusy && !checkpoints.length && (
            <SideEmpty icon={<History size={15} />} title="No changes yet" body="Every write the agent performs is captured here with its before-image and a restore path." />
          )}
          {checkpoints.length > 0 && !diff && (
            <div className="checkpoint-list" data-scrollable>
              {checkpoints.map((checkpoint) => (
                <div className="checkpoint" key={checkpoint.runId}>
                  <div className="checkpoint-head">
                    <span>{timeAgo(checkpoint.createdAt)}</span>
                    <code>{checkpoint.runId.slice(0, 8)}</code>
                    <span>{checkpoint.files.length} file{checkpoint.files.length === 1 ? "" : "s"}</span>
                  </div>
                  {checkpoint.files.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      className={`checkpoint-file ${file.changed ? "is-changed" : ""}`}
                      onClick={() => void openDiff(checkpoint.runId, file.path)}
                    >
                      <FileCode2 size={12} />
                      <span title={file.path}>{shortPath(file.path, 32)}</span>
                      <span className="checkpoint-tag">{!file.existedBefore ? "new" : file.changed ? "changed" : "unchanged"}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {diff && (
            <div className="diff-view">
              <div className="diff-head">
                <div className="diff-path" title={diff.path}>{shortPath(diff.path, 36)}</div>
                <span className="diff-count">
                  {diff.added > 0 && <span className="add">+{diff.added}</span>}
                  {diff.removed > 0 && <span className="del">-{diff.removed}</span>}
                </span>
                <button type="button" className="icon-button" onClick={() => { setDiff(null); setConfirming(""); }} aria-label="Close diff"><X size={14} /></button>
              </div>
              <div className="diff-actions">
                <button type="button" className={`button small ${confirming === diff.path ? "danger" : ""}`} onClick={() => void restore()}>
                  {confirming === diff.path ? <Check size={13} /> : <RotateCcw size={13} />}
                  {confirming === diff.path ? "Confirm restore" : "Restore file"}
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() => props.onComment(`Review the changes to ${diff.path} in this session (checkpoint ${activeRun.slice(0, 8)}). The diff is open in the review panel. Identify any problem and propose the next step.`)}
                >
                  <MessageSquarePlus size={13} /> Ask agent
                </button>
              </div>
              <pre className="diff-body" data-scrollable>
                {diff.lines.map((line, index) => (
                  <div
                    className={`diff-line ${line.type} ${selection && index >= selection.start && index <= selection.end ? "is-selected" : ""}`}
                    key={index}
                    onClick={(event) => setSelection((current) => {
                      if (!current || !event.shiftKey) return { start: index, end: index };
                      return { start: Math.min(current.start, index), end: Math.max(current.end, index) };
                    })}
                  >
                    <span className="diff-num">{line.oldLine ?? ""}</span>
                    <span className="diff-num">{line.newLine ?? ""}</span>
                    <span className="diff-mark">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
                    <span className="diff-text">{line.text || " "}</span>
                  </div>
                ))}
                {!diff.lines.length && <div className="side-empty">No textual difference.</div>}
              </pre>
              {selection && (
                <div className="diff-comment">
                  <div className="diff-comment-head">Lines {selection.start + 1}–{selection.end + 1} selected</div>
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    rows={2}
                    placeholder="What should the agent change here?"
                    aria-label="Line comment"
                  />
                  <div className="diff-comment-actions">
                    <button type="button" className="button small ghost" onClick={() => { setSelection(null); setComment(""); }}>Cancel</button>
                    <button type="button" className="button small primary" onClick={sendSelection}><Send size={12} /> Send to agent</button>
                  </div>
                </div>
              )}
              {diff.truncated && <div className="side-file-foot">Diff truncated for display.</div>}
              {currentCheckpoint && <div className="side-file-foot">Checkpoint {currentCheckpoint.runId.slice(0, 8)} · {timeAgo(currentCheckpoint.createdAt)}</div>}
            </div>
          )}
          {notice && <div className="side-notice">{notice}</div>}
        </div>
      )}

      {tab === "browser" && (
        <div className="side-browser">
          <form className="browser-bar" onSubmit={(event) => { event.preventDefault(); void openPage(); }}>
            <button type="button" className="icon-button" onClick={() => void browserAction("back")} disabled={!page?.canGoBack} aria-label="Back"><ArrowLeft size={13} /></button>
            <button type="button" className="icon-button" onClick={() => void browserAction("forward")} disabled={!page?.canGoForward} aria-label="Forward"><ArrowRight size={13} /></button>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-label="Browser URL"
              spellCheck={false}
              placeholder="https://target.local"
            />
            <button type="button" className="icon-button" onClick={() => void browserAction("reload")} disabled={!browserActive} aria-label="Reload"><RotateCw size={13} /></button>
            <button type="submit" className="button small primary">Go</button>
          </form>
          <div className="browser-region" ref={region}>
            {!browserActive && (
              <SideEmpty
                icon={<Globe size={15} />}
                title="Isolated preview"
                body="Load a target here: own session, no Node, no popups, no renderer access."
              />
            )}
          </div>
          {browserError && <div className="side-notice">{browserError}</div>}
          <div className="browser-foot">
            <span title={page?.url}>{page?.title || page?.url || "No page loaded"}</span>
            <button
              type="button"
              className="button small ghost"
              disabled={!browserActive}
              onClick={() => props.onComment(`Inspect ${page?.url || address}. The page is open in the preview pane; fetch it with web_fetch or reason from the URL, then report what matters for this session.`)}
            >
              <MessageSquarePlus size={12} /> Ask agent
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function SideEmpty(props: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="side-void">
      <span className="side-void-icon">{props.icon}</span>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}
