/**
 * save_memory — lets the agent persist facts that should survive across
 * sessions in the current workspace.
 *
 * The tool writes a plain Markdown index (`MEMORY.md`) plus optional per-topic
 * detail notes. The index is automatically injected into the system prompt of
 * every new session in the same workspace, so the model starts with relevant
 * context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { slugify, upsertMemoryEntry, type MemoryType } from "../memory-store.js";

export const SAVE_MEMORY_TOOL_NAME = "save_memory";

const SaveMemoryParams = Type.Object({
	topic: Type.String({
		description:
			"Short, stable topic name (e.g. 'Stack', 'API conventions', 'User preference'). This becomes the note filename.",
	}),
	summary: Type.String({
		description: "One-line summary (≤150 chars) shown in the always-loaded memory index.",
	}),
	detail: Type.Optional(
		Type.String({
			description:
				"Optional longer detail. Written to notes/<topic>.md; the model can read it on demand with its read tool.",
		}),
	),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("project"),
				Type.Literal("preference"),
				Type.Literal("decision"),
			],
			{
				description:
					"Category: project (codebase fact), preference (user taste), decision (agreed approach).",
			},
		),
	),
});

export interface SaveMemoryDetails {
	topic: string;
	slug: string;
	summary: string;
	detail?: string;
	type?: MemoryType;
	saved: boolean;
	reason?: string;
}

export interface SaveMemoryOptions {
	/** Base directory for all persisted memory, typically `~/.hypatiai/cowork`. */
	baseDir: string;
	/** Current workspace directory. */
	workspaceCwd: string;
}

export default function saveMemoryExtension(pi: ExtensionAPI, options: SaveMemoryOptions): void {
	pi.registerTool({
		name: SAVE_MEMORY_TOOL_NAME,
		label: "Save Memory",
		description:
			"Persist a fact about this workspace so future sessions remember it. " +
			"Use this when the user states a preference, makes a decision, mentions a recurring codebase convention, " +
			"or asks you to remember something for next time. " +
			"Keep the summary concise (≤150 chars); add optional detail for longer context. " +
			"The model can read detail notes later with its read tool.",
		promptSnippet: "save_memory(topic, summary, type?, detail?) — remember a fact across sessions",
		promptGuidelines: [
			"Call save_memory when something would help a future session: a decision, a preference, a recurring convention, or a codebase fact.",
			"Do not call save_memory for transient chat context that only matters in this conversation.",
			"Use the same topic slug to update an existing memory; use a new topic to add a distinct fact.",
		],
		parameters: SaveMemoryParams,
		async execute(_toolCallId, params) {
			const result = upsertMemoryEntry(options.baseDir, options.workspaceCwd, {
				topic: params.topic,
				summary: params.summary,
				detail: params.detail,
				type: params.type,
			});

			const details: SaveMemoryDetails = {
				topic: params.topic,
				slug: slugify(params.topic),
				summary: params.summary,
				detail: params.detail,
				type: params.type,
				saved: result.ok,
				reason: result.ok ? undefined : result.reason,
			};

			return {
				content: [
					{
						type: "text",
						text: result.ok
							? `Remembered "${params.topic}": ${params.summary}`
							: `Could not save memory: ${result.reason}`,
					},
				],
				details,
			};
		},
	});
}
