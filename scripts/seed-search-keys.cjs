// One-off: encrypt search-provider keys with the OS cipher and merge them into
// the app's config, using the same shape ConfigStore persists.
// Run: npx electron scripts/seed-search-keys.cjs
const { app, safeStorage } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS cipher unavailable");
    const dir = path.join(app.getPath("appData"), "OpenHack");
    const file = path.join(dir, "config.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.searchKeys = raw.searchKeys && typeof raw.searchKeys === "object" ? raw.searchKeys : {};
    const stored = [];
    if (process.env.SEED_EXA_KEY) {
      raw.searchKeys.exaKeySecret = safeStorage.encryptString(process.env.SEED_EXA_KEY).toString("base64");
      stored.push("exa");
    }
    if (process.env.SEED_TINYFISH_KEY) {
      raw.searchKeys.tinyfishKeySecret = safeStorage.encryptString(process.env.SEED_TINYFISH_KEY).toString("base64");
      stored.push("tinyfish");
    }
    await writeFile(file, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`stored: ${stored.join(", ") || "nothing"}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`seed failed: ${error.message}\n`);
    app.exit(1);
  }
});
