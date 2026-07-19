/**
 * Hypatia Content CoWork — Agent Sidecar Entry Point
 *
 * A thin Node.js process that runs the pi coding agent SDK programmatically.
 * Communicates with the Tauri Rust backend via stdin/stdout JSON lines.
 *
 * This file delegates all bootstrapping to `app/bootstrap.ts` and all stdin
 * handling to `transport/readline-loop.ts`. It intentionally contains no
 * business logic so the orchestration layers can be tested independently.
 */

import { bootstrapApp } from "./app/bootstrap.js";
import { runReadlineLoop } from "./transport/readline-loop.js";
import { log } from "./protocol.js";

async function main() {
	const { handleCommand } = await bootstrapApp();
	await runReadlineLoop(handleCommand);
}

main().catch((err) => {
	log("Fatal: %s", err instanceof Error ? err.message : String(err));
	process.exit(1);
});
