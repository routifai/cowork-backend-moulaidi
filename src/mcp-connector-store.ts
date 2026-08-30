/**
 * mcp-connector-store — persistence for user-configured MCP connectors
 * ("My Connectors"), both local (stdio-spawned) and remote (Streamable HTTP,
 * optionally OAuth-authenticated).
 *
 * Connectors live in a single `mcp-connectors.json` under the Hypatia agent
 * dir, mirroring settings-store.ts's whole-file-read/whole-file-write shape
 * (there's no per-session data here — session-scoped enablement is tracked
 * in-memory on SessionState, not persisted; see app/session-state.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

export interface McpConnectorOAuthState {
	clientInformation?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
	authorizationServerUrl?: string;
	resourceUrl?: string;
}

interface McpConnectorBase {
	id: string;
	name: string;
	/** Whether new sessions start with this connector's tools registered. */
	enabledByDefault: boolean;
}

export interface StdioMcpConnector extends McpConnectorBase {
	transport: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface HttpMcpConnector extends McpConnectorBase {
	transport: "http";
	url: string;
	/** Static auth headers (e.g. a hand-pasted Bearer token). Ignored once `oauth.tokens` is set. */
	headers?: Record<string, string>;
	oauth?: McpConnectorOAuthState;
}

export type McpConnector = StdioMcpConnector | HttpMcpConnector;

interface McpConnectorFile {
	connectors: McpConnector[];
}

export function mcpConnectorsFilePath(agentDir: string): string {
	return join(agentDir, "mcp-connectors.json");
}

function loadFile(agentDir: string): McpConnectorFile {
	const fp = mcpConnectorsFilePath(agentDir);
	if (!existsSync(fp)) return { connectors: [] };
	try {
		const parsed = JSON.parse(readFileSync(fp, "utf-8"));
		if (parsed && typeof parsed === "object" && Array.isArray(parsed.connectors)) {
			return { connectors: parsed.connectors as McpConnector[] };
		}
		return { connectors: [] };
	} catch {
		return { connectors: [] };
	}
}

function saveFile(agentDir: string, file: McpConnectorFile): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(mcpConnectorsFilePath(agentDir), JSON.stringify(file, null, 2), "utf-8");
}

export function listMcpConnectors(agentDir: string): McpConnector[] {
	return loadFile(agentDir).connectors;
}

export function getMcpConnector(agentDir: string, id: string): McpConnector | undefined {
	return loadFile(agentDir).connectors.find((c) => c.id === id);
}

/** Insert or replace a connector by id. Returns the saved connector. */
export function upsertMcpConnector(agentDir: string, connector: McpConnector): McpConnector {
	const file = loadFile(agentDir);
	const idx = file.connectors.findIndex((c) => c.id === connector.id);
	if (idx >= 0) {
		file.connectors[idx] = connector;
	} else {
		file.connectors.push(connector);
	}
	saveFile(agentDir, file);
	return connector;
}

export function deleteMcpConnector(agentDir: string, id: string): boolean {
	const file = loadFile(agentDir);
	const before = file.connectors.length;
	file.connectors = file.connectors.filter((c) => c.id !== id);
	if (file.connectors.length === before) return false;
	saveFile(agentDir, file);
	return true;
}

/**
 * Merge OAuth state into an existing HTTP connector without touching its
 * other fields. No-ops (does not create a connector) if `id` isn't found or
 * isn't an http connector — the OAuth flow always starts from an existing
 * saved connector.
 */
export function saveMcpConnectorOAuthState(
	agentDir: string,
	id: string,
	oauth: McpConnectorOAuthState,
): HttpMcpConnector | undefined {
	const file = loadFile(agentDir);
	const idx = file.connectors.findIndex((c) => c.id === id);
	if (idx < 0) return undefined;
	const existing = file.connectors[idx];
	if (existing.transport !== "http") return undefined;
	const updated: HttpMcpConnector = {
		...existing,
		oauth: { ...existing.oauth, ...oauth },
	};
	file.connectors[idx] = updated;
	saveFile(agentDir, file);
	return updated;
}
