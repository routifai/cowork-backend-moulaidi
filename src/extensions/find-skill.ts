/**
 * find_skill — searches the agent's skill library (pi's native Agent Skills:
 * https://agentskills.io/specification) by short task description.
 *
 * pi already lists every discovered skill's name+description in the system
 * prompt automatically. This tool exists for scale: once the library grows
 * large, a deliberate, ranked search beats skimming a growing list — the
 * SDK's own docs note models don't always proactively read a skill just from
 * seeing it listed. Reuses pi's own loadSkills() rather than reimplementing
 * SKILL.md parsing, and returns metadata only — the model reads the winning
 * skill's file with its existing read tool.
 */

import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rankBm25 } from "../lib/bm25.js";

export const FIND_SKILL_TOOL_NAME = "find_skill";

const MAX_RESULTS = 5;

const FindSkillParams = Type.Object({
	query: Type.String({
		description:
			"Short description of the task you're trying to accomplish. Matched against each skill's name and description.",
	}),
});

export interface FindSkillMatch {
	name: string;
	description: string;
	filePath: string;
}

export interface FindSkillDetails {
	query: string;
	matches: FindSkillMatch[];
}

export interface FindSkillOptions {
	/** Current workspace directory — project-local skills are scoped to this. */
	workspaceCwd: string;
	/** pi's global agent directory (typically ~/.pi/agent) — global skills live under `<agentDir>/skills`. */
	agentDir: string;
}

export default function findSkillExtension(pi: ExtensionAPI, options: FindSkillOptions): void {
	pi.registerTool({
		name: FIND_SKILL_TOOL_NAME,
		label: "Find Skill",
		description:
			"Search the skill library by a short description of the task at hand. Returns the " +
			"best-matching skills' name, description, and file path — never the full skill " +
			"content. Read the winning skill's file with your read tool to load its full " +
			"instructions. Use this when a task might match a specialized skill (e.g. document " +
			"authoring, PDF handling) that isn't obviously already listed in the available skills " +
			"section above.",
		promptSnippet: "find_skill(query) — search the skill library for a matching skill by task description",
		promptGuidelines: [
			"Call find_skill when a task might match a specialized skill that doesn't already appear in the always-listed available skills.",
			"Read the returned filePath with your read tool to load a matched skill's full instructions before following them.",
		],
		parameters: FindSkillParams,
		async execute(_toolCallId, params) {
			const { skills } = loadSkills({
				cwd: options.workspaceCwd,
				agentDir: options.agentDir,
				skillPaths: [],
				includeDefaults: true,
			});

			// Skills with disable-model-invocation are already hidden from the
			// system prompt's listing (per the skill author's frontmatter) —
			// respect that here too rather than surfacing them via search.
			const visible = skills.filter((s) => !s.disableModelInvocation);

			const ranked = rankBm25(
				params.query,
				visible.map((s) => ({ id: s.name, text: `${s.name} ${s.description}` })),
			);

			const matches: FindSkillMatch[] = ranked
				.filter((r) => r.score > 0)
				.slice(0, MAX_RESULTS)
				.map((r) => {
					const skill = visible.find((s) => s.name === r.id);
					return skill
						? { name: skill.name, description: skill.description, filePath: skill.filePath }
						: null;
				})
				.filter((m): m is FindSkillMatch => m !== null);

			const details: FindSkillDetails = { query: params.query, matches };

			return {
				content: [
					{
						type: "text",
						text:
							matches.length > 0
								? `Found ${matches.length} matching skill(s): ${matches.map((m) => m.name).join(", ")}`
								: `No matching skills found for "${params.query}".`,
					},
				],
				details,
			};
		},
	});
}
