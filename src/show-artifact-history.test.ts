import { describe, expect, it } from "vitest";
import { reconstructShowArtifacts } from "./show-artifact-history.js";

function assistantMsg(timestamp: number, toolCalls: Record<string, unknown>[]) {
	return { role: "assistant", timestamp, toolCalls };
}

describe("reconstructShowArtifacts", () => {
	it("reconstructs a record from a completed show_artifact tool call", () => {
		const messages = [
			assistantMsg(100, [
				{
					id: "t1",
					name: "show_artifact",
					status: "completed",
					args: { id: "demo", type: "html", title: "Demo", content: "<h1>hi</h1>" },
				},
			]),
		];
		expect(reconstructShowArtifacts(messages)).toEqual([
			{ id: "demo", type: "html", title: "Demo", content: "<h1>hi</h1>", language: undefined, updatedAt: 100 },
		]);
	});

	it("skips pending/error tool calls", () => {
		const messages = [
			assistantMsg(100, [
				{ id: "t1", name: "show_artifact", status: "pending", args: { id: "a", content: "x" } },
				{ id: "t2", name: "show_artifact", status: "error", args: { id: "b", content: "y" } },
			]),
		];
		expect(reconstructShowArtifacts(messages)).toEqual([]);
	});

	it("ignores calls to other tools", () => {
		const messages = [
			assistantMsg(100, [
				{ id: "t1", name: "write", status: "completed", args: { path: "/a.ts", content: "x" } },
			]),
		];
		expect(reconstructShowArtifacts(messages)).toEqual([]);
	});

	it("later messages win on id collisions (same artifact updated across two turns)", () => {
		const messages = [
			assistantMsg(100, [
				{
					id: "t1",
					name: "show_artifact",
					status: "completed",
					args: { id: "demo", type: "html", title: "Demo", content: "v1" },
				},
			]),
			assistantMsg(200, [
				{
					id: "t2",
					name: "show_artifact",
					status: "completed",
					args: { id: "demo", type: "html", title: "Demo", content: "v2" },
				},
			]),
		];
		const artifacts = reconstructShowArtifacts(messages);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toMatchObject({ id: "demo", content: "v2", updatedAt: 200 });
	});

	it("keeps distinct ids as separate records", () => {
		const messages = [
			assistantMsg(100, [
				{ id: "t1", name: "show_artifact", status: "completed", args: { id: "a", content: "x" } },
				{ id: "t2", name: "show_artifact", status: "completed", args: { id: "b", content: "y" } },
			]),
		];
		expect(reconstructShowArtifacts(messages).map((a) => a.id).sort()).toEqual(["a", "b"]);
	});

	it("passes through the optional language field for code artifacts", () => {
		const messages = [
			assistantMsg(100, [
				{
					id: "t1",
					name: "show_artifact",
					status: "completed",
					args: { id: "a", type: "code", title: "a.ts", content: "const x = 1;", language: "typescript" },
				},
			]),
		];
		expect(reconstructShowArtifacts(messages)[0]).toMatchObject({ language: "typescript" });
	});

	it("ignores non-assistant messages and messages with no toolCalls", () => {
		const messages = [
			{ role: "user", timestamp: 50 },
			{ role: "assistant", timestamp: 60 },
			assistantMsg(100, [
				{ id: "t1", name: "show_artifact", status: "completed", args: { id: "a", content: "x" } },
			]),
		];
		expect(reconstructShowArtifacts(messages)).toHaveLength(1);
	});

	it("skips a show_artifact call with a malformed args shape (missing id/content)", () => {
		const messages = [
			assistantMsg(100, [{ id: "t1", name: "show_artifact", status: "completed", args: { title: "no id" } }]),
		];
		expect(reconstructShowArtifacts(messages)).toEqual([]);
	});
});
