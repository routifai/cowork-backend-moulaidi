# Context Map

## Contexts

- [Cowork](./CONTEXT.md) — the agent-sidecar engine itself: wraps the pi coding-agent SDK, talks stdio JSON-lines to the Tauri Rust host
- [Presenting](./presenting/CONTEXT.md) — the Hypatia PowerPoint Builder's Python engine: presentation generation, chat-based slide editing, template parsing, export

## Relationships

- **Presenting → Cowork**: Presenting owns no model credentials. It relays model-call requests through the Tauri Rust host, which forwards them as a command on Cowork's existing stdio protocol; Cowork's `ModelRuntime` executes the call and the response is relayed back the same path. See `docs/adr/0002-presenting-model-calls-relay-via-rust-host.md`.
