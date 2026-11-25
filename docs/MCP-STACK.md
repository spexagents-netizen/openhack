# MCP stack

The list, where it lives, and what to turn on.

## Auto-provisioning on a fresh machine

First launch runs `presets/mcp-stack.json` against the host and adds only what
it can actually run:

- `rea`, `context7`, `re-mcp-ghidra` — fetched by `npx`/`uvx` on first use, so
  they are added and started automatically when the runner exists.
- `reva`, `burp`, `burp-collab`, `hexstrike`, `jadx` — need a licensed app, a
  running proxy, a Ghidra extension or a database. They are reported, not faked.

The result is written to `%APPDATA%\OpenHack\stack-bootstrap.json`, so the app
can always say what it installed and what it held back. **Extensions → Install
stack** re-runs the same plan at any time.

Verified on a clean profile: `added: rea, context7, re-mcp-ghidra`,
`manual: reva, burp, burp-collab, hexstrike, jadx`.

## Where it lives

- **In the app:** Settings → **Extensions**. Every server, its state, its tools.
- **On disk:** `%APPDATA%\OpenHack\config.json` → `mcpServers`.
- **Import:** Extensions → **Import OpenCode** copies every stdio server from
  `~/.config/opencode/opencode.json` in one click. Remote (HTTP) servers are
  listed as skipped until the HTTP transport lands.

OpenHack `mcpServers` entry:

```json
{ "id": "rea", "name": "REA", "command": "node", "args": [".../rea.mjs", "mcp"], "env": {}, "enabled": true }
```

## What is on this machine now

16 servers configured in OpenCode. Tool counts are measured where noted.

| Server | Transport | Tools | State | Role |
|---|---|---|---|---|
| `rea` | stdio | **229** (measured, 3.4 MB schema) | on | binaries, .NET, Electron, Android, firmware |
| `craft-anything` | stdio | **39** exposed (320 in repo) | on | Rust RE engine, app/game study |
| `browse` | stdio | 26 | on | real logged-in browser |
| `cheatengine` | stdio | 194 | on | game memory — nobody else has this |
| `artex` | stdio | **7** | on | your local task/finding control plane |
| `tinyfish` | remote HTTP | 43 | on | web search + fetch |
| `meshy` | stdio | 28 | on | 3D generation (not security) |
| `elevenlabs` | stdio | 27 | on | voice (not security) |
| `blender` | stdio | 10 | on | 3D (not security) |
| `blendkit` | stdio | 5 | on | assets (not security) |
| `Roblox_Studio` | stdio | 36 | on | game dev (not security) |
| `sqlmap` | stdio | — | **off** | injection proof |
| `zap` | remote HTTP | — | **off** | proxy, scan, replay |
| `burp` | remote HTTP | — | **off** | proxy, replay |
| `hexstrike` | stdio | — | **off** | 150+ pentest tools behind one door |
| `kali` | stdio | — | **off** | pentest tool runner |

## Tiers

**Core — keep on.** `rea`, `craft-anything`, `browse`, `tinyfish`.
This is recon, reverse engineering and current intelligence. Nothing else required.

**Money — turn on for bounty.** `zap` or `burp` (pick one proxy), `sqlmap`.
Without a proxy there is no web exploitation; with it, the API and injection
skills become real.

**Differentiator.** `cheatengine`. One app that reverses a binary, finds a memory
pointer and writes a trainer. No competitor ships this.

**Optional aggregator.** `hexstrike`, `kali` — enable when you want breadth; they
overlap with `rea` and the ProjectDiscovery CLIs.

**Not security.** `meshy`, `elevenlabs`, `blender`, `blendkit`, `Roblox_Studio`.
Fine to keep, irrelevant to the hacking story.

**Local only.** `artex` is yours, depends on a credentialed local server. Never
bundle it.

## Add these (not yet installed)

| Tool | Why | Install |
|---|---|---|
| `interactsh` | OAST for blind SSRF/XSS/SQLi — half of modern payouts | `go install github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest` |
| `subfinder` | passive subdomain enumeration | `go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest` |
| `httpx` | fast probing with status, title, tech | `go install github.com/projectdiscovery/httpx/cmd/httpx@latest` |
| `katana` | crawler that finds endpoints the UI hides | `go install github.com/projectdiscovery/katana/cmd/katana@latest` |
| `nuclei` | template scanner, after manual mapping | `go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest` |
| `metamcp` | one endpoint in front of many MCP servers | `npx -y @metamcp/mcp-server` |

The ProjectDiscovery CLIs need no MCP wrapper: the agent calls them through
`process_run`. That is cheaper than a server per tool.

## Remote MCP servers

`tinyfish`, `zap` and `burp` are HTTP servers. They are supported: a config entry
with a `url` uses the Streamable HTTP transport, and optional `headers` (an
Authorization token, an access-mode header) are encrypted with DPAPI exactly like
stdio environment values. **Import OpenCode** carries both transports; the id,
URL, headers and disabled state come across intact. Servers answer in pages, so
discovery walks the cursor up to 256 tools.

A remote server that rejects the connection reports the server's own error on
its card — for example TinyFish's keyless tier needs
`x-tinyfish-access-mode: keyless`, and without it the endpoint answers
`Unauthorized: Valid OAuth Bearer token required`.

## When a server will not connect

| Symptom | Cause | Fix |
|---|---|---|
| `Connection closed` + npm `ENOENT ... _npx\<hash>\package.json` | A partial npx download left a half-written cache entry | Delete `%LOCALAPPDATA%\npm-cache\_npx\<hash>` and reconnect. REA failed exactly this way on this machine. |
| `Unauthorized: Valid OAuth Bearer token required` | The endpoint wants a key or an access-mode header | Add it under Headers on the server card; for TinyFish the CLI registration supplies `X-API-Key` and then the full 43-tool catalog appears. |
| Connects, then tools fail | The server's own daemon is not running (Blender, ARTEX, Cheat Engine) | Start the daemon, then reconnect. |
| Takes a long time on first connect | A package runner is fetching the server | REA needs ~44 s cold and exposes 263 tools; the startup budget for `npx`/`uvx` is 180 s. |

## Why the switchboard matters here

`rea` alone is 3.4 MB of tool schema — about 876k tokens. It is never injected
into a prompt. The model sees `tool_search` → `tool_describe` → `tool_call`, and
the catalog stays in the main process. That is what makes 275 tools usable at
all, and it is why adding servers does not cost context.
