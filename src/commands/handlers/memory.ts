/**
 * Memory command handlers: get_memory_index, get_memory_note,
 * save_memory_note, delete_memory_topic.
 *
 * Memory paths are scoped to the current workspace and stored under
 * `~/.hypatiai/cowork/memory/<encoded-cwd>/`.
 */

import { send } from "../../protocol.js";
import type { HandlerDependencies } from "../handler-registry.js";
import { hypatiaAgentDir } from "../../agent-init.js";
import {
	deleteMemoryTopic,
	loadMemoryIndex,
	loadMemoryNote,
	upsertMemoryEntry,
	saveMemoryNote,
	type MemoryType,
} from "../../memory-store.js";

export async function handleGetMemoryIndex(deps: HandlerDependencies, cmd: any): Promise<void> {
	try {
		const entries = loadMemoryIndex(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd);
		send({ type: "result", id: cmd.id, data: { entries } });
	} catch (err) {
		send({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function handleGetMemoryNote(deps: HandlerDependencies, cmd: any): Promise<void> {
	try {
		const content = loadMemoryNote(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd, cmd.topic ?? "");
		send({ type: "result", id: cmd.id, data: { content } });
	} catch (err) {
		send({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function handleSaveMemoryNote(deps: HandlerDependencies, cmd: any): Promise<void> {
	try {
		const topic: string = cmd.topic ?? "";
		const detail: string | undefined = cmd.detail;
		const result = upsertMemoryEntry(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd, {
			topic,
			summary: cmd.summary ?? "",
			type: ((cmd.memoryType ?? cmd.type_field) as MemoryType) ?? undefined,
			detail,
		});

		if (!result.ok) {
			send({ type: "error", id: cmd.id, message: result.reason });
			return;
		}

		// Allow callers to overwrite just the note body without bumping the index.
		if (cmd.noteContent !== undefined && cmd.noteContent !== null) {
			saveMemoryNote(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd, topic, cmd.noteContent);
		}

		// Reload the resource loader so the memory block is picked up for any
		// future turn in the active session.
		try {
			if (deps.session) await deps.session.reload();
		} catch (reloadErr) {
			// best-effort
		}

		send({ type: "result", id: cmd.id, data: { success: true } });
	} catch (err) {
		send({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function handleDeleteMemoryTopic(deps: HandlerDependencies, cmd: any): Promise<void> {
	try {
		const removed = deleteMemoryTopic(
			hypatiaAgentDir(deps.hypatiaDir),
			deps.workspaceCwd,
			cmd.topic ?? "",
		);
		send({ type: "result", id: cmd.id, data: { removed } });
	} catch (err) {
		send({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
