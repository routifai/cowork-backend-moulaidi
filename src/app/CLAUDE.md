## Responsibility

Process-wide and per-session state containers, and the bootstrap sequence that turns a bare Node process into a running pi-coding-agent sidecar.

## Key files

- `bootstrap.ts` — `bootstrapApp()`: builds the `AppContainer`, defines `initAgent(hypatiaDirPath, workspace?)` (full (re)bootstrap: `ModelRuntime` → `ModelRegistry` → `SettingsManager` → resource loader → one fresh `AgentSession`, sends the `ready` protocol event), and assembles `HandlerDependencies` (getters/functions closed over `container`) for `commands/handler-registry.ts`'s `createHandler`. Returns `{ container, handleCommand }` to `index.ts`.
- `container.ts` — `AppContainer` interface: the process-wide fields (`modelRuntime`, `modelRegistry`, `settingsManager`, `hypatiaDir`) plus `sessions: Map<string, SessionState>` and `activeSessionId`.
- `session-state.ts` — `SessionState` interface: everything that's actually per-session (the live `AgentSession`, its `SessionManager`/`DefaultResourceLoader`, `workspaceCwd`, `promptScheduler`, `promptRunner`, `createdAt`/`lastActivity`). One of these per open session; `AppContainer.sessions` maps id → `SessionState` instead of these being flat fields (they used to be, pre multi-session support).

## How it's invoked

`src/index.ts`'s `main()` is the only caller of `bootstrapApp()`. The returned `handleCommand` is handed straight to `transport/readline-loop.ts`'s `runReadlineLoop`. `commands/handlers/sessions.ts` (`handleNewSession`, `handleLoadSession`) also imports `SessionManager`/`createAgentSession` and `buildResourceLoader` directly (dynamic `import()`) to spawn additional sessions without going through `initAgent` again — `initAgent` is reserved for full-process (re)bootstrap.

## Gotchas

- `session id` = `SessionManager.getSessionFile()` (the pi session file path), not a separately generated id — this is the same identity the frontend already tracks a session by. A `randomUUID()` fallback only applies to the rare in-memory session with no backing file.
- `initAgent()` always calls `container.sessions.clear()` before inserting the new session — a full `reload`/`init` intentionally blows away every other tracked session (matches pre-multi-session behavior exactly). Narrowing that blast radius is explicitly deferred — see `docs/plans/multi-session-concurrency.md`, Phase 5.
- `activeSessionId` is a back-compat resolution path only. New call sites that run an actual agent turn should carry an explicit `sessionId`, not rely on "whichever session is active."
- `deps.session` / `deps.workspaceCwd` in `HandlerDependencies` resolve through `activeSession()` (a closure in `bootstrap.ts`, not a container field) — they silently return `undefined`/the default workspace if no session is active yet, so handlers using them still need their own initialized-check.
