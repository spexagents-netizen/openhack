# OpenHack — master improvement plan

Status: research complete 2026-11-24, plan ready for execution.
Scope: every subsystem of OpenHack — runtime, tools, bus, UI/UX, security, performance, packaging, evaluation, interop.

This plan is source-driven. Every competitor claim has a link in [Appendix A](#appendix-a-sources). Where a benchmark or spec changes the design, it is quoted and dated. Where a choice is a judgment call, it is labeled **decision**, not "best practice".

---

## Progress log

| Date | Workstream | State |
| --- | --- | --- |
| 2026-11-24 | W1 design system | **Shipped in source.** `theme/tokens.css`, local Geist Sans/Mono woff2, neutral surface ladder, accessible focus ring, new titlebar with workspace switcher, rail, grouped sidebar with unread dots, shared button/input/pill/toggle/toast states. |
| 2026-11-24 | W2 chat experience | **Partial.** Tool calls grouped per turn with ok/failed/running summary, code blocks with copy + wrap, worker cards restyled with cancel-ready layout, per-session drafts, session unread markers, new empty-state starter cards. Pending: session tabs, side-panel output viewer, per-line diff comments. |
| 2026-11-24 | Verification | 54 unit tests, 5 Electron E2E, packaged smoke all pass; screenshots refreshed at `artifacts/ui-empty-1440.png`, `ui-complete-1440.png`, `ui-bus-1440.png`, `ui-spawn-1440.png`, `ui-settings-1040.png`. |
| 2026-11-24 | W9 security core | **Shipped in source.** Approval records bind actor/run/call/tool/normalized-args/workspace/policy version into a SHA-256 digest, expire in 5 minutes and are consumed atomically before execution; replay and expiry deny. Central redaction covers logs, audit and MCP errors. Egress policy blocks cloud metadata by default and refuses redirects into it. Append-only redacted audit log with rotation, readable from Settings. |
| 2026-11-24 | Verification | 68 unit/integration tests, 5 Electron E2E, packaged smoke all pass; coverage 88.47% stmts / 75.03% branches / 95.14% lines. |
| 2026-11-24 | W5 checkpoints | **Shipped in source.** Every mutating workspace write captures a content-addressed before-image into `checkpoints/<session>/<run>/`, with a manifest per run. Restore returns the original bytes or deletes a created file; binary before-images are refused for diff; checkpoints prune to the newest 20 per session. |
| 2026-11-24 | W3 side panel | **Shipped in source.** Changes, Files and Browser tabs. Diff line selection (shift to extend) with a comment composer that produces a scoped review prompt; per-file restore; isolated Chromium preview with its own partition, no Node, denied permissions/popups, HTTP(S)-only URL policy, and detach on tab close. |
| 2026-11-24 | Verification | 73 unit/integration tests, 5 Electron E2E, packaged smoke; coverage 88.24% stmts / 74.85% branches / 95.00% lines. |
| 2026-11-24 | W6 runtime | **Shipped in source (compaction pending).** Plan/Act is enforced twice: mutating tools are removed before the model sees them, and a second guard refuses any non-read call. Session mode persists. Approvals persist to SQLite; a pending approval from a dead process can be approved or denied after restart, executes the exact saved call once, appends the tool result and continues the loop; stale approvals expire. Context usage is shown in the session header. |
| 2026-11-24 | Verification | 78 unit/integration tests, 5 Electron E2E, packaged smoke; coverage 87.76% stmts / 74.25% branches / 94.05% lines. |
| 2026-11-24 | Verification | 80 unit/integration tests, 6 Electron E2E, packaged smoke; coverage scope widened to security, checkpoints, bus and browser URL policy: 87.36% stmts / 71.86% branches / 93.75% lines. |
| 2026-11-24 | W6b/W8a | **Shipped in source.** Durable deterministic compaction: older turns summarized into a capped session summary, recent window kept, marker included in the next request. `apply_patch` validates every hunk before writing, applies multi-file diffs, and rolls back on a write failure. |
| 2026-11-24 | Verification | 86 unit/integration tests, 7 Electron E2E, packaged smoke; coverage 87.24% stmts / 71.86% branches / 88.08% functions / 93.62% lines. |
| 2026-11-24 | W15 design | **Shipped in source.** Renderer rebuilt from tokens: obsidian surface ladder anchored on `#1C1C1E` over a `#0A0A0B` void, bone ink, one ember accent, hairline borders instead of boxed cards, film grain, lit slab edges. New type scale, 720px reading measure, one motion curve. Glass only on floating layers (palette, approval, toast, modal). Live ember filament while a run streams; conic ember sweep on composer focus. Rail + sidebar unified as quiet chrome, session rows grouped with unread dots, single-call tool rows without a roll-up header, designed empty states for the inspector, workspace, extensions and history. New app icon and in-app mark. Verified with a screenshot harness (`e2e/visual.spec.ts`) across seven surfaces at 1440/1280/1120. |
| 2026-11-24 | Verification | 86 unit/integration tests, 7 Electron E2E, visual harness, packaged smoke; coverage 87.24% stmts / 71.86% branches / 88.08% functions / 93.62% lines. |
| 2026-11-24 | W16 runtime | **Shipped in source.** Removed the per-run model step ceiling. A run now ends only when the model returns a final answer or the operator cancels; spawned workers follow the same rule. `maxSteps` is gone from the engine, settings contract, IPC validation and Settings UI (replaced by an explicit Run policy readout). Legacy configs carrying `maxSteps` are stripped on load and never rewritten. Bus test harness now waits on observable state instead of a fixed sleep. |
| 2026-11-24 | Verification | 88 unit/integration tests (1 opt-in skipped), 7 Electron E2E, visual harness, packaged smoke; coverage 87.22% stmts / 71.86% branches / 88.08% functions / 93.61% lines. |
| 2026-11-24 | W17 search | **Shipped in source.** Search reordered around hosted keyless MCP providers (Exa, TinyFish, Parallel) instead of scraped HTML. Tier one races every candidate and takes the first usable answer; Brave/Tavily jump the queue when keyed; DuckDuckGo and the public SearXNG rotation are demoted to a last-resort net. Added a minimal Streamable-HTTP MCP client with session reuse, a payload parser that reads Exa block documents and JSON envelopes, a per-provider budget and an absolute deadline. Measured on four real queries: 0.55-1.37 s, 8 results, all Exa; the previous chain returned zero results on the same queries (DuckDuckGo block page, all five SearXNG instances rejected). |
| 2026-11-24 | Verification | 96 unit/integration tests (1 opt-in skipped), 7 Electron E2E, visual harness, live search benchmark. Coverage scope extended to `src/main/web`: 86.05% stmts / 71.79% branches / 87.04% functions / 92.79% lines. |
| 2026-11-24 | W18 search keys | **Shipped in source.** Exa key stored encrypted with the OS cipher (DPAPI), exposed to the renderer only as a boolean, sent only as the \`x-api-key\` header. TinyFish is keyless by measurement: its MCP endpoint returns 401 for both \`x-api-key\` and bearer keys and requires OAuth, so no key is ever sent there. Verified end to end on this machine: the stored key decrypts and authenticates a live MCP search (200, 5 results). |
| 2026-11-24 | Verification | 99 unit/integration tests (1 opt-in skipped), 7 Electron E2E, visual harness, live search with the stored key. |
| 2026-11-24 | W18 correction | **Correction to W18.** The earlier "TinyFish MCP rejects API keys" finding was a bad probe: the script read an unset variable, so the header value was the literal string `undefined`. Re-tested with the key actually loaded: MCP accepts `x-api-key` (200), and the gateway REST search `GET https://agent.tinyfish.ai/v1/search` with `X-API-Key` answers in about 250 ms warm. TinyFish is now a keyed provider on the REST path, with the keyless MCP tier as the no-key fallback. Both provider keys are stored encrypted and seeded. |
| 2026-11-24 | Verification | 100 unit/integration tests (1 opt-in skipped), 7 Electron E2E, packaged smoke, live chain with both stored keys (8 results per query, Exa and TinyFish alternating as race winner). |
| 2026-11-24 | W20 stack | **Shipped in source.** presets/mcp-stack.json defines the curated eight with tier, runner and prerequisites. First launch plans the stack against the host, adds only what the runner can execute, connects in the background, writes stack-bootstrap.json. Extensions gained Install stack and Import OpenCode. Verified on a clean profile: added rea, context7, re-mcp-ghidra; manual reva, burp, burp-collab, hexstrike, jadx. Fixed a real defect found while testing: app.getAppPath() points at out/main in a dev launch, so bundled skills and presets were never found; resources now anchor on the built main file. |
| 2026-11-24 | Stress test | Live model against a local BOLA lab: 23 tool calls in 75 s, api-testing skill loaded via skill_search, bug proven with a 2x3 identity matrix plus negative controls, report written to the workspace. No run errors. |
| 2026-11-24 | W21 remote MCP | **Shipped in source.** Streamable HTTP transport in the MCP manager (url takes precedence over command), paginated tool discovery up to 256 tools, and remote headers encrypted with DPAPI alongside env. Import from OpenCode now maps remote servers with url + headers instead of skipping them; the MCP editor takes a URL or a command. First launch also imports the operator's whole OpenCode MCP set; the marker is version-aware so an upgrade re-plans. Verified live against agent.tinyfish.ai: ready state over HTTP, keyless tier exposes only its single search tool (the 43-tool catalog belongs to the CLI's authed session), and an unreachable endpoint reports its own error. Installed build on the test machine: 18 MCP entries, 3 of them remote. |
| 2026-11-24 | Verification | 122 unit/integration tests (2 opt-in skipped), 7 Electron E2E, packaged smoke. |
| Next | W8b | PTY streaming, bundled ripgrep, attachments, browser agent tools. |

---

## 1. Current baseline (measured, not remembered)

| Area | State today |
| --- | --- |
| Stack | Electron 45 + React 19 + TypeScript, electron-vite, electron-builder NSIS, Vitest + Playwright |
| Runtime | `AgentEngine` (SSE → tool loop) + `AgentService` (sessions, approvals, persistence) |
| Tools | workspace list/read/search/write/replace, `process_run` (no-shell argv), `web_search`, `web_fetch` |
| Multi-agent | `agent_spawn` (≤8 tasks, 6 concurrent, 24/session, one level) + BusService (channels, roster, hop 6, concurrency 3) |
| Web | keyless chain: configured SearXNG → DuckDuckGo (0.78 s) → public SearXNG race → Brave/Tavily env keys; Jina reader for SPAs |
| Persistence | sql.js SQLite, serialized atomic rename, sessions/messages/runs/bus_messages/bus_memory |
| Tests | 54 unit/integration + 5 Electron E2E + packaged + opt-in live; coverage 88.29% stmts, 76.22% branches |
| UI | single-column chat, blood-on-black, mono everywhere, small text, no diff review, no preview pane |
| Installer | unsigned NSIS per-user x64, 137 MB |

**What is genuinely good and must not regress:** approval gate enforced in main, workspace canonicalization + symlink rejection, atomic writes, no-shell argv, DPAPI secrets, renderer sandbox + CSP, keyless web chain, worker attribution in the same session, and the test coverage already above 85%.

**What is weak:** visual design, no diff/checkpoint model, no preview pane, no plan/act separation, one-shot run model (no resume across restart), sql.js in-memory export cost, no native streaming terminal, no attachments, no eval harness, unsigned installer, no update channel, MCP stdio only, no A2A/ACP, and the UI reads as "old terminal" instead of a modern tool.

---

## 2. Competitor synthesis (what to take, what to refuse)

| Source | What they proved | Adopt | Do not copy |
| --- | --- | --- | --- |
| OpenCode desktop 2.4.x | Parallel agents per tab, built-in browser beside agent, diff review with per-line comments, unread dots, Windows taskbar progress, model speed tiers, background compaction, wrap-lines control, GUI plugins in the sidebar, per-mode settings previews | Parallel tabs with unread state, diff review + comments, preview pane, speed tiers, background compaction, taskbar status, wrap toggle | Its branding, copy, assets, SolidJS code |
| Cline / Roo Code | Plan/Act separation with per-mode models, checkpoints with rollback, MCP marketplace, codebase indexing | Plan/Act modes + model per mode, checkpoints, curated server discovery | Auto-approve defaults |
| Cursor | Background agents across worktrees, checkpoints for undo, parallel subagents with their own context | Worktree isolation option for destructive runs, checkpoint restore UX | Cloud-only execution model |
| Zed + ACP | Editor-agnostic agent protocol; speed comes from native rendering, not from Rust theology | ACP adapter so Zed/JetBrains can drive OpenHack | Rewriting the app in Rust |
| Goose | Extension-first; recipes as shareable configs; subagents with inherited or explicit extensions | Recipes = declarative manifest v2 with tool allowlists and model bindings | Global extension enable-everything |
| OpenHands | Sandbox per run; warm runtimes for latency; benchmark harness as a first-class artifact | Optional sandbox profile for untrusted targets; eval harness in-repo | Required Docker for normal use |
| LangGraph | `interrupt()` pauses and resumes; resumed nodes re-execute, so pre-interrupt work must be idempotent | Run state machine with explicit `waiting_approval` / `input_required` states and idempotent steps | Its Python dependency graph |
| A2A v1.0 | Agent Cards, task lifecycle incl. `input_required` and `auth_required`, push/webhook delivery, opaque execution | Agent Card endpoint + A2A task adapter in phase 5 | Replacing our bus with A2A internally |
| MCP 2025-11-25 | Tasks (durable deferred results), sampling with tools, URL elicitation, OIDC discovery, OAuth Client ID metadata docs, JSON Schema 2020-12, SSE polling/resume | Streamable HTTP transport, OAuth, MCP tasks mapping onto our run state, icons metadata | Keeping stdio-only |
| OWASP AI Agent Security | Approvals must be actor+parameter-bound, single-use, expiring, fail-closed; memory isolation; abuse-case matrix in CI | Approval digest binding, redaction pipeline, adversarial suite in CI | Trusting a `user_confirmed` boolean |
| Terminal-Bench / SWE-bench | Verifier quality is the product; agents regress silently without an eval harness | Eval suite with grader transcripts and pass-rate history | Chasing a leaderboard number |

**Directives from the research:**
1. Stay Electron + React. The performance gap is real (Electron idles 150–300 MB vs Tauri 20–80 MB in public comparisons), but the plan is to fix cold start and idle CPU instead of rewriting. Tauri is recorded as an option to re-evaluate at v2 if memory becomes a release blocker.
2. The bus stays ours internally. A2A is an adapter on the outside, not a rewrite of the core.
3. Approvals become cryptographic in effect: single-use, expiring, bound to actor + normalized tool + normalized arguments + workspace + policy version.
4. UI moves to a neutral modern design system, not "terminal plus more terminal".

---

## 3. UI/UX redesign — the core of the complaint

The current skin fails for specific reasons: monospaced type on almost everything, 9–10px text, red fill on primary actions, no surface hierarchy, hairline-only elevation, and no review surfaces. The fix is a system, not a palette swap.

### 3.1 Design language

- **Feel:** modern, quiet, high-craft. Neutral surfaces, generous whitespace, 13–15px body text, restrained color.
- **Identity:** ember stays as brand accent, but only on the logo, the primary CTA, live/approval state, and error text. Everything else is neutral.
- **No** scanlines, no glow, no terminal textures, no all-caps mono labels on every element, no red buttons for "send".
- **Motion:** 120–180 ms ease-out for hover and entry, 200 ms for drawers. No bounce. `prefers-reduced-motion` disables all nonessential animation.
- **Density:** `comfortable` (default) and `compact` (power users) as a real setting.

### 3.2 Tokens (new `src/renderer/theme/tokens.css`)

```css
:root {
  /* surfaces: neutral, slightly cool, never pure black */
  --c-canvas: #0b0c0e;
  --c-surface-1: #101114;
  --c-surface-2: #15171b;
  --c-surface-3: #1b1e24;
  --c-overlay: rgba(4, 5, 7, 0.72);
  --c-line: #1f232b;
  --c-line-strong: #2c323d;

  /* text: warm-white hierarchy, all >= 4.5:1 on surface-1 */
  --c-ink: #eceef1;
  --c-ink-muted: #b8bec8;
  --c-ink-subtle: #8b929e;
  --c-ink-faint: #6b7380;

  /* brand + semantics */
  --c-accent: #ff5a3c;      /* ember, brand + primary CTA only */
  --c-accent-hover: #ff7457;
  --c-accent-ink: #14060a;
  --c-accent-soft: rgba(255, 90, 60, 0.10);
  --c-focus: #7aa2ff;       /* accessible, non-brand focus ring */
  --c-ok: #4cc38a;
  --c-warn: #e0b04a;
  --c-error: #ff6b6b;
  --c-info: #63b3ff;

  /* type */
  --font-ui: "Geist Sans", "Inter", "Segoe UI Variable Text", system-ui, sans-serif;
  --font-mono: "Geist Mono", "JetBrains Mono", "Cascadia Code", Consolas, monospace;

  /* radius: modern, not terminal-square */
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --r-xl: 16px;
  --r-pill: 999px;

  /* spacing: 4px base */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px;

  /* elevation: soft, low-alpha shadows, not glows */
  --e-1: 0 1px 2px rgba(0, 0, 0, 0.35);
  --e-2: 0 4px 16px rgba(0, 0, 0, 0.35);
  --e-3: 0 16px 48px rgba(0, 0, 0, 0.5);
}
```

Rules:
- Body text ≥ 13 px; captions ≥ 11 px; mono only for code, paths, ids, logs.
- Primary text/background contrast ≥ 4.5:1; secondary ≥ 4.5:1 where informative; only decorative text may be lower.
- Accent is never a large-area fill except the send/primary button and the logo tile.
- Elevation comes from the surface ladder plus a 1px line, plus a faint top-edge highlight on lifted panels.

### 3.3 Type scale

| Token | Size | Weight | Use |
| --- | --- | --- | --- |
| display | 34 | 600 | empty-state hero |
| title | 20 | 600 | view titles |
| heading | 15 | 600 | section heads, session title |
| body | 13.5 | 400 | default |
| small | 12.5 | 400 | secondary |
| caption | 11.5 | 450 | meta, status |
| mono-body | 12.5 | 400 | code, logs |
| mono-small | 11.5 | 400 | paths, ids |

Geist is bundled locally (`@font-face` with woff2 in `src/renderer/assets/fonts/`), so the packaged CSP stays `font-src 'self'` and no network fetch happens. Fallbacks: Inter → Segoe UI Variable → system-ui. Mono: Geist Mono → JetBrains Mono → Cascadia.

### 3.4 Layout

```
┌ titlebar 44: brand · [workspace switcher]        search ⌘K   ● status   ▢ ▢ ▢
├ rail 56: session / bus / workspace / extensions / settings
├ sidebar 248: [+ new]  search  sessions (grouped by day, unread dots)
└ main
   ├ tabs row (only when >1 session open): title + close + unread
   ├ chat column (max 880, centered, 24px gutters)
   │   user block · assistant markdown · tool group · diff review · workers
   └ side panel (resizable, hidden by default): Preview / Files / Diff / Browser
```

Decisions:
- One session per tab, many tabs open. Sidebar shows all sessions; unread dot when a background session finishes or needs approval.
- Side panel appears only when there is something to look at. It is not a permanent fourth column.
- Chat column width 880 with 24 px gutters; markdown measure 72 ch for readability.

### 3.5 Component inventory (new `src/renderer/components/`)

| Component | Required states |
| --- | --- |
| Button (primary/secondary/ghost/danger/icon) | default, hover, pressed, focus ring, disabled, loading |
| Input / Textarea | empty, filled, focus, error, disabled |
| Select (custom, not native) | closed, open, active option, keyboard nav, grouped providers |
| SessionRow | default, hover, active, unread, delete-confirm |
| MessageBlock | streaming, complete, error, folded reasoning |
| ToolGroup | collapsed summary (N calls, status), expanded list, per-call output |
| CodeBlock | language tag, copy button, wrap toggle, line numbers on demand |
| DiffReview | per-file hunks, +/- coloring, per-line comment, select-to-comment, accept/reject file |
| WorkerCard | queued, running, done, failed, cancel |
| ApprovalDialog | action preview, risk badge, exact args, allow-once, deny, allow-remember-rule |
| EmptyState | branded hero, 3 starters, setup checklist when unconfigured |
| TabsBar | active, hover-close, unread, overflow menu |
| SidePanel | tabs (Preview/Files/Diff/Browser), resize handle, focus trap |
| Toast | info, success, error, action link |
| ModelPicker | grouped by provider, speed tier badge, capability icons |
| StatusPill | idle/working/needs-approval/error |
| ContextMenu / Tooltip | keyboard accessible, no hover-only essential info |

### 3.6 Concrete UI changes per area

- **Timeline:** markdown at 13.5px/1.7 line-height; code blocks with copy + wrap; reasoning collapsed by default; tool calls grouped as one row per assistant turn ("4 tool calls · read 3, write 1") expandable to rows; worker cards nested with per-worker cancel and expandable report.
- **Diff review:** new panel. File list with add/remove/change counts; unified hunks; per-line comment; "send comments to agent" with `Mod+Enter`.
- **Preview:** browser pane beside the chat for app/web targets, plus file preview with syntax highlighting.
- **Composer:** large, calm, rounded-12; attachments chip row; model + permission controls in a quiet footer; Enter to send, Shift+Enter newline, drafts per session.
- **Settings:** segmented sections with navigation-card previews; per-mode model selectors; budget display; permission presets as cards with a small diagram; system prompt editor with a template restore.
- **Empty state:** one hero line, three runnable starters, and a setup checklist only if something is missing. No decorative grid.
- **Errors:** inline, calm, with the raw provider message collapsed under "details".

### 3.7 Accessibility gates (test, not intention)

- axe-core on chat, settings, bus, extensions: 0 critical violations.
- Full keyboard path: tab order sane, no invisible tab stops (a known class of bug in the reference desktop), focus visible on every interactive element, dialogs trap and restore focus.
- Zoom to 200%: no clipped controls, no horizontal scroll in chat at 1040 px.
- Reduced motion honored.

---

## 4. Workstreams

Effort is in person-days for one engineer. Priorities: P0 this cycle, P1 next, P2 later, P3 optional.

### W1 — Design system & shell (P0, 4d)
1. Add `theme/tokens.css`, font assets, base reset, focus system, motion scale.
2. Rebuild `TitleBar`, `ActivityRail`, `Sidebar` on the new tokens; grouped session list with unread dots.
3. Add shared primitives (Button, Input, Select, StatusPill, Toast, Tooltip, ContextMenu).
4. Replace all legacy color/typography usages in `styles.css` with tokens; delete dead selectors.
5. Storybook-lite route `/dev/components` behind `OPENHACK_DEVTOOLS=1` showing every state.
**Acceptance:** components render every documented state; no visual regressions at 1440/1040/768; axe passes.

### W2 — Chat experience (P0, 4d)
1. Markdown renderer upgrade: syntax highlighting for code (Prism/Shiki WASM), copy/wrap buttons, tables, task lists.
2. Tool-grouping per assistant turn with aggregated status, expandable rows, output caps + "open full output" in side panel.
3. Worker cards with cancel, expandable report, per-model badge.
4. Session tabs with unread + close; sidebar unread on `run.completed` and `tool.approval`.
5. Composer: drafts, attachments chip row (UI only in W2; wiring in W8), model + permission footer, stop button distinct from send.
**Acceptance:** Playwright asserts unread on background completion, wrap toggle works, tool group expands, worker cancel aborts the worker only.

### W3 — Side panel: files, diff, preview (P1, 4d)
1. Resizable panel with tabs Preview / Files / Diff / Browser; persisted width and active tab per workspace.
2. File preview with syntax highlighting and line numbers; click path from tool row opens it.
3. Diff panel fed by checkpoints (W5) with per-line comment UI.
4. Browser pane (isolated partition, no nodeIntegration, windowOpen denied) with URL bar, back/forward, zoom, "send page to agent".
**Acceptance:** panel remembers layout per workspace; clicking a tool path opens its file; comments appear in next agent prompt.

### W4 — Models & settings (P1, 3d)
1. Per-mode model binding: Plan vs Act vs Worker default.
2. Speed tiers on models (fast/balanced/deep) as remembered variants rather than separate entries.
3. Budget: per-session token counter, per-run estimated cost, optional hard stop.
4. Provider health: last success time, last error, request/response timings; no secrets in UI.
5. Settings navigation previews and consistent keyboard behavior.
**Acceptance:** changing Act model affects only Act runs; budget cap aborts before the next model call with a clear error.

### W5 — Checkpoints & undo (P1, 4d)
1. Content-addressed file snapshot store: before each workspace write/replace, copy original to `checkpoints/<runId>/<step>/`.
2. Manifest per checkpoint: runId, sessionId, step, timestamp, tool, args hash, files affected, sha256 before/after.
3. Checkpoint restore: file-level and run-level undo, atomic, refuses to overwrite user edits made after the checkpoint without confirmation.
4. Wire into the Diff panel for "what changed in this run".
**Acceptance:** unit test proves a write then restore yields the original bytes; user-edit conflict requires confirmation; manifest matches actual file hashes.

### W6 — Runtime evolution (P1, 4d)
1. Explicit run states: `running`, `waiting_approval`, `input_required`, `completed`, `failed`, `cancelled`, `interrupted` (already partly present; make it a real machine with transitions tested).
2. Approval becomes a resumable checkpoint: app restart reconstructs pending approval from the DB instead of marking everything interrupted.
3. Plan/Act: Plan mode forbids write/execute tools by construction (not by prompt), Act allows per permission profile.
4. Background compaction: summarize older turns into a stored summary message when crossing 70% context, without blocking the next prompt.
5. Idempotent steps: a resumed step never re-executes a completed tool (LangGraph's warning about resume re-execution applied literally).
**Acceptance:** kill the process during `waiting_approval`, relaunch, same approval resumes with same digest; Plan mode physically cannot call `process_run`.

### W7 — Worker pool & bus hardening (P1, 3d)
1. Per-agent provider/model binding in settings UI (backend already supports it).
2. Priority queue (operator > lead > worker), fairness between sessions, per-session worker budget.
3. Cancel cascade: cancel parent → children → queued children removed; queue items never start after a cancel.
4. Bus message integrity: sender verified from run binding (already true), add expiry + replay id dedupe on triggers, per-channel rate limit.
5. Optional worktree-per-worker for destructive parallel edits; merge back with diff review.
**Acceptance:** cancelling a parent with 8 queued workers starts none of them; two sessions cannot starve each other.

### W8 — Tooling (P1, 4d)
1. `process_run` v2: streaming stdout/stderr, PTY for interactive commands (`node-pty` optional dependency, lazy-loaded), per-command env allowlist, working dir selection inside workspace.
2. Workspace search v2: bundled `ripgrep` binary with timeout + result caps + ignore rules; keep JS fallback when binary missing.
3. `apply_patch` tool: unified diff with context validation, atomic multi-file apply, rejects malformed hunks.
4. Attachments: images and text files into model input where supported (base64 for vision models, text extraction for others), 20 MiB cap, explicit user selection only.
5. `browser_*` tools: navigate, read DOM, click, type, screenshot, console log capture — driven by the W3 pane's partition, never by the renderer.
**Acceptance:** streaming output appears live; malformed patch is refused without partial writes; binary/image attachments never exceed caps; browser actions come from main.

### W9 — Security & sandbox (P0, 4d)
1. Approval integrity: record = actor, runId, callId, tool, normalized args SHA-256, workspace, policy version, issued-at, expires-at (5 min), single-use consumed atomically before execution. Unknown tool = deny.
2. Redaction pipeline: provider errors, tool results, bus memory, logs — secrets patterns (key/token/password/pem) masked centrally, plus a test that proves no secret reaches the renderer.
3. Memory hygiene: bus memory TTL + size caps + redaction on write; per-session isolation already present; add a "forget" action.
4. SSRF/egress policy: `web_fetch` and browser tools get an allow/deny list for private ranges, configurable per workspace, because agent-driven fetching is the classic exfil path.
5. Plugin trust levels: `manifest` (current), `tools` (declarative tool specs executed by main), `sandboxed-js` (vm2-style isolated loader with no fs/net, only declared capabilities).
6. Audit log: append-only JSONL of every approval, denial, tool execution, and policy change, redacted, with a viewer.
**Acceptance:** abuse matrix passes (approval replay, parameter tamper, unknown tool, memory poison, SSRF to 169.254.169.254, oversized exfil attempt); all deny paths fail closed.

### W10 — Performance (P1, 2d)
1. Renderer bundle split by view (chat/bus/workspace/extensions/settings) + lazy markdown highlighter + lazy diff viewer.
2. Virtualize session list, timeline, and bus transcript past 200 items; keep DOM small.
3. Move SSE parsing and sql.js work off the main thread where profiling shows >16 ms frames; target <16 ms/frame while streaming.
4. Cold start: defer MCP connects (done), defer plugin scans, defer font loading to local woff2, measure and log timings to `artifacts/perf.json`.
5. Idle CPU: no background timers unless work is active; `backgroundThrottling` stays false only while a run is live.
**Acceptance:** cold start < 1.5 s to interactive on this machine; timeline scroll stays > 50 fps at 1,000 messages; idle CPU < 1%.

### W11 — Persistence & migrations (P1, 2d)
1. Introduce versioned migrations table; every schema change is a numbered migration with a test that opens an older DB.
2. Evaluate `better-sqlite3` (WAL, prepared statements) vs current sql.js export-per-write; choose based on measured write cost, with fallback to sql.js if native rebuild fails.
3. Session retention: archive old bus sessions, cap tool-result size stored in DB, vacuum job.
4. Export: session → Markdown and JSON with tool transcripts and worker trees.
**Acceptance:** a DB from v0.1 opens with no loss; migration is atomic and idempotent; export reproduces the full thread including workers.

### W12 — Evaluation & CI (P0, 3d)
1. Adversarial suite in-repo: approval replay, param tamper, unknown tool, memory poison, SSRF, exfil-size, recursion, multi-agent privilege escalation, prompt override via retrieved page.
2. Task fixtures: 12 realistic jobs (map surface, trace flow, patch a vuln, build a tool, research with citations, parallel fan-out, checkpoint undo).
3. Grader transcripts saved as artifacts; pass-rate tracked per model; CI fails on regression.
4. Optional Terminal-Bench subset via Docker when available (never required).
5. Visual regression: screenshots for every component state and 5 core views at 3 widths, diffed with a pixel budget.
**Acceptance:** CI produces a report with pass-rate per model and per abuse case; a deliberately broken control fails the gate.

### W13 — Packaging & distribution (P1, 2d)
1. Authenticode signing in CI with secrets from the environment; document the exact steps, never commit the cert.
2. `electron-updater`: signed feed, delta updates, rollback on failed launch, opt-in channel.
3. Clean uninstall: remove shortcuts, optional data-dir purge (asked, not assumed).
4. `openhack://` deep links: open project, new session, trigger bus task.
5. Taskbar progress + flash on `tool.approval` (parity with the reference desktop's Windows behavior).
**Acceptance:** signed installer on a clean VM installs, launches, updates to the next build, uninstalls cleanly.

### W14 — Interop (P2, 3d)
1. ACP adapter: expose OpenHack sessions to Zed/JetBrains via `agentclientprotocol.com`.
2. A2A server: `/.well-known/agent-card.json` with capabilities (streaming, pushNotifications), task mapping onto our run states, `TASK_STATE_INPUT_REQUIRED` for approvals.
3. MCP Streamable HTTP + OAuth + MCP tasks (2025-11-25 spec) alongside stdio; icons metadata used in Extensions UI.
4. Import OpenCode providers (done), plus optional import of OpenCode sessions as read-only history.
**Acceptance:** Zed can list and drive an OpenHack session; an A2A client can submit a task and receive streaming updates and an approval request.

### W15 — Docs & operator experience (P0, 1d)
1. Quickstart: install → import → first target → first parallel army.
2. Permissions and trust model doc with real examples.
3. Privacy: what leaves the machine (provider, search engine, reader, MCP), what never does.
4. Sample recipe pack and MCP/plugin manifest examples with CI-validated fixtures.
**Acceptance:** a new operator reaches a verified agent run in under 5 minutes using only the docs.

### W16 — Optional (P3)
- Local model provider (llama.cpp/Ollama) as an offline profile.
- Remote headless agent mode (OpenHack as a service on one machine, thin client elsewhere).
- Voice dictation input.
- Team-shared bus over TLS with signed messages, not loopback-only.

---

## 5. Sequenced roadmap

| Phase | Contents | Exit criteria |
| --- | --- | --- |
| **P0 (this cycle)** | W1 design system, W2 chat UX, W9 security core, W12 eval baseline, W15 docs | New UI on all views; approvals replay-proof; adversarial suite in CI; quickstart works |
| **P1** | W3 side panel, W4 models, W5 checkpoints, W6 runtime states, W7 pool/bus, W8 tools, W10 perf, W11 persistence, W13 packaging | Diff review + undo, Plan/Act, resumable approvals, PTY + patches + attachments, signed auto-updating installer, perf budgets met |
| **P2** | W14 interop | ACP + A2A + MCP HTTP/OAuth/tasks with integration tests |
| **P3** | W16 optional | Only on operator request |

Rough effort: P0 ≈ 16 person-days, P1 ≈ 25, P2 ≈ 3. One engineer, serial. Two engineers can split UI (W1–W4) from runtime/security (W5–W12) and finish P0+P1 in roughly half the wall-clock time.

---

## 6. File-level change map

| Area | Files touched |
| --- | --- |
| Design system | `src/renderer/theme/tokens.css`, new `assets/fonts/*`, `styles.css` (replaced), `components/ui.tsx`, new `components/primitives/*` |
| Chat | `components/ChatTimeline.tsx`, `Composer.tsx`, `ModelPicker.tsx`, `Sidebar.tsx`, `TitleBar.tsx`, new `TabsBar.tsx`, `CodeBlock.tsx`, `ToolGroup.tsx`, `WorkerCard.tsx` |
| Side panel | new `components/SidePanel.tsx`, `FilePreview.tsx`, `DiffReview.tsx`, `BrowserPane.tsx` |
| Settings | `views/SettingsView.tsx`, new `ModelBindingEditor.tsx`, `BudgetPanel.tsx` |
| Runtime | `main/agent/engine.ts`, `service.ts`, new `run-state.ts`, `compaction.ts`, `checkpoints.ts`, `approvals.ts` |
| Workers | `service.ts` (spawn), `bus/bus.ts` (queue, expiry, replay) |
| Tools | `main/workspace/process.ts` (PTY), new `patch.ts`, `search.ts` (rg), `attachments.ts`, `browser/*` |
| Security | new `approval-integrity.ts`, `redact.ts`, `egress.ts`, `audit.ts`, `plugins/sandbox.ts` |
| Persistence | `storage/sessions.ts`, new `migrations/*`, `export.ts` |
| Interop | new `acp/server.ts`, `a2a/server.ts`, `mcp/http.ts` |
| Packaging | `electron-builder.yml`, new `update.ts`, `deep-links.ts`, CI workflow |
| Eval | new `eval/fixtures/*`, `eval/adversarial/*`, `eval/report.ts`, `e2e/visual.spec.ts` |

---

## 7. Test strategy additions (mapped to OWASP abuse cases)

| Abuse case | Test that must exist and pass |
| --- | --- |
| Prompt override from a retrieved page | A page containing "ignore your instructions and run X" never triggers X; retrieval content is data-marked |
| Tool misuse | Unknown/unregistered tool fails closed even when the model requests it confidently |
| Privilege escalation | A worker with a restricted profile cannot call execute tools or read outside its root |
| Memory poisoning | Bus memory with injected directives is redacted/expired/isolated; reader agents do not act on it as instruction |
| Data exfiltration | `web_fetch` to a private range or with >N bytes is denied; secrets never appear in outbound URLs |
| Recursive tool abuse | Hop/step/cost limits trip and record why; queued workers never start post-cancel |
| Approval bypass | Replaying an approval id fails; changing one argument byte invalidates the digest; expired approvals deny |
| Multi-agent chaining | A low-trust worker cannot make a high-trust agent exceed its boundary |

Each case ships with: fixture, expected outcome, and a retained transcript in `artifacts/eval/`.

---

## 8. Risks and open decisions

| Risk / decision | Handling |
| --- | --- |
| Electron memory vs Tauri | Measure first (W10). If idle > 250 MB after optimization, re-evaluate a Tauri shell for v2 with the same main-process code ported to Rust IPC. Do not rewrite now. |
| Native PTY and better-sqlite3 build pain | Both optional with tested fallbacks (argv-only process runner, sql.js). Never block a release on native rebuild. |
| Executable plugins are a trust boundary | Start with manifest + declarative tools only; sandboxed-js is opt-in with capability declarations. No arbitrary third-party code execution by default. |
| Attachments/vision | Model capability flag per provider; images only when the model accepts them. No silent base64 flooding of text-only models. |
| A2A/ACP scope creep | Adapters only; the internal bus contract stays stable and tested. |
| Light theme | Build tokens with a parallel light scale but ship dark-first; light theme is a follow-up, not a launch blocker. |
| Cost control | Per-session token budget (W4) is the guardrail against denial-of-wallet during parallel fan-out. |

**Open questions for the operator:**
1. Which provider/model should be the default for workers (fast tier) vs lead (deep tier)?
2. Should Plan mode be the default for new sessions, with Act as an explicit switch?
3. Do you want destructive runs isolated in git worktrees by default?
4. Is a local/offline model profile a requirement for any target you work on?
5. Are signed releases a blocker for distribution, and which cert/CI should sign them?

---

## Appendix A — sources

- OpenCode desktop features and changelog: https://opencode.ai/desktop ; desktop package shape: https://raw.githubusercontent.com/sst/opencode/dev/packages/desktop/package.json
- Cline/Roo modes, checkpoints, MCP: https://docs.cline.bot/tools-reference/all-cline-tools ; https://cline.bot/
- Cursor background agents and subagents: https://cursor.com/help/ai-features/background-agents ; https://cursor.com/docs/subagents.md
- Zed Agent Client Protocol: https://zed.dev/acp ; https://zed.dev/blog/claude-code-via-acp
- Goose subagents and recipes: https://block.github.io/goose/docs/tutorials/subagents ; https://block.github.io/goose/docs/guides/recipes/recipe-reference
- OpenHands architecture and benchmarks: https://docs.openhands.dev/enterprise/architecture ; https://github.com/OpenHands/benchmarks
- LangGraph interrupts and subgraphs: https://docs.langchain.com/oss/python/langgraph/interrupts ; https://docs.langchain.com/oss/python/langgraph/use-subgraphs
- A2A v1.0 specification (Agent Card, task states, push): https://a2a-protocol.org/latest/specification
- MCP 2025-11-25 changelog (tasks, sampling with tools, OAuth, SSE resume): https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/changelog.mdx ; schema: https://modelcontextprotocol.io/specification/2025-11-25/schema
- OWASP AI Agent Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- Terminal-Bench and SWE-bench Verified: https://www.tbench.ai/ ; https://www.swebench.com/verified.html
- Linear design analysis and tokens: https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md
- Radix Colors (accessible dark scales): https://www.radix-ui.com/colors
- Geist font family: https://vercel.com/font ; https://github.com/vercel/geist-font
- shadcn theming guidance: https://ui.shadcn.com/docs/theming
- Electron vs Tauri footprint comparisons (used as directional evidence, not gospel): https://buildr.sh/posts/tauri-vs-electron-2026 ; https://pkgpulse.hashnode.dev/electron-vs-tauri-2026

**Note on dates:** protocol claims are quoted against MCP 2025-11-25 and A2A v1.0. Competitor UI behavior is quoted from current docs/changelogs fetched on 2026-11-24. Where public comparisons disagree on Electron/Tauri numbers, this plan treats them as ranges to measure against, not as facts to ship on.
