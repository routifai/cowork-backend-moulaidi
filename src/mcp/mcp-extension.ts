/**
 * mcp-extension — the pi ExtensionFactory that bridges configured MCP
 * connectors into the agent's tool set.
 *
 * Registered once per session (see agent-init.ts's buildResourceLoader()),
 * and re-run every time that session's ResourceLoader.reload() fires —
 * including the "toggle a connector on/off mid-conversation" path
 * (commands/handlers/mcp-connectors.ts calls `session.reload()` after
 * mutating the session's enabled-connector set). Each invocation reads live
 * state via `getEnabledConnectorIds`, so a reload naturally reconnects to
 * whatever's enabled *now* — no bespoke live-reconnect machinery needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { listMcpConnectors, type McpConnector } from "../mcp-connector-store.js";
import { connectMcpConnector, mcpResultErrorMessage, mcpToolName, toPiToolResult } from "./mcp-client.js";
import { log } from "../protocol.js";

export interface McpExtensionOptions {
	agentDir: string;
	/**
	 * Which connector ids are enabled *for this session*. `undefined` means
	 * "no explicit choice made yet" — fall back to each connector's stored
	 * `enabledByDefault`. This is a getter (not a fixed array) so a later
	 * `session.reload()` — driven by SessionState's mutable box, see
	 * app/session-state.ts — picks up a toggle made after the session started.
	 */
	getEnabledConnectorIds: () => Set<string> | undefined;
}

function selectEnabledConnectors(all: McpConnector[], enabledIds: Set<string> | undefined): McpConnector[] {
	if (enabledIds) return all.filter((c) => enabledIds.has(c.id));
	return all.filter((c) => c.enabledByDefault);
}

export default async function mcpExtension(pi: ExtensionAPI, opts: McpExtensionOptions): Promise<void> {
	const all = listMcpConnectors(opts.agentDir);
	const enabled = selectEnabledConnectors(all, opts.getEnabledConnectorIds());
	if (enabled.length === 0) return;

	const clients: Client[] = [];
	const registeredNames = new Set<string>();

	const results = await Promise.all(enabled.map((connector) => connectMcpConnector(connector, opts.agentDir)));

	for (const result of results) {
		if ("error" in result) {
			log("mcp connector %s failed to connect: %s", result.connector.name, result.error);
			continue;
		}
		const { connector, client, tools } = result;
		clients.push(client);

		for (const tool of tools) {
			const name = mcpToolName(connector.name, tool.name);
			if (registeredNames.has(name)) {
				log("mcp: skipping duplicate tool name %s from connector %s", name, connector.name);
				continue;
			}
			registeredNames.add(name);

			pi.registerTool({
				name,
				label: tool.title ?? tool.name,
				description: tool.description ?? `Tool "${tool.name}" from MCP connector "${connector.name}".`,
				// MCP ships tools as raw JSON Schema; pi's typebox (v1) stores its
				// `Kind` as a plain string rather than a module-local Symbol (see
				// disk-extension-loader.ts's comment on this), so a bare JSON
				// Schema object validates the same way a TypeBox schema would.
				parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
				async execute(_toolCallId, params) {
					const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
					// pi has no isError field on a tool result — isError is derived
					// purely from execute() throwing (see mcp-client.ts's doc comment
					// on toPiToolResult), so an MCP-reported error must throw here.
					if (result.isError) throw new Error(mcpResultErrorMessage(result));
					return toPiToolResult(result);
				},
			});
		}
	}

	if (clients.length === 0) return;

	pi.on("session_shutdown", async () => {
		await Promise.all(
			clients.map((c) =>
				c.close().catch((err) => log("mcp: error closing client: %s", err instanceof Error ? err.message : String(err))),
			),
		);
	});
}
