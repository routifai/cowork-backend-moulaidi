/**
 * Session command handlers — backed by pi-coding-agent's native SessionManager
 * (auto-persists to ~/.pi/agent/sessions/). Cowork no longer keeps a parallel
 * ~/.hypatiai/cowork/sessions store; pinning + custom titles live in
 * ~/.pi/agent/cowork-meta.json via pi-session-store.
 *
 * Commands: reload, new_session, get_workspace, list_sessions, save_session
 * (no-op — pi auto-persists), load_session, delete_session, rename_session,
 * set_session_pinned, search_sessions.
 *
 * new_session/load_session add a session to HandlerDependencies' session
 * map rather than replacing a single global one — per
 * docs/plans/multi-session-concurrency.md, creating or loading a session
 * must never touch a DIFFERENT session's live AgentSession. The one
 * exception: reloading the same session file that's already tracked
 * replaces its own live AgentSession, which is "restarting this session,"
 * not touching a different one — see the abort call in handleLoadSession.
 */

import { send, log } from "../../protocol.js";
import { reconstructShowArtifacts } from "../../show-artifact-history.js";
import type { HandlerDependencies } from "../handler-registry.js";
import { resolveWorkspace, defaultWorkspaceDir, piAgentDir } from "../../agent-init.js";
import { createPromptScheduler } from "../../prompt-scheduler.js";
import { createPromptRunner } from "../../prompt-runner.js";
import {
	listPiSessions,
	loadPiSession,
	deletePiSession,
	renamePiSession,
	setPiSessionPinned,
	searchPiSessions,
} from "../../pi-session-store.js";

export async function handleReload(deps: HandlerDependencies, cmd: any): Promise<void> {
	await deps.initAgent(deps.hypatiaDir);
	send({ type: "result", id: cmd.id, data: { success: true } });
}

/** Build a fresh persisting pi session bound to `cwd`, track it, and make it active. Returns its file path (= session id). */
async function spawnSession(
	deps: HandlerDependencies,
	cwd: string,
	resourceLoader: any,
	mcpConnectorIds: { current: Set<string> | undefined },
): Promise<string> {
	const { SessionManager, createAgentSession } = await import("@earendil-works/pi-coding-agent");
	const sessionManager = SessionManager.create(cwd);
	const result = await createAgentSession({
		cwd,
		modelRuntime: deps.modelRuntime!,
		sessionManager,
		settingsManager: deps.settingsManager!,
		resourceLoader,
	});
	const id = sessionManager.getSessionFile() ?? cwd;
	const promptRunner = createPromptRunner(id);
	promptRunner.subscribeSession(result.session);
	await deps.bindExtensionUi(result.session, id);
	deps.addSession({
		id,
		session: result.session,
		sessionManager,
		resourceLoader,
		workspaceCwd: cwd,
		promptScheduler: createPromptScheduler(),
		promptRunner,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		mcpConnectorIds,
	});
	deps.setActiveSessionId(id);
	return id;
}

export async function handleNewSession(deps: HandlerDependencies, cmd: any): Promise<void> {
	if (!deps.modelRuntime || !deps.modelRegistry || !deps.settingsManager) {
		send({ type: "error", id: cmd.id, error: "Agent not initialized" });
		return;
	}
	const cwd = resolveWorkspace(cmd.cwd, deps.hypatiaDir);
	log("new_session: cwd=%s", cwd);
	// Always build a fresh resource loader (never reused across sessions —
	// resourceLoader is duplicated per session, see multi-session-concurrency.md)
	// so a brand-new session's system prompt always reflects up-to-date
	// project memory/instructions, not a stale cached one.
	const { buildResourceLoader } = await import("../../agent-init.js");
	// Mutable box shared with the resource loader's getEnabledConnectorIds
	// closure — see app/session-state.ts's mcpConnectorIds doc comment.
	const mcpConnectorIds: { current: Set<string> | undefined } = { current: undefined };
	const resourceLoader = await buildResourceLoader(cwd, deps.hypatiaDir, deps.settingsManager, {
		getEnabledConnectorIds: () => mcpConnectorIds.current,
	});
	const file = await spawnSession(deps, cwd, resourceLoader, mcpConnectorIds);
	send({ type: "result", id: cmd.id, data: { success: true, cwd, file } });
}

export async function handleGetWorkspace(deps: HandlerDependencies, cmd: any): Promise<void> {
	send({
		type: "result",
		id: cmd.id,
		data: { cwd: deps.workspaceCwd, default: defaultWorkspaceDir(deps.hypatiaDir) },
	});
}

export async function handleListSessions(deps: HandlerDependencies, cmd: any): Promise<void> {
	// Scope to the active workspace folder (pi-style) unless the UI asks for all.
	const cwd = cmd.allFolders ? undefined : deps.workspaceCwd;
	const sessions = await listPiSessions(piAgentDir(), cwd);
	send({ type: "result", id: cmd.id, data: { sessions } });
}

/** No-op: pi persists sessions during the agent loop. Kept for protocol compat. */
export async function handleSaveSession(_deps: HandlerDependencies, cmd: any): Promise<void> {
	send({ type: "done", id: cmd.id });
}

export async function handleLoadSession(deps: HandlerDependencies, cmd: any): Promise<void> {
	try {
		const path = cmd.sessionFile as string;
		const loaded = loadPiSession(path);

		if (deps.modelRuntime && deps.modelRegistry && deps.settingsManager) {
			const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
			const { buildResourceLoader } = await import("../../agent-init.js");

			const sessionCwd = resolveWorkspace(loaded.cwd, deps.hypatiaDir);
			const mcpConnectorIds: { current: Set<string> | undefined } = { current: undefined };
			const resourceLoader = await buildResourceLoader(
				sessionCwd,
				deps.hypatiaDir,
				deps.settingsManager,
				{ getEnabledConnectorIds: () => mcpConnectorIds.current },
			);

			log("load_session: rebinding agent session for %s", path);
			log("load_session: creating agent session (cwd=%s)", sessionCwd);
			const resumed = await createAgentSession({
				cwd: sessionCwd,
				modelRuntime: deps.modelRuntime,
				sessionManager: loaded.manager,
				settingsManager: deps.settingsManager,
				resourceLoader,
			});

			const id = path;
			// Reloading a session file that's already tracked replaces its own
			// live AgentSession — abort the outgoing one so it doesn't keep
			// emitting events under an id the map no longer points at. This is
			// "restarting this session," not touching a different one — never
			// abort any OTHER entry in the map.
			const existing = deps.getSession(id);
			if (existing) existing.session.abort();

			log("load_session: session created, subscribing");
			const promptRunner = createPromptRunner(id);
			promptRunner.subscribeSession(resumed.session);
			await deps.bindExtensionUi(resumed.session, id);
			deps.addSession({
				id,
				session: resumed.session,
				sessionManager: loaded.manager,
				resourceLoader,
				workspaceCwd: sessionCwd,
				promptScheduler: createPromptScheduler(),
				promptRunner,
				createdAt: existing?.createdAt ?? Date.now(),
				lastActivity: Date.now(),
				mcpConnectorIds,
			});
			deps.setActiveSessionId(id);
			log("load_session: ready to send result");
		}

		send({
			type: "result",
			id: cmd.id,
			data: {
				messages: loaded.messages,
				artifacts: reconstructShowArtifacts(loaded.messages),
				title: loaded.title,
				model: loaded.model,
				provider: loaded.provider,
				cwd: deps.workspaceCwd,
			},
		});
	} catch (err) {
		send({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Aborts and untracks a specific live session. This is the ONLY handler
 * allowed to abort a session other than load_session's own "restarting
 * myself" case — new_session/load_session must never touch a different
 * session's AgentSession.
 */
export async function handleCloseSession(deps: HandlerDependencies, cmd: any): Promise<void> {
	const state = deps.getSession(cmd.sessionId);
	if (state) {
		state.session.abort();
		deps.removeSession(cmd.sessionId);
		if (deps.activeSessionId === cmd.sessionId) {
			// The active pointer can't dangle on a removed id — memory/
			// settings-style commands resolve "the active session" through it.
			// Fall back to whatever other session remains, or nothing.
			const remaining = deps.listSessionIds();
			deps.setActiveSessionId(remaining[0]);
		}
	}
	send({ type: "result", id: cmd.id, data: { closed: Boolean(state) } });
}

export async function handleDeleteSession(_deps: HandlerDependencies, cmd: any): Promise<void> {
	const deleted = deletePiSession(piAgentDir(), cmd.sessionFile);
	send({ type: "result", id: cmd.id, data: { deleted } });
}

export async function handleRenameSession(_deps: HandlerDependencies, cmd: any): Promise<void> {
	const renamed = renamePiSession(piAgentDir(), cmd.sessionFile, cmd.title);
	send({ type: "result", id: cmd.id, data: { renamed } });
}

export async function handleSetSessionPinned(_deps: HandlerDependencies, cmd: any): Promise<void> {
	const ok = setPiSessionPinned(piAgentDir(), cmd.sessionFile, cmd.pinned);
	send({ type: "result", id: cmd.id, data: { ok, pinned: cmd.pinned } });
}

export async function handleSearchSessions(deps: HandlerDependencies, cmd: any): Promise<void> {
	const cwd = cmd.allFolders ? undefined : deps.workspaceCwd;
	const matches = await searchPiSessions(piAgentDir(), cmd.query, cwd);
	send({ type: "result", id: cmd.id, data: { matches } });
}
