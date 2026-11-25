// Builds the tester bundle: installer, model relay, decrypted provider keys,
// every skill on this machine, and a one-click setup. Keys land only in the
// bundle, never in the repo.
// Run: node scripts/make-friend-bundle.mjs
import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";

const run = promisify(execFile);
const home = process.env.USERPROFILE;
const appData = process.env.APPDATA;
const repo = process.cwd();
const out = path.join(repo, "release", "friend-bundle");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PORTABLE_MCP = new Set(["rea", "context7", "re-mcp-ghidra", "sqlmap", "tinyfish"]);

async function copySkills(from, into, seen) {
  if (!existsSync(from)) return 0;
  let count = 0;
  for (const entry of await readdir(from)) {
    const dir = path.join(from, entry);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (!existsSync(path.join(dir, "SKILL.md"))) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    await cp(dir, path.join(into, entry), { recursive: true });
    count += 1;
  }
  return count;
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "profile"), { recursive: true });
await mkdir(path.join(out, "skills"), { recursive: true });
await mkdir(path.join(out, "relay"), { recursive: true });

// ── installer ───────────────────────────────────────────────────────────────
const releases = await readdir(path.join(repo, "release"));
const setup = releases.find((name) => /^OpenHack-Setup-.*\.exe$/.test(name));
if (!setup) throw new Error("No installer in release/ — run npm run dist first");
await cp(path.join(repo, "release", setup), path.join(out, setup));

// ── model relay: the same script this machine runs, no secrets inside ───────
const relaySource = path.join(home, ".config", "opencode", "modal-relay.mjs");
if (!existsSync(relaySource)) throw new Error("modal-relay.mjs not found");
await cp(relaySource, path.join(out, "relay", "modal-relay.mjs"));
await writeFile(path.join(out, "relay", "Start-Relay.cmd"), `@echo off\r
cd /d "%~dp0"\r
rem Optional second endpoint: put the Kimi upstream host in kimi-upstream.txt\r
if exist "%~dp0kimi-upstream.txt" (\r
  set /p KIMI_UPSTREAM=<"%~dp0kimi-upstream.txt"\r
  start "" /min cmd /c "set MODAL_RELAY_PORT=20200&& set MODAL_UPSTREAM_HOST=%KIMI_UPSTREAM%&& node modal-relay.mjs"\r
)\r
start "" /min node modal-relay.mjs\r
`);

// ── providers: decrypt this machine's keys straight into the bundle ─────────
let providers = [];
try {
  // Run the packaged Electron binary directly: spawning npx.cmd from Node needs
  // a shell, and the path is known.
  const electronBin = process.platform === "win32"
    ? path.join(repo, "node_modules", "electron", "dist", "electron.exe")
    : path.join(repo, "node_modules", ".bin", "electron");
  await run(electronBin, ["scripts/export-provider-secrets.cjs"], { cwd: repo, timeout: 180000 });
  const secretPath = path.join(out, "profile", "providers.secret.json");
  if (existsSync(secretPath)) providers = JSON.parse(await readFile(secretPath, "utf8")).providers ?? [];
} catch (error) {
  console.log(`provider export skipped: ${String(error.message).split("\n")[0]}`);
}

// ── portable profile ───────────────────────────────────────────────────────
const config = JSON.parse(await readFile(path.join(appData, "OpenHack", "config.json"), "utf8"));
const dropped = [];
const portable = [];
for (const server of config.mcpServers ?? []) {
  const entry = { id: server.id, name: server.name, enabled: server.enabled };
  if (server.url) {
    if (!/^https:\/\//i.test(server.url) || /127\.0\.0\.1|localhost/i.test(server.url)) {
      dropped.push(`${server.id} (local endpoint)`);
      continue;
    }
    entry.url = server.url;
  } else if (PORTABLE_MCP.has(server.id) && /^(npx|uvx)$/i.test(path.basename(server.command ?? ""))) {
    entry.command = server.command;
    entry.args = server.args ?? [];
  } else {
    dropped.push(`${server.id} (machine path or personal install)`);
    continue;
  }
  portable.push(entry);
}

const defaultProvider = providers.find((provider) => /:20199\//.test(provider.baseURL)) ?? providers[0];

const profile = {
  version: 1,
  note: "Tester profile. Providers point at the bundled relay on 127.0.0.1.",
  settings: {
    permission: config.settings?.permission ?? "supervised",
    systemPrompt: config.settings?.systemPrompt,
    egressPolicy: config.settings?.egressPolicy ?? "block-metadata",
    reasoningEffort: config.settings?.reasoningEffort ?? "off",
    recentWorkspaces: [],
    // The bundled relay runs the DeepSeek upstream on 20199 by default; Kimi
    // needs its own host in kimi-upstream.txt, so it is not the default.
    ...(defaultProvider ? { activeProviderId: defaultProvider.id, activeModel: defaultProvider.models?.[0]?.id } : {}),
  },
  providers,
  mcpServers: portable,
  enabledPlugins: [],
  installedPlugins: [],
};
await writeFile(path.join(out, "profile", "config.json"), JSON.stringify(profile, null, 2));

// ── skills ─────────────────────────────────────────────────────────────────
const seen = new Set();
const counts = {
  app: await copySkills(path.join(repo, "skills"), path.join(out, "skills"), seen),
  claude: await copySkills(path.join(home, ".claude", "skills"), path.join(out, "skills"), seen),
  opencode: await copySkills(path.join(home, ".config", "opencode", "skills"), path.join(out, "skills"), seen),
};
const skillDirs = (await readdir(path.join(out, "skills"))).length;

// ── setup scripts ──────────────────────────────────────────────────────────
await writeFile(path.join(out, "Install-Friend.cmd"), `@echo off\r
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Friend.ps1"\r
pause\r
`);

await writeFile(path.join(out, "Install-Friend.ps1"), String.raw`# Installs OpenHack, the model relay, this profile and every skill, then launches.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$setup = Get-ChildItem $here -Filter 'OpenHack-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw 'OpenHack installer not found next to this script.' }

Write-Host 'Installing OpenHack (per-user, no admin)...' -ForegroundColor Cyan
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait

$exe = Join-Path $env:LOCALAPPDATA 'Programs\OpenHack\OpenHack.exe'
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path $exe) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 800 }
if (-not (Test-Path $exe)) { throw 'Install finished but OpenHack.exe was not found.' }

$data = Join-Path $env:APPDATA 'OpenHack'
New-Item -ItemType Directory -Force -Path $data | Out-Null

Write-Host 'Installing skills...' -ForegroundColor Cyan
$skillTarget = Join-Path $data 'skills'
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
Copy-Item (Join-Path $here 'skills\*') $skillTarget -Recurse -Force

Write-Host 'Installing the model relay...' -ForegroundColor Cyan
$relayDir = Join-Path $data 'relay'
New-Item -ItemType Directory -Force -Path $relayDir | Out-Null
Copy-Item (Join-Path $here 'relay\*') $relayDir -Recurse -Force

Write-Host 'Writing the profile...' -ForegroundColor Cyan
$configPath = Join-Path $data 'config.json'
Copy-Item (Join-Path $here 'profile\config.json') $configPath -Force

Write-Host 'Starting the relay now, and at every login...' -ForegroundColor Cyan
$relayStart = Join-Path $relayDir 'Start-Relay.cmd'
Start-Process -FilePath $relayStart -WindowStyle Hidden
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenHack Relay.lnk'))
$shortcut.TargetPath = $relayStart
$shortcut.WindowStyle = 7
$shortcut.Save()

Start-Sleep -Seconds 2
Write-Host 'Launching OpenHack.' -ForegroundColor Cyan
Start-Process -FilePath $exe
Write-Host ''
Write-Host 'Done. The relay forwards to the shared model endpoints; keep this folder private because it carries API keys.' -ForegroundColor Yellow
`);

await writeFile(path.join(out, "README-FRIEND.md"), `# OpenHack - tester build

## Install

1. Extract this folder anywhere. Keep it private: the profile carries API keys.
2. Double-click **Install-Friend.cmd**.

Windows SmartScreen warns because the installer is not signed: **More info -> Run anyway**.

## What is installed

- OpenHack itself, per-user, no admin.
- **${skillDirs} skills** in \`%APPDATA%\\OpenHack\\skills\`. The agent searches them and loads one only when a task needs it.
- **Model relay** in \`%APPDATA%\\OpenHack\\relay\`, started now and at every login. It forwards \`127.0.0.1:20199\` to the shared Modal endpoint, which is why the same models work here.
- **${portable.length} MCP servers**: ${portable.map((server) => server.id).join(", ")}. They download themselves through npx/uvx on first use. REA takes about 45 seconds the first time.

## Models

The profile carries ${providers.length} provider${providers.length === 1 ? "" : "s"}: ${providers.map((provider) => provider.id).join(", ") || "none"}.
They point at the local relay, so no endpoint setup is needed. If a request fails
with a connection error, run \`%APPDATA%\\OpenHack\\relay\\Start-Relay.cmd\` once.

## Not included

${dropped.map((entry) => `- ${entry}`).join("\n")}

Those need programs installed on the sender's PC. Install them and add them under
Extensions if you want them.

## Notes to send back

Anything that felt slow, anything the agent got wrong, and the exact text of any
error. The audit log is at \`%APPDATA%\\OpenHack\\audit.log\`.
`);

const manifest = {
  builtAt: new Date().toISOString(),
  installer: setup,
  installerSha256: sha(await readFile(path.join(out, setup))),
  relaySha256: sha(await readFile(path.join(out, "relay", "modal-relay.mjs"))),
  skills: { total: skillDirs, bySource: counts },
  mcp: portable.map((server) => server.id),
  providers: providers.map((provider) => ({ id: provider.id, baseURL: provider.baseURL, key: provider.apiKey ? `${provider.apiKey.length} chars` : "none" })),
  dropped,
};
await writeFile(path.join(out, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

console.log(`bundle: ${out}`);
console.log(`skills: ${skillDirs} (app ${counts.app}, claude ${counts.claude}, opencode ${counts.opencode})`);
console.log(`providers: ${providers.map((provider) => `${provider.id} -> ${provider.baseURL}`).join(", ") || "none"}`);
console.log(`mcp: ${portable.map((server) => server.id).join(", ")}`);
