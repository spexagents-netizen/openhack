import { rename } from "node:fs/promises";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * Windows denies a rename while Defender, the search indexer, or an editor holds
 * a handle on the target for a few milliseconds. Retrying with backoff keeps the
 * atomic write contract instead of surfacing a spurious failure to the operator.
 */
export async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** attempt));
    }
  }
}
