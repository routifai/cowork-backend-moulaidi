import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteMemoryTopic,
	encodeWorkspacePath,
	loadMemoryIndex,
	loadMemoryNote,
	memoryDirForCwd,
	memoryIndexBlock,
	memoryIndexPath,
	memoryNotePath,
	slugify,
	upsertMemoryEntry,
} from "./memory-store.js";

describe("memory-store", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hypatia-memory-"));
	const cwd = "/Users/simo/project";

	it("encodes workspace paths deterministically", () => {
		expect(encodeWorkspacePath("/Users/simo/project")).toBe("--Users-simo-project--");
		expect(encodeWorkspacePath("C:\\\\Users\\\\project")).toBe("--C---Users--project--");
	});

	it("slugifies topics", () => {
		expect(slugify("Project Conventions")).toBe("project-conventions");
		expect(slugify("API keys / secrets")).toBe("api-keys-secrets");
	});

	it("computes memory paths", () => {
		expect(memoryDirForCwd(baseDir, cwd)).toContain("/memory/--Users-simo-project--");
		expect(memoryIndexPath(baseDir, cwd)).toContain("MEMORY.md");
		expect(memoryNotePath(baseDir, cwd, "Conventions")).toContain("notes/conventions.md");
	});

	it("loads an empty index when none exists", () => {
		expect(loadMemoryIndex(baseDir, cwd)).toEqual([]);
		expect(memoryIndexBlock(baseDir, cwd)).toBe("");
	});

	it("upserts an entry with a detail note", () => {
		const result = upsertMemoryEntry(baseDir, cwd, {
			topic: "Stack",
			summary: "We use Node 22 + React 19",
			type: "project",
			detail: "Package manager is pnpm. Tailwind v4.",
		});
		expect(result).toEqual({ ok: true });

		const entries = loadMemoryIndex(baseDir, cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].topic).toBe("Stack");
		expect(entries[0].type).toBe("project");
		expect(entries[0].summary).toBe("We use Node 22 + React 19");

		expect(loadMemoryNote(baseDir, cwd, "Stack")).toContain("pnpm");
	});

	it("updates an existing entry by slug", () => {
		upsertMemoryEntry(baseDir, cwd, { topic: "Stack", summary: "First summary" });
		upsertMemoryEntry(baseDir, cwd, { topic: "stack", summary: "Updated summary" });

		const entries = loadMemoryIndex(baseDir, cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].summary).toBe("Updated summary");
	});

	it("renders a system-prompt memory block", () => {
		upsertMemoryEntry(baseDir, cwd, { topic: "Convention", summary: "Use pnpm", type: "preference" });
		const block = memoryIndexBlock(baseDir, cwd);
		expect(block).toContain("## Project memory");
		expect(block).toContain("**Convention**");
		expect(block).toContain("[preference] Use pnpm");
	});

	it("deletes a topic and its note", () => {
		// Ensure a clean index for this isolated test.
		upsertMemoryEntry(baseDir, cwd, { topic: "UniqueDeleteMe", summary: "gone soon", detail: "body" });
		expect(deleteMemoryTopic(baseDir, cwd, "UniqueDeleteMe")).toBe(true);
		expect(loadMemoryIndex(baseDir, cwd).filter((e) => e.topic === "UniqueDeleteMe")).toHaveLength(0);
		expect(loadMemoryNote(baseDir, cwd, "UniqueDeleteMe")).toBeNull();
		expect(deleteMemoryTopic(baseDir, cwd, "UniqueDeleteMe")).toBe(false);
	});
});
