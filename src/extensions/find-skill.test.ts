import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import findSkillExtension, { FIND_SKILL_TOOL_NAME, type FindSkillDetails } from "./find-skill.js";

function fakeExtensionAPI() {
	const tools: unknown[] = [];
	return {
		registerTool: (tool: unknown) => tools.push(tool),
		tools,
	};
}

function writeSkill(skillsDir: string, name: string, description: string) {
	const dir = join(skillsDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFull instructions body.\n`,
		"utf-8",
	);
}

describe("find-skill extension", () => {
	// This directory plays the role of pi's global agentDir (~/.pi/agent) —
	// global skills are discovered under <agentDir>/skills, so pointing
	// agentDir at a temp dir keeps the test fully hermetic (no dependency on
	// the real ~/.pi/agent/skills or any settings.json-configured library).
	const agentDir = mkdtempSync(join(tmpdir(), "hypatia-find-skill-"));
	const workspaceCwd = "/Users/simo/project";

	writeSkill(join(agentDir, "skills"), "pptx", "Presentation creation and editing for PowerPoint files.");
	writeSkill(join(agentDir, "skills"), "pdf-tools", "Extracts text and tables from PDF files, fills PDF forms.");
	writeSkill(
		join(agentDir, "skills"),
		"webapp-testing",
		"Toolkit for testing local web applications using Playwright.",
	);

	function registerAndGetTool() {
		const api = fakeExtensionAPI();
		// @ts-expect-error minimal fake for registration/execute tests
		findSkillExtension(api, { workspaceCwd, agentDir });
		return api.tools[0] as {
			execute: (
				id: string,
				params: unknown,
			) => Promise<{ content: { type: string; text: string }[]; details: FindSkillDetails }>;
		};
	}

	it("registers the find_skill tool", () => {
		const api = fakeExtensionAPI();
		// @ts-expect-error minimal fake for registration test
		findSkillExtension(api, { workspaceCwd, agentDir });
		expect(api.tools).toHaveLength(1);
		expect((api.tools[0] as { name: string }).name).toBe(FIND_SKILL_TOOL_NAME);
	});

	it("ranks the matching skill first and returns metadata only, never skill body content", async () => {
		const tool = registerAndGetTool();
		const result = await tool.execute("call-1", { query: "create a powerpoint presentation" });

		expect(result.details.matches[0].name).toBe("pptx");
		expect(result.details.matches[0].filePath).toContain("pptx");
		// Metadata only — the body ("Full instructions body.") must never leak
		// into the tool result; the model is expected to `read` filePath itself.
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("Full instructions body");
		expect(result.content[0].text).toContain("pptx");
	});

	it("excludes unrelated skills from a query with no term overlap", async () => {
		const tool = registerAndGetTool();
		const result = await tool.execute("call-2", { query: "extract text from a pdf form" });

		const names = result.details.matches.map((m) => m.name);
		expect(names).toContain("pdf-tools");
		expect(names).not.toContain("webapp-testing");
		expect(names).not.toContain("pptx");
	});

	it("returns an empty match list (not an error) when nothing matches", async () => {
		const tool = registerAndGetTool();
		const result = await tool.execute("call-3", { query: "zzz nonexistent gibberish query" });

		expect(result.details.matches).toEqual([]);
		expect(result.content[0].text).toContain("No matching skills found");
	});
});
