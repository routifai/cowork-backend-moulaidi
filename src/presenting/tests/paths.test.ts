import { describe, expect, it } from "vitest";
import { loadsJsonish } from "../utils/jsonish.js";
import { presentingEngineRoot } from "../paths.js";
import { join } from "node:path";

describe("presenting paths", () => {
	it("resolves the engine root under hypatia-backend", () => {
		const root = presentingEngineRoot();
		expect(root.endsWith(join("presenting", "engine"))).toBe(true);
	});
});

describe("loadsJsonish fence/prose cases used by generation", () => {
	it("parses an outline-shaped fence", () => {
		const text = '```json\n{"slides":[{"content":"## Title\\nBody"}]}\n```';
		expect(loadsJsonish(text)).toEqual({ slides: [{ content: "## Title\nBody" }] });
	});
});
