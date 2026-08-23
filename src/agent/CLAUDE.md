## Responsibility

Single concern: make `npm install` work for pi extensions inside the shipped Tauri app, where there is no system Node/npm and the app install directory may be root-owned.

## Key files

- `npm-bundling.ts` — three functions, all pure/side-effect-scoped:
  - `bundledNpmCommand(env, execPath, exists)` — returns `[execPath, "--use-system-ca", cli]` if `HYPATIA_BUNDLED_NPM_CLI` is set and points at a real file, else `undefined` (dev fallback: pi uses system `npm` on PATH).
  - `bundledNpmPrefix(env, home)` — returns `~/.hypatia-cowork/npm-global` unless the caller already configured `npm_config_prefix`/`NPM_CONFIG_PREFIX`, or there's no bundled CLI at all.
  - `applyBundledNpm(settingsManager)` — the actual side effect: monkey-patches `settingsManager.getNpmCommand` so it falls back to the bundled command only when the user hasn't configured their own `npmCommand`, and best-effort `mkdirSync`s the prefix dir and sets `process.env.npm_config_prefix`.

## How it's invoked

Called once, from `app/bootstrap.ts`'s `initAgent()`, right after `SettingsManager.inMemory(...)` is constructed and before `buildResourceLoader()` runs (so any extension install triggered during resource loading already sees the bundled npm). No other caller.

## Gotchas

- The override is deliberately ephemeral (monkey-patched at runtime), not persisted into the user's `settings.json` — a persisted absolute path to this specific bundle's `npm-cli.js` would go stale on the next app update and break the standalone `pi` CLI, which doesn't have `HYPATIA_BUNDLED_NPM_CLI` set.
- `--use-system-ca` is passed as a real CLI arg, not via `NODE_OPTIONS`, because older Node versions used by some child processes reject that `NODE_OPTIONS` value — this lets npm trust corporate MITM root certs without relying on env propagation.
- If `mkdirSync` on the prefix dir fails, the code silently leaves npm's default (probably-broken) prefix behavior in place rather than half-configuring something worse — check stderr logs, not a thrown error, if global installs mysteriously still fail EACCES in the shipped app.
