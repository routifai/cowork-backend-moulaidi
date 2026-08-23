## Project

`hypatia-backend` (package name `hypatia-backend`, description "Hypatia Cowork — engine / agent-sidecar server"). Standalone engine for **Hypatia Cowork**, split out of the `zosma-cowork` monorepo (`zosma-cowork/backend/agent-sidecar`). It wraps the `@earendil-works/pi-*` coding-agent SDK (pi) and exposes it to a Tauri desktop shell (`hypatia-frontend`, a separate repo) over stdin/stdout JSON-lines.

- `hypatia-frontend` owns the Tauri Rust process that spawns this as a child process and pipes its stdio — that's the only thing allowed to own the child process / talk stdio to the webview.
- This repo's job is to build and version a standalone bundle: `pnpm run bundle` → `dist/bundle.cjs`, consumed by `hypatia-frontend`'s build instead of a relative in-tree import.
- The wire protocol (`src/commands/types.ts`, the `Command` union) is the actual contract between the two repos — keep it in lockstep with whatever parses it on the frontend/Rust side.
- Transport is deliberately stdin/stdout JSON-lines, not HTTP/SSE — both halves run on the same desktop machine, so a network hop was evaluated and dropped (see `docs/plans/birepo-split-proposal.md` in `zosma-cowork` for the earlier HTTP direction).

## Architecture

Single long-lived Node process, no HTTP server. Entry point `src/index.ts`:

```
main() → bootstrapApp() (src/app/bootstrap.ts) → { container, handleCommand }
       → runReadlineLoop(handleCommand) (src/transport/readline-loop.ts)
```

- `transport/readline-loop.ts` reads newline-delimited JSON commands from stdin, JSON-parses each line, and calls `handleCommand`. Catches handler errors and emits protocol `error`/`done` events rather than crashing; exits(0) when stdin closes.
- `app/bootstrap.ts` builds the `AppContainer` (process-wide state: `ModelRuntime`, `ModelRegistry`, `SettingsManager`, `hypatiaDir`, and a `Map<sessionId, SessionState>`), defines `initAgent()` (full bootstrap of the pi SDK + first session), and wires `HandlerDependencies` for `commands/handler-registry.ts`'s `createHandler`.
- `agent-init.ts` (top-level, not a subdirectory) is the "pure init" layer: directory resolution (`piAgentDir`, `defaultHypatiaDir`, `resolveWorkspace`), the Hypatia system prompt (`HYPATIA_SYSTEM_PROMPT`), and `buildResourceLoader()` which constructs pi's `DefaultResourceLoader` with the inline extension factories (vendored Anthropic-messages bridge + the four first-party extensions under `src/extensions/`).
- `protocol.ts` is the transport-level helper: `send()` writes JSON to stdout (the actual protocol channel), `log`/`logWarn`/`logError`/`logDebug` write prefixed lines to stderr (level via `SIDECAR_LOG_LEVEL`). All process logging goes through here — never `console.log` (that would corrupt the stdout JSON channel).
- Per-session state (`SessionState` in `app/session-state.ts`: the live `AgentSession`, its `SessionManager`/`ResourceLoader`, workspace cwd, prompt scheduler/runner) is tracked in `AppContainer.sessions`. `activeSessionId` is a transitional back-compat pointer for commands that don't yet carry an explicit `sessionId` (memory, instructions/settings, `get_workspace`, list/search sessions). Commands that run an actual agent turn (`prompt`/`abort`/`steer`/`follow_up`/`clear_queue`/`set_model`/`get_active_model`) carry an explicit `sessionId`. See `docs/plans/multi-session-concurrency.md` for the migration this is mid-way through.

## src/ layout

| Path | Role |
|---|---|
| `index.ts` | Entry point; delegates to `app/` + `transport/`, no business logic. |
| `protocol.ts` | stdout `send()` / stderr `log*()` for the JSON-line protocol. |
| `agent-init.ts` | Directory resolution, system prompt, `buildResourceLoader()` (pi SDK bootstrap + inline extensions). |
| `app/` | Process-wide + per-session state containers and the bootstrap sequence. See `src/app/CLAUDE.md`. |
| `transport/` | stdin readline loop. See `src/transport/CLAUDE.md`. |
| `commands/` | Wire protocol types (`Command` union) + the command dispatcher and its handlers. See `src/commands/CLAUDE.md`. |
| `extensions/` | First-party pi extensions (tools + slash commands) registered by `agent-init.ts`. See `src/extensions/CLAUDE.md`. |
| `agent/` | Bundled-npm override so extension `npm install` works with no system Node. See `src/agent/CLAUDE.md`. |
| `providers/` | `openai-completions` — currently orphaned/unwired scaffold. See `src/providers/CLAUDE.md`. |
| `lib/` | Small standalone algorithms (currently just BM25 ranking). See `src/lib/CLAUDE.md`. |
| `vendor/` | Third-party/vendored code (`anthropic-messages` protocol bridge, pulled by `scripts/fetch-vendor.mjs` / `scripts/vendor-latest.mjs`). Not documented here — treat as external. |
| `disk-extension-loader.ts` | jiti-based loader for npm/disk pi extensions with `virtualModules` so they resolve against the bundle's own copies instead of a (possibly absent) `node_modules`. Wired into `agent-init.ts`'s `buildResourceLoader()` (`buildExtensionFactories()` → `DefaultResourceLoader`'s `extensionFactories`, with `noExtensions: true`). See the "Gotchas" section below. |
| `extension-ui-bridge.ts` | Bridges pi extensions' `ctx.ui.*` dialog calls to the desktop UI via `ui_request`/`ui_response` protocol events (select/confirm/input/editor/notify/etc.), plus a whitelisted-extension-config file helper. |
| `bundled-binaries.ts`, `agent-init.ts`'s `activateBundledBinaries()` caller | Points bundled tool binaries at machine-writable paths for the shipped app. |
| `memory-store.ts`, `instructions-store.ts`, `settings-store.ts`, `pi-session-store.ts` | Per-workspace persistence under `~/.hypatiai/cowork/...` and pi's own `~/.pi/agent/...` (memory notes, custom instructions, settings, session list/pin/rename metadata). |
| `prompt-runner.ts`, `prompt-scheduler.ts` | Per-session prompt execution + FIFO serialization so overlapping `prompt` commands on the same session don't race. |
| `about-cowork.ts`, `show-artifact-history.ts`, `extractChatMessages.ts` | System-prompt self-description doc, artifact reconstruction on session load, chat message extraction helpers. |

## Build / test

```bash
pnpm install                # postinstall runs scripts/fetch-vendor.mjs
pnpm run dev                # tsx watch — stdio sidecar mode, reads .env if present
pnpm run build               # tsc (type-check + emit, per tsconfig.json rootDir=src)
pnpm run bundle              # esbuild src/index.ts → dist/bundle.cjs (cjs, node platform), then scripts/postbundle.mjs
pnpm run start               # node dist/bundle.cjs
pnpm run test                # vitest run (src/**/*.{test,spec}.{ts,js})
pnpm run typecheck           # tsc --noEmit
```

Manual smoke test: `scripts/test-sidecar.sh` pipes JSON commands to the sidecar over stdio (matches the real protocol rather than a test harness).

## Gotchas

- **stdout is a strict JSON-line channel.** Only `protocol.ts`'s `send()` may write to it. Any stray `console.log` anywhere in `src/` (or a dependency) corrupts the protocol from the frontend's perspective. Use `log`/`logWarn`/`logError`/`logDebug` (stderr) instead.
- **`disk-extension-loader.ts` is now wired in** (fixes issue #147: disk/npm pi extensions like `web_search`/`fetch_content` previously failed to load in the bundled, no-`node_modules` shipped app). `agent-init.ts`'s `buildResourceLoader()` calls `buildExtensionFactories()` and passes the result into `DefaultResourceLoader`'s `extensionFactories` alongside the 4 inline factories (`piAnthropicMessages`, `showArtifactExtension`, `saveMemoryExtension`, `findSkillExtension`), with `noExtensions: true` so `DefaultResourceLoader`'s own built-in resolution doesn't also try (and fail in the bundle). This means everything under `~/.pi/agent` — `settings.json` `packages` (`npm:@narumitw/pi-plan-mode`) and loose files in `~/.pi/agent/extensions` (`permission-gate.ts`, `todo.ts`, `custom-compaction.ts`, `project-trust.ts`, `reload-runtime.ts`, `summarize.ts`) — now loads in both dev and prod uniformly. See `docs/adr/0001-use-narumitw-pi-plan-mode.md` for why and its accepted tradeoffs (bash-gating conflict between `pi-plan-mode` and `permission-gate.ts`).
- **`src/commands/types.ts` defines more commands than `handler-registry.ts` handles.** `ListExtensionsCommand`, `SearchSkillsCommand`, `ListSkillsCommand`, `FetchSkillPackumentCommand`, `TasksListCommand`/`TasksDeleteCommand`/`TasksSetEnabledCommand`/`TasksRunNowCommand`/`TasksListRunsCommand`/`TasksGetCompletedCommand`, `StartRemoteCommand`/`StopRemoteCommand`/`GetRemoteStatusCommand` are all part of the `Command` union but have no `case` in `handleCommand`'s switch — they fall through to the `default: logWarn("Unknown command...")` branch and get an `error` response. Treat these as reserved/in-progress protocol surface, not implemented handlers.
- Session identity = the pi session file path (`SessionManager.getSessionFile()`), not a separately minted UUID (UUID is only a fallback for sessions with no backing file).
- A full `reload`/`init` always replaces every tracked session (`container.sessions.clear()`), matching pre-multi-session behavior; scoping reload to a single session is explicitly deferred (Phase 5 of `docs/plans/multi-session-concurrency.md`).

## Agent skills

### Issue tracker

GitHub Issues on `routifai/cowork-backend-moulaidi`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at repo root (not yet created, lazy). See `docs/agents/domain.md`.
