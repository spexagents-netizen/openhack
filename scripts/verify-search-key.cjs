// Proves both stored search keys decrypt with the OS cipher and authenticate a
// real request. Prints no secret material.
// Run: npx electron scripts/verify-search-key.cjs
const { app, safeStorage } = require("electron");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const readKey = (raw, field) => {
  const secret = raw.searchKeys?.[field];
  if (!secret) return null;
  return safeStorage.decryptString(Buffer.from(secret, "base64"));
};

async function exaCheck(key) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key };
  const url = "https://mcp.exa.ai/mcp";
  const started = Date.now();
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhack-verify", version: "0" } } }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  await init.text();
  if (!init.ok) throw new Error(`handshake HTTP ${init.status}`);
  const extra = session ? { "mcp-session-id": session } : {};
  await fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => undefined);
  const call = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search_exa", arguments: { query: "Exa MCP x-api-key auth", numResults: 5 } } }),
  });
  const text = await call.text();
  if (!call.ok) throw new Error(`tool HTTP ${call.status}`);
  const count = (text.match(/URL:/g) ?? []).length;
  return { status: call.status, ms: Date.now() - started, results: count };
}

async function tinyfishCheck(key) {
  const url = new URL("https://agent.tinyfish.ai/v1/search");
  url.searchParams.set("query", "TinyFish search api gateway");
  const started = Date.now();
  const response = await fetch(url.toString(), {
    headers: { "X-API-Key": key, accept: "application/json", "user-agent": "openhack/0.1" },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${body.slice(0, 80)}`);
  const parsed = JSON.parse(body);
  return { status: response.status, ms: Date.now() - started, results: (parsed.results ?? []).length };
}

app.whenReady().then(async () => {
  try {
    const file = path.join(app.getPath("appData"), "OpenHack", "config.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    const exa = readKey(raw, "exaKeySecret");
    const tiny = readKey(raw, "tinyfishKeySecret");

    if (exa) {
      const run = await exaCheck(exa);
      process.stdout.write(`exa      key ${exa.length} chars -> ${run.status} in ${run.ms}ms, ${run.results} results\n`);
    } else {
      process.stdout.write("exa      no stored key\n");
    }
    if (tiny) {
      const run = await tinyfishCheck(tiny);
      process.stdout.write(`tinyfish key ${tiny.length} chars -> ${run.status} in ${run.ms}ms, ${run.results} results\n`);
    } else {
      process.stdout.write("tinyfish no stored key\n");
    }
    app.exit(0);
  } catch (error) {
    process.stderr.write(`verify failed: ${error.message}\n`);
    app.exit(1);
  }
});
