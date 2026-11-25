# OpenHack architecture and reference evidence

## Reference under study

- Repository: `https://github.com/anomalyco/opencode`
- Revision: `9a8a656e96cc0bb646d423cec12c2c86cb0b3e46`
- Desktop package version: `2.4.1`
- Source inventory: 254 JavaScript/TypeScript desktop sources, 165,985 AST nodes examined by REA.

### Evidence ledger

| Evidence | Observation |
| --- | --- |
| REA `ev_0ca2b1e1e7b57815f4f55dac6f3aac50f95aa3c3bde74e0b25a6cb3ad16f9426` | JavaScript application analysis retained the desktop source graph. Coverage is partial around dynamic IPC and 5,000 semantic unknowns; static analysis does not prove runtime enforcement. |
| REA `ev_9f1b910378e7bde964b5da5ae05b33a43bd3e38ae72159bf46acaffa8875ae8d` | Summary view: 254 parsed files, 1 context-bridge API, 5 exposed bridge members, 4 dynamically named IPC operations, 2 browser windows. Dynamic channels remain unresolved. |
| Craft Anything `ev_6fcca127d7fe62cd968c9672921e56b606675d7ca6d5d0311393fa4ccaabf2ab` | Electron application map: explicit main/preload/renderer boundaries, `contextBridge` surface, navigation policy, sender checks, and schema-validated IPC patterns. Paged module coverage means absence is not established. |
| Craft Anything `ev_0eff04284e0b5bb24265c8470df49c144f0348d8114d76971cef852ceaa1cdc6` | OpenHack compiled output: Electron app bundled by esbuild, one BrowserWindow with `sandbox`, `contextIsolation`, `nodeIntegration: false`, and `webSecurity: true`; a context bridge and paired push channel were recovered. Two dynamic invoke channels remain outside the static channel map. |
| REA `ev_3ad0bba2116c94effb58e2ded112d30c8f0c6f419a8838d202d48bf9c7c17c3c` → `ev_7bd6bd3fcdd12a00fb3c7b57e0ef799dfa3bf2f3c34955acbb9adcbcf60bca59` | Packaged `app.asar` analysis. The renderer bundle exceeded the per-source deadline, so the view is partial. The retained summary still observes one context-bridge API with three exposed members and the window’s explicit security preferences; it does not prove runtime enforcement. |
| REA `ev_45e34cb494846f9225c52e79eb6ec7eaa375d2f3d9ade4adfc6d2b3c80d14374` | Selected compiled main + preload analysis. Static semantics remain partial around 1,143 dynamic calls and object flow; runtime behavior is instead evidenced by the Electron and packaged E2E tests. |

Observed facts and design choices are intentionally separated. OpenHack does not include or copy OpenCode source, assets, or branding.

## Translation into OpenHack

| Reference mechanism | OpenHack implementation |
| --- | --- |
| Electron main / preload / renderer separation | Main owns providers, secrets, SQLite, tools, approvals, MCP, and plugins. Preload exposes a channel allowlist. Renderer is sandboxed. |
| Narrow bridge surface | `window.openhack.invoke(channel, payload)` + one event subscription. No raw `ipcRenderer`, filesystem, process, or secret access. |
| Navigation confinement | External HTTP(S) links leave through the OS browser; other navigation/window creation is denied. |
| Schema boundary | Zod validates every IPC method; the import adapter parses data only and never evaluates configuration code. |
| Native desktop shell | Custom title bar overlay, durable window, workspace/session/context panes, command palette, and narrow-layout fallback. |
| Agent execution as durable steps | Every model call is a step; each step reloads ordered history from the local session store. A run can pause for approval without losing its state. |

## Process and data flow

```text
Renderer (sandboxed React)
  │ allowlisted invoke / event stream
  ▼
Electron main
  ├── ConfigStore         DPAPI-encrypted provider/MCP secrets
  ├── SessionStore        SQLite via sql.js, serialized atomic persistence
  ├── AgentService        run lifecycle, approval resolution, event persistence
  ├── AgentEngine         provider-neutral model/tool loop
  ├── Workspace           canonical authorized root + file/process tools
  ├── Web runtime         keyless search chain + bounded fetch/reader
  ├── BusService          channels, roster, dispatch, shared memory, webhook
  ├── McpManager          one stdio child process per enabled server
  └── PluginManager       validated manifest-only contributions

AgentEngine ── HTTPS/loopback fetch ──► OpenAI-compatible provider
AgentEngine ── approval gate ─────────► Workspace / MCP tool
```

## Agent loop

1. `AgentService.start()` validates session, provider, and model, then claims the session.
2. The user message and run record are committed before model execution.
3. Context is assembled from the system prompt, enabled plugin prompts, authorized workspace, and ordered history.
4. History is bounded by the selected model's context limit in complete assistant/tool units.
5. Provider SSE is parsed into provider-neutral events; tool arguments are assembled and validated before execution.
6. Write/execute tools cross the runtime approval gate. Denial is returned to the model as a tool result.
7. Tool results are persisted and appended in order; the next step makes a fresh model call.
8. Cancellation aborts the request and process tree, records the terminal state, and ignores stale events.

## Web research toolchain

Two first-party tools, both `read` risk, both executed in the main process:

| Tool | Chain |
| --- | --- |
| `web_search` | configured SearXNG → DuckDuckGo HTML → public SearXNG race → Brave/Tavily when a key exists |
| `web_fetch` | direct bounded HTTP(S) → HTML-to-text → reader proxy when the page is a client-rendered shell |

Measured on this bench on 2026-11-24, against the live network:

```text
duckduckgo  10 results in 0.78 s
searx.be                    non-JSON (JSON API disabled)
search.inetol.net           non-JSON
baresearch.org              non-JSON
opnxng.com / search.rhscz.eu / searx.tiekoetter.com / priv.au   HTTP 429
startpage.com               22 KB challenge page, 0 results
nvd.nist.gov                2,629 bytes of Angular shell, 0 readable characters
r.jina.ai/nvd.nist.gov…     28,226 bytes of readable Markdown
```

Design consequences, each driven by the measurement rather than by preference:

- DuckDuckGo leads because it is the only keyless engine that answered reliably and fast.
- Public SearXNG is a parallel race with a 5 s budget, so a dead volunteer host cannot serialize latency.
- Startpage was removed from the chain; its markup no longer contains server-rendered results.
- The reader fallback triggers on a renderer signature, not on text length, so a genuinely short static page (`example.com`, 156 characters) stays direct.
- Search results are cached for 10 minutes per query to avoid re-spending rate limit inside one investigation.

Both tools return JSON that names the backend that answered, and `web_search` reports every failed attempt when no engine produces results. A silent empty answer is never fabricated.

## Agent bus

The bus is a message plane, not a second agent loop. It owns a transcript, a shared memory table and dispatch; every model turn still runs through `AgentService` and therefore through the same approval gate, workspace boundary and web tools.

```text
operator ──► BusService.postFromOperator ──► dispatch(agent)
                                                 │
                                    sessions.createSession(kind=bus)
                                                 │
                                          AgentService.start
                                                 │
                            tool call: bus_send / bus_read / bus_memory_*
                                                 │
                                    record(message) + dispatch(next)
                                                 │
                                    onRunFinished ──► record(result)
```

Bounds are enforcement, not etiquette:

- `BUS_MAX_HOPS = 6`. Each `bus_send` inherits `parent.hops + 1`; dispatch refuses at the limit and records a system message.
- `BUS_CONCURRENCY = 3`. Additional dispatches queue; `onRunFinished` drains the queue.
- Tool calls are signed by the run's binding, so an agent cannot post as another agent.

Bus tools are `read` risk: they only mutate local coordination state. Every file, process and network effect still crosses its own risk gate.

The trigger webhook is a plain `node:http` server bound to `127.0.0.1`. It compares the token in constant time, caps the body at 64 KiB and rate-limits per minute. A trigger message is recorded as `sender: "trigger"` so the transcript shows what woke the bus.

Bus sessions are stored with `kind = 'bus'`; `listSessions()` defaults to `chat`, which keeps the sidebar free of internal agent runs without adding a second database.

## Dynamic workers

`agent_spawn` is an external tool routed in `AgentService`, not in `AgentEngine`. The engine only knows "one tool call, one awaited result"; the service turns that single call into N parallel `engine.run()` invocations:

```text
callExternalTool("agent_spawn", args, signal, callId)
  └─ spawnWorkers()
       ├─ validate 1..8 tasks, 24 per session, 8k briefs
       ├─ Semaphore(6).acquire() per worker
       ├─ child AgentEngine.run({ history: [system persona], input: brief })
       ├─ childEmit stamps agentId/agentName/agentRole/parentCallId
       └─ JSON aggregate { workers[], completed, failed }
```

Consequences that matter:

- Workers cannot recurse because the child tool list is `externalTools.filter(name !== "agent_spawn")`.
- The semaphore transfers its slot to the next waiter on release, so a concurrent acquire cannot overshoot the limit between release and resume.
- Child events skip `run.started/completed/failed` so the parent's run state stays authoritative in the UI; worker state is carried by `subagent.*` events and message attribution.
- Child approvals are registered against the parent `runId`, so cancelling the parent resolves any pending worker approval instead of leaving a dialog orphaned.
- Child messages persist through the same `handleEvent` path with `agent_*` columns, which is why a reload keeps the army visible.

## Persistence

SQLite tables:

- `sessions`
- `messages`
- `runs`

The database is exported to a temporary file and atomically renamed. Writes are serialized through a queue to prevent concurrent-export corruption. On startup, stale `running` jobs are marked `interrupted`; they are never silently retried.

## Trust boundaries

- Workspace root is a user-granted capability. The renderer cannot grant a workspace by path; only the native directory picker can.
- Canonical path checks are performed before and after resolution. Symlinks and junctions are not followed.
- Commands are spawned without a shell. Environment inheritance is reduced to operational variables plus explicitly configured MCP values.
- API keys remain in the main process. Renderer DTOs expose only `hasApiKey`.
- Provider redirects are rejected. Remote endpoints require TLS; loopback HTTP is allowed for local gateways.
- Packaged CSP blocks all renderer network access.
- MCP servers and the model are untrusted inputs. Tool authority is never inferred from prose alone.

## Provider behavior verified

The local OpenCode configuration exposed file-backed credentials:

```text
modal-kimi  http://127.0.0.1:20200/v1  → 200 /models
modal-ep    http://127.0.0.1:20199/v1  → 200 /models
```

Both endpoint tests returned `200`. A direct minimal chat completion returned a successful stream from each model. The application resolves `{file:…}` references relative to the OpenCode config directory and keeps the file contents out of renderer state.

## Deliberate exclusions from the reference

- OpenCode branding, UI assets, copy, and source.
- Compiling configuration or plugins as executable code.
- Treating the reference's internal architecture as proof of security properties.
- Provider-specific behavior parity beyond the OpenAI-compatible chat/tool surface.
