/**
 * MCP connector command handlers ("My Connectors"): CRUD + test + the
 * per-session enable/disable toggle + the OAuth login flow.
 */

import { randomUUID } from "node:crypto";
import { send, log } from "../../protocol.js";
import type { HandlerDependencies } from "../handler-registry.js";
import { hypatiaAgentDir } from "../../agent-init.js";
import {
	deleteMcpConnector,
	getMcpConnector,
	listMcpConnectors,
	upsertMcpConnector,
	type McpConnector,
} from "../../mcp-connector-store.js";
import { connectMcpConnector } from "../../mcp/mcp-client.js";
import { startMcpConnectorOAuth, submitMcpOAuthCode } from "../../mcp/mcp-oauth.js";
import { resolveTargetSession } from "./core.js";
import type {
	ListMcpConnectorsCommand,
	SaveMcpConnectorCommand,
	DeleteMcpConnectorCommand,
	TestMcpConnectorCommand,
	SetSessionMcpConnectorCommand,
	McpConnectorOAuthStartCommand,
	McpConnectorOAuthSubmitCodeCommand,
	McpConnectorInput,
} from "../types.js";

function inputToConnector(input: McpConnectorInput, existing?: McpConnector): McpConnector {
	const id = input.id ?? existing?.id ?? randomUUID();
	if (input.transport === "stdio") {
		if (!input.command) throw new Error("stdio connector requires a command");
		return {
			id,
			name: input.name,
			enabledByDefault: input.enabledByDefault,
			transport: "stdio",
			command: input.command,
			args: input.args,
			env: input.env,
		};
	}
	if (!input.url) throw new Error("http connector requires a url");
	const existingOAuth = existing?.transport === "http" ? existing.oauth : undefined;
	return {
		id,
		name: input.name,
		enabledByDefault: input.enabledByDefault,
		transport: "http",
		url: input.url,
		headers: input.headers,
		oauth: existingOAuth,
	};
}

export async function handleListMcpConnectors(
	deps: HandlerDependencies,
	cmd: ListMcpConnectorsCommand,
): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	const connectors = listMcpConnectors(agentDir);
	const state = cmd.sessionId ? deps.getSession(cmd.sessionId) : undefined;
	const enabledIds = state?.mcpConnectorIds.current;
	const data = connectors.map((c) => ({
		...redactConnector(c),
		enabled: enabledIds ? enabledIds.has(c.id) : c.enabledByDefault,
	}));
	send({ type: "result", id: cmd.id, data: { connectors: data } });
}

/** Never send OAuth tokens/client secrets to the frontend. */
function redactConnector(c: McpConnector): Record<string, unknown> {
	if (c.transport !== "http") return { ...c };
	const { oauth, ...rest } = c;
	return { ...rest, hasOAuth: Boolean(oauth?.tokens) };
}

export async function handleSaveMcpConnector(
	deps: HandlerDependencies,
	cmd: SaveMcpConnectorCommand,
): Promise<void> {
	try {
		const agentDir = hypatiaAgentDir(deps.hypatiaDir);
		const existing = cmd.connector.id ? getMcpConnector(agentDir, cmd.connector.id) : undefined;
		const connector = inputToConnector(cmd.connector, existing);
		upsertMcpConnector(agentDir, connector);
		send({ type: "result", id: cmd.id, data: { connector: redactConnector(connector) } });
	} catch (err) {
		send({ type: "error", id: cmd.id, message: err instanceof Error ? err.message : String(err) });
	}
}

export async function handleDeleteMcpConnector(
	deps: HandlerDependencies,
	cmd: DeleteMcpConnectorCommand,
): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	const deleted = deleteMcpConnector(agentDir, cmd.connectorId);
	send({ type: "result", id: cmd.id, data: { deleted } });
}

export async function handleTestMcpConnector(
	deps: HandlerDependencies,
	cmd: TestMcpConnectorCommand,
): Promise<void> {
	try {
		const agentDir = hypatiaAgentDir(deps.hypatiaDir);
		// Test against a throwaway connector object — not persisted — so
		// "Test" in the Add Connector dialog works before Save. If the input
		// names an already-saved connector, reuse its saved OAuth tokens so
		// testing a connected remote connector doesn't require re-authing.
		const existing = cmd.connector.id ? getMcpConnector(agentDir, cmd.connector.id) : undefined;
		const probe = inputToConnector({ ...cmd.connector, id: cmd.connector.id ?? "test" }, existing);
		const result = await connectMcpConnector(probe, agentDir);
		if ("error" in result) {
			send({ type: "result", id: cmd.id, data: { success: false, error: result.error } });
			return;
		}
		const tools = result.tools.map((t) => ({ name: t.name, description: t.description }));
		await result.client.close().catch(() => {});
		send({ type: "result", id: cmd.id, data: { success: true, tools } });
	} catch (err) {
		send({ type: "error", id: cmd.id, message: err instanceof Error ? err.message : String(err) });
	}
}

export async function handleSetSessionMcpConnector(
	deps: HandlerDependencies,
	cmd: SetSessionMcpConnectorCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;

	if (!state.mcpConnectorIds.current) {
		// First per-session override: seed from stored defaults so toggling
		// one connector off doesn't silently disable every other
		// enabled-by-default connector too.
		const agentDir = hypatiaAgentDir(deps.hypatiaDir);
		state.mcpConnectorIds.current = new Set(
			listMcpConnectors(agentDir)
				.filter((c) => c.enabledByDefault)
				.map((c) => c.id),
		);
	}
	if (cmd.enabled) {
		state.mcpConnectorIds.current.add(cmd.connectorId);
	} else {
		state.mcpConnectorIds.current.delete(cmd.connectorId);
	}

	try {
		await state.session.reload();
	} catch (err) {
		log(
			"set_session_mcp_connector: session.reload() failed (applies on next new chat): %s",
			err instanceof Error ? err.message : String(err),
		);
	}
	send({
		type: "result",
		id: cmd.id,
		data: { enabledConnectorIds: Array.from(state.mcpConnectorIds.current) },
	});
}

export async function handleMcpConnectorOAuthStart(
	deps: HandlerDependencies,
	cmd: McpConnectorOAuthStartCommand,
): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	const result = await startMcpConnectorOAuth(agentDir, cmd.connectorId);
	if (result.success) {
		send({ type: "result", id: cmd.id, data: { success: true } });
	} else {
		send({ type: "error", id: cmd.id, message: result.error });
	}
}

export async function handleMcpConnectorOAuthSubmitCode(
	_deps: HandlerDependencies,
	cmd: McpConnectorOAuthSubmitCodeCommand,
): Promise<void> {
	const accepted = submitMcpOAuthCode(cmd.connectorId, cmd.code);
	send({ type: "result", id: cmd.id, data: { accepted } });
}
