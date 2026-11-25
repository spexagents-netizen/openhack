# OpenHack TDD evidence

## User journeys

1. As an operator, I authorize a local workspace and start a session against a configured model.
2. As an operator, I see streamed reasoning/text and every tool action; risky writes stop for explicit approval.
3. As an operator, I can cancel a run and recover a coherent session after a provider failure.
4. As an operator, I can import Kimi and DeepSeek from OpenCode without exposing their credentials.
5. As an operator, I can add a stdio MCP server, inspect its tools, and have them enter the same execution policy.
6. As an operator, I can install and relaunch a packaged Windows application with persisted sessions.

## Red → green record

The first test run was RED for all five core suites because the modules did not exist:

```text
Test Files  5 failed (5)
Tests  no tests
Cannot find module '../src/main/providers/sse'
Cannot find module '../src/main/config/opencode'
Cannot find module '../src/main/workspace/workspace'
Cannot find module '../src/main/agent/engine'
Cannot find module '../src/main/agent/run-machine'
```

The implementation was then driven by those contracts. Final automated results:

```text
Test Files  26 passed | 1 skipped (27)
Tests       100 passed | 1 skipped (101)
```

Coverage:

```text
Statements  86.05%
Branches    71.79%
Functions   87.04%
Lines       92.79%
```

## Guarantees

| # | Guarantee | Test | Type | Result |
| --- | --- | --- | --- | --- |
| 1 | Fragmented SSE text, reasoning, and multiple tool calls normalize without mixing arguments | `tests/sse-parser.test.ts` | unit | PASS |
| 2 | Malformed/incomplete tool arguments fail before execution | `tests/sse-parser.test.ts`, `tests/edge-cases.test.ts` | unit | PASS |
| 3 | `{env:…}` and `{file:…}` credentials resolve; keys are redacted from failures | `tests/provider.test.ts` | integration | PASS |
| 4 | A full model → tool → model run writes the workspace and persists a final answer | `tests/agent.test.ts`, `tests/agent-service.test.ts` | integration | PASS |
| 5 | Denied writes leave the workspace unchanged | `tests/agent.test.ts` | integration | PASS |
| 6 | Workspace traversal, symlinks, junctions, binary files, and size limits are rejected | `tests/workspace.test.ts`, `tests/edge-cases.test.ts` | unit/integration | PASS |
| 7 | Process execution has timeout, cancellation, output cap, and no-shell argv handling | `tests/builtin-tools.test.ts`, `tests/edge-cases.test.ts` | integration | PASS |
| 8 | Session/messages/tool calls persist across store reopen | `tests/sessions.test.ts` | integration | PASS |
| 9 | Provider and MCP secrets never appear in persisted plaintext | `tests/config-store.test.ts` | integration | PASS |
| 10 | A real stdio MCP server starts, inventories a tool, and answers a call | `tests/mcp.test.ts` | integration | PASS |
| 11 | Plugin manifests are data-only and contribute prompts only when enabled | `tests/plugins.test.ts` | integration | PASS |
| 12 | Renderer receives no Node `require`/`process` primitives | `e2e/app.spec.ts` | Electron E2E | PASS |
| 13 | Approval gate is visible; allow executes exactly one write; provider errors recover | `e2e/app.spec.ts` | Electron E2E | PASS |
| 14 | Packaged app launches, uses the packaged sql.js runtime, and restores a session after relaunch | `e2e/packaged.spec.ts` | packaged E2E | PASS |
| 15 | OpenCode imports both live Modal providers and both endpoints answer | `e2e/live-providers.spec.ts` | opt-in live E2E | PASS |
| 16 | HTML is converted to text without scripts or styles, links resolved, entities decoded | `tests/web.test.ts` | unit | PASS |
| 17 | SearXNG JSON parses and deduplicates; a dead instance falls through to DuckDuckGo; repeat queries hit cache | `tests/web.test.ts` | integration | PASS |
| 18 | Fetch follows bounded redirects, rejects binary and non-HTTP input, caps output, and honours cancellation | `tests/web.test.ts` | integration | PASS |
| 19 | A client-rendered shell escalates to the reader while a short static page stays direct | `tests/web.test.ts`, `tests/live-web.test.ts` | integration + live | PASS |
| 20 | The real app searches the live web through DeepSeek and answers with a cited URL | `e2e/live-providers.spec.ts` | opt-in live E2E | PASS |
| 21 | Operator task routes to a named agent, the run posts a result back, and bus sessions stay out of chat history | `tests/bus.test.ts`, `e2e/app.spec.ts` | integration + Electron E2E | PASS |
| 22 | Shared memory round-trips with attribution and the hop limit stops a delegation loop | `tests/bus.test.ts` | integration | PASS |
| 23 | Dispatch queues past concurrency 3 and drains on completion | `tests/bus.test.ts` | integration | PASS |
| 24 | The loopback webhook accepts a signed trigger, rejects a bad token, and wakes an agent | `tests/bus.test.ts` | integration | PASS |
| 25 | The bus view renders roster, transcript, memory drawer and trigger URL | `e2e/app.spec.ts` | Electron E2E | PASS |
| 26 | `agent_spawn` fans out two workers that actually overlap in flight and returns both reports in one aggregated tool result | `tests/spawn.test.ts` | integration | PASS |
| 27 | Worker messages persist with name/role attribution in the parent session; no extra chat session appears | `tests/spawn.test.ts`, `e2e/app.spec.ts` | integration + Electron E2E | PASS |
| 28 | A failed worker does not abort the rest of the army; the aggregate reports completed/failed counts | `tests/spawn.test.ts` | integration | PASS |
| 29 | Cancelling the parent run cancels every worker and leaves no orphaned failure message | `tests/spawn.test.ts` | integration | PASS |
| 30 | Workers cannot spawn (no `agent_spawn` in child tools); 9-task batches and the 24-worker cap are refused before any run | `tests/spawn.test.ts` | integration | PASS |
| 31 | Approval digests are stable across argument key order, change with any argument byte, and bind workspace/agent/policy | `tests/security.test.ts` | unit | PASS |
| 32 | An approval is single-use; replaying a consumed id is refused, expiry denies on the gate clock, cancel clears pending ids | `tests/security.test.ts`, `tests/agent-service.test.ts` | unit + integration | PASS |
| 33 | Redaction removes known secrets, key material and bearer tokens from logs and never throws on oversized or deep values | `tests/security.test.ts` | unit | PASS |
| 34 | Egress blocks cloud metadata before any network call and refuses a redirect into metadata | `tests/security.test.ts` | integration | PASS |
| 35 | Audit log is append-only JSONL, redacted, rotates at size, and reads back through the Settings panel | `tests/security.test.ts`, `e2e/app.spec.ts` | unit + Electron E2E | PASS |
| 36 | Worker pool queues beyond 6 and finishes all 8 without exceeding the semaphore | `tests/spawn.test.ts` | integration | PASS |
| 37 | A write captures its before-image, the diff shows the exact removed/added lines, and restore returns the original bytes | `tests/checkpoints.test.ts` | integration | PASS |
| 38 | A created file is restored by deletion; unknown checkpoints and paths are refused | `tests/checkpoints.test.ts` | integration | PASS |
| 39 | The review panel lists a run's changed files, renders the diff, restores with confirmation, and hands the file back to the agent | `e2e/app.spec.ts` | Electron E2E | PASS |
| 40 | Plan mode removes write/execute/spawn tools from the model request and refuses one if the model calls it anyway; Act executes the identical call | `tests/plan-mode.test.ts` | integration | PASS |
| 41 | Session mode persists across reopen and updates to Act | `tests/sessions.test.ts` | integration | PASS |
| 42 | A pending approval persisted by a dead process executes once on approval, appends the tool result, and continues the run | `tests/approval-resume.test.ts` | integration | PASS |
| 43 | Denying an interrupted approval touches nothing, is not replayable, and stale approvals expire instead of resuming | `tests/approval-resume.test.ts` | integration | PASS |
| 44 | The Plan/Act switch changes session state and announces read-only mode in the real app | `e2e/app.spec.ts` | Electron E2E | PASS |
| 45 | Browser preview loads an HTTP page in an isolated view, reports its title, and detaches when the tab closes | `e2e/app.spec.ts` | Electron E2E | PASS |
| 46 | The browser URL policy admits only HTTP(S) and upgrades bare hosts; file, data, javascript and ftp are refused | `tests/browser.test.ts` | unit | PASS |
| 47 | Selecting diff lines and sending a line comment produces a scoped review prompt for the agent | `e2e/app.spec.ts` | Electron E2E | PASS |
| 48 | Compaction leaves short histories untouched, summarizes older turns into a durable capped summary, and keeps recent messages | `tests/compaction.test.ts` | unit | PASS |
| 49 | `apply_patch` applies a multi-file diff only after every hunk validates, and writes nothing when one file fails | `tests/apply-patch.test.ts` | integration | PASS |
| 50 | Patch paths reject traversal, absolute paths and malformed input; the real app applies a patch through approval | `tests/apply-patch.test.ts`, `e2e/app.spec.ts` | unit + Electron E2E | PASS |
| 51 | A run has no step ceiling: 40 consecutive tool rounds execute and the 41st model call still returns the final answer | `tests/agent.test.ts` | integration | PASS |
| 52 | A stored `maxSteps` from an older build is dropped on load and never rewritten | `tests/config-store.test.ts` | unit | PASS |
| 53 | `web_search` answers from the hosted keyless provider and never calls DuckDuckGo or a SearXNG instance when it does | `tests/web.test.ts` | unit | PASS |
| 54 | A cached MCP session is reused across calls; a session the server rejects is re-handshaked exactly once | `tests/mcp-search.test.ts` | unit | PASS |
| 55 | MCP handshake rejection, tool errors and empty payloads surface as errors, and unparseable prose yields zero results rather than a guessed hit | `tests/mcp-search.test.ts` | unit | PASS |
| 56 | Scraped engines are only consulted after every hosted provider fails, and a single-result DuckDuckGo page still parses | `tests/web.test.ts` | unit | PASS |
| 57 | A stored Exa key round-trips through the OS cipher, never appears in the config file or the public settings, and clears cleanly | `tests/config-store.test.ts` | unit | PASS |
| 58 | The Exa key is sent only as the `x-api-key` header, never as a URL parameter, and a stored key wins over the environment | `tests/mcp-search.test.ts` | unit | PASS |
| 59 | Storing a key is refused when the OS cipher is unavailable, so a secret can never land in plaintext | `tests/config-store.test.ts` | unit | PASS |
| 60 | With a TinyFish key the provider uses the gateway REST search and sends the key as `X-API-Key`; without one it falls back to the keyless MCP tier | `tests/mcp-search.test.ts` | unit | PASS |

## Rendered states inspected

- Empty workspace entry: `artifacts/ui-empty-1440.png`
- Streaming/loading: `artifacts/ui-loading-1440.png`
- Permission dialog: `artifacts/ui-approval-1440.png`
- Successful tool run: `artifacts/ui-complete-1440.png`
- Provider error: `artifacts/ui-error-1440.png`
- Settings at narrow desktop: `artifacts/ui-settings-1040.png`
- Packaged launch: `artifacts/ui-packaged.png`
- Live imported providers: `artifacts/ui-live-providers.png`
- Live model conversation: `artifacts/ui-live-chat.png`
- Live agent web search: `artifacts/ui-live-websearch.png`
- Live web-chain measurements: `artifacts/web-live.json`
- Agent bus transcript: `artifacts/ui-bus-1440.png`
- Agent bus memory drawer and trigger URL: `artifacts/ui-bus-memory-1440.png`
- Parallel worker army in one session: `artifacts/ui-spawn-1440.png`

Rendered review confirmed visible hierarchy, keyboard-focusable controls, stable desktop layout at 1440×900 and 1040×720, explicit empty/error/partial/streaming states, and no horizontal overflow in the inspected views.

## Known verification limits

- The installer was built and the unpacked packaged application was executed. The NSIS installer itself was not launched because doing so would create user shortcuts and an uninstall registry entry on this machine.
- The current installer is unsigned; signing and clean-VM install/upgrade/uninstall verification remain release-hardening steps.
- Live provider tests are opt-in because they depend on the operator's local Modal gateway files and network state.
