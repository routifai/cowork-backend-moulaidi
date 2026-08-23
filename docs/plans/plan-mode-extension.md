# Plan-mode extension (Claude-Code-style plan → approve → execute)

**Superseded by [ADR 0001](../adr/0001-use-narumitw-pi-plan-mode.md).** The
"no standalone pi planner package exists" premise below turned out to be
wrong — `@narumitw/pi-plan-mode`, a real published npm extension, was found
after this doc was written. `plan-mode.ts` (verdict 1 / steps below) is
being removed, not kept as a fallback. Kept here for the verdicts on
subagent delegation and background sessions (2 and 3), which still stand.

Status: planned, not started.
Scope: `hypatia-backend` only (possibly a small `hypatia-frontend` touch if
the toggle mechanism needs it — confirmed during implementation, not
assumed up front).

## Problem / origin

Asked to research a "pi planner extension" and a "subagent-spawning"
extension, and judge honestly whether either is worth integrating to mimic
Claude Code's plan mode — or whether it's over-engineering for what
Hypatia's current setup already handles. This required real source-level
verification across three separate research rounds (the first two targets
turned out to be different from what they first appeared).

## Verdicts

### 1. Plan mode → build it (this doc)
No standalone "pi planner" package exists. The real match is `plan-mode`,
an official example extension shipped **inside the installed
`@earendil-works/pi-coding-agent@0.80.10` package**
(`node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts`).
Purely additive (event hooks only — `before_agent_start`, `tool_call`,
`setActiveTools`, never touches pi's core loop). Verified Hypatia can
actually run it: `ctx.ui.select()`/`ctx.ui.editor()` are real, fully-wired
end-to-end (`hypatia-backend/src/extension-ui-bridge.ts:111-138` →
`hypatia-frontend/src-tauri/src/lib.rs` → `useExtensionUi.ts` →
`ExtensionUiDialog.tsx`), and `pi.setActiveTools`/`pi.on("tool_call")`/
`pi.on("before_agent_start")` are all real, currently-declared SDK APIs.
Its tool-list management is defensive (calls `pi.getActiveTools()` first,
only strips `edit`/`write`), so Hypatia's own custom tools (`show_artifact`,
`save_memory`, `find_skill`) survive it untouched.

Three concrete problems found and designed around (see "Target design"
below for the fix):
1. Its progress tracking is fragile regex-parsing of `[DONE:n]` markers out
   of free text — redundant with the already-installed, already-loaded
   `~/.pi/agent/extensions/todo.ts`, which is a real structured task tool
   (functionally equivalent to Claude Code's `TodoWrite`).
2. Its own bash-gating conflicts with the already-installed and
   already-tuned `~/.pi/agent/extensions/permission-gate.ts` — traced the
   actual event-dispatch code (`dist/core/extensions/runner.js:656-674`)
   and found a concrete case: plan-mode's allowlist permits `curl`
   (assuming silent execution), but permission-gate flags `curl` for
   confirmation regardless, since both handlers run and neither blocks in
   isolation — breaking the "uninterrupted read-only planning" premise.
3. Its restricted tool set references `questionnaire`, which isn't a real
   SDK tool but a second example extension that itself depends on
   `ctx.ui.custom()` — a stub in Hypatia
   (`extension-ui-bridge.ts:167`: `async () => undefined as never`).

### 2. Subagent delegation (pi-subagents npm package) → skip
Verified against the actual real package the user meant
([pi-subagents](https://pi.dev/packages/pi-subagents), `nicobailon`,
v0.37.2) by downloading and reading its source directly, not trusting docs.
It's genuinely well-engineered (background job tracking, fleet TUI,
watchdog, chains — 130+ files), with a smarter binary-resolution chain than
a naive approach. But it fundamentally works by spawning a separate,
independently-authenticated child `pi` CLI process. Traced its exact
resolution logic against Hypatia's real bundled resources
(`hypatia-frontend/src-tauri/tauri.conf.json:47` — sidecar JS, bundled
Node, `git`/`gh`; no `pi` binary, no `node_modules`) and confirmed every
resolution branch fails in a packaged build, falling through to a bare `pi`
PATH lookup that finds nothing on a real user's machine. Even if a binary
were found, the spawned child gets no working auth: Hypatia's embedded
Anthropic key is baked in as a build-time string literal
(`scripts/prebuild.mjs:70`), never exposed via `process.env`, never
persisted to `~/.pi/agent/auth.json`. **This would appear to work in local
dev (where a real pi CLI/node_modules often exist) and silently fail for
every real packaged-app user** — a dangerous trap, not a simple gap.
**Decision: do not adopt. Revisit only with a concrete need**, and treat
"make spawned subagents work in a packaged build" as its own dedicated
packaging/security project if that day comes — not bundled into this plan.

### 3. Background/concurrent sessions → real finding, deliberately deferred
User separately raised wanting Cursor-style background agents (start a
task, it keeps running, start a second session meanwhile). Verified
Hypatia's actual architecture is a strict single-session app end to end:
`AppContainer.session`/`sessionManager`/`resourceLoader` are singular
process-wide fields (`hypatia-backend/src/app/container.ts:12-23`, doc
comment: *"the sidecar is single-threaded by design"*), and both
`spawnSession()` and `handleLoadSession` unconditionally call
`deps.session.abort()` on whatever was previously running before replacing
it (`hypatia-backend/src/commands/handlers/sessions.ts:42,134` — exact
lines, confirmed). The frontend mirrors this: one `usePiStream()` instance,
one `StreamState`, no "running in background" concept on any session-list
entry. Nothing in the pi SDK itself blocks multiple concurrent
`AgentSession` objects in one process, except one real shared-state gotcha
worth remembering later: `AgentSession.reload()` calls a **process-global**
`resetApiProviders()` in `@earendil-works/pi-ai`'s `compat.js:48-120`,
which would affect every concurrent session in the same process.
**User's decision: scope this as its own dedicated plan later** — it's a
real backend (per-session state) + frontend (multi-session live status UI)
architecture change, much bigger than plan-mode. Findings captured here so
future planning doesn't have to re-derive them.

## What this doc covers
Only the plan-mode extension (verdict 1). Verdicts 2 and 3 are decisions,
not further work items, for now.

## Steps

### 1. Resolve the toggle mechanism — resolved
- [x] Confirmed the gap and the fix. `MessageInput.tsx:290-322`: when the
  composer text starts with `/`, the palette takes over Enter entirely —
  if it doesn't match an entry in `BUILTIN_COMMANDS`, the keystroke is
  swallowed and nothing is sent, not even as plain text. So a bare
  `pi.registerCommand("plan", ...)` on the backend would be unreachable —
  the frontend never lets a raw `/plan` through.
  However, the SDK's `session.prompt()` *already* special-cases registered
  commands before treating text as a normal turn — confirmed in
  `agent-session.js:803-806`: `if (expandPromptTemplates &&
  text.startsWith("/")) { const handled = await
  this._tryExecuteExtensionCommand(text); ... }`, and
  `_tryExecuteExtensionCommand` (`agent-session.js:927-934`) strips the
  leading `/`, looks up the command by name, and runs its handler —
  "handles extension commands... immediately, even during streaming" per
  the method's own doc comment.
  **Fix**: add a `"plan"` entry to `hypatia-frontend/src/lib/builtinCommands.ts`'s
  `BUILTIN_COMMANDS`, whose `run(ctx)` calls a new `ctx.sendMessage(text)`
  action (one new field on `CommandContext`, wired in `App.tsx`'s
  `handleRunCommand` to the existing `handleSend`). This makes `/plan`
  reachable through the *existing* composer palette (it now matches a real
  command, so the swallow-if-unmatched gate no longer applies) and routes
  through the *existing* `handleSend` → `session.prompt()` path — no new
  Tauri command, no new RPC handler, reuses 100% existing plumbing.
  Accepted tradeoff: if triggered while a turn is actively streaming, it
  queues behind the current turn via Hypatia's own prompt-scheduler
  (`prompt-scheduler.ts`) rather than firing instantly — acceptable for v1
  since toggling before the next message, not mid-stream, is the primary
  use case; documented as a known limitation, not silently ignored.

### 2. Create `plan-mode.ts` — done
- [x] `hypatia-backend/src/extensions/plan-mode.ts` (+ `plan-mode.test.ts`,
  15 tests, all passing), following the established
  `pi.registerCommand`/`pi.on(...)` extension-factory pattern already used
  by `save-memory.ts`/`find-skill.ts` (no options object needed here since
  there's no external I/O dependency to inject — pure in-memory state).
- [x] Entering plan mode: `pi.registerCommand("plan", ...)` captures
  `pi.getActiveTools()` once, then `pi.setActiveTools([...current tools
  minus edit/write, plus read/bash/grep/find/ls/todo if missing])`. **No
  custom bash allowlist** — relies entirely on the already-tuned
  `permission-gate.ts` for bash safety in this mode too (fix for problem
  #2). Verified via test that a currently-active custom tool
  (`show_artifact`, `save_memory`) survives the toggle untouched, and that
  toggling off restores the *exact* original set, not a fixed list.
- [x] Planning-phase prompt via `pi.on("before_agent_start")`: instructs
  the model to explore read-only and propose a plan via the `todo` tool's
  `add` action, not a bespoke `Plan:` text block — fix for problem #1,
  giving progress tracking exactly one mechanism. Also strips stale
  `plan-mode-context` messages via `pi.on("context")` once plan mode is
  off, so old instructions don't linger in history forever.
- [x] Approval-gate signal: `pi.on("tool_call")` sets a `planProposedThisTurn`
  flag when `toolName === "todo" && input.action === "add"` while plan mode
  is active; `pi.on("agent_end")` checks (and always resets) that flag, and
  only then calls `ctx.ui.select("Plan mode — what next?", ["Execute the
  plan", "Stay in plan mode", "Refine the plan"])` — this part needed no
  changes from the original example's approach, kept as-is. Verified via
  test that an `agent_end` with no preceding `todo add` call never prompts,
  a stale flag doesn't leak into a later unrelated `agent_end`, and the
  dialog is skipped when `ctx.hasUI` is false.
- [x] Execution: "Execute the plan" flips `planModeEnabled = false`, calls
  `pi.setActiveTools()` with the captured pre-plan-mode snapshot (a true
  restore), and sends a `pi.sendUserMessage(..., {deliverAs: "followUp"})`
  telling the model to proceed — verified this genuinely turns plan mode
  off (a subsequent `before_agent_start` no longer injects the plan-mode
  message).
- [x] "Refine the plan" opens `ctx.ui.editor(...)` and forwards non-empty,
  trimmed text as a follow-up user message; empty/whitespace-only input
  sends nothing. "Stay in plan mode" (or the dialog being dismissed) is a
  genuine no-op — no tool changes, no message sent, plan mode stays on.
  All three branches covered by tests.
- [x] Dropped the `questionnaire` tool reference entirely (fix for problem
  #3) — not referenced anywhere in the injected prompt text.
- [x] In-memory state only, as scoped — no session persistence code exists.

Typecheck clean, 15/15 new tests passing.

### 3. Wire into `agent-init.ts` — done
- [x] Registered `planModeExtension` in `extensionFactories`, alongside
  `showArtifactExtension`/`saveMemoryExtension`/`findSkillExtension`.
- [x] Added one Guidelines bullet to `HYPATIA_SYSTEM_PROMPT`: *"For a
  substantial or risky change, you may suggest the user enable plan mode
  (type /plan) so you can propose a plan for review before making changes
  — you cannot toggle it yourself."* (the model can't invoke `/plan`
  itself — it's a human-only toggle, matching Claude Code's own plan mode.)
- [x] **Toggle plumbing**: added a `"plan"` entry to
  `hypatia-frontend/src/lib/builtinCommands.ts`'s `BUILTIN_COMMANDS`
  (`run: (ctx) => ctx.sendMessage("/plan")`), a new `sendMessage` field on
  `CommandContext`, and wired it in `App.tsx`'s `handleRunCommand` to the
  existing `handleSend`. `builtinCommands.test.ts` updated (6 commands now,
  new test asserts `/plan` sends the literal text). Frontend: typecheck
  clean, lint clean, 443/443 tests passing.

### 4. Regression + manual verification — done
- [x] `npx tsc --noEmit && npx vitest run` in `hypatia-backend`: typecheck
  clean, 120/120 tests passing (105 pre-existing + 15 new for plan-mode).
- [x] **Verified against a real `AgentSession`**, not just the unit-test
  fake harness (a temporary debug script + a temporary `console.error`
  inside the extension, both removed after): calling `session.prompt("/plan")`
  twice against a live session showed the exact active-tool-list transition
  — `edit`/`write` genuinely removed on enable, genuinely restored on
  disable, and Hypatia's own custom tools (`show_artifact`, `save_memory`,
  `find_skill`) plus the user's own `reload_runtime` global extension
  survived untouched in both directions. This is the same proof technique
  used earlier in this session for verifying the project-memory system
  prompt injection — don't just trust the code, observe the real object.
- [x] Confirmed the assembled system prompt (via `resourceLoader.getSystemPrompt()`
  against a real `buildResourceLoader()` call) contains the new plan-mode
  Guidelines bullet, appearing correctly among the other tool bullets.
- [x] Confirmed via source inspection that `plan-mode.ts` registers no
  `bash`-specific `tool_call` logic of its own — the only `tool_call` hook
  present is for detecting `todo`/`add` calls (observation only, always
  returns `undefined`, never blocks) — so `permission-gate.ts` remains the
  sole bash gate in every mode, exactly as designed; the conflict found
  during research (problem #2) cannot recur because there's nothing left
  in this file to conflict with it.
- [ ] **Not yet done — needs a real live chat session with a real model**:
  getting the model to actually propose a plan via the `todo` tool and
  confirming the `ctx.ui.select()` dialog renders as a real clickable
  element in the running Tauri app (not just the backend log), and that
  choosing "Execute the plan" lets the model proceed through the todo list
  naturally. Everything below the model's own behavior is now verified;
  the model's own behavior in a live session is the one thing only a real
  run of the app can confirm.

## Explicitly out of scope (v1)
- No persistence of plan-mode state across session reload/resume.
- No `questionnaire`-tool-style clarifying-questions flow.
- No changes to `permission-gate.ts` — reused exactly as-is, on purpose.
- No subagent delegation (pi-subagents) — verdict is skip.
- No background/concurrent session work — verdict is defer to its own plan.
