import { describe, expect, it } from "vitest";
import {
	attachmentDisplayName,
	shouldParseAttachments,
	stripUiContextPrefix,
} from "../chat/service.js";

describe("chat attachments", () => {
	it("uses the explicit name when present", () => {
		expect(attachmentDisplayName({ name: "brief.pdf", filePath: "/tmp/x.pdf" })).toBe("brief.pdf");
	});

	it("falls back to the basename", () => {
		expect(attachmentDisplayName({ filePath: "/tmp/presenton/notes.docx" })).toBe("notes.docx");
	});

	it("parses attachments when the user asks about document content", () => {
		expect(
			shouldParseAttachments("summarize the attached brief", [
				{ filePath: "/tmp/brief.pdf", name: "brief.pdf" },
			]),
		).toBe(true);
	});

	it("skips parsing for direct file-placement requests", () => {
		expect(
			shouldParseAttachments("insert this file on slide 2", [
				{ filePath: "/tmp/brief.pdf", name: "brief.pdf" },
			]),
		).toBe(false);
	});

	it("parses when the user message is empty but files are attached", () => {
		expect(shouldParseAttachments("", [{ filePath: "/tmp/brief.pdf" }])).toBe(true);
	});

	it("strips a UI-context prefix before the user message", () => {
		expect(stripUiContextPrefix("UI context: slide 1\nUser message: make it shorter")).toBe(
			"make it shorter",
		);
	});
});
