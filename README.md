# OpenHack

OpenHack is a local-first desktop AI agent built for offensive security, reverse engineering and autonomous coding. It ships as a Windows `x64` application, streams directly to OpenAI-compatible endpoints, executes tools through a runtime-enforced approval boundary, runs a shared **agent bus**, and connects stdio MCP servers and declarative plugins.

![OpenHack session](artifacts/ui-complete-1440.png)

## Install

The built installer is:

```text
release/OpenHack-Setup-0.1.0.exe
```

It is a per-user NSIS installer. Installation does not require administrator elevation. The packaged application is also available at `release/win-unpacked/OpenHack.exe`.

SHA-256:

```text
064bf59c2d8ab12c07400841ebf5ef7ceb15639d860de082a0a88611d517d489  OpenHack-Setup-0.1.0.exe
```

The hash is also stored at `release/SHA256SUMS.txt`. The current development build is not Authenticode-signed, so Windows SmartScreen may show an unknown-publisher warning.

Reference study and evidence: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/EVIDENCE-REPORT.md`](docs/EVIDENCE-REPORT.md). Test record: [`docs/TDD-EVIDENCE.md`](docs/TDD-EVIDENCE.md).

## First launch

On first launch OpenHack looks for:

```text
%USERPROFILE%\.config\opencode\opencode.json
```

It imports only these providers:

- `modal-kimi` → `moonshotai/Kimi-K3.1-Pro`
- `modal-ep` → `deepseek-ai/DeepSeek-V4.1-Flash-1017`

It supports OpenCode credential references in `apiKey`:

- `{env:VARIABLE}` — resolved from the environment at request time
- `{file:relative/or/absolute/path}` — resolved relative to the OpenCode config directory
- literal values — stored encrypted at rest using Windows DPAPI

OpenCode's endpoint, model limits, tool capability, and token-field settings are preserved. Secrets never enter renderer state, logs, screenshots, session records, or model prompts.

More providers can be added under **Settings → Model providers**. HTTP endpoints are accepted only on loopback; remote endpoints require HTTPS.

## What works

- Streaming OpenAI-compatible chat completions, including reasoning deltas and parallel tool-call assembly.
- Provider-neutral agent loop with durable SQLite sessions, messages, tool results, and run state.
- Built-in tools:
  - `workspace_list`
  - `workspace_read`
  - `workspace_search`
  - `workspace_write`
  - `workspace_replace`
  - `apply_patch` (validated multi-file unified diff with rollback)
  - `process_run` (argument-array execution without a shell)
  - `web_search` (hosted keyless providers, scraped engines as the net)
  - `web_fetch` (page reader with renderer fallback)
  - `agent_spawn` (parallel workers in the current session)
  - `bus_send`, `bus_read`, `bus_memory_write`, `bus_memory_read`, `bus_roster`
- Canonical workspace boundary with symlink/junction rejection and atomic writes.
- Runtime approval policy:
  - **Supervised** — writes and commands require approval
  - **Workspace** — writes inside the authorized root run automatically; commands require approval
  - **Autonomous** — all tool actions use model judgment
- **Context compaction**: older turns collapse into a durable session summary when the context budget is crossed; recent turns stay verbatim.
- **Auto-provisioned stack**: first launch adds the curated MCP servers this host can actually run (`npx`/`uvx`), imports your existing OpenCode servers (stdio **and** remote HTTP), records what it held back, and leaves the rest one click away. Skills ship in the installer and the app also reads `~/.claude/skills` and `~/.config/opencode/skills`.
- **Switchboard**: the model sees five verbs (`tool_search`, `tool_describe`, `tool_call`, `skill_search`, `skill_load`) instead of every MCP tool. A 229-tool server costs ~3.4 MB of schema; it never enters the prompt.
- **Unbounded runs**: there is no step ceiling. A run ends when the model returns a final answer or you press stop; spawned workers follow the same rule.
- **Plan/Act sessions**: Plan removes every mutating tool before the model sees it and the runtime refuses one anyway; Act restores the full toolset.
- Cancelable runs with process-tree termination and durable cancellation recovery.
- Approvals persist to SQLite. If the app dies while waiting, the next launch shows the pending action and can approve or deny it; approval executes the exact saved call once and continues the session.
- Checkpoints: every file a run writes is captured before mutation, with a unified diff and one-click restore in the review panel.
- Stdio MCP server lifecycle: start, discovery, namespaced tools, calls, disconnect, restart, and failure reporting.
- Manifest plugins that contribute prompts and commands as validated data. Third-party plugin code is not executed.
- **Agent bus**: one shared channel, a six-agent roster, bounded delegation, shared memory, and a loopback trigger webhook.
- Local session history, workspace browser, file preview, command palette, and keyboard navigation.
- Review panel with change history, unified diffs, line selection + comments, file restore, and a one-click handoff to the agent.
- Built-in browser preview in an isolated Chromium view: own partition, no Node, denied permissions and popups, HTTP(S)-only navigation.
- Main-process provider access only. The renderer is sandboxed, context-isolated, and exposes a narrow IPC bridge.
- No telemetry, analytics, or phone-home channel.

OpenHack itself applies no model-output moderation layer. Whether a model refuses or complies is determined by the selected provider and model. Tool authority remains enforced by the application regardless of model output.

## Interface

The surface is a single material: obsidian slabs on a near-black void, separated by hairlines instead of boxes, with one accent used as a laser sight rather than decoration.

- **Palette** — canvas `#1C1C1E`, void `#0A0A0B`, bone ink `#F3F0EA`, ember `#FF5D3A`. Ember appears only on brand, live state, the primary action and the operator's own turns.
- **Material** — the chat and review panes are raised slabs: a hairline border, a lit top edge and a warm bloom falling from the top-left. Floating layers (palette, approval dialog, toasts) are real glass: translucent, 28–36px backdrop blur, 130–140% saturation.
- **Live edges** — while a run streams, a single ember filament runs along the top edge of the bench. The composer's hairline becomes a slow conic ember sweep on focus.
- **Type** — Geist Sans and Geist Mono, bundled locally. Five sizes only (10 / 11.5 / 12.5 / 13.5 / 14.5) plus three display sizes, tabular numerals in every metric, micro-labels in wide-tracked mono.
- **Motion** — one curve, `cubic-bezier(0.16, 1, 0.3, 1)`, 110–420ms. Messages rise 4px, surfaces settle, nothing bounces. `prefers-reduced-motion` collapses every duration.
- **Accessibility** — bone-on-obsidian body text above 7:1, secondary text above 4.5:1, an ember focus ring at 2px offset, full keyboard reach, and visible focus on every control.
- **Density** — 720px reading measure, 26px message rhythm, 34px lane padding; the transcript and the composer share one optical center.

## Dynamic army

The lead agent in a chat session creates workers on demand, inside that same session — no second window, no copy-paste.

```text
operator: break this target into independent probes
lead ── agent_spawn { tasks: [ … ] } ──►  N workers run in parallel
                                          │
                       each worker: same workspace, same tools,
                       own model run, own transcript attribution
                                          │
        one aggregated result ──► lead reconciles ──► single thread
```

- One `agent_spawn` call takes up to **8** tasks; every task runs at the same time. Workers never spawn workers, so the tree is exactly one level deep.
- A session may create **24** workers total. A shared pool of **6** model runs gates the whole app, so a fan-out cannot starve the UI or another session.
- Each worker gets its own role, brief, optional model, and the full toolset minus `agent_spawn`. It shares the authorized workspace, so a worker can inspect and patch real files.
- Worker output is attributed: every message carries the worker name and role, renders indented in the same thread under the spawn row, and survives reload.
- Approval still applies. `agent_spawn` is `execute` risk, so supervised mode asks once for the batch; workers' own writes and commands follow the same policy.
- Cancelling the parent run aborts every worker through the shared signal.

## Agent bus

The Bus view is a shared channel that every agent can read and write. It exists so a job can be split without copy-pasting between windows.

**Roster** (default, editable in the bus view):

| id | name | role |
| --- | --- | --- |
| `lead` | VECTOR | decomposition, delegation, operator status |
| `recon` | GHOST | recon, OSINT, surface mapping |
| `exploit` | SPECTER | exploitation and proof |
| `reverse` | CIPHER | binaries, protocols, protections |
| `builder` | FORGE | implementation and automation |
| `research` | ORACLE | current facts with citations |

**How it moves**

- The operator posts to a channel, optionally with `@agent` or the route selector. A named agent starts immediately.
- Agents call `bus_send` to hand work to another agent, `bus_memory_write` to persist facts, `bus_read` to catch up, and `bus_roster` to see who is available.
- Every agent reply is posted back to the channel with its name. The operator sees the whole exchange.
- Bus runs are stored as `bus` sessions, separate from the chat history in the sidebar.

**Bounds** (deliberate, so two models cannot talk forever):

- Hop limit `6`. The chain stops and posts a system message instead of starting another agent.
- Concurrency `3`. Extra dispatches queue and drain as runs finish.
- Messages and memory are local SQLite rows, capped per message at 20,000 characters.

**Triggers**

A loopback webhook wakes the bus from outside:

```text
POST http://127.0.0.1:47821/hook/<token>
{ "title": "GitHub issue #12", "text": "new report", "agent": "research", "channel": "triggers" }
```

The URL and token are shown in the bus memory drawer. It binds `127.0.0.1` only, rejects a bad token with `403`, caps the body at 64 KiB, and rate-limits to 60 requests per minute.

## Web research

`web_search` and `web_fetch` are first-party tools. They need no account, API key or credit card.

**Search chain** — tier one starts every candidate at once and the first usable answer wins, so one slow host never sets the latency:

1. Brave or Tavily when `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` exist in the environment
2. Exa, with your key when one is stored, otherwise the keyless pool
3. TinyFish — keyed `GET /v1/search` on the gateway when a key is stored, otherwise the keyless MCP tier
4. Your own SearXNG instance, if set in **Settings → Web research**
5. Tier two, only if every one above fails: Parallel, then the DuckDuckGo HTML endpoint
6. Tier three: public SearXNG instances raced in parallel as the last net

**Provider keys**: paste them in **Settings → Web research**. Both are encrypted with Windows DPAPI in the main process, never enter renderer state, and are sent only as request headers — the Exa key as `x-api-key` to `https://mcp.exa.ai/mcp`, the TinyFish key as `X-API-Key` to `https://agent.tinyfish.ai/v1/search`. Neither is ever a URL parameter, where it would end up in logs. `EXA_API_KEY` / `TINYFISH_API_KEY` in the environment work too and are used when nothing is stored. Keyless tiers are shared and rate-limit by IP; a key moves search onto your own plan.

Measured on this machine on 2026-11-24, four real queries through the shipped code: **0.55–1.37 s, 8 results each, all served by Exa**. The same four queries against the previous chain returned nothing — DuckDuckGo served its block page and all five public SearXNG instances rejected the request. That is the difference between a search API and scraping an HTML results page.

**Fetch chain**:

1. Direct HTTP(S) fetch, redirects followed up to 5 hops, 3 MiB body cap, 60 s cap
2. HTML converted to Markdown-ish text with links, headings and lists preserved
3. If the response is a client-rendered shell (`app-root`, `id="root"`, `__NEXT_DATA__`, `ng-version`, `data-reactroot`, and similar) or has no body text, the URL is re-read through `https://r.jina.ai` and the longer extraction wins

Measured: NVD's Angular shell returns 2.6 KB of markup and zero readable text; the reader fallback returns 28 KB of usable advisory text. Static pages stay on the direct path.

Both tools are `read` risk, so they run without an approval prompt under every permission profile. They still cross the runtime tool boundary and are recorded in the session.

**Privacy**: a search query and every fetched URL leave this machine — to the search provider and, for client-rendered pages, to Jina. Nothing else from the workspace is included. Disable the reader with `OPENHACK_READER_PREFIX=off`; point search at your own instance with the Settings field or `OPENHACK_SEARXNG_URL`. `EXA_API_KEY` and `TINYFISH_API_KEY` raise those providers out of the keyless pool.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `Ctrl+K` | Command palette |
| `Ctrl+N` | New session |
| `Ctrl+,` | Settings |
| `Esc` | Close palette/dialog |

## Build from source

Requirements: Windows 10/11, Node.js 22+, npm.

```powershell
npm install
npm run dev
```

Validation:

```powershell
npm test
npm run test:coverage
npm run test:e2e
npm run dist
npm run test:packaged
```

Optional live-provider verification, using the local OpenCode endpoints:

```powershell
$env:OPENHACK_LIVE_PROVIDERS = "1"
npx playwright test e2e/live-providers.spec.ts
```

`npm run dist` writes the installer and unpacked application under `release/`.

## MCP servers

Add servers under **Extensions → MCP servers**. Only stdio transport is implemented in `0.1.0`.

The equivalent stored shape is:

```json
{
  "id": "security-tools",
  "name": "Security tools",
  "command": "npx",
  "args": ["-y", "@publisher/mcp-server"],
  "cwd": "C:\\tools\\mcp-server",
  "env": { "API_KEY": "…" },
  "enabled": true
}
```

Environment values are encrypted with DPAPI before persistence. The renderer receives environment key names only. MCP tool annotations marked `readOnlyHint: true` are treated as reads; every other MCP tool follows the execute approval path.

## Manifest plugins

A plugin is a folder containing `openhack-plugin.json`:

```json
{
  "id": "com.example.evidence-tools",
  "name": "Evidence tools",
  "version": "1.0.0",
  "description": "Adds evidence discipline and reusable prompts.",
  "systemPrompt": "Cite exact files and lines for every security claim.",
  "commands": [
    {
      "name": "map",
      "description": "Map the target",
      "prompt": "Map the authorized target and rank its trust boundaries."
    }
  ],
  "permissions": ["workspace.read"]
}
```

Folder import is limited to 100 files and 5 MiB. Symbolic links are rejected. Manifests are schema-validated; no JavaScript is evaluated.

## Security boundary

- The renderer loads only packaged local content and has `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
- IPC channels are allowlisted in the preload and revalidated in the main process.
- Provider requests originate in the main process with redirects disabled and fixed timeouts.
- Workspace paths are canonicalized before validation and again before file access.
- Files are replaced atomically. Paths outside the authorized root, symlinks, junctions, and binary reads are rejected.
- Commands use executable + argument arrays with `shell: false`, a bounded environment, output caps, and timeout/cancellation handling.
- Approval is enforced by the main-process agent, not only by the UI.
- Each approval is a one-shot capability: SHA-256 over actor, run, tool call, normalized arguments, workspace and policy version, valid for 5 minutes, consumed atomically before execution. Replaying an approval id fails.
- Outbound fetches obey an egress policy: cloud metadata endpoints are blocked by default, every redirect hop is re-checked, and strict mode refuses private networks and loopback.
- Security events (approvals, denials, tool executions) append to a redacted JSONL audit log with size rotation; the log is readable from Settings.
- Production CSP blocks renderer network connections.

## Known limits in `0.1.0`

- Windows `x64` only.
- Stdio MCP only; remote MCP/OAuth is not implemented.
- Manifest plugins only; executable third-party plugin hosting is not implemented.
- No image or file attachments in prompts.
- No automatic updates.
- Installer is unsigned.
- Provider compatibility is limited to the OpenAI chat-completions/tool-calling surface.
- Search depends on third-party endpoints. The hosted providers answer without a key but rate-limit by IP under heavy use; `EXA_API_KEY` or `TINYFISH_API_KEY`, or a self-hosted SearXNG instance, removes the shared pool entirely.
- Search has no JavaScript execution of its own; heavy client-rendered pages depend on the reader fallback.
- Bus agents share the active model unless you bind a provider/model to an agent id; the roster editor in the UI toggles enablement only.
- Spawned workers are one level deep by design; nested armies are not allowed.
- Worker reports are capped at 6,000 characters each and 8 tasks per call.
- The bus webhook is loopback-only and has no signature beyond its bearer token; expose it through a reverse proxy only if you add your own authentication.
- A local MCP server runs with the user's privileges. Review the server package before starting it.
