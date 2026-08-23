import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assemblePptxFromImages } from "../services/assemble-pptx.js";

// 1x1 PNG
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("assemblePptxFromImages", () => {
	it("writes a ZIP that looks like a PPTX", () => {
		const dir = mkdtempSync(join(tmpdir(), "pptx-test-"));
		try {
			const png = join(dir, "slide.png");
			const out = join(dir, "deck.pptx");
			writeFileSync(png, TINY_PNG);
			assemblePptxFromImages([png, png], out);
			const bytes = readFileSync(out);
			expect(bytes.subarray(0, 2).toString()).toBe("PK");
			expect(bytes.includes(Buffer.from("[Content_Types].xml"))).toBe(true);
			expect(bytes.includes(Buffer.from("ppt/slides/slide1.xml"))).toBe(true);
			expect(bytes.includes(Buffer.from("ppt/slides/slide2.xml"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
