# Install OpenHack

Windows 10/11, x64. Per-user, no administrator rights. The installer is not
code-signed, so SmartScreen shows an unknown-publisher warning — choose
**More info → Run anyway**.

## The fast path

Double-click the release installer:

```text
OpenHack-Setup-0.1.0.exe
```

Then open **Settings → Model providers → Import OpenCode** if OpenCode is already
configured on the machine, otherwise add an OpenAI-compatible endpoint and key.
The curated MCP stack provisions itself on first launch.

## Let an agent do it

The repository ships an install runbook for OpenCode (and any agent that can run
PowerShell). Copy the three folders into the OpenCode config directory:

```powershell
$src = "https://github.com/<owner>/<name>"
$cfg = "$env:USERPROFILE\.config\opencode"
# after cloning the repo to $repo:
Copy-Item "$repo\opencode\agent\*"   "$cfg\agent"   -Force
Copy-Item "$repo\opencode\command\*" "$cfg\command" -Force
Copy-Item "$repo\opencode\skill\*"   "$cfg\skill"   -Force
```

Then, in OpenCode:

```text
/openhack-install <owner>/<name>
```

or just:

```text
Install OpenHack from https://github.com/<owner>/<name>
```

The `openhack-installer` agent clones the repo, runs `install/Install-OpenHack.ps1`,
verifies the release asset against `SHA256SUMS.txt`, installs silently, copies the
skills, and reports the path, version and skill count.

## Manual install from source

```powershell
git clone https://github.com/<owner>/<name>.git
cd <name>
npm install
npm run dist
.\release\OpenHack-Setup-0.1.0.exe
```

Node 22 or newer. `npm run dist` builds the renderer, the main process and the NSIS
installer.

## What lands where

| Path | Content |
|---|---|
| `%LOCALAPPDATA%\Programs\OpenHack` | application |
| `%APPDATA%\OpenHack\config.json` | providers, settings, MCP servers (secrets DPAPI-encrypted) |
| `%APPDATA%\OpenHack\skills` | installed skills |
| `%APPDATA%\OpenHack\openhack.sqlite` | sessions, messages, approvals |
| `%APPDATA%\OpenHack\audit.log` | append-only redacted audit trail |

Uninstalling removes the application and leaves `%APPDATA%\OpenHack` intact, so
settings and sessions survive a reinstall.

## Verify a download

```powershell
Get-FileHash .\OpenHack-Setup-0.1.0.exe -Algorithm SHA256
```

Compare with `SHA256SUMS.txt` from the same release.
