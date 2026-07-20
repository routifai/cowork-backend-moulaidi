/**
 * show_artifact — lets the agent deliberately render something for the user
 * in the playground side panel, instead of describing it in text or relying
 * on the panel to guess from write/edit/bash side effects (the previous,
 * removed approach — see docs/plans in the zosma-cowork monorepo for why).
 *
 * execute() does exactly one thing: echoes the params into the tool
 * result's `details` verbatim. No cross-call state, no correlation cache —
 * the frontend's tool_execution_end handler reads `result.details` directly.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SHOW_ARTIFACT_TOOL_NAME = "show_artifact";

const ARTIFACT_TYPES = ["html", "markdown", "code", "diff", "image"] as const;

export interface ShowArtifactDetails {
	id: string;
	type: (typeof ARTIFACT_TYPES)[number];
	title: string;
	content: string;
	language?: string;
}

const ShowArtifactParams = Type.Object({
	id: Type.String({
		description:
			"Stable identifier. Reuse the SAME id on a later call to update this artifact in place; use a new id to open a new one.",
	}),
	type: StringEnum(ARTIFACT_TYPES),
	title: Type.String({ description: "Short label shown on the artifact's tab." }),
	content: Type.String({
		description:
			"Full content: raw HTML for 'html', markdown for 'markdown', source for 'code', a unified diff for 'diff', a data: URI for 'image'.",
	}),
	language: Type.Optional(
		Type.String({ description: "Source language for 'code' (e.g. 'typescript'). Ignored otherwise." }),
	),
});

export default function showArtifactExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SHOW_ARTIFACT_TOOL_NAME,
		label: "Show Artifact",
		description:
			"Render something for the user in a persistent side panel (the playground), instead of describing it in text. " +
			"Use this when showing a rendered HTML/SVG page, a formatted document, a code file, a diff summarizing a multi-file change, " +
			"or an image would be clearer than prose — e.g. the user asks to 'see', 'preview', or 'show' something you produced. " +
			"Reuse the same id to update something already shown; use a new id to open a new tab. Do not use this for routine tool output.",
		promptSnippet: "show_artifact(id, type, title, content) — render HTML/markdown/code/diff/image in the side panel",
		promptGuidelines: [
			"When a rendered preview would be clearer than text, call show_artifact instead of just describing it.",
		],
		parameters: ShowArtifactParams,
		async execute(_toolCallId, params) {
			const details: ShowArtifactDetails = {
				id: params.id,
				type: params.type,
				title: params.title,
				content: params.content,
				language: params.language,
			};
			return {
				content: [{ type: "text", text: `Shown in playground: "${params.title}" (${params.type})` }],
				details,
			};
		},
	});
}
