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
}

export interface PromptCommand {
	type: "prompt";
	id: string;
	text: string;
	_origin?: "remote";
}

export interface AbortCommand {
	type: "abort";
	id: string;
}

export interface SteerCommand {
	type: "steer";
	id: string;
	text: string;
	images?: SteerImage[];
}

export interface FollowUpCommand {
	type: "follow_up";
	id: string;
	text: string;
	images?: SteerImage[];
}

export interface ClearQueueCommand {
	type: "clear_queue";
	id: string;
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
	| ReloadCommand
	| SaveSessionCommand
	| LoadSessionCommand
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
	| UiResponseCommand;
