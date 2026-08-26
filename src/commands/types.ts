/**
 * Hypatia Content CoWork — Sidecar Command Types
 *
 * All stdin command type interfaces for the JSON-line protocol between the
 * Tauri Rust backend and the Node.js agent sidecar.
 */

// ── Core commands ──────────────────────────────────────────────────────────

export interface InitCommand {
	type: "init";
	hypatiaDir?: string;
	workspace?: string;
}

export interface GetModelsCommand {
	type: "get_models";
	id: string;
}

export interface GetActiveModelCommand {
	type: "get_active_model";
	id: string;
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface PromptCommand {
	type: "prompt";
	id: string;
	text: string;
	_origin?: "remote";
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface AbortCommand {
	type: "abort";
	id: string;
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface SteerCommand {
	type: "steer";
	id: string;
	text: string;
	images?: SteerImage[];
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface FollowUpCommand {
	type: "follow_up";
	id: string;
	text: string;
	images?: SteerImage[];
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface ClearQueueCommand {
	type: "clear_queue";
	id: string;
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

export interface SteerImage {
	/** MIME type of the image. */
	mimeType: string;
	/** Base64-encoded image data (no data: prefix). */
	data: string;
	/** Optional filename or label. */
	name?: string;
}

export interface SetModelCommand {
	type: "set_model";
	id: string;
	provider: string;
	model: string;
	/** Which session to target. Omitted = the currently active session (back-compat). */
	sessionId?: string;
}

/**
 * One-shot model completion, not tied to any agent session — the relay
 * mechanism the Presenting Engine (a separate Python process, see
 * `presenting/CONTEXT.md`) uses since it holds no model credentials itself.
 * Sent by the Tauri Rust host on the Presenting Engine's behalf, not by the
 * frontend directly. See `docs/adr/0002-presenting-model-calls-relay-via-rust-host.md`.
 */
export interface CompleteModelCallCommand {
	type: "complete_model_call";
	id: string;
	provider: string;
	model: string;
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}

// ── Session commands ───────────────────────────────────────────────────────

export interface ReloadCommand {
	type: "reload";
	id: string;
}

export interface NewSessionCommand {
	type: "new_session";
	id: string;
	cwd?: string;
}

export interface GetWorkspaceCommand {
	type: "get_workspace";
	id: string;
}

export interface ListSessionsCommand {
	type: "list_sessions";
	id: string;
	allFolders?: boolean;
}

export interface SaveSessionCommand {
	type: "save_session";
	id: string;
	title: string;
	messages: unknown[];
	model?: string;
	provider?: string;
}

export interface LoadSessionCommand {
	type: "load_session";
	id: string;
	sessionFile: string;
}

export interface DeleteSessionCommand {
	type: "delete_session";
	id: string;
	sessionFile: string;
}

/**
 * Explicitly aborts and untracks a specific live session (identified by its
 * session file path / sessionId). The only command allowed to abort a
 * session other than "restarting" it via load_session on the same file —
 * new_session/load_session never touch a different session's AgentSession.
 */
export interface CloseSessionCommand {
	type: "close_session";
	id: string;
	sessionId: string;
}

export interface RenameSessionCommand {
	type: "rename_session";
	id: string;
	sessionFile: string;
	title: string;
}

export interface SetSessionPinnedCommand {
	type: "set_session_pinned";
	id: string;
	sessionFile: string;
	pinned: boolean;
}

export interface SearchSessionsCommand {
	type: "search_sessions";
	id: string;
	query: string;
	allFolders?: boolean;
}

// ── Settings / Instructions commands ───────────────────────────────────────

export interface GetSettingsCommand {
	type: "get_settings";
	id: string;
}

export interface SaveSettingsCommand {
	type: "save_settings";
	id: string;
	[key: string]: unknown;
}

export interface GetInstructionsCommand {
	type: "get_instructions";
	id: string;
}

export interface SaveInstructionsCommand {
	type: "save_instructions";
	id: string;
	content: string;
}

// ── Memory commands ─────────────────────────────────────────────────────────

export interface GetMemoryIndexCommand {
	type: "get_memory_index";
	id: string;
}

export interface GetMemoryNoteCommand {
	type: "get_memory_note";
	id: string;
	topic: string;
}

export interface SaveMemoryNoteCommand {
	type: "save_memory_note";
	id: string;
	topic: string;
	summary: string;
	memoryType?: "project" | "preference" | "decision";
	detail?: string;
	noteContent?: string;
}

export interface DeleteMemoryTopicCommand {
	type: "delete_memory_topic";
	id: string;
	topic: string;
}

// ── Extension commands ─────────────────────────────────────────────────────

export interface ListExtensionsCommand {
	type: "list_extensions";
	id: string;
}

// ── Skills commands ────────────────────────────────────────────────────────

export interface SearchSkillsCommand {
	type: "search_skills";
	id: string;
	query: string;
}

export interface ListSkillsCommand {
	type: "list_skills";
	id: string;
}

export interface FetchSkillPackumentCommand {
	type: "fetch_skill_packument";
	id: string;
	packageName: string;
}

// ── Tasks commands ─────────────────────────────────────────────────────────

export interface TasksListCommand {
	type: "tasks_list";
	id: string;
	cwd?: string;
}

export interface TasksDeleteCommand {
	type: "tasks_delete";
	id: string;
	taskId: string;
	cwd?: string;
}

export interface TasksSetEnabledCommand {
	type: "tasks_set_enabled";
	id: string;
	taskId: string;
	enabled: boolean;
	cwd?: string;
}

export interface TasksRunNowCommand {
	type: "tasks_run_now";
	id: string;
	taskId: string;
	cwd?: string;
}

export interface TasksListRunsCommand {
	type: "tasks_list_runs";
	id: string;
	taskId: string;
	cwd?: string;
	limit?: number;
}

export interface TasksGetCompletedCommand {
	type: "tasks_get_completed";
	id: string;
	cwd?: string;
}

// ── Remote / UI commands ───────────────────────────────────────────────────

export interface StartRemoteCommand {
	type: "start_remote";
	id: string;
	port?: number;
	host?: string;
}

export interface StopRemoteCommand {
	type: "stop_remote";
	id: string;
}

export interface GetRemoteStatusCommand {
	type: "get_remote_status";
	id: string;
}

export interface UiResponseCommand {
	type: "ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

// ── Presenting commands ─────────────────────────────────────────────────────

export interface PresentingPingCommand {
	type: "presenting_ping";
	id: string;
}

export interface PresentingStartGenerationCommand {
	type: "presenting_start_generation";
	id: string;
	content?: string;
	template?: string;
	provider?: string;
	model?: string;
	nSlides?: number;
	language?: string;
	tone?: string;
	verbosity?: string;
	instructions?: string;
	includeTitleSlide?: boolean;
	includeTableOfContents?: boolean;
	documentText?: string;
	documentName?: string;
	webSearch?: boolean;
	webSearchProvider?: string;
}

export interface PresentingGetPresentationCommand {
	type: "presenting_get_presentation";
	id: string;
	presentationId: string;
}

export interface PresentingParseDocumentCommand {
	type: "presenting_parse_document";
	id: string;
	filePath: string;
	language?: string;
}

export interface PresentingExportPresentationCommand {
	type: "presenting_export_presentation";
	id: string;
	presentationId: string;
	outputPath: string;
}

export interface PresentingEditSlideCommand {
	type: "presenting_edit_slide";
	id: string;
	presentationId: string;
	tool: string;
	args?: Record<string, unknown>;
}

/** Restores one slide's raw stored state (a snapshot captured client-side before a chat edit) — a direct DB write, no LLM involved. Powers the "keep original / keep edit" comparison after a chat turn. */
export interface PresentingRestoreSlideCommand {
	type: "presenting_restore_slide";
	id: string;
	presentationId: string;
	index: number;
	snapshot: {
		htmlContent?: string | null;
		content?: Record<string, unknown> | null;
		ui?: unknown | null;
		speakerNote?: string | null;
	};
}

export interface PresentingChatAttachment {
	name?: string;
	filePath: string;
}

export interface PresentingChatEditCommand {
	type: "presenting_chat_edit";
	id: string;
	presentationId: string;
	message: string;
	provider: string;
	model: string;
	conversationId?: string;
	presentationType?: string;
	chatMode?: "presentation" | "outline";
	attachments?: PresentingChatAttachment[];
}

/** Import a user-uploaded .pptx as a new, workspace-scoped Imported Template (see presenting/CONTEXT.md). */
export interface PresentingImportTemplateCommand {
	type: "presenting_import_template";
	id: string;
	pptxPath: string;
	name?: string;
	provider: string;
	model: string;
}

export interface PresentingListImportedTemplatesCommand {
	type: "presenting_list_imported_templates";
	id: string;
}

export interface PresentingDeleteImportedTemplateCommand {
	type: "presenting_delete_imported_template";
	id: string;
	templateId: string;
}

// ── Union type ─────────────────────────────────────────────────────────────

export type Command =
	| InitCommand
	| GetModelsCommand
	| GetActiveModelCommand
	| PromptCommand
	| AbortCommand
	| SteerCommand
	| FollowUpCommand
	| ClearQueueCommand
	| SetModelCommand
	| CompleteModelCallCommand
	| ReloadCommand
	| SaveSessionCommand
	| LoadSessionCommand
	| CloseSessionCommand
	| DeleteSessionCommand
	| RenameSessionCommand
	| SetSessionPinnedCommand
	| SearchSessionsCommand
	| NewSessionCommand
	| GetWorkspaceCommand
	| ListSessionsCommand
	| GetSettingsCommand
	| SaveSettingsCommand
	| GetInstructionsCommand
	| SaveInstructionsCommand
	| GetMemoryIndexCommand
	| GetMemoryNoteCommand
	| SaveMemoryNoteCommand
	| DeleteMemoryTopicCommand
	| ListExtensionsCommand
	| TasksListCommand
	| TasksDeleteCommand
	| TasksSetEnabledCommand
	| TasksRunNowCommand
	| TasksListRunsCommand
	| TasksGetCompletedCommand
	| SearchSkillsCommand
	| ListSkillsCommand
	| FetchSkillPackumentCommand
	| StartRemoteCommand
	| StopRemoteCommand
	| GetRemoteStatusCommand
	| UiResponseCommand
	| PresentingPingCommand
	| PresentingStartGenerationCommand
	| PresentingGetPresentationCommand
	| PresentingChatEditCommand
	| PresentingParseDocumentCommand
	| PresentingExportPresentationCommand
	| PresentingEditSlideCommand
	| PresentingImportTemplateCommand
	| PresentingListImportedTemplatesCommand
	| PresentingDeleteImportedTemplateCommand
	| PresentingRestoreSlideCommand;
