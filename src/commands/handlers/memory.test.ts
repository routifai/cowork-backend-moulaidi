import { describe, expect, it, vi, type Mock } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocol from "../../protocol.js";
import {
	handleGetMemoryIndex,
	handleGetMemoryNote,
	handleSaveMemoryNote,
	handleDeleteMemoryTopic,
} from "./memory.js";
import type { HandlerDependencies } from "../handler-registry.js";

const noop = () => {};

function mockDeps(baseDir: string, cwd: string): HandlerDependencies {
	return {
		initialized: true,
		modelRegistry: {} as any,
		session: { reload: () => Promise.resolve() } as any,
		modelRuntime: {},
		settingsManager: {},
		sessionManager: {},
		resourceLoader: {},
		workspaceCwd: cwd,
		hypatiaDir: baseDir,
		promptScheduler: { schedule: () => {} },
		initAgent: async () => {},
		buildResourceLoader: async () => ({}),
		bindExtensionUi: async () => {},
		resolveUiResponse: noop,
		setInitialized: noop,
		setSession: noop,
		setSessionManager: noop,
		setResourceLoader: noop,
		setWorkspaceCwd: noop,
	};
}

describe("memory handlers", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hypatia-memory-handlers-"));
	const cwd = "/Users/simo/project";
	const deps = mockDeps(baseDir, cwd);

	it("saves, reads, and deletes a memory topic", async () => {
		const messages: unknown[] = [];
		vi.spyOn(protocol, "send").mockImplementation((msg: unknown) => {
			messages.push(msg);
		});

		await handleSaveMemoryNote(deps, {
			type: "save_memory_note",
			id: "s1",
			topic: "Convention",
			summary: "Use pnpm",
			type_field: "preference",
			detail: "Always pnpm",
		} as any);
		expect(messages.at(-1)).toMatchObject({ type: "result", id: "s1", data: { success: true } });

		await handleGetMemoryIndex(deps, { type: "get_memory_index", id: "g1" });
		expect(messages.at(-1)).toMatchObject({
			type: "result",
			id: "g1",
			data: { entries: [{ topic: "Convention", summary: "Use pnpm", type: "preference" }] },
		});

		await handleGetMemoryNote(deps, { type: "get_memory_note", id: "g2", topic: "Convention" });
		expect(messages.at(-1)).toMatchObject({
			type: "result",
			id: "g2",
			data: { content: "Always pnpm" },
		});

		await handleDeleteMemoryTopic(deps, { type: "delete_memory_topic", id: "d1", topic: "Convention" });
		expect(messages.at(-1)).toMatchObject({ type: "result", id: "d1", data: { removed: true } });
	});
});
