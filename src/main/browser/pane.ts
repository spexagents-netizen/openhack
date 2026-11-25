import { BrowserWindow, WebContentsView, session, shell } from "electron";
import type { BrowserPageState } from "../../shared/contracts";
import { normalizeBrowserUrl } from "./url";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserState = BrowserPageState;

/**
 * A real Chromium view owned by the main process. The renderer only supplies a
 * rectangle and a URL; it never touches webContents. The view has no preload,
 * no Node, its own partition, denied permissions and denied popups.
 */
export class BrowserPane {
  private view?: WebContentsView;
  private visible = false;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly windowRef: () => BrowserWindow | null,
    private readonly broadcast: (payload: unknown) => void,
  ) {}

  private get window(): BrowserWindow | null {
    return this.windowRef();
  }

  async show(input: { url?: string; bounds: BrowserBounds }): Promise<BrowserState> {
    if (!this.window) throw new Error("Window is not ready");
    const view = this.ensureView();
    this.bounds = normalizeBounds(input.bounds);
    this.attach(view);
    view.setBounds(this.bounds);
    if (input.url) await this.load(input.url);
    return this.state();
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = normalizeBounds(bounds);
    if (this.view && this.visible) this.view.setBounds(this.bounds);
  }

  hide(): void {
    if (!this.view || !this.visible) return;
    this.visible = false;
    this.window?.contentView.removeChildView(this.view);
  }

  navigate(url: string): BrowserState {
    void this.load(url);
    return this.state();
  }

  action(action: "back" | "forward" | "reload"): BrowserState {
    const contents = this.view?.webContents;
    if (contents) {
      if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      if (action === "reload") contents.reload();
    }
    return this.state();
  }

  async snapshot(): Promise<string> {
    const contents = this.view?.webContents;
    if (!contents) return "";
    const image = await contents.capturePage();
    return image.toPNG().toString("base64");
  }

  state(): BrowserState {
    const contents = this.view?.webContents;
    if (!contents) return { url: "", title: "", canGoBack: false, canGoForward: false, loading: false };
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
    };
  }

  destroy(): void {
    if (!this.view) return;
    try {
      this.window?.contentView.removeChildView(this.view);
    } catch {
      // The window may already be gone.
    }
    this.view.webContents.close();
    this.view = undefined;
    this.visible = false;
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const partition = session.fromPartition("persist:openhack-browser");
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:openhack-browser",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.on("did-navigate", () => this.emitState());
    view.webContents.on("did-navigate-in-page", () => this.emitState());
    view.webContents.on("page-title-updated", () => this.emitState());
    view.webContents.on("did-start-loading", () => this.emitState());
    view.webContents.on("did-stop-loading", () => this.emitState());
    this.view = view;
    return view;
  }

  private attach(view: WebContentsView): void {
    // Re-add to guarantee the preview sits above the renderer surface.
    const window = this.window;
    if (!window) return;
    if (this.visible) window.contentView.removeChildView(view);
    window.contentView.addChildView(view);
    this.visible = true;
  }

  private async load(value: string): Promise<void> {
    const target = normalizeBrowserUrl(value);
    if (!target) return;
    const view = this.ensureView();
    try {
      await view.webContents.loadURL(target);
    } catch (error) {
      this.broadcast({ kind: "browser.state", state: this.state(), error: error instanceof Error ? error.message : String(error) });
    }
  }

  private emitState(): void {
    this.broadcast({ kind: "browser.state", state: this.state() });
  }
}

function normalizeBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}
