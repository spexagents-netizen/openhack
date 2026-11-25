---
name: openhack-install
description: Install or update OpenHack from a GitHub release on Windows — clone, hash-verified silent install, skills, verify, report.
---

# Install OpenHack

Windows 10/11 only. Per-user, no admin. The installer is unsigned, so SmartScreen
will warn; that is expected, not a failure.

## 1. Identify the target

The operator gives a repository as `owner/name` or as a GitHub URL. Normalize it to
`owner/name`. If there is no repository, stop and ask for one — everything else is
mechanical from there.

## 2. Look before writing

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\OpenHack\OpenHack.exe"
```

Present means upgrade; absent means fresh install. Say which one this is before you
start, because an upgrade should not lose the operator's settings.

## 3. Fetch the checkout

```powershell
$src = Join-Path $env:TEMP "openhack-src"
if (Test-Path $src) { Remove-Item $src -Recurse -Force }
git clone --depth 1 "https://github.com/<owner>/<name>.git" $src
```

Without git, download `https://github.com/<owner>/<name>/archive/refs/heads/main.zip`
and expand it into `$src`.

## 4. Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$src\install\Install-OpenHack.ps1" -Repo <owner>/<name> -NoLaunch
```

What that script does, in order: resolves the latest release, downloads
`OpenHack-Setup-*.exe`, verifies it against `SHA256SUMS.txt`, runs the NSIS
installer silently, copies `skills/` into `%APPDATA%\OpenHack\skills`, and prints
the installed path. Flags: `-Version v0.1.0` to pin, `-NoSkills` to skip the copy.

If the hash does not match, the script throws. Do not work around it.

## 5. Verify

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\OpenHack\OpenHack.exe"
(Get-ChildItem "$env:APPDATA\OpenHack\skills" -Directory).Count
Start-Process "$env:LOCALAPPDATA\Programs\OpenHack\OpenHack.exe"
Start-Sleep 6
Get-Process OpenHack | Select-Object -First 1 Name, Id
```

Three facts to report: the executable path, the skill count, and the running
process. A silent installer that produced no process means the install failed even
if the file exists.

## 6. First run

- Providers: **Settings → Model providers → Import OpenCode** picks up an existing
  OpenCode config. Otherwise add an OpenAI-compatible endpoint and key.
- MCP: the app provisions its curated stack on first launch. **Extensions** shows
  each server's state.
- Skills: already installed; the agent loads one only when a task needs it.

## Failure modes worth knowing

| Symptom | Cause | Fix |
|---|---|---|
| `Invoke-RestMethod` 404 | Wrong `owner/name`, or the repo has no releases | Check the repo has a release with an `.exe` asset |
| Hash mismatch | Partial download or a replaced asset | Delete the temp folder and rerun; never skip the check |
| Installer exits, no exe | Antivirus quarantined it | Restore or re-download, then rerun |
| App opens but no models | No provider configured | Settings → Import OpenCode, or add an endpoint |
| REA shows red | npx has not finished the first fetch | Wait ~45 s and reconnect |
