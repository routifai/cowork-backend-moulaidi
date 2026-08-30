import { describe, expect, it } from "vitest";
import { mcpResultErrorMessage, mcpToolName, toPiToolResult } from "./mcp-client.js";

describe("mcpToolName", () => {
	it("namespaces the tool under a slugified connector name", () => {
		expect(mcpToolName("My Connector", "search")).toBe("mcp__my_connector__search");
	});

	it("sanitizes characters unsafe for a tool name", () => {
		expect(mcpToolName("Weird!! Name??", "do/the-thing")).toBe("mcp__weird_name__do_the-thing");
	});

	it("falls back to a generic slug when the connector name has no safe characters", () => {
		expect(mcpToolName("!!!", "tool")).toBe("mcp__connector__tool");
	});
});

describe("toPiToolResult", () => {
	it("maps text content blocks", () => {
		const result = toPiToolResult({ content: [{ type: "text", text: "hello" }] } as any);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("maps image content blocks", () => {
		const result = toPiToolResult({
			content: [{ type: "image", data: "base64==", mimeType: "image/png" }],
		} as any);
		expect(result.content).toEqual([{ type: "image", data: "base64==", mimeType: "image/png" }]);
	});

	it("falls back to a readable placeholder for unsupported block types", () => {
		const result = toPiToolResult({ content: [{ type: "audio", data: "x", mimeType: "audio/wav" }] } as any);
		expect(result.content).toEqual([{ type: "text", text: "[unsupported MCP content block: audio]" }]);
	});

	it("defaults to no content when the result omits it", () => {
		const result = toPiToolResult({} as any);
		expect(result.content).toEqual([]);
	});
});

describe("mcpResultErrorMessage", () => {
	it("joins text blocks into the error message", () => {
		const message = mcpResultErrorMessage({
			isError: true,
			content: [
				{ type: "text", text: "line one" },
				{ type: "text", text: "line two" },
			],
		} as any);
		expect(message).toBe("line one\nline two");
	});

	it("falls back to a generic message when there is no text content", () => {
		expect(mcpResultErrorMessage({ isError: true, content: [] } as any)).toBe("MCP tool call failed");
	});
});
