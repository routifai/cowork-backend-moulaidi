import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteMcpConnector,
	getMcpConnector,
	listMcpConnectors,
	saveMcpConnectorOAuthState,
	upsertMcpConnector,
	type StdioMcpConnector,
	type HttpMcpConnector,
} from "./mcp-connector-store.js";

describe("mcp-connector-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hypatia-mcp-connectors-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const stdio: StdioMcpConnector = {
		id: "local-1",
		name: "Local Tool",
		enabledByDefault: true,
		transport: "stdio",
		command: "npx",
		args: ["-y", "some-mcp-server"],
	};

	it("returns [] when no connectors file exists", () => {
		expect(listMcpConnectors(dir)).toEqual([]);
	});

	it("persists and reads back a connector", () => {
		upsertMcpConnector(dir, stdio);
		expect(listMcpConnectors(dir)).toEqual([stdio]);
		expect(getMcpConnector(dir, "local-1")).toEqual(stdio);
	});

	it("replaces a connector with the same id rather than duplicating it", () => {
		upsertMcpConnector(dir, stdio);
		upsertMcpConnector(dir, { ...stdio, name: "Renamed" });
		const all = listMcpConnectors(dir);
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe("Renamed");
	});

	it("deletes a connector by id", () => {
		upsertMcpConnector(dir, stdio);
		expect(deleteMcpConnector(dir, "local-1")).toBe(true);
		expect(listMcpConnectors(dir)).toEqual([]);
	});

	it("deleting an unknown id is a no-op that returns false", () => {
		expect(deleteMcpConnector(dir, "missing")).toBe(false);
	});

	it("merges OAuth state into an existing http connector without touching other fields", () => {
		const http: HttpMcpConnector = {
			id: "remote-1",
			name: "Remote Tool",
			enabledByDefault: false,
			transport: "http",
			url: "https://example.com/mcp",
		};
		upsertMcpConnector(dir, http);

		const updated = saveMcpConnectorOAuthState(dir, "remote-1", {
			tokens: { access_token: "abc", token_type: "Bearer" } as any,
		});

		expect(updated?.oauth?.tokens).toEqual({ access_token: "abc", token_type: "Bearer" });
		expect(updated?.url).toBe("https://example.com/mcp");
		expect(getMcpConnector(dir, "remote-1")).toEqual(updated);
	});

	it("saveMcpConnectorOAuthState is a no-op for an unknown id", () => {
		expect(saveMcpConnectorOAuthState(dir, "missing", { tokens: {} as any })).toBeUndefined();
	});

	it("saveMcpConnectorOAuthState is a no-op for a stdio connector", () => {
		upsertMcpConnector(dir, stdio);
		expect(saveMcpConnectorOAuthState(dir, "local-1", { tokens: {} as any })).toBeUndefined();
	});
});
