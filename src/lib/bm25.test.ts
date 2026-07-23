import { describe, expect, it } from "vitest";
import { rankBm25 } from "./bm25.js";

describe("rankBm25", () => {
	it("ranks the document whose text matches the query terms above unrelated documents", () => {
		const results = rankBm25("create a powerpoint presentation", [
			{ id: "pptx", text: "Presentation creation and editing for PowerPoint (.pptx) files." },
			{ id: "pdf", text: "Extracts text and tables from PDF files, fills PDF forms." },
			{ id: "webapp-testing", text: "Toolkit for testing local web applications using Playwright." },
		]);

		expect(results[0].id).toBe("pptx");
		expect(results[0].score).toBeGreaterThan(results[1].score);
		expect(results[0].score).toBeGreaterThan(results[2].score);
	});

	it("gives a zero score to a document with no overlapping terms", () => {
		const results = rankBm25("pdf forms", [{ id: "unrelated", text: "Web search and content extraction." }]);
		expect(results[0].score).toBe(0);
	});

	it("scores a document containing the query term more than once higher than one containing it once, all else equal", () => {
		const results = rankBm25("search", [
			{ id: "once", text: "search for documentation" },
			{ id: "twice", text: "search search for documentation" },
			{ id: "none", text: "totally unrelated content" },
		]);
		const byId = (id: string) => results.find((r) => r.id === id)!;
		expect(byId("twice").score).toBeGreaterThan(byId("once").score);
		expect(byId("once").score).toBeGreaterThan(byId("none").score);
	});

	it("is case-insensitive and ignores punctuation", () => {
		const results = rankBm25("PowerPoint!", [{ id: "a", text: "powerpoint presentations" }]);
		expect(results[0].score).toBeGreaterThan(0);
	});

	it("returns every document, sorted descending by score, none dropped", () => {
		const results = rankBm25("anything", [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }]);
		expect(results).toHaveLength(3);
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});

	it("handles an empty document list", () => {
		expect(rankBm25("query", [])).toEqual([]);
	});

	it("handles an empty query (no terms to match, every score is zero)", () => {
		const results = rankBm25("", [{ id: "a", text: "some text" }]);
		expect(results[0].score).toBe(0);
	});

	it("doesn't let filler words in the query outrank the document matching the actual subject — real bug found testing against the real skills library: 'make me a PowerPoint presentation' ranked a GIF-creation skill above pptx because its description happened to contain 'make'/'me', accumulating more weak matches than pptx's one strong match on 'powerpoint'/'presentation'", () => {
		const results = rankBm25("make me a PowerPoint presentation", [
			{
				id: "pptx",
				text: "Presentation creation, editing, and analysis. Creating new presentations, modifying content, presentation tasks.",
			},
			{
				id: "slack-gif-creator",
				text: 'Knowledge and utilities for creating animated GIFs. Use when users request GIFs like "make me a GIF of X doing Y for Slack."',
			},
		]);
		const byId = (id: string) => results.find((r) => r.id === id)!;
		expect(byId("pptx").score).toBeGreaterThan(byId("slack-gif-creator").score);
	});
});
