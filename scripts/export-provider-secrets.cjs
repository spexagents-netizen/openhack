// Decrypts this machine's provider keys with the app's own profile so a tester
// bundle can carry them. Output goes straight into the bundle, never the repo.
// Run: npx electron scripts/export-provider-secrets.cjs
const { app, safeStorage } = require("electron");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

// safeStorage keys live per userData directory; match the app or every
// ciphertext fails with "Error while decrypting".
app.setName("OpenHack");
app.setPath("userData", path.join(app.getPath("appData"), "OpenHack"));

app.whenReady().then(async () => {
  try {
    const configPath = path.join(app.getPath("appData"), "OpenHack", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const out = [];
    for (const provider of config.providers ?? []) {
      let key;
      if (provider.apiKeySecret) {
        try {
          key = safeStorage.decryptString(Buffer.from(provider.apiKeySecret, "base64"));
        } catch (error) {
          process.stdout.write(`skip ${provider.id}: ${error.message}\n`);
          continue;
        }
      } else if (typeof provider.apiKey === "string") {
        key = provider.apiKey;
      }
      out.push({
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        ...(key ? { apiKey: key } : {}),
        models: provider.models,
        maxTokensField: provider.maxTokensField,
        headerTimeoutMs: provider.headerTimeoutMs,
        chunkTimeoutMs: provider.chunkTimeoutMs,
      });
    }
    const target = path.join(process.cwd(), "release", "friend-bundle", "profile", "providers.secret.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ providers: out, exportedAt: new Date().toISOString() }, null, 2), "utf8");
    process.stdout.write(`exported ${out.length} providers -> ${target}\n`);
    for (const provider of out) {
      process.stdout.write(`  ${provider.id}  ${provider.baseURL}  ${provider.apiKey ? "key " + provider.apiKey.length + " chars" : "no key"}\n`);
    }
    app.exit(0);
  } catch (error) {
    process.stderr.write(`export failed: ${error.message}\n`);
    app.exit(1);
  }
});
