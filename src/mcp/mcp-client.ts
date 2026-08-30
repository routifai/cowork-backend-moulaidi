/**
 * mcp-client — connects to a single configured MCP connector (local stdio or
 * remote Streamable HTTP) and maps its tools/results to pi's tool shapes.
 *
 * Every function here is best-effort / non-throwing at the top level — a
 * connector that fails to connect (bad command, unreachable URL, expired
 * token) must not take down session bootstrap, matching how
 * disk-extension-loader.ts tolerates a single bad extension.
 */

import {
	Client,
	StreamableHTTPClientTransport,
	type CallToolResult,
	type ContentBlock,
	type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpConnector } from "../mcp-connector-store.js";
import { createMcpOAuthProvider } from "./mcp-oauth.js";

export const MCP_CONNECT_TIMEOUT_MS = 10_000;

export interface ConnectedMcpConnector {
	connector: McpConnector;
	client: Client;
	tools: Tool[];
}

export type ConnectMcpConnectorResult = ConnectedMcpConnector | { connector: McpConnector; error: string };

function buildTransport(connector: McpConnector, agentDir: string) {
	if (connector.transport === "stdio") {
		return new StdioClientTransport({
			command: connector.command,
			args: connector.args,
			env: connector.env,
		});
	}
	const authProvider = connector.oauth?.tokens
		? createMcpOAuthProvider(agentDir, connector)
		: undefined;
	return new StreamableHTTPClientTransport(new URL(connector.url), {
		authProvider,
		requestInit: connector.headers ? { headers: connector.headers } : undefined,
	});
}

/**
 * Connect to one connector and list its tools. Never throws — returns
 * `{ error }` instead so callers can log-and-skip a single bad connector
 * without aborting the rest.
 */
export async function connectMcpConnector(
	connector: McpConnector,
	agentDir: string,
): Promise<ConnectMcpConnectorResult> {
	const client = new Client({ name: "hypatia-cowork", version: "1.0.0" });
	try {
		const transport = buildTransport(connector, agentDir);
		await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, "connect");
		const { tools } = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, "listTools");
		return { connector, client, tools };
	} catch (err) {
		try {
			await client.close();
		} catch {
			// already failed to connect; nothing to clean up
		}
		return { connector, error: err instanceof Error ? err.message : String(err) };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`mcp ${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Sanitize + namespace an MCP tool name so it can't collide across connectors. */
export function mcpToolName(connectorName: string, toolName: string): string {
	const slug = connectorName
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 30);
	const safeTool = toolName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
	return `mcp__${slug || "connector"}__${safeTool}`.slice(0, 128);
}

/**
 * Map an MCP CallToolResult into pi's AgentToolResult content shape. Unlike
 * MCP, pi has no `isError` field on a tool result — the agent loop derives
 * `isError` purely from whether `execute()` threw (see
 * `@earendil-works/pi-agent-core`'s `executePreparedToolCall`). Callers must
 * check `result.isError` themselves and throw instead of calling this when
 * it's true — see `mcpResultErrorMessage`.
 */
export function toPiToolResult(result: CallToolResult): AgentToolResult<unknown> {
	return {
		content: (result.content ?? []).map(contentBlockToPiContent),
		details: undefined,
	};
}

/** Text to throw as an Error when `CallToolResult.isError` is true. */
export function mcpResultErrorMessage(result: CallToolResult): string {
	const text = (result.content ?? [])
		.map((b) => (b.type === "text" ? b.text : `[${b.type} content]`))
		.join("\n")
		.trim();
	return text || "MCP tool call failed";
}

function contentBlockToPiContent(block: ContentBlock): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
	if (block.type === "text") {
		return { type: "text", text: block.text };
	}
	if (block.type === "image") {
		return { type: "image", data: block.data, mimeType: block.mimeType };
	}
	// audio / resource / resource_link — no pi content type for these yet;
	// surface something readable rather than dropping the block silently.
	return { type: "text", text: `[unsupported MCP content block: ${block.type}]` };
}
