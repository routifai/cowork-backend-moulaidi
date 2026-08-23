# hypatia-backend

Engine / agent-sidecar for Hypatia Cowork: wraps the `@earendil-works/pi-*` coding-agent SDK (pi) and exposes it to the Tauri desktop shell over stdin/stdout JSON-lines.

## Language

**Plan mode**:
The read-only exploration mode, toggled by `/plan`, in which the model proposes a plan for human review before `edit`/`write` tools are re-enabled. Canonically implemented by the third-party npm extension `@narumitw/pi-plan-mode` (loaded via pi's native `settings.json` package resolution), not by a Hypatia-authored file.
_Avoid_: referring to `src/extensions/plan-mode.ts` as "plan mode" — that file is the retired, hand-rolled predecessor (see ADR 0001) and is being removed to prevent a `/plan` command-name collision.

**Extension** (in the pi sense):
A `pi.ExtensionFactory` — a `(pi: ExtensionAPI) => void` — registered either inline in `agent-init.ts`'s `buildResourceLoader()` (Hypatia-authored: `show_artifact`, `save_memory`, `find_skill`) or resolved natively by `DefaultResourceLoader` from `~/.pi/agent/extensions/*.ts` (loose files) and `settings.json`'s `packages` array (`npm:`-sourced). Both sources register into the same per-session extension runtime; commands/tools from either can collide by name.
_Avoid_: "plugin" — the codebase and pi SDK both say "extension."

**Sidecar**:
This process (`hypatia-backend`) as run and owned by `hypatia-frontend`'s Tauri Rust host over stdio. Distinct from a standalone `pi` CLI session — the sidecar is single long-lived process, no HTTP server, one session at a time.
