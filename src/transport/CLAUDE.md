## Responsibility

The stdin side of the JSON-lines protocol. One file, one job: read newline-delimited JSON commands and dispatch them.

## Key files

- `readline-loop.ts` — `runReadlineLoop(handleCommand)`: wraps `node:readline` over `process.stdin`, `JSON.parse`s each non-empty line, and calls `handleCommand(cmd)`. A malformed line is logged (`logWarn`, truncated to 100 chars) and skipped, not fatal. A thrown handler error is caught, logged (`logError`), and turned into a protocol `error` event (`send({ type: "error", id, message })`) rather than crashing the process. When stdin closes (EOF), logs a warning and `process.exit(0)`.

## How it's invoked

Only caller: `src/index.ts`'s `main()`, passed the `handleCommand` returned by `app/bootstrap.ts`'s `bootstrapApp()`. This is the outermost loop of the whole process — nothing calls back into it.

## Gotchas

- `crlfDelay: Number.POSITIVE_INFINITY` is set so a `\r\n` split across two stdin chunks doesn't get treated as two separate blank-ish lines.
- Errors thrown inside `handleCommand` are still caught here even though `commands/handler-registry.ts`'s dispatcher also does its own per-command try/catch in some handlers — this is the last-resort safety net so one bad command can never kill the sidecar process.
- Never write anything but the JSON protocol to stdout from code reachable through this loop — see the root `CLAUDE.md` "stdout is a strict JSON-line channel" gotcha.
