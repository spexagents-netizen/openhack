// Decrypts the MCP secrets exactly as the app does, into a temp config the
// diagnostic can use. Writes no secret to stdout.
const { app, safeStorage } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// safeStorage keys live per userData directory; match the app exactly or every
// ciphertext fails with "Error while decrypting".
app.setName("OpenHack");
app.setPath("userData", path.join(app.getPath("appData"), "OpenHack"));

app.whenReady().then(async () => {
  try {
    const file = path.join(app.getPath("appData"), "OpenHack", "config.json");
    const cfg = JSON.parse(await readFile(file, "utf8"));
    const out = { mcpServers: [] };
    for (const server of cfg.mcpServers ?? []) {
      const next = { ...server };
      for (const [secretKey, plainKey] of [["envSecret", "env"], ["headersSecret", "headers"]]) {
        if (!next[secretKey]) continue;
        try {
          next[plainKey] = JSON.parse(safeStorage.decryptString(Buffer.from(next[secretKey], "base64")));
          delete next[secretKey];
        } catch (error) {
          process.stdout.write(`decrypt failed for ${server.id}.${secretKey}: ${error.message}\n`);
        }
      }
      out.mcpServers.push(next);
    }
    const target = path.join(os.tmpdir(), "openhack-mcp-diagnostic.json");
    await writeFile(target, JSON.stringify(out, null, 2), "utf8");
    process.stdout.write(`wrote ${out.mcpServers.length} servers to ${target}\n`);
    for (const server of out.mcpServers) {
      process.stdout.write(`${server.id}: env=${Object.keys(server.env ?? {}).join(",") || "-"} headers=${Object.keys(server.headers ?? {}).join(",") || "-"}\n`);
    }
    app.exit(0);
  } catch (error) {
    process.stderr.write(`failed: ${error.message}\n`);
    app.exit(1);
  }
});
