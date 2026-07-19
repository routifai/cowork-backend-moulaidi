/**
 * Tests for instructions-store — the custom-instructions Markdown persistence
 * that feeds the sidecar's system prompt.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	customInstructionsBlock,
	INSTRUCTIONS_FILENAME,
	instructionsFilePath,
	loadInstructions,
	saveInstructions,
} from "./instructions-store.js";

describe("instructions-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hypatia-instr-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("loadInstructions", () => {
		it("returns an empty string when the file is absent", () => {
			expect(loadInstructions(dir)).toBe("");
		});

		it("reads the file content when present", () => {
			writeFileSync(instructionsFilePath(dir), "Prefer tabs.", "utf-8");
			expect(loadInstructions(dir)).toBe("Prefer tabs.");
		});
	});

	describe("saveInstructions", () => {
		it("writes INSTRUCTIONS.md and returns its absolute path", () => {
			const p = saveInstructions(dir, "Be concise.");
			expect(p).toBe(join(dir, INSTRUCTIONS_FILENAME));
			expect(existsSync(p)).toBe(true);
			expect(readFileSync(p, "utf-8")).toBe("Be concise.");
		});

		it("creates the target directory if it does not exist", () => {
			const nested = join(dir, "cowork");
			const p = saveInstructions(nested, "Hi");
			expect(existsSync(p)).toBe(true);
			expect(p).toBe(join(nested, INSTRUCTIONS_FILENAME));
		});

		it("round-trips through loadInstructions", () => {
			saveInstructions(dir, "# Style\n\nUse TypeScript.");
			expect(loadInstructions(dir)).toBe("# Style\n\nUse TypeScript.");
		});

		it("can clear instructions by writing empty content", () => {
			saveInstructions(dir, "something");
			saveInstructions(dir, "");
			expect(loadInstructions(dir)).toBe("");
		});
	});

	describe("customInstructionsBlock", () => {
		it("returns an empty string for empty or whitespace-only content", () => {
			expect(customInstructionsBlock("")).toBe("");
			expect(customInstructionsBlock("   \n\t  ")).toBe("");
		});

		it("wraps content in a delimited system-prompt section", () => {
			const block = customInstructionsBlock("Always write tests first.");
			expect(block).toMatch(/## User's custom instructions/);
			expect(block).toContain("Always write tests first.");
		});

		it("trims surrounding whitespace from the content", () => {
			const block = customInstructionsBlock("\n\n  Use tabs.  \n\n");
			expect(block).toContain("Use tabs.");
			expect(block).not.toMatch(/Use tabs\.\s{2,}$/);
		});
	});
});
