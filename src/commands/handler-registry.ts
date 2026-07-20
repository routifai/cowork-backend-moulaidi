/**
 * Hypatia Content CoWork — Command Handler Registry
 *
 * Creates a handleCommand function that dispatches JSON-line commands to the
 * appropriate handler. State (session, auth, etc.) is captured via the factory
 * function's arguments rather than global scope.
 */

// ── Core handlers ──────────────────────────────────────────────────────────
import {
	handleInit,
	handleGetModels,
	handleGetActiveModel,
	handlePrompt,
	handleAbort,
	handleSteer,
	handleFollowUp,
	handleClearQueue,
	handleUiResponse,
	handleSetModel,
} from "./handlers/core.js";

// ── Session handlers ───────────────────────────────────────────────────────
import {
	handleReload,
	handleNewSession,
	handleGetWorkspace,
	handleListSessions,
	handleSaveSession,
	handleLoadSession,
	handleDeleteSession,
	handleRenameSession,
	handleSetSessionPinned,
	handleSearchSessions,
} from "./handlers/sessions.js";

// ── Settings handlers ──────────────────────────────────────────────────────
import {
	handleGetSettings,
	handleSaveSettings,
	handleGetInstructions,
	handleSaveInstructions,
} from "./handlers/settings.js";
import {
	handleGetMemoryIndex,
	handleGetMemoryNote,
	handleSaveMemoryNote,
	handleDeleteMemoryTopic,
} from "./handlers/memory.js";

// ── Types ──────────────────────────────────────────────────────────────────
import { send, log, logWarn } from "../protocol.js";
import type { Command } from "./types.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface HandlerDependencies {
	// Agent infrastructure
	initialized: boolean;
	modelRegistry: ModelRegistry;
	session: any;
	modelRuntime: any;
	settingsManager: any;
	sessionManager: any;
	resourceLoader: any;

	// Directories
	hypatiaDir: string;
	workspaceCwd: string;

	// Prompt scheduling
	promptScheduler: {
		schedule: (task: () => Promise<void>, onError: (err: unknown) => void) => void;
	};

	// Functions
	initAgent: (hypatiaDir: string, workspace?: string) => Promise<void>;
	buildResourceLoader: (cwd: string, opts?: any) => Promise<any>;
	bindExtensionUi: (session: any) => Promise<void>;
	resolveUiResponse: (response: any) => void;

	// State mutation helpers
	setInitialized: (v: boolean) => void;
	setSession: (s: any) => void;
	setSessionManager: (sm: any) => void;
	setResourceLoader: (rl: any) => void;
	setWorkspaceCwd: (cwd: string) => void;
}

/**
 * Create the handleCommand function, capturing a shared state container.
 * See the AGENTS.md Code Architecture rules: modules have single
 * responsibility — this is the sole command routing point.
 */
export function createHandler(deps: HandlerDependencies): (cmd: Command) => Promise<void> {
	return async function handleCommand(cmd: Command): Promise<void> {
		log("Command: type=%s id=%s", cmd.type, "id" in cmd ? cmd.id : "-");

		switch (cmd.type) {
			// ═══════════════════════════════════════════════════════════════
			// Core commands
			// ═══════════════════════════════════════════════════════════════

			case "init":
				await handleInit(deps, cmd as any);
				break;

			case "get_models":
				await handleGetModels(deps, cmd as any);
				break;

			case "get_active_model":
				await handleGetActiveModel(deps, cmd as any);
				break;

			case "prompt":
				await handlePrompt(deps, cmd as any);
				break;

			case "abort":
				await handleAbort(deps, cmd as any);
				break;

			case "steer":
				await handleSteer(deps, cmd as any);
				break;

			case "follow_up":
				await handleFollowUp(deps, cmd as any);
				break;

			case "clear_queue":
				await handleClearQueue(deps, cmd as any);
				break;

			case "ui_response":
				await handleUiResponse(deps, cmd as any);
				break;

			case "set_model":
				await handleSetModel(deps, cmd as any);
				break;

			// ═══════════════════════════════════════════════════════════════
			// Session management
			// ═══════════════════════════════════════════════════════════════

			case "reload":
				await handleReload(deps, cmd as any);
				break;

			case "new_session":
				await handleNewSession(deps, cmd as any);
				break;

			case "get_workspace":
				await handleGetWorkspace(deps, cmd as any);
				break;

			case "list_sessions":
				await handleListSessions(deps, cmd as any);
				break;

			case "save_session":
				await handleSaveSession(deps, cmd as any);
				break;

			case "load_session":
				await handleLoadSession(deps, cmd as any);
				break;

			case "delete_session":
				await handleDeleteSession(deps, cmd as any);
				break;

			case "rename_session":
				await handleRenameSession(deps, cmd as any);
				break;

			case "set_session_pinned":
				await handleSetSessionPinned(deps, cmd as any);
				break;

			case "search_sessions":
				await handleSearchSessions(deps, cmd as any);
				break;

			// ═══════════════════════════════════════════════════════════════
			// Settings / Instructions
			// ═══════════════════════════════════════════════════════════════

			case "get_settings":
				await handleGetSettings(deps, cmd as any);
				break;

			case "save_settings":
				await handleSaveSettings(deps, cmd as any);
				break;

			case "get_instructions":
				await handleGetInstructions(deps, cmd as any);
				break;

			case "save_instructions":
				await handleSaveInstructions(deps, cmd as any);
				break;

			// ═══════════════════════════════════════════════════════════════
			// Memory
			// ═══════════════════════════════════════════════════════════════

			case "get_memory_index":
				await handleGetMemoryIndex(deps, cmd as any);
				break;

			case "get_memory_note":
				await handleGetMemoryNote(deps, cmd as any);
				break;

			case "save_memory_note":
				await handleSaveMemoryNote(deps, cmd as any);
				break;

			case "delete_memory_topic":
				await handleDeleteMemoryTopic(deps, cmd as any);
				break;

			default:
				logWarn("Unknown command: %s", (cmd as Command).type);
				send({
					type: "error",
					id: "unknown",
					message: `Unknown command: ${(cmd as Command).type}`,
				});
		}
	};
}
