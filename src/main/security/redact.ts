const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted key]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|cookie)\b(\s*[:=]\s*)("?)[^\s"',;]{4,}\3/gi, "$1$2[redacted]"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]"],
];

const MAX_LENGTH = 200_000;

/**
 * Central redaction. Every value here may have come from a page, a server, a
 * subprocess or a model, so the filter is deliberately broad and never throws.
 */
export function redact(text: string, secrets: string[] = []): string {
  if (!text) return text;
  let output = text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}\n[truncated]` : text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    output = output.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactValue(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => redactValue(entry, secrets, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      output[key] = /key|token|secret|password|authorization|cookie/i.test(key) ? "[redacted]" : redactValue(entry, secrets, depth + 1);
    }
    return output;
  }
  return value;
}

export function containsSecret(text: string, secrets: string[] = []): boolean {
  if (!text) return false;
  if (secrets.some((secret) => secret.length >= 6 && text.includes(secret))) return true;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text);
}

export function collectSecretValues(...values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.length >= 6));
}
