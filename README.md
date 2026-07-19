# hypatia-backend

Standalone Hypatia Cowork engine — the agent sidecar, split into its own repo.

## Development

```bash
pnpm install
pnpm run dev        # stdio sidecar mode (reads JSON commands on stdin, writes JSON events to stdout)
pnpm run test
pnpm run typecheck
```

## Notes

- Copied from `zosma-cowork/backend/agent-sidecar` as a starting reference.
- Updated to `@earendil-works/pi-*` v0.80.10 to match the current API.
- Transport stays stdin/stdout JSON-lines — both halves of Hypatia Cowork run on the same desktop machine, so an HTTP/SSE hop was evaluated and dropped (see `docs/plans/birepo-split-proposal.md` in `zosma-cowork` for the earlier HTTP direction and why it was superseded).
- `hypatia-frontend` owns the Tauri Rust shell that spawns this process and pipes its stdio — that's the only thing that can own a child process and talk stdio to a webview consumer. This repo's job is to build and version a standalone bundle (`pnpm run bundle` → `dist/bundle.cjs`) that `hypatia-frontend`'s build consumes instead of building it in-tree via a relative path.
- The wire protocol (`src/commands/types.ts`) is the actual contract between the two repos — keep it in lockstep with whatever consumes it on the frontend/shell side.
