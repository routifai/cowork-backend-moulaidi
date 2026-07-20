import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import saveMemoryExtension, { SAVE_MEMORY_TOOL_NAME } from "./save-memory.js";
import { loadMemoryIndex, loadMemoryNote } from "../memory-store.js";

function fakeExtensionAPI() {
	const tools: unknown[] = [];
	return {
		registerTool: (tool: unknown) => tools.push(tool),
		tools,
	};
}

describe("save-memory extension", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hypatia-save-memory-"));
	const workspaceCwd = "/Users/simo/project";

	it("registers the save_memory tool", () => {
		const api = fakeExtensionAPI();
		// @ts-expect-error minimal fake for registration test
		saveMemoryExtension(api, { baseDir, workspaceCwd });
		expect(api.tools).toHaveLength(1);
		expect((api.tools[0] as { name: string }).name).toBe(SAVE_MEMORY_TOOL_NAME);
	});

	it("persists a memory entry via execute", async () => {
		const api = fakeExtensionAPI();
		// @ts-expect-error minimal fake for execute test
		saveMemoryExtension(api, { baseDir, workspaceCwd });
		const tool = api.tools[0] as { execute: (id: string, params: unknown) => Promise<{ content: unknown[]; details: unknown }> };

		const result = await tool.execute("call-1", {
			topic: "Stack",
			summary: "Use pnpm and Node 22",
			type: "project",
			detail: "React 19 + Tailwind v4.",
		});

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: 'Remembered "Stack": Use pnpm and Node 22',
		});

		const entries = loadMemoryIndex(baseDir, workspaceCwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].topic).toBe("Stack");

		expect(loadMemoryNote(baseDir, workspaceCwd, "Stack")).toContain("React 19");
	});
});
