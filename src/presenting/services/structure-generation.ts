/**
 * Presentation structure generation.
 * Port of presenting/engine/services/structure_generation.py
 */
import { loadsJsonish } from "../utils/jsonish.js";
import type { PresentationOutlineModel, PresentationLayoutModel, PresentationStructureModel } from "../utils/models.js";
import { outlineToString, layoutToString } from "../utils/models.js";

const GET_MESSAGES_SYSTEM_PROMPT = `
You're a professional presentation designer with creative freedom to design engaging presentations.

# DESIGN PHILOSOPHY
- Create visually compelling and varied presentations
- Match layout to content purpose and audience needs

# Layout Selection Guidelines
1. **Content-driven choices**: Let the slide's purpose guide layout selection
- Opening/closing -> Title layouts
- Processes/workflows -> Visual process layouts
- Comparisons/contrasts -> Side-by-side layouts
- Data/metrics -> Chart/graph layouts
- Concepts/ideas -> Image + text layouts
- Key insights -> Emphasis layouts

2. **Visual variety**: Aim for diverse slide layouts across the presentation.
- Don't use same layout for multiple slides unless necessary.
- Mix text-heavy and visual-heavy slides naturally
- Use your judgment on when repetition serves the content
- Balance information density across slides
- Adjacent slide layouts should be different unless instructed/necessary otherwise.

3. **Audience experience**: Consider how slides work together
- Create natural transitions between topics

4. **Table of contents**:
- Must only use table of contents layout if slide content contains table of contents.

{user_instruction_header}

Extract visual constraints from User Instructions and Original User Request; User
Instructions win conflicts. The supplied slide count is authoritative. Slide numbers are
one-based, and "all" or "every" includes the title slide. Prefer exact chart types and
image placements over variety, reusing layouts if needed. A numeric table on a
chart-requested slide is chart data, not a request for a table-only layout.

Select layout index for each of the {n_slides} slides based on what will best serve the presentation's goals.

Respond with ONLY a single JSON object matching this shape, no prose before or after:
{{"slides": [0, 1, 2, ...]}} — exactly {n_slides} integers, each a valid 0-based index
into the presentation layout list below.
`;

function buildMessages(
  layout: PresentationLayoutModel,
  nSlides: number,
  data: string,
  instructions?: string | null,
  sourceContent?: string | null,
): [string, string] {
  const intentSections: string[] = [];
  if (instructions) intentSections.push(`# User Instructions:\n${instructions}`);
  if (sourceContent) intentSections.push(`# Original User Request:\n${sourceContent}`);
  const systemPrompt = GET_MESSAGES_SYSTEM_PROMPT
    .replace("{user_instruction_header}", intentSections.join("\n\n"))
    .replace(/{n_slides}/g, String(nSlides));
  const userPrompt = `${layoutToString(layout)}\n\n--------------------------------------\n\n${data}`;
  return [systemPrompt, userPrompt];
}

function extractText(msg: unknown): string {
  if (typeof msg !== "object" || msg === null) return "";
  const content = (msg as any).content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => typeof b === "object" && b !== null && (b as any).type === "text").map((b) => (b as any).text).join("");
}

function checkMsg(msg: unknown): void {
  if (typeof msg !== "object" || msg === null) return;
  const sr = (msg as any).stopReason;
  if (sr != null && sr !== "stop" && sr !== "toolUse") throw new Error((msg as any).errorMessage ?? `model call ended with stopReason=${sr}`);
}

export async function generatePresentationStructure(
  deps: { modelRuntime: any; modelRegistry: any },
  outline: PresentationOutlineModel,
  layout: PresentationLayoutModel,
  provider: string,
  model: string,
  instructions?: string | null,
  sourceContent?: string | null,
): Promise<PresentationStructureModel> {
  const nSlides = outline.slides.length;
  const [systemPrompt, userPrompt] = buildMessages(layout, nSlides, outlineToString(outline), instructions, sourceContent);
  const found = deps.modelRegistry.find(provider, model);
  if (!found) throw new Error(`Model ${provider}/${model} not found`);
  const msg = await deps.modelRuntime.completeSimple(found, {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  });
  checkMsg(msg);
  const text = extractText(msg);
  if (!text.trim()) throw new Error("Model returned no text content while generating the presentation structure");
  const raw = loadsJsonish(text) as Record<string, unknown>;
  return { slides: Array.isArray(raw.slides) ? (raw.slides as number[]) : [] };
}
