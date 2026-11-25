import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { redact, redactValue } from "./redact";

/**
 * Append-only security log. Entries carry decisions and hashes, never raw
 * arguments or credentials. Rotation keeps one previous file for review.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly secrets: () => string[],
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  record(event: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify(redactValue({
      ts: new Date().toISOString(),
      event,
      ...data,
    }, this.secrets())) as string;
    this.queue = this.queue
      .then(() => this.write(`${redact(line, this.secrets())}\n`))
      .catch(() => undefined);
  }

  async tail(lines = 40): Promise<string[]> {
    await this.queue;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.filePath, "utf8");
      return raw.trim().split("\n").filter(Boolean).slice(-Math.max(1, Math.min(lines, 500)));
    } catch {
      return [];
    }
  }

  private async write(line: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      if (info.size > this.maxBytes) await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
    } catch {
      // First write; nothing to rotate.
    }
    await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
  }
}
