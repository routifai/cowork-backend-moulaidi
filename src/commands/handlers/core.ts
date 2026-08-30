/**
 * Hypatia Content CoWork — Core Command Handlers
 *
 * Handles: init, get_models, get_active_model, prompt, abort, steer,
 * follow_up, clear_queue, ui_response, set_model
 */

import type {
	InitCommand,
	GetModelsCommand,
	GetActiveModelCommand,
	PromptCommand,
	AbortCommand,
	SteerCommand,
	FollowUpCommand,
	ClearQueueCommand,
	UiResponseCommand,
	SetModelCommand,
	CompleteModelCallCommand,
} from "../types.js";
import { send as sendMsg, log } from "../../protocol.js";
import type { HandlerDependencies } from "../handler-registry.js";
import type { SessionState } from "../../app/session-state.js";
import type { SteerImage } from "../types.js";

/**
 * SteerImage (this wire protocol's shape) lacks the `type: "image"`
 * discriminant the SDK's ImageContent requires — was previously masked by
 * `session: any`; state.session is now precisely typed, surfacing it for
 * real. Maps the wire shape to the SDK shape rather than casting it away.
 */
function toImageContent(images: SteerImage[] | undefined) {
	return images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
}

// ── init ───────────────────────────────────────────────────────────────────

export async function handleInit(
	deps: HandlerDependencies,
	cmd: InitCommand,
): Promise<void> {
	await deps.initAgent(cmd.hypatiaDir ?? "", cmd.workspace);
}

// ── get_models ─────────────────────────────────────────────────────────────

export async function handleGetModels(
	deps: HandlerDependencies,
	cmd: GetModelsCommand,
): Promise<void> {
	if (!deps.initialized || !deps.modelRegistry) {
		sendMsg({ type: "error", id: cmd.id, message: "Not initialized" });
		return;
	}
	const available = await deps.modelRegistry.getAvailable();
	const models = available.map((m: any) => ({
		id: m.id,
		name: m.name,
		provider: m.provider,
		reasoning: m.reasoning,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	}));
	sendMsg({ type: "result", id: cmd.id, data: { models } });
}

// ── session resolution for agent-turn commands ──────────────────────────────

/**
 * Resolves which SessionState a session-scoped command targets: the id it
 * explicitly names, or — for a still-unmigrated caller that omits it —
 * whichever session is currently active. Sends the standard "Not
 * initialized" error and returns undefined if no session can be resolved.
 */
export function resolveTargetSession(
	deps: HandlerDependencies,
	cmd: { id: string; sessionId?: string },
): SessionState | undefined {
	const id = cmd.sessionId ?? deps.activeSessionId;
	const state = id ? deps.getSession(id) : undefined;
	if (!deps.initialized || !state) {
		sendMsg({ type: "error", id: cmd.id, message: "Not initialized" });
		return undefined;
	}
	return state;
}

// ── get_active_model ───────────────────────────────────────────────────────

export async function handleGetActiveModel(
	deps: HandlerDependencies,
	cmd: GetActiveModelCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	const model = state.session.model
		? {
				provider: state.session.model.provider,
				id: state.session.model.id,
				name: state.session.model.name,
			}
		: null;
	sendMsg({
		type: "result",
		id: cmd.id,
		data: { model, thinkingLevel: state.session.thinkingLevel ?? null },
	});
}

// ── prompt ─────────────────────────────────────────────────────────────────

export async function handlePrompt(
	deps: HandlerDependencies,
	cmd: PromptCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	state.promptScheduler.schedule(
		() => state.promptRunner.runPromptTask(cmd, state.session, deps.hypatiaDir, state.workspaceCwd),
		(err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			log("prompt task error: %s", msg);
			sendMsg({ type: "error", id: cmd.id, message: msg });
			sendMsg({ type: "done", id: cmd.id });
		},
	);
}

// ── abort ──────────────────────────────────────────────────────────────────

export async function handleAbort(
	deps: HandlerDependencies,
	cmd: AbortCommand,
): Promise<void> {
	const id = cmd.sessionId ?? deps.activeSessionId;
	const state = id ? deps.getSession(id) : undefined;
	if (state) {
		state.session.abort();
	}
	sendMsg({ type: "result", id: cmd.id, data: { aborted: true } });
}

// ── steer ──────────────────────────────────────────────────────────────────

export async function handleSteer(
	deps: HandlerDependencies,
	cmd: SteerCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	try {
		await state.session.steer(cmd.text, toImageContent(cmd.images));
		sendMsg({ type: "result", id: cmd.id, data: { queued: true } });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		sendMsg({ type: "error", id: cmd.id, message: msg });
	}
}

// ── follow_up ──────────────────────────────────────────────────────────────

export async function handleFollowUp(
	deps: HandlerDependencies,
	cmd: FollowUpCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	try {
		await state.session.followUp(cmd.text, toImageContent(cmd.images));
		sendMsg({ type: "result", id: cmd.id, data: { queued: true } });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		sendMsg({ type: "error", id: cmd.id, message: msg });
	}
}

// ── clear_queue ────────────────────────────────────────────────────────────

export async function handleClearQueue(
	deps: HandlerDependencies,
	cmd: ClearQueueCommand,
): Promise<void> {
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	try {
		const drained = state.session.clearQueue();
		sendMsg({ type: "result", id: cmd.id, data: { drained } });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		sendMsg({ type: "error", id: cmd.id, message: msg });
	}
}

// ── ui_response ────────────────────────────────────────────────────────────

export async function handleUiResponse(
	deps: HandlerDependencies,
	cmd: UiResponseCommand,
): Promise<void> {
	deps.resolveUiResponse(cmd);
}

// ── set_model ──────────────────────────────────────────────────────────────

export async function handleSetModel(
	deps: HandlerDependencies,
	cmd: SetModelCommand,
): Promise<void> {
	if (!deps.modelRegistry) {
		sendMsg({ type: "error", id: cmd.id, message: "Not initialized" });
		return;
	}
	const state = resolveTargetSession(deps, cmd);
	if (!state) return;
	try {
		const found = deps.modelRegistry.find(cmd.provider, cmd.model);
		if (!found) {
			log("set_model: NOT FOUND %s/%s", cmd.provider, cmd.model);
			sendMsg({
				type: "error",
				id: cmd.id,
				message: `Model ${cmd.provider}/${cmd.model} not found`,
			});
			return;
		}
		log("set_model: found %s/%s (id=%s)", cmd.provider, cmd.model, found.id);
		await (state.session as any).setModel(found);
		const currentModel = state.session.model;
		log(
			"set_model: after setModel, session.model = %s/%s",
			currentModel?.provider,
			currentModel?.id,
		);
		sendMsg({ type: "result", id: cmd.id, data: { success: true } });
	} catch (err) {
		sendMsg({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── complete_model_call ──────────────────────────────────────────────────────

/**
 * One-shot model completion for the Presenting Engine relay (see the type's
 * doc comment in types.ts). Unlike every other handler in this file, this
 * one does NOT resolve a target session — it's not a turn in any
 * `AgentSession`, just a direct `ModelRuntime.completeSimple()` call. This
 * is the first caller of `completeSimple()` in this codebase; every other
 * model call goes through a full agent turn instead.
 */
export async function handleCompleteModelCall(
	deps: HandlerDependencies,
	cmd: CompleteModelCallCommand,
): Promise<void> {
	if (!deps.modelRegistry || !deps.modelRuntime) {
		sendMsg({ type: "error", id: cmd.id, message: "Not initialized" });
		return;
	}
	try {
		const found = deps.modelRegistry.find(cmd.provider, cmd.model);
		if (!found) {
			sendMsg({
				type: "error",
				id: cmd.id,
				message: `Model ${cmd.provider}/${cmd.model} not found`,
			});
			return;
		}
		const result = await deps.modelRuntime.completeSimple(found, {
			systemPrompt: cmd.systemPrompt,
			messages: cmd.messages,
			tools: cmd.tools,
		});
		sendMsg({ type: "result", id: cmd.id, data: result });
	} catch (err) {
		sendMsg({
			type: "error",
			id: cmd.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
