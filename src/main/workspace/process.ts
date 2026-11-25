import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runWorkspaceProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal: AbortSignal;
}): Promise<ProcessResult> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60000, 1000), 600000);
  const environment = Object.fromEntries([
    "PATH", "Path", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  ].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])) as Record<string, string>;
  environment.OPENHACK_WORKSPACE = options.cwd;

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const kill = () => {
      if (child.killed || child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true });
        killer.on("error", () => child.kill("SIGTERM"));
      } else child.kill("SIGTERM");
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    options.signal.addEventListener("abort", abort, { once: true });
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const current = stream === "stdout" ? stdout : stderr;
      if (current.length >= 1024 * 1024) { truncated = true; return; }
      const next = current + chunk.toString("utf8");
      if (next.length > 1024 * 1024) truncated = true;
      if (stream === "stdout") stdout = next.slice(0, 1024 * 1024);
      else stderr = next.slice(0, 1024 * 1024);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started, truncated, timedOut });
    });
  });
}
