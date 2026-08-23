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
	handleCompleteModelCall,
} from "./handlers/core.js";

// ── Session handlers ───────────────────────────────────────────────────────
import {
	handleReload,
	handleNewSession,
	handleGetWorkspace,
	handleListSessions,
	handleSaveSession,
	handleLoadSession,
	handleCloseSession,
	handleDeleteSession,
	handleRenameSession,
	handleSetSessionPinned,
	handleSearchSessions,
} from "./handlers/sessions.js";

// ── Presenting handlers ────────────────────────────────────────────────────
import { handlePresentingPing } from "../presenting/commands/ping.js";
import { handlePresentingStartGeneration } from "../presenting/commands/start-generation.js";
import { handlePresentingGetPresentation } from "../presenting/commands/get-presentation.js";
import { handlePresentingChatEdit } from "../presenting/commands/chat-edit.js";
import { handlePresentingParseDocument } from "../presenting/commands/parse-document.js";
import { handlePresentingExportPresentation } from "../presenting/commands/export-presentation.js";
import { handlePresentingEditSlide } from "../presenting/commands/edit-slide.js";
import { handlePresentingImportTemplate } from "../presenting/commands/import-template.js";
import { handlePresentingListImportedTemplates } from "../presenting/commands/list-imported-templates.js";
import { handlePresentingDeleteImportedTemplate } from "../presenting/commands/delete-imported-template.js";

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
import type { SessionState } from "../app/session-state.js";

export interface HandlerDependencies {
	// Agent infrastructure — genuinely process-wide, one for the whole sidecar
	initialized: boolean;
	modelRegistry: ModelRegistry;
	modelRuntime: any;
	settingsManager: any;
	hypatiaDir: string;

	/**
	 * Back-compat resolution: "whichever session is currently active."
	 * Used by commands that don't carry their own sessionId yet (memory,
	 * instructions/settings). Resolves to undefined if no session exists.
	 */
	session: any;
	workspaceCwd: string;

	// Per-session state (session id = pi session file path)
	getSession: (id: string) => SessionState | undefined;
	addSession: (state: SessionState) => void;
	removeSession: (id: string) => void;
	listSessionIds: () => string[];
	activeSessionId: string | undefined;
	setActiveSessionId: (id: string | undefined) => void;

	// Functions
	initAgent: (hypatiaDir: string, workspace?: string) => Promise<void>;
	buildResourceLoader: (cwd: string, opts?: any) => Promise<any>;
	bindExtensionUi: (session: any, sessionId: string) => Promise<void>;
	resolveUiResponse: (response: any) => void;

	// State mutation helpers
	setInitialized: (v: boolean) => void;
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

			case "complete_model_call":
				await handleCompleteModelCall(deps, cmd as any);
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

			case "close_session":
				await handleCloseSession(deps, cmd as any);
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

		// ═══════════════════════════════════════════════════════════════
		// Presenting Engine
		// ═══════════════════════════════════════════════════════════════

		case "presenting_ping":
			await handlePresentingPing(cmd as any);
			break;

		case "presenting_start_generation":
			await handlePresentingStartGeneration(deps, cmd as any);
			break;

		case "presenting_get_presentation":
			await handlePresentingGetPresentation(cmd as any);
			break;

		case "presenting_chat_edit":
			await handlePresentingChatEdit(deps, cmd as any);
			break;

		case "presenting_parse_document":
			await handlePresentingParseDocument(cmd as any);
			break;

		case "presenting_export_presentation":
			await handlePresentingExportPresentation(cmd as any);
			break;

		case "presenting_edit_slide":
			await handlePresentingEditSlide(deps, cmd as any);
			break;

		case "presenting_import_template":
			await handlePresentingImportTemplate(deps, cmd as any);
			break;

		case "presenting_list_imported_templates":
			await handlePresentingListImportedTemplates(deps, cmd as any);
			break;

		case "presenting_delete_imported_template":
			await handlePresentingDeleteImportedTemplate(deps, cmd as any);
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
