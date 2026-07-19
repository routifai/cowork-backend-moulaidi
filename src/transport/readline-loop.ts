import { createInterface } from "node:readline";
import { logWarn, logError, send } from "../protocol.js";
import type { Command } from "../commands/types.js";

/**
 * Read JSON-lines commands from stdin and dispatch them to the command
 * handler. Writes protocol `error` and `done` events for malformed commands
 * or uncaught handler errors.
 */
export async function runReadlineLoop(
	handleCommand: (cmd: Command) => Promise<void>,
): Promise<void> {
	const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

	for await (const line of rl) {
		if (!line.trim()) continue;

		let cmd: Command;
		try {
			cmd = JSON.parse(line);
		} catch {
			logWarn("Invalid JSON: %s", line.slice(0, 100));
			continue;
		}

		try {
			await handleCommand(cmd);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logError("command error (type=%s): %s", "type" in cmd ? cmd.type : "?", message);
			send({ type: "error", id: "id" in cmd ? cmd.id : "unknown", message });
		}
	}

	logWarn("Sidecar shutting down (stdin closed)");
	process.exit(0);
}
