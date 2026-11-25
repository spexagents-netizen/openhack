import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderConfig } from "../../shared/contracts";
import { OpenAIStreamParser } from "./sse";
import type { ModelProvider, ModelRequest } from "./types";
import type { ModelEvent } from "../../shared/contracts";

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      ...config,
      headerTimeoutMs: Number.isFinite(config.headerTimeoutMs) && config.headerTimeoutMs > 0 ? config.headerTimeoutMs : 120000,
      chunkTimeoutMs: Number.isFinite(config.chunkTimeoutMs) && config.chunkTimeoutMs > 0 ? config.chunkTimeoutMs : 120000,
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const apiKey = await resolveApiKey(this.config.apiKey);
      timer = setTimeout(() => controller.abort(), this.config.headerTimeoutMs);
      const response = await fetch(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.name ? { name: message.name } : {}),
          })),
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: "auto",
          } : {}),
          ...(request.reasoningEffort && request.reasoningEffort !== "off" ? { reasoning_effort: request.reasoningEffort } : {}),
          [this.config.maxTokensField]: request.maxTokens ?? 16384,
        }),
        signal: controller.signal,
        redirect: "error",
      });
      clearTimeout(timer);
      timer = undefined;
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 4000);
        throw new Error(`Provider returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
      }
      if (!response.body) throw new Error("Provider returned an empty response body");
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const text = await response.text();
        const parser = new OpenAIStreamParser();
        yield* parser.push(`data: ${text}\n\ndata: [DONE]\n\n`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new OpenAIStreamParser();
      while (true) {
        timer = setTimeout(() => controller.abort(), this.config.chunkTimeoutMs);
        const next = await reader.read();
        clearTimeout(timer);
        timer = undefined;
        if (next.done) break;
        const events = parser.push(decoder.decode(next.value, { stream: true }));
        for (const event of events) yield event;
      }
      for (const event of parser.push(decoder.decode())) yield event;
      for (const event of parser.finish()) yield event;
    } catch (error) {
      throw new Error(sanitizeError(error, [this.config.apiKey, await resolveApiKey(this.config.apiKey).catch(() => undefined)]));
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.config.headerTimeoutMs, 15000));
    try {
      const apiKey = await resolveApiKey(this.config.apiKey);
      const response = await fetch(`${this.config.baseURL.replace(/\/$/, "")}/models`, {
        headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: controller.signal,
        redirect: "error",
      });
      const detail = (await response.text()).slice(0, 500);
      return {
        ok: response.ok,
        detail: response.ok ? `Reachable · ${response.status}` : sanitizeError(`${response.status} · ${detail}`, [this.config.apiKey, await resolveApiKey(this.config.apiKey).catch(() => undefined)]),
      };
    } catch (error) {
      return { ok: false, detail: sanitizeError(error, [this.config.apiKey, await resolveApiKey(this.config.apiKey).catch(() => undefined)]) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function resolveApiKey(reference?: string): Promise<string | undefined> {
  if (!reference) return undefined;
  const env = /^\{env:([^}]+)\}$/.exec(reference);
  if (env) return process.env[env[1]!];
  const file = /^\{file:([^}]+)\}$/.exec(reference);
  if (file) {
    const expanded = file[1]!.startsWith("~")
      ? path.join(homedir(), file[1]!.slice(1).replace(/^[\\/]/, ""))
      : path.resolve(file[1]!);
    try {
      return (await readFile(expanded, "utf8")).trim();
    } catch {
      throw new Error("Provider credential file could not be read");
    }
  }
  return reference;
}

function sanitizeError(error: unknown, secrets: Array<string | undefined>): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
  if (/abort/i.test(message)) return "The request was cancelled or timed out";
  return message;
}
