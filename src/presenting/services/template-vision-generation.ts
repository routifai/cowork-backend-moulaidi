/**
 * Phase B (per-slide) of Imported Template import: one vision/LLM call per
 * slide, grouping a slide's raw extracted elements (pptx-extraction.ts) into
 * named Components with a decorative/content classification, using both the
 * rendered slide image and the raw element JSON as input.
 *
 * Adapted from presenton's generate_slide_layout
 * (servers/fastapi/templates/v2/generation.py) shape, without its
 * self-critique preview-render loop (explicit v1 cut — see
 * import-template-orchestrator.ts).
 *
 * This is the first place in this codebase that constructs an ImageContent
 * block ({ type: "image", data, mimeType }) — vision input existed in the
 * type system (pi-ai's UserMessage.content) but no caller had used it yet.
 */
import { loadsJsonish } from "../utils/jsonish.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import type { RawSlideLayout, RawSlideElement } from "./pptx-extraction.js";

export interface SlideComponent {
	id: string;
	description: string;
	position: { x: number; y: number };
	elements: (RawSlideElement & { decorative: boolean })[];
}

/** Maps 1:1 onto a template.json `layouts[]` entry — the shape the renderer (template-binding.ts) and content-schema deriver (template-schema.ts) actually consume. */
export interface SlideLayout {
	id: string;
	description: string;
	components: SlideComponent[];
}

const MAX_PARALLEL_SLIDE_VISION_CALLS = 10;

const SYSTEM_PROMPT = `You convert a raw slide's element list into a small set of named Components.

# Steps
1. Look at the slide image and the raw element list together.
2. Group elements that visually belong together (e.g. a heading and its underline, an icon and its label) into a Component.
3. Give each Component a short \`id\` (kebab-case, e.g. "section-title") and a one-sentence \`description\`.
4. For every element, set \`decorative\`:
   - \`decorative: true\` = fixed visual scaffolding that should stay unchanged in every presentation built from this template (backgrounds, logos, frame graphics, static labels).
   - \`decorative: false\` = a content slot whose value should be replaced or regenerated per presentation (titles, body text, data, user-supplied images).

# Output
Respond with ONLY a single JSON object, no prose before or after:
{"components": [{"id": string, "description": string, "position": {"x": number, "y": number}, "elements": [<element from the input, with a "decorative" boolean field added>]}]}`;

function extractText(msg: unknown): string {
	if (typeof msg !== "object" || msg === null) return "";
	const content = (msg as any).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: unknown) => typeof b === "object" && b !== null && (b as any).type === "text")
		.map((b: any) => b.text)
		.join("");
}

function checkAssistantMessage(msg: unknown): void {
	if (typeof msg !== "object" || msg === null) return;
	const stopReason = (msg as any).stopReason;
	if (stopReason != null && stopReason !== "stop" && stopReason !== "toolUse") {
		throw new Error((msg as any).errorMessage ?? `model call ended with stopReason=${stopReason}`);
	}
}

function firstElementPosition(elements: RawSlideElement[]): { x: number; y: number } {
	const first = elements[0];
	return first ? { x: first.position.x, y: first.position.y } : { x: 0, y: 0 };
}

async function generateSlideLayout(
	deps: { modelRuntime: any; modelRegistry: any },
	provider: string,
	model: string,
	rawSlide: RawSlideLayout,
	slideImagePng: Buffer,
): Promise<SlideLayout> {
	const found = deps.modelRegistry.find(provider, model);
	if (!found) throw new Error(`Model ${provider}/${model} not found`);

	const msg = await deps.modelRuntime.completeSimple(found, {
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", data: slideImagePng.toString("base64"), mimeType: "image/png" },
					{ type: "text", text: JSON.stringify({ id: rawSlide.id, description: rawSlide.description, elements: rawSlide.elements }) },
				],
			},
		],
	});
	checkAssistantMessage(msg);
	const text = extractText(msg);
	if (!text.trim()) throw new Error(`Model returned no text content while analyzing slide '${rawSlide.id}'`);

	const raw = loadsJsonish(text) as { components?: unknown };
	const components = Array.isArray(raw.components) ? (raw.components as Record<string, unknown>[]) : [];

	return {
		id: rawSlide.id,
		description: rawSlide.description,
		components: components.map((c) => ({
			id: String(c.id ?? ""),
			description: String(c.description ?? ""),
			position: (c.position as { x: number; y: number }) ?? firstElementPosition(rawSlide.elements),
			elements: Array.isArray(c.elements) ? (c.elements as (RawSlideElement & { decorative: boolean })[]) : [],
		})),
	};
}

/** Analyze every slide in parallel (bounded concurrency), producing one SlideLayout per slide. */
export async function generateSlideLayouts(
	deps: { modelRuntime: any; modelRegistry: any },
	provider: string,
	model: string,
	rawSlides: RawSlideLayout[],
	slideImages: Buffer[],
): Promise<SlideLayout[]> {
	if (rawSlides.length !== slideImages.length) {
		throw new Error(`Slide count mismatch: ${rawSlides.length} raw layouts vs ${slideImages.length} images`);
	}
	return runWithConcurrency(rawSlides, MAX_PARALLEL_SLIDE_VISION_CALLS, (rawSlide, index) =>
		generateSlideLayout(deps, provider, model, rawSlide, slideImages[index]),
	);
}
