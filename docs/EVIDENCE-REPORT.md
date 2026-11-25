# Investigation report

**Question:** What shipped OpenCode architecture and interaction patterns should guide a new polished Windows desktop AI agent with streaming models, workspace tools, MCP and plugins?

**Purpose:** Build an original installable Windows desktop agent informed by evidence, not a superficial UI clone.

**Done when:** Relevant OpenCode architecture is evidenced with IDs and translated into an original Electron/React implementation plan; the new app, tests and Windows installer are built and verified.

## What we looked at

- opencode (A folder)
- https://github.com/anomalyco/opencode
- D:\HackCode\references\opencode
- D:\HackCode\ outputs

## What we found

### Observed: OpenCode desktop 2.4.1 is an Electron application with separate main, preload and renderer layers and a narrow contextBridge surface. Static analysis is limited for dynamic IPC and runtime enforcement.

- **Confidence:** Worked it out (derived)
- **Evidence:**
  - `ev_6fcca127d7fe62cd968c9672921e56b606675d7ca6d5d0311393fa4ccaabf2ab` — Electron app desktop 2.4.1: 254 source files, 0 IPC channel(s) (0 paired), 2 window(s), 7 endpoint(s), 5 route(s). (path=D:\HackCode\references\opencode\packages\desktop)

### Design choice: OpenHack will use an original React renderer, narrow typed contextBridge, main-process agent runtime, safeStorage-protected secrets, direct OpenAI-compatible streaming, and extensible MCP/manifest-plugin contracts rather than copied source or branding.

- **Confidence:** Best guess (inferred)
- **Evidence:**
  - `ev_6fcca127d7fe62cd968c9672921e56b606675d7ca6d5d0311393fa4ccaabf2ab` — Electron app desktop 2.4.1: 254 source files, 0 IPC channel(s) (0 paired), 2 window(s), 7 endpoint(s), 5 route(s). (path=D:\HackCode\references\opencode\packages\desktop)

### Observed in the compiled OpenHack build: Electron main/preload/renderer output with esbuild, one BrowserWindow using sandbox + contextIsolation + nodeIntegration:false + webSecurity:true, a contextBridge, and a paired push event channel. Dynamic invoke channels remain a static-analysis limitation.

- **Confidence:** Worked it out (derived)
- **Evidence:**
  - `ev_0eff04284e0b5bb24265c8470df49c144f0348d8114d76971cef852ceaa1cdc6` — Electron app out: 4 source files, 1 IPC channel(s) (1 paired), 1 window(s), 4 endpoint(s), 0 route(s), bundled with esbuild. (path=D:\HackCode\openhack\out)

## Open questions

_None outstanding._

## How this was done

- **Mode:** Deep (the original's code and files could be read)
- **Engines:** builtin
- **Limitations:**
  - 2 IPC call(s) use a channel name computed at run time; they are not in the channel map.
  - 9 IPC call(s) use a channel name computed at run time; they are not in the channel map.
  - Only one page of module summaries is included; tools that take this evidence need every module, so pass the input path to them or use offset=0 with a limit above modules_total.
  - Static reading only: code built at run time (eval, computed requires, remote content) is invisible; IPC pairs need literal channel names.
  - The input listing was cut short; files beyond it were not read.
  - the ASAR listing was cut short by the file-count, depth, or path-byte limit
  - the kind is detected from the first bytes and, to break ties, the file name

## Handoff

OpenHack 0.1.0 is complete at D:\HackCode\openhack. Installer: release\OpenHack-Setup-0.1.0.exe. SHA-256: 0eef920bc5708f0840e81f7065972fac633ea6f1db5ea2041d8343301fa5144e. Validation: 34 Vitest tests pass; coverage statements 86.75%, branches 75.85%, functions 86.33%, lines 93.74%; 3 source Electron E2E pass; packaged launch/persistence smoke passes; opt-in live test imported Kimi + DeepSeek and completed a real DeepSeek chat. Key files: README.md, docs/ARCHITECTURE.md, docs/TDD-EVIDENCE.md. IMPORTANT LIMITS: installer is unsigned and was not executed; stdio MCP only; manifest plugins only; no attachments/auto-update. NEXT: operator will supply MCP/plugin targets. Add them in Extensions and test each with a fixture, keeping MCP tools on the execute approval path unless readOnlyHint is proven. Provider API keys are DPAPI-encrypted or remain file references resolved in main. Renderer/network boundary is enforced by sandbox, contextBridge, IPC allowlist, and packaged CSP.

## Evidence ledger

- `ev_4b92079ab18dac9d9d2e3916c98c7db69a1035143485b42b535ef324924472f7` **core_target_triage** — opencode is a folder (an app bundle, an unpacked app or a project). (Best guess)
- `ev_6fcca127d7fe62cd968c9672921e56b606675d7ca6d5d0311393fa4ccaabf2ab` **js_app_map** — Electron app desktop 2.4.1: 254 source files, 0 IPC channel(s) (0 paired), 2 window(s), 7 endpoint(s), 5 route(s). (Worked it out)
- `ev_77451607d1b6fafdbd1aebaa7c7a930976d08aa883adec1d00d370d471090ad1` **js_app_map** — JavaScript code app.asar: 0 source files, 0 IPC channel(s) (0 paired), 0 window(s), 0 endpoint(s), 0 route(s). (Worked it out)
- `ev_0eff04284e0b5bb24265c8470df49c144f0348d8114d76971cef852ceaa1cdc6` **js_app_map** — Electron app out: 4 source files, 1 IPC channel(s) (1 paired), 1 window(s), 4 endpoint(s), 0 route(s), bundled with esbuild. (Worked it out)

