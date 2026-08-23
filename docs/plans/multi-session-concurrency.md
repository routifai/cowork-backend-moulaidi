# Multi-session concurrency (background sessions)

Status: planned, not started.
Spans both repos: `hypatia-backend` (session map, wire protocol, extension
UI bridge) and `hypatia-frontend` (Rust bridge, React state model, sidebar
UI).

## Problem

User report: "when I created a new chat while the agent is working it did
stop." Confirmed root cause via two parallel deep-investigation passes,
not guessed:

- `spawnSession()` (`src/commands/handlers/sessions.ts:42`) and
  `handleLoadSession` (`sessions.ts:134`) both unconditionally call
  `deps.session.abort()` on whatever was previously running, because
  `AppContainer` (`src/app/container.ts:12-23`) is a flat singleton — one
  global `session`/`sessionManager`/`resourceLoader`/`workspaceCwd` for the
  entire process. No `Command` type anywhere carries a session identifier.
- The wire protocol has no session tag on any outgoing message
  (`protocol.ts`'s `send()`), and pi's own SDK emits events with no
  session-distinguishing field either (confirmed by reading
  `agent-session.js`'s `_emit()` directly).
- Frontend mirrors this: `App.tsx` has one `usePiStream()` instance and one
  `activeSessionFile`. Today the backend's own `.abort()` masks a worse
  latent bug: the Rust bridge's event-broadcast loop
  (`hypatia-frontend/src-tauri/src/lib.rs:601-603`) sends every incoming
  event to *every* pending-prompt channel with no filtering — if the
  backend stopped auto-aborting without a matching fix here, a second
  session's output would cross-contaminate whatever session is displayed.
- Confirmed: exactly one sidecar Node process for the app's whole lifetime.
  "Multiple concurrent sessions" means multiple `AgentSession` objects
  inside that *same* process, not multiple processes — the lighter option,
  and the load-bearing assumption behind this whole design.
- One accepted, bounded residual hazard: `AgentSession.reload()` (from
  `save_instructions`/`save_memory`) calls a process-global
  `resetApiProviders()` in `@earendil-works/pi-ai`'s `compat.js`. Verified
  it does not interrupt an already-in-flight request for a different
  session, but does wipe non-built-in custom API providers process-wide —
  a different session's *next* call for such a provider could transiently
  throw until re-registered. Low probability, self-correcting on retry.
  **Accepted as a documented known limitation, not solved by this plan.**

## Decisions

- **Full scope**: phases 0-3 (backend fix + real frontend multi-session
  UI), not just the backend-only fix. Phase 4 (sidebar polish) is a clear
  separable follow-on. Phase 5 (`handleReload`'s full blast-radius fix) is
  deferred indefinitely.
- **Background-session permission dialogs**: badge + click-through. A
  backgrounded session waiting on a confirmation (e.g. a `permission-gate.ts`
  bash prompt) shows a waiting indicator in the sidebar; the user clicks in
  to see and answer it. Nothing auto-switches the view, nothing silently
  queues indefinitely.
- **Session id = the pi session file path** — already unique, already what
  `SessionEntry.file`/`activeSessionFile` treat as identity. No new id
  namespace.
- **`resourceLoader` duplicated per session**, not shared-by-cwd — simpler,
  safe given the concurrency cap bounds the cost. Revisit only if
  profiling ever shows it matters.
- **Concurrency cap**: start at 3 concurrently-active sessions, enforced as
  a simple constant — a cost/sanity guardrail, not a hard technical limit,
  easy to tune later.

## Steps

### Phase 0 — groundwork, zero visible behavior change — done
- [x] Converted `hypatia-backend/src/prompt-runner.ts`'s three module-level
  `let`s into closure state via `createPromptRunner(sessionId): PromptRunner`
  (`{subscribeSession, runPromptTask}`), mirroring `createPromptScheduler()`.
  Dropped `activePromptId`/`setActivePromptId`/`clearPromptFlags`/
  `markPromptEmitted` as standalone exports — confirmed via grep they had
  zero consumers outside this file (not even `handleAbort`, which just
  calls `deps.session.abort()` directly), so they became private closure
  details instead of dead public API surface.
- [x] `AppContainer` (`app/container.ts`) gained `promptRunner: PromptRunner`.
  `bootstrap.ts` creates it once via `createPromptRunner(PRIMARY_SESSION_ID)`
  (a documented placeholder constant, `"primary"`, with a comment pointing
  at Phase 1), exposes it via `deps.promptRunner`. `sessions.ts`'s two
  `subscribeSession(...)` call sites and `core.ts`'s `runPromptTask(...)`
  call now go through `deps.promptRunner.subscribeSession(...)`/
  `deps.promptRunner.runPromptTask(...)` instead of importing standalone
  functions. `HandlerDependencies` (`handler-registry.ts`) updated to match.
- [x] Added `sessionId` to `type: "event"` envelopes in `subscribeSession`
  — confirmed via real verification (below) this is the only envelope that
  needed it; `result`/`error`/`done`/`ready` genuinely needed no change.
- [x] Threaded `sessionId` through `bindExtensionUi`/`createUiContext` in
  `extension-ui-bridge.ts` — `emitUiRequest`/`emitUiCancel` (and therefore
  every `ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget/
  setTitle/setEditorText` call, which all route through them) now tag
  their events with the session id too.
- [x] Updated 3 test files for the new shapes: `subscribe-session.test.ts`
  (now calls `createPromptRunner("test-session").subscribeSession(...)`
  and asserts the tagged envelope), `sessions.test.ts` and `memory.test.ts`
  (both `mockDeps()` helpers gained a `promptRunner` field; removed
  `sessions.test.ts`'s now-stale `vi.mock("../../prompt-runner.js", ...)`,
  since `sessions.ts` no longer imports it directly).
- [x] **Verify — done, with a real caveat noted**: `npx tsc --noEmit &&
  npx vitest run` — clean, 120/120 tests passing. **Real end-to-end run**:
  wrote a temporary script calling the actual `bootstrapApp()` (not a
  mock) and drove `init → new_session → prompt → new_session (rebind) →
  prompt` through the real `handleCommand`, capturing real stdout.
  Confirmed: every captured `type:"event"` line (including one emitted by
  the real `project-trust` extension via the UI bridge, not a synthetic
  test event) carried `"sessionId":"primary"`, zero lines missing it, and
  the rebind path (a second `new_session` re-subscribing a new session
  object) worked correctly too. The actual LLM calls themselves failed
  with "No API key found" — expected and unrelated to this refactor: this
  environment has no stored `~/.pi/agent/auth.json` credentials and
  Hypatia's embedded key is only present in a packaged build, not when
  running raw source via `tsx`. The error path itself (`send({type:
  "error"...})` + `send({type:"done"...})`) fired correctly regardless,
  confirming the wiring survives an error turn, not just a happy path.
  Script deleted after use (one-off verification, not a permanent test).

### Phase 1 — backend session map + the actual abort-bug fix — done
This is the "the reported bug is fixed" milestone, backend-side.
- [x] Created `hypatia-backend/src/app/session-state.ts`: `SessionState =
  { id, session, sessionManager, resourceLoader, workspaceCwd,
  promptScheduler, promptRunner, createdAt, lastActivity }`. `id` is the pi
  session file path, as planned.
- [x] `AppContainer` (`src/app/container.ts`) now holds `sessions: Map<string,
  SessionState>` + a transitional `activeSessionId: string | undefined`.
  `modelRuntime`/`modelRegistry`/`settingsManager`/`hypatiaDir` stayed
  singular, as planned. `initialized` also stayed process-wide (gates
  whether `initAgent()` has ever completed — not meaningfully per-session).
- [x] `HandlerDependencies` (`handler-registry.ts`) replaced flat
  `sessionManager`/`resourceLoader`/`promptScheduler`/`promptRunner` (and
  their setters) with `getSession(id)`/`addSession(state)`/
  `removeSession(id)`/`listSessionIds()`/`activeSessionId`/
  `setActiveSessionId(id)`. Kept `session`/`workspaceCwd` as **backward-compat
  getters** resolving against the active session — deliberate, narrower
  than originally sketched: only `memory.ts`/`settings.ts` (and
  `sessions.ts`'s own read-only handlers: get_workspace/list/search) still
  read these two flat fields, and none of them need per-session addressing
  yet, so they were left untouched rather than migrated speculatively.
- [x] Added `sessionId?: string` (optional, for the transitional period) to
  `PromptCommand`/`AbortCommand`/`SteerCommand`/`FollowUpCommand`/
  `ClearQueueCommand`/`SetModelCommand`/`GetActiveModelCommand` in
  `commands/types.ts`. All 7 handlers in `core.ts` now resolve via a shared
  `resolveTargetSession(deps, cmd)` helper: `cmd.sessionId ?? deps.activeSessionId`.
- [x] **Deleted** both unconditional abort calls
  (`sessions.ts`'s old lines 42 and 134) outright — confirmed via grep that
  the only two `.abort()` calls remaining in the file are: (1) inside
  `handleLoadSession`, scoped to the case where the *same* session id is
  being reloaded (a legitimate "restart myself," not touching a different
  session), and (2) inside the new `handleCloseSession` handler.
- [x] Added the new explicit **`close_session`** command
  (`CloseSessionCommand` in `types.ts`, `handleCloseSession` in
  `sessions.ts`, wired in `handler-registry.ts`) — the only handler allowed
  to abort a session other than the same-id-reload case above. Also
  reassigns `activeSessionId` to another remaining session (or `undefined`)
  if the closed session was the active one, so the backward-compat getters
  never dangle on a removed id.
- [x] **Design simplification found necessary during implementation**:
  `handleNewSession` no longer has a "same cwd → reload the existing
  loader" special case — since `resourceLoader` is now duplicated per
  session (not shared), there's no single "current" loader to compare
  against. It now always builds a fresh `resourceLoader` for every new
  session, which is *at least as fresh* as the old reload-based path (a
  freshly-built loader can't be stale) and is simpler. Updated
  `sessions.test.ts` accordingly — the two old tests asserting the
  reuse-vs-rebuild branching were rewritten to assert "always fresh."
- [x] **Real pre-existing bug surfaced and fixed as a side effect of type
  safety, not scope creep**: `state.session` is now precisely typed
  (previously `any`), which surfaced that `SteerImage` (this app's wire
  shape for images) was missing the `type: "image"` discriminant the SDK's
  `ImageContent` requires — masked before by the `any` cast, silently
  present in `handleSteer`/`handleFollowUp` this whole time. Fixed with a
  small `toImageContent()` mapper in `core.ts` rather than re-casting to
  `any` to hide it again.
- [x] `handleReload` — left its "rebuild everything" semantics unchanged,
  confirmed: `initAgent()` now does `container.sessions.clear()` before
  installing the one freshly-bootstrapped session, exactly matching the old
  single-session behavior (Phase 5, fixing this blast radius, stays
  deferred).
- [x] Updated `sessions.test.ts`/`memory.test.ts`'s `mockDeps()` helpers for
  the new `HandlerDependencies` shape.
- [x] **Verify — done, real, against the unmocked `bootstrapApp()`**: wrote
  a temporary script driving `init → new_session(A) → new_session(B) →
  close_session(A)` through the real `handleCommand`, inspecting the real
  returned `container` directly (not a test double). Results: after
  creating session B, session A was **still present in the map, its exact
  same in-memory `AgentSession` object, with its wrapped `abort()` called
  zero times** — the literal proof the reported bug is fixed. The explicit
  `close_session` command correctly called `abort()` exactly once and
  removed the session from the map. `npx tsc --noEmit && npx vitest run`:
  clean, 121/121 (118 pre-existing/renamed + 3 new). Script deleted after
  use.

### Phase 2 — real per-session ids through the wire + Rust filtering — done
- [x] Backend already uses the real per-session file-path id everywhere
  (Phase 1 replaced the `"primary"` placeholder as part of the session-map
  work — there was no separate placeholder-swap step left to do here).
- [x] `hypatia-frontend/src-tauri/src/lib.rs`: `PendingPrompt` gained
  `session_id: String`. `send_prompt`/`abort_prompt`/`steer_prompt`/
  `follow_up_prompt`/`clear_queue`/`get_active_model` all take a
  `session_id` argument now and include it in the JSON sent to the
  sidecar — `abort_prompt` stops hardcoding the literal `{"id":"ab"}`
  (now generates a real id via `next_request_id()`, matching every other
  command's convention, even though nothing awaits its response).
- [x] `read_stdout`'s broadcast loop: extracted the filter condition into a
  small pure function, `event_targets_session(event_session_id,
  pending_session_id)`, matching this file's own established convention of
  extracting wire-logic into unit-testable pure functions (same pattern as
  `build_steer_payload` etc.). Changed the loop from unconditional
  "send to every pending-prompt channel" to calling this filter per entry.
- [x] Added Rust unit tests: updated all `build_*_payload` tests for the
  new `session_id` parameter (asserting the field's presence/value), plus
  3 new tests for `event_targets_session` covering same-session match,
  different-session rejection, and an untagged-event edge case. `cargo
  check` and `cargo test`: clean, 12/12 passing.
- [x] **Real gap caught while starting Phase 3, fixed retroactively here**:
  the `ui_request`/`ui_cancel`/oauth/`queue_update` events are emitted as
  **global** Tauri events (`app.emit(...)`), a separate code path from the
  per-Channel broadcast loop fixed above — and that path was still emitting
  the bare inner event object, never the tagged outer envelope, so it lost
  `sessionId` entirely despite Phase 0's backend-side tagging. Added
  `tag_with_session_id(payload, session_id)` (another small pure,
  unit-tested function) and applied it at both emit sites. Without this, a
  background session's permission-gate dialog would have been genuinely
  untraceable to its session, exactly the risk flagged (but not fully
  closed) in the original design. `cargo test`: 14/14 passing.
- [x] **Verify**: unit-level verification chosen over a live two-channel
  Tauri harness — there's no existing test infrastructure in this codebase
  for driving `read_stdout` against a real `Channel`/`AppHandle` (only pure
  functions have tests here), and building one just for this would be a
  disproportionate one-off investment. The outgoing-payload tests already
  confirm Rust correctly embeds `sessionId`; the new `event_targets_session`
  tests directly cover the exact filtering predicate that fixes the
  cross-contamination bug. **The real, live, two-sessions-at-once
  end-to-end proof happens naturally in Phase 3's acceptance test below**,
  once the frontend can actually open two sessions to observe it with.

### Phase 3 — frontend multi-stream state — done, one item genuinely blocked
The actual user-facing scenario ("start a task, switch away, come back and
watch it") becomes possible here.
- [x] `usePiStream.ts`: `streamReducer`/`StreamAction`/`StreamState`/
  `INITIAL_STATE` left **completely unchanged** — deliberately, to keep the
  refactor's blast radius small and preserve the existing 25-test
  `streamReducer` suite (sub-turn boundaries, text_end correction,
  duplicate sub-turn collapse, mid-stream error finalization, delivered
  steer/follow-up bubbles) fully valid, since it tests the reducer
  directly, never the hook. Added a wrapping `multiStreamReducer(state:
  Record<sessionId, StreamState>, action)` that routes each action to the
  right session's slot via the existing `streamReducer`, plus a
  `FORGET_SESSION` action (removes a session's map key entirely — used on
  deletion, never on an ordinary tab switch).
- [x] `usePiStream()` now exposes `streams` (renamed from `state`), and
  `startStream`/`abortStream`/`steerStream`/`followUpStream`/`clearQueue`
  all take `sessionId` as their first argument, threading it into every
  `invoke(...)` call (matching Phase 2's Rust signatures) and into every
  dispatched action via a per-call closure — each `startStream` call's own
  `Channel.onmessage` closes over its own `sessionId`, so events always
  land in the right slot regardless of what's currently displayed. The
  global `queue_update` listener now reads `sessionId` from the payload
  (populated by Phase 2's `tag_with_session_id` fix) and drops anything
  untagged rather than guessing.
- [x] `App.tsx`: derives `const streamState = streams[activeSessionFile] ??
  INITIAL_STATE` — "which session is displayed" and "which sessions are
  live" are now fully decoupled. Removed all 3 `dispatch({type:"RESET"})`
  calls: `handleNewSession`/`handleSessionSelect` now do nothing to any
  stream state at all (the literal fix); `handleConfirmDelete` calls the
  new `forgetSession(file)` instead, unconditionally (not just when the
  deleted session was displayed) since it only ever touches that one
  session's own slot.
- [x] **Real correctness subtlety found and fixed while implementing, not
  after**: naively removing the RESET calls would have caused a genuine
  double-counting bug — `loadedSessionMessages` (refreshed via
  `load_session` on every switch) and `streams[id].messages` (the
  transient in-flight reducer copy) would both end up containing a
  background session's just-completed turn once you switched back to it
  (pi auto-persists throughout, so `load_session`'s fresh disk fetch
  already includes it), rendering it twice. Fixed by adding
  `activeSessionFile` to the existing merge-effect's dependency array
  (previously only `[streamState.isRunning]`), so switching TO a session
  that finished streaming while backgrounded now triggers the same
  merge-into-`loadedSessionMessages` + `forgetSession(sid)` cycle that
  already ran for the "displayed session's turn just finished" case —
  eliminating the duplication by construction, not a special case.
- [x] Added 5 new unit tests for `multiStreamReducer` (exported for
  testing, matching the existing `streamReducer`-tested-directly
  convention): routing into a fresh session's slot, a
  **reference-equality** regression test proving one session's action
  leaves a different session's slot as the exact same object (not just
  deep-equal), two sessions accumulating independently, `FORGET_SESSION`
  removing only the named key, and a no-op `FORGET_SESSION` on an
  untracked id returning the same state reference.
- [x] Fixed one now-stale test mock (`App.telemetry.test.tsx`).
- [x] **Verify**: `pnpm typecheck && pnpm lint && pnpm test` — clean,
  448/448 passing (443 prior + 5 new). Confirmed via grep that `App.tsx` is
  the only consumer of the `usePiStream()` hook itself.
- [ ] **Not done — genuinely blocked, not skipped**: the plan's own
  acceptance test ("start a long task in session A, switch to session B
  mid-stream, send a prompt there, switch back to A and confirm A's stream
  continued uninterrupted") requires a real model call, and this
  environment has no configured API credentials (`~/.pi/agent/auth.json`
  is empty; Hypatia's embedded key only exists in a packaged build) — the
  same wall Phase 0's verification hit. Everything mechanically verifiable
  without a live model has been verified: the backend never aborts a
  different session (Phase 1, against a real `AgentSession`), the wire
  protocol correctly tags and filters by session id (Phase 2, Rust unit
  tests), and the frontend's routing logic never lets one session's action
  touch another's state (Phase 3, reference-equality unit tests on the
  actual reducer). **This needs a real run in the app with a configured
  provider to close out.**

### Phase 4 — sidebar polish (separable follow-on)
- [ ] Add a **runtime-only** (never persisted) `liveStatus?: "idle" |
  "running"` field to `SessionEntry`/`Session`
  (`App.tsx`/`Sidebar.tsx`/`ConversationSearch.tsx`), computed at render
  time by joining disk-truth `sessionEntries` with the in-memory
  `liveSessions` map — never stored directly on `sessionEntries`, since the
  next `list_sessions` refresh would silently stomp it.
- [ ] Render as a small badge next to the title, following the existing
  `pinned` icon pattern in `ConversationSearch.tsx` (~line 553, 612) — no
  re-sorting (would cause distracting jumps while streaming).
- [ ] Wire the badge + click-through UX for a background session's
  permission-gate confirmation (per the decision above).
- [ ] Enforce the concurrency cap (constant, starting at 3) in
  `handleNewSession`/`handleLoadSession`, with a friendly (not raw-error)
  rejection message when exceeded.
- [ ] **Verify**: run 3+ concurrent sessions in the real app; confirm
  badges track running/idle correctly and clear on completion; trigger a
  bash confirmation in a background session and confirm the badge +
  click-in flow surfaces it; exceed the cap and confirm the friendly
  rejection.

## Explicitly out of scope
- Phase 5 (`handleReload`'s full blast-radius fix, so it stops nuking every
  live session on reload) — deferred indefinitely, matching this project's
  established pattern for scope this size.
- No fix for the `resetApiProviders()` cross-session hazard — accepted,
  documented, low-probability, self-correcting on retry.
- No change to the concurrency cap's exact numbers beyond a sane starting
  default — a tuning knob, not a design decision to over-build now.
