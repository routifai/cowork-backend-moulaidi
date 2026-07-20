/**
 * Reconstructs playground state from a loaded session's chat messages
 * (extractChatMessages.ts output) by scanning for completed `show_artifact`
 * tool calls and reading their original arguments directly — one tool name,
 * no guessing. Replaces the old artifact-classifier.ts's
 * classifyArtifactsFromHistory, which had to reverse-engineer intent from
 * write/edit/bash/read side effects across four tool names.
 */

export interface ShowArtifactRecord {
	id: string;
	type: string;
	title: string;
	content: string;
	language?: string;
	updatedAt: number;
}

interface HistoryToolCall {
	name?: unknown;
	status?: unknown;
	args?: unknown;
}

interface HistoryChatMessage {
	role?: unknown;
	timestamp?: unknown;
	toolCalls?: HistoryToolCall[];
}

/**
 * Later messages win on id collisions (same upsert semantics as the live
 * path), since messages are walked in their natural chronological order.
 */
export function reconstructShowArtifacts(chatMessages: HistoryChatMessage[]): ShowArtifactRecord[] {
	const byId = new Map<string, ShowArtifactRecord>();

	for (const msg of chatMessages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.toolCalls)) continue;
		const updatedAt = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		for (const tc of msg.toolCalls) {
			if (tc.name !== "show_artifact" || tc.status !== "completed") continue;
			const args = tc.args as Record<string, unknown> | undefined;
			if (typeof args?.id !== "string" || typeof args?.content !== "string") continue;
			byId.set(args.id, {
				id: args.id,
				type: typeof args.type === "string" ? args.type : "code",
				title: typeof args.title === "string" ? args.title : args.id,
				content: args.content,
				language: typeof args.language === "string" ? args.language : undefined,
				updatedAt,
			});
		}
	}

	return [...byId.values()];
}
