import type { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./session-state.js";

/**
 * Mutable runtime state shared across command handlers.
 *
 * Fields here are genuinely process-wide (one model runtime, one settings
 * manager, one directory config for the whole sidecar). Per-session state
 * (the live AgentSession, its SessionManager/ResourceLoader, its own
 * workspace and prompt scheduler) lives in `sessions`, keyed by session id
 * (the pi session file path) — see session-state.ts. `activeSessionId` is a
 * transitional pointer: commands that don't yet carry their own `sessionId`
 * (memory, instructions, get_workspace, list/search sessions, etc.) resolve
 * against "whichever session is currently active," matching the app's
 * pre-multi-session behavior exactly. Commands that run an actual agent turn
 * (prompt/abort/steer/follow_up/clear_queue/set_model/get_active_model)
 * carry an explicit sessionId and resolve a specific SessionState directly.
 */
export interface AppContainer {
	initialized: boolean;
	modelRuntime: ModelRuntime | undefined;
	modelRegistry: ModelRegistry | undefined;
	settingsManager: ReturnType<typeof SettingsManager.inMemory> | undefined;
	hypatiaDir: string;
	sessions: Map<string, SessionState>;
	activeSessionId: string | undefined;
}
