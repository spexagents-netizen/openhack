import { htmlToText, extractTitle } from "./html";
import { BROWSER_UA } from "./search";
import { checkEgress, type EgressPolicy } from "../security/egress";

export interface FetchReport {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  bytes: number;
  truncated: boolean;
  backend: "direct" | "reader";
  /** True when the page is a client-rendered shell with no usable body text. */
  needsRenderer: boolean;
}

export interface FetchOptions {
  url: string;
  signal: AbortSignal;
  maxChars?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Optional reader proxy, e.g. Jina. Tried only when direct extraction is thin. */
  readerPrefix?: string;
  /** Outbound policy applied to the target and every redirect hop. */
  policy?: EgressPolicy;
}

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_READER = "https://r.jina.ai";
const SPA_MARKERS = /<app-root|<div[^>]+id=["'](root|app)["']|__NEXT_DATA__|ng-version|data-reactroot|data-server-rendered|window\.__INITIAL|id=["']__nuxt/i;

export async function webFetch(options: FetchOptions): Promise<FetchReport> {
  const target = normalizeTarget(options.url);
  const policy = options.policy ?? "block-metadata";
  const verdict = checkEgress(target, policy);
  if (!verdict.allowed) throw new Error(`Egress blocked: ${verdict.reason ?? "policy"}`);
  const maxChars = Math.min(Math.max(options.maxChars ?? 24000, 500), 120000);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 20000, 1000), 60000);
  const doFetch = options.fetchImpl ?? fetch;
  const reader = resolveReader(options.readerPrefix);

  let direct: FetchReport;
  try {
    direct = await fetchOnce(doFetch, target, maxChars, timeoutMs, options.signal, "direct", 0, policy);
  } catch (error) {
    if (options.signal.aborted) throw error;
    // A policy denial is final; do not route around it through a reader proxy.
    if (error instanceof Error && error.message.startsWith("Egress blocked")) throw error;
    if (!reader) throw error;
    const proxied = await fetchOnce(doFetch, readerFor(reader, target), maxChars, timeoutMs, options.signal, "reader", 0, policy);
    return { ...proxied, url: target, finalUrl: target, backend: "reader" };
  }

  // A short but complete page (example.com, a status endpoint) is a valid answer.
  // Only a markup shell with no body text justifies paying for a renderer.
  if (direct.backend === "reader" || !reader || !direct.needsRenderer) return direct;
  try {
    const proxied = await fetchOnce(doFetch, readerFor(reader, target), maxChars, timeoutMs, options.signal, "reader", 0, policy);
    if (proxied.text.trim().length > direct.text.trim().length) {
      return { ...proxied, url: target, finalUrl: target, backend: "reader" };
    }
  } catch {
    // The direct extraction remains a valid, if thin, answer.
  }
  return direct;
}

function resolveReader(configured?: string): string {
  const value = (configured ?? process.env.OPENHACK_READER_PREFIX ?? DEFAULT_READER).trim();
  if (/^(off|none|0|false)$/i.test(value)) return "";
  return value.replace(/\/+$/, "");
}

function readerFor(prefix: string, target: string): string {
  return `${prefix}/${target}`;
}

async function fetchOnce(
  doFetch: typeof fetch,
  target: string,
  maxChars: number,
  timeoutMs: number,
  parentSignal: AbortSignal,
  backend: FetchReport["backend"],
  depth: number,
  policy: EgressPolicy,
): Promise<FetchReport> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  parentSignal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (parentSignal.aborted) throw new Error("Run cancelled");
    const response = await doFetch(target, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": BROWSER_UA,
      },
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} without a location header`);
      const next = new URL(location, target).toString();
      if (!/^https?:\/\//i.test(next)) throw new Error("Redirect left the HTTP(S) scheme");
      const nextVerdict = checkEgress(next, policy);
      if (!nextVerdict.allowed) throw new Error(`Egress blocked on redirect: ${nextVerdict.reason ?? "policy"}`);
      if (depth >= MAX_REDIRECTS) throw new Error("Too many redirects");
      return fetchOnce(doFetch, next, maxChars, timeoutMs, parentSignal, backend, depth + 1, policy);
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (/^(image|video|audio|font)\//.test(contentType) || /application\/(zip|pdf|octet-stream|x-msdownload)/.test(contentType)) {
      throw new Error(`Refusing non-text content: ${contentType || "unknown type"}`);
    }
    const { text, bytes, truncated } = await readBounded(response, MAX_BYTES);
    const readable = /html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
    const body = readable ? htmlToText(text, response.url || target) : text;
    const clipped = body.slice(0, maxChars);
    const visible = body.trim().length;
    return {
      url: target,
      finalUrl: response.url || target,
      status: response.status,
      contentType: contentType || (readable ? "text/html" : "text/plain"),
      ...(readable && extractTitle(text) ? { title: extractTitle(text).slice(0, 300) } : {}),
      text: clipped,
      bytes,
      truncated: truncated || body.length > clipped.length,
      backend,
      needsRenderer: readable && (visible === 0 || (visible < 600 && SPA_MARKERS.test(text))),
    };
  } catch (error) {
    if (parentSignal.aborted) throw new Error("Run cancelled");
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Fetch timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", relay);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), bytes: text.length, truncated: text.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - bytes;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining));
      bytes += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buffer), bytes, truncated };
}

function normalizeTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL cannot be empty");
  if (trimmed.length > 8192) throw new Error("URL exceeds 8,192 characters");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs can be fetched");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}
