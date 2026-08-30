/**
 * mcp-oauth — OAuth 2.1 (dynamic client registration + PKCE + browser
 * redirect) for remote MCP connectors, using the MCP SDK's own client-side
 * auth helpers (`@modelcontextprotocol/client`'s `auth()` / `OAuthClientProvider`).
 *
 * The browser step reuses an already-wired-but-unused convention: any
 * backend event whose `kind` starts with `"oauth_"` is forwarded by the Rust
 * host straight to the frontend as a global Tauri event (see
 * `hypatia-frontend/src-tauri/src/lib.rs`'s `read_stdout`). We emit
 * `oauth_authorize_url` and the frontend opens it via the existing
 * `openExternalUrl()` helper — no Rust changes needed.
 *
 * The callback itself is a local loopback HTTP server, the same shape
 * `@earendil-works/pi-ai`'s `dist/auth/oauth/anthropic.js` already uses for
 * the Anthropic provider login (a different fixed port so the two don't
 * collide) — including its "paste the redirect URL" manual fallback via
 * `submitMcpOAuthCode`.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
	auth,
	discoverOAuthServerInfo,
	type OAuthClientProvider,
	type OAuthClientMetadata,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { send, log } from "../protocol.js";
import {
	getMcpConnector,
	saveMcpConnectorOAuthState,
	type HttpMcpConnector,
	type McpConnector,
} from "../mcp-connector-store.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53_701;
const CALLBACK_PATH = "/mcp/oauth/callback";
const REDIRECT_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CLIENT_METADATA: OAuthClientMetadata = {
	client_name: "Hypatia Cowork",
	redirect_uris: [REDIRECT_URL],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
};

// In-memory, one-login-attempt-at-a-time state. PKCE verifiers are
// short-lived by nature (used once, within the same login attempt) so
// there's no need to persist them.
const codeVerifiers = new Map<string, string>();

/**
 * Build an `OAuthClientProvider` for one connector, backed by
 * mcp-connector-store.ts. Used both for normal connections (reading saved
 * tokens) and for driving a login flow (also writing them).
 */
export function createMcpOAuthProvider(agentDir: string, connector: McpConnector): OAuthClientProvider {
	if (connector.transport !== "http") {
		throw new Error(`createMcpOAuthProvider: connector ${connector.id} is not an http connector`);
	}
	const id = connector.id;
	return {
		clientMetadata: CLIENT_METADATA,
		redirectUrl: REDIRECT_URL,
		clientInformation(): StoredOAuthClientInformation | undefined {
			return currentConnector(agentDir, id)?.oauth?.clientInformation;
		},
		saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
			saveMcpConnectorOAuthState(agentDir, id, { clientInformation });
		},
		tokens(): StoredOAuthTokens | undefined {
			return currentConnector(agentDir, id)?.oauth?.tokens;
		},
		saveTokens(tokens: StoredOAuthTokens): void {
			saveMcpConnectorOAuthState(agentDir, id, { tokens });
		},
		codeVerifier(): string {
			const verifier = codeVerifiers.get(id);
			if (!verifier) throw new Error("no PKCE code verifier in progress for this connector");
			return verifier;
		},
		saveCodeVerifier(codeVerifier: string): void {
			codeVerifiers.set(id, codeVerifier);
		},
		redirectToAuthorization(authorizationUrl: URL): void {
			send({
				type: "event",
				event: { kind: "oauth_authorize_url", url: authorizationUrl.toString(), connectorId: id },
			});
		},
		authorizationServerUrl(): string | undefined {
			return currentConnector(agentDir, id)?.oauth?.authorizationServerUrl;
		},
		saveAuthorizationServerUrl(authorizationServerUrl: string): void {
			saveMcpConnectorOAuthState(agentDir, id, { authorizationServerUrl });
		},
		resourceUrl(): string | undefined {
			return currentConnector(agentDir, id)?.oauth?.resourceUrl;
		},
		saveResourceUrl(resourceUrl: string): void {
			saveMcpConnectorOAuthState(agentDir, id, { resourceUrl });
		},
	};
}

function currentConnector(agentDir: string, id: string): HttpMcpConnector | undefined {
	const connector = getMcpConnector(agentDir, id);
	return connector?.transport === "http" ? connector : undefined;
}

interface CallbackResult {
	code: string;
	iss?: string;
}

function startCallbackServer(): Promise<{ server: Server; waitForCallback: Promise<CallbackResult> }> {
	return new Promise((resolve, reject) => {
		let settle: (v: CallbackResult) => void;
		const waitForCallback = new Promise<CallbackResult>((res) => {
			settle = res;
		});
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not found");
				return;
			}
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (error || !code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`<html><body>MCP connector authorization failed${error ? `: ${error}` : ""}. You can close this window.</body></html>`);
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body>MCP connector authorized. You can close this window.</body></html>");
			settle({ code, iss: url.searchParams.get("iss") ?? undefined });
		});
		server.on("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve({ server, waitForCallback }));
	});
}

// Pending manual-code submissions (the `McpConnectorOAuthSubmitCodeCommand`
// fallback), keyed by connector id, resolved by whichever login flow is
// awaiting one.
const pendingManualCode = new Map<string, (result: CallbackResult) => void>();

export function submitMcpOAuthCode(connectorId: string, code: string): boolean {
	const resolver = pendingManualCode.get(connectorId);
	if (!resolver) return false;
	resolver({ code });
	pendingManualCode.delete(connectorId);
	return true;
}

/**
 * Drive the full OAuth login for a connector: discover the authorization
 * server, start the loopback callback listener, trigger the browser
 * redirect (via `oauth_authorize_url`), wait for the callback (or a
 * manually-submitted code), and complete the token exchange. Resolves once
 * the whole flow settles — mirrors how `handleLoadSession` does multi-step
 * async work before sending a single result.
 */
export async function startMcpConnectorOAuth(
	agentDir: string,
	connectorId: string,
): Promise<{ success: true } | { success: false; error: string }> {
	const connector = getMcpConnector(agentDir, connectorId);
	if (!connector || connector.transport !== "http") {
		return { success: false, error: "connector not found or not a remote connector" };
	}
	const provider = createMcpOAuthProvider(agentDir, connector);
	try {
		const { authorizationServerUrl } = await discoverOAuthServerInfo(connector.url);
		saveMcpConnectorOAuthState(agentDir, connectorId, { authorizationServerUrl });

		const first = await auth(provider, { serverUrl: connector.url });
		if (first === "AUTHORIZED") return { success: true };

		// first === "REDIRECT": provider.redirectToAuthorization() already
		// fired (sent the oauth_authorize_url event). Wait for the browser
		// round-trip via the loopback server, or a manually-pasted code.
		const { server, waitForCallback } = await startCallbackServer();
		const manualCode = new Promise<CallbackResult>((resolve) => {
			pendingManualCode.set(connectorId, resolve);
		});
		try {
			const result = await Promise.race([
				waitForCallback,
				manualCode,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timed out waiting for authorization")), LOGIN_TIMEOUT_MS),
				),
			]);
			const second = await auth(provider, {
				serverUrl: connector.url,
				authorizationCode: result.code,
				iss: result.iss,
			});
			if (second !== "AUTHORIZED") {
				return { success: false, error: `authorization did not complete (state: ${second})` };
			}
			return { success: true };
		} finally {
			pendingManualCode.delete(connectorId);
			server.close();
		}
	} catch (err) {
		log("mcp oauth login failed for %s: %s", connectorId, err instanceof Error ? err.message : String(err));
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		codeVerifiers.delete(connectorId);
	}
}
