import type {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { createPromptScheduler } from "../prompt-scheduler.js";
import type { PromptRunner } from "../prompt-runner.js";

/**
 * Everything that used to be a flat, process-wide field on AppContainer but
 * is actually per-session state: the live agent session, its backing
 * SessionManager/ResourceLoader, the workspace it's bound to, and its own
 * prompt-serialization/watchdog machinery. One of these exists per open
 * session; AppContainer holds a Map<id, SessionState> instead of these
 * fields directly.
 *
 * `id` is the pi session file path (SessionManager.getSessionFile()) —
 * already the identity the frontend treats a session by, so no separate id
 * namespace is needed.
 */
export interface SessionState {
	id: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	resourceLoader: DefaultResourceLoader;
	workspaceCwd: string;
	promptScheduler: ReturnType<typeof createPromptScheduler>;
	promptRunner: PromptRunner;
	createdAt: number;
	lastActivity: number;
	/**
	 * This session's MCP connector enablement, in-memory only (resets on a
	 * fresh/reopened session or app restart — see docs/plans, "My Connectors").
	 * `current` is `undefined` until the user makes an explicit per-session
	 * toggle; the resource loader falls back to each connector's stored
	 * `enabledByDefault` until then. The box is shared with the closure passed
	 * to `buildResourceLoader`'s `getEnabledConnectorIds`, so mutating
	 * `.current` and calling `session.reload()` is what makes a toggle apply
	 * live — see commands/handlers/mcp-connectors.ts.
	 */
	mcpConnectorIds: { current: Set<string> | undefined };
}
