---
description: Install OpenHack from a GitHub repo
---

Install OpenHack from this repository: $ARGUMENTS

Follow the `openhack-install` skill exactly:

1. Confirm the repository is `owner/name`. If only a URL was given, extract it.
2. Check whether `%LOCALAPPDATA%\Programs\OpenHack\OpenHack.exe` already exists and
   say whether this is a fresh install or an upgrade.
3. Clone the repo to `%TEMP%\openhack-src` and run
   `install\Install-OpenHack.ps1 -Repo <owner/name>` with `-NoLaunch`.
4. Verify the executable, the installed version and the skill count.
5. Report the path, the verified SHA-256 and the skill count. Launch it only if
   the operator asked you to.
