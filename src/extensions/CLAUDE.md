## Responsibility

First-party pi `ExtensionFactory`s: tools and slash commands specific to Hypatia Cowork, registered inline alongside the vendored Anthropic-messages bridge. Distinct from pi's own native/npm extension ecosystem (`~/.pi/agent/extensions`, loaded — in principle — via `disk-extension-loader.ts`, see root `CLAUDE.md` gotcha).

## Key files

- `show-artifact.ts` — `show_artifact` tool. `execute()` does nothing but echo its params into the tool result's `details` verbatim (no cross-call state); the frontend's `tool_execution_end` handler reads `result.details` directly to render the playground side panel. ⚠️ no test file.
- `save-memory.ts` — `save_memory` tool. Delegates to `memory-store.ts`'s `upsertMemoryEntry(baseDir, workspaceCwd, {...})`; writes `MEMORY.md` (index, auto-injected into every new session's system prompt for the same workspace) plus an optional per-topic detail note under `notes/<topic>.md`.
- `find-skill.ts` — `find_skill` tool. Reuses pi's own `loadSkills()` rather than reimplementing `SKILL.md` parsing, filters out skills with `disableModelInvocation`, ranks the rest with `lib/bm25.ts`'s `rankBm25`, returns top 5 by name/description/filePath only (never full skill content — the model re-reads the winning file with its own read tool).

**Plan mode (`/plan`) is no longer a first-party file here.** It's the third-party npm extension `@narumitw/pi-plan-mode`, loaded via `disk-extension-loader.ts`'s `buildExtensionFactories()` (see root `CLAUDE.md` and `docs/adr/0001-use-narumitw-pi-plan-mode.md`) — not registered in this directory's `extensionFactories` array. The hand-rolled `plan-mode.ts`/`plan-mode.test.ts` were deleted, not deprecated in place: keeping both active would have made `/plan` unreachable (the SDK auto-disambiguates same-name commands across extensions to `plan:1`/`plan:2`, but the frontend's toggle sends the literal string `"/plan"`).

## How it's invoked

All four are registered as `extensionFactories` in `agent-init.ts`'s `buildResourceLoader()`, alongside `vendor/anthropic-messages`'s `piAnthropicMessages`:

```
extensionFactories: [
  piAnthropicMessages,
  showArtifactExtension,
  (pi) => saveMemoryExtension(pi, { baseDir: hypatiaAgentDir(hypatiaDir), workspaceCwd }),
  (pi) => findSkillExtension(pi, { agentDir: piResourceDir, workspaceCwd }),
  planModeExtension,
]
```

`buildResourceLoader` is called from `app/bootstrap.ts`'s `initAgent()` (first/full session) and again from `commands/handlers/sessions.ts` (`handleNewSession`, `handleLoadSession`) every time a session is spawned or resumed — each session gets its own fresh `DefaultResourceLoader` instance, so these factories run once per session, not once per process.

## Gotchas

- **`disk-extension-loader.ts` is now wired in** (`agent-init.ts`'s `buildResourceLoader()`, `noExtensions: true` passed to `DefaultResourceLoader`), so pi's own extension ecosystem under `~/.pi/agent` — `settings.json` `packages` (e.g. `npm:@narumitw/pi-plan-mode`) plus loose files in `~/.pi/agent/extensions` (`permission-gate.ts`, `todo.ts`, `custom-compaction.ts`, `project-trust.ts`, `reload-runtime.ts`, `summarize.ts`) — loads for real now, in both dev and the bundled app. This was previously dead code; see root `CLAUDE.md` history and `docs/adr/0001-use-narumitw-pi-plan-mode.md`.
- **`@narumitw/pi-plan-mode` has its own bash-gating that can conflict with `permission-gate.ts`.** Both hook `tool_call` for the `bash` tool with independent safe-command lists; the SDK's `emitToolCall` (`core/extensions/runner.js`) runs handlers in registration order and the first `block: true` short-circuits the rest — so whichever extension registers first governs a given bash call during planning, not both together. Accepted as a known limitation (ADR 0001), not something to re-solve by forking either extension's policy.
- `find-skill.ts` returns metadata only, never skill content, by design — if search results look right but the model doesn't seem to follow the skill, check whether it actually read the returned `filePath` afterward.
