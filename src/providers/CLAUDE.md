## Responsibility

Intended home for alternate LLM-provider integrations. Currently contains exactly one subdirectory, `openai-completions/`, which is **not wired into the running sidecar** — see Gotchas.

## Key files

- `openai-completions/tool-execution.js` — a `toolHandlers` object (`beforeToolCall`, `tool_result`) plus a Zod schema (`HYPATIA_OFFICE_DOCS_SCHEMA`) describing an `officecli`-backed office-document tool surface (`create_document`, `add_element`, `set_element`, `remove_element`, `read_document`, `validate_document`, `batch_edit`, `preview_document`). `sendToSidecarTool()` is an explicit placeholder: it only checks `which officecli` and returns a hardcoded `"(placeholder)"` result — there is no actual stdin/stdout bridge to the running sidecar implemented (see the `// TODO: Actually execute the tool via sidecar's MCP protocol` comment).
- `openai-completions/tool-executor.js` — not code, just a Markdown-in-.js doc file describing the intended integration and a `require()`-based usage example (inconsistent with the rest of this ESM (`"type": "module"`) codebase).

## How it's invoked

Nothing. `grep`ing the rest of `src/` for `openai-completions`, `tool-execution`, or `tool-executor` turns up no importers — this directory is not referenced from `agent-init.ts`, `app/bootstrap.ts`, or anywhere else. It also imports `zod`, which is not a dependency in this package's `package.json` (only `typebox` is used elsewhere for schemas), so it would fail to even resolve if something did try to import it. Because nothing imports it, esbuild's `pnpm run bundle` tree-shakes it out of `dist/bundle.cjs` entirely.

## Gotchas

- Treat this as an unfinished/abandoned scaffold, not a working integration — do not assume `officecli` tool calls are actually reachable from a running session through this path. If asked to wire up office-document tools, the real integration point is a new `ExtensionFactory` under `src/extensions/` registered in `agent-init.ts`'s `buildResourceLoader()`, following the pattern of `show-artifact.ts`/`save-memory.ts`, not this directory.
- If you do decide to revive this, you'll need to add `zod` as a real dependency (or rewrite the schema in `typebox`, matching every other tool definition in this repo) and actually implement `sendToSidecarTool`.
