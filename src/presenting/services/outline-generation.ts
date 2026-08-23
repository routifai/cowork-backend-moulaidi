/**
 * Presentation outline generation.
 * Port of presenting/engine/services/outline_generation.py
 */
import { loadsJsonish } from "../utils/jsonish.js";
import { normalizeOutlinePayload, MAX_OUTLINE_CONTENT_WORDS } from "../utils/outline-limits.js";
import type { PresentationOutlineModel } from "../utils/models.js";
import { createOutlineModel } from "../utils/models.js";

export const MAX_NUMBER_OF_SLIDES = 50;

function resolvePromptLanguage(language?: string | null): string {
  if (!language) return "auto-detect";
  const s = language.trim();
  if (!s || s.toLowerCase() === "auto" || s.toLowerCase() === "auto-detect") return "auto-detect";
  return s;
}

function resolvePromptNSlides(nSlides?: number | null): string {
  if (nSlides == null) return `auto-detect, maximum ${MAX_NUMBER_OF_SLIDES}`;
  return String(nSlides);
}

export function getOutlineSystemPrompt(verbosity?: string | null, includeTitleSlide = true, includeTableOfContents = false): string {
  const verbosityInstruction =
    verbosity === "concise"
      ? "Slide content should be around 20 words but detailed enough to generate a good slide."
      : verbosity === "text-heavy"
        ? "Slide content should be around 60 words but detailed enough to generate a good slide."
        : "Slide content should be around 40 words but detailed enough to generate a good slide.";

  const titleSlideInstruction = includeTitleSlide
    ? "Include presenter name in first slide."
    : "Do not include presenter name in any slides.";

  const tocBlock = includeTableOfContents
    ? "Include a table of contents slide in the outline sequence.\n"
    : "";

  const slideOutlineStructure =
    "Each slide content:\n" +
    "   - Must have a ## title.\n" +
    "   - Must be in Markdown format.\n" +
    "   - Don't use **bold** and __italic__ text.\n" +
    "   - First slide title must be the same as the presentation title.";

  const contentOnlyRules =
    "Slide outlines are a user-visible content plan, not a production brief.\n" +
    "Write only audience-facing content and data that could appear on the finished slide.\n" +
    "Never include or paraphrase commands, configuration, or meta-commentary about how " +
    "to create the slide. This includes requests about slide type, charts, graphs, " +
    "tables, images, icons, layout, positioning, colors, fonts, styling, animation, " +
    "or transitions.\n" +
    "Do not write phrases such as 'create a bar chart', 'add an image', 'use a table', " +
    "'show this as', 'the slide should', or 'place on the left'.\n" +
    "Use visual requests only to choose content for the specified slide. For any chart " +
    "request, include a compact Markdown table with labels and numeric values. Preserve " +
    "supplied data; otherwise add a small relevant dataset and clearly label estimates " +
    "or illustrative values. Do not mention the chart instruction.\n";

  return (
    "Generate presentation title and content for slides.\n" +
    "Generation settings are authoritative. The Number of Slides, Language, Tone, " +
    "Include Title Slide, and Include Table Of Contents fields override conflicting " +
    "requests inside Content, Instructions, or Context.\n" +
    "If Language is not auto-detect, generate every presentation title and slide " +
    "outline in exactly that language, even if Content asks for a different language.\n" +
    "Generate flow based on user **content** and use **context** just for reference.\n" +
    "Presentation title should be plain text, not markdown. It should be a concise title for the presentation.\n" +
    "Each slide content should contain the content for that slide.\n" +
    `Never generate more than ${MAX_NUMBER_OF_SLIDES} slide outlines, even if the user asks for more. ` +
    `Each slide outline must be ${MAX_OUTLINE_CONTENT_WORDS} words or fewer.\n` +
    `${verbosityInstruction}\n` +
    "Follow the intended outcome of user instructions when they do not conflict with " +
    "the authoritative generation settings, but never copy production instructions " +
    "into slide content.\n" +
    "Apply slide-specific instructions only to the exact slide mentioned and only once. " +
    "Do not apply patterns across multiple slides unless explicitly requested. " +
    "Resolve ambiguous instructions using the most direct interpretation.\n" +
    "Follow the user's specified tone across all slides. " +
    "Maintain clarity, readability, and factual accuracy. " +
    "If no tone is provided, use a clear and professional style. " +
    "Ensure logical flow between slides and avoid repetition or generic filler content.\n" +
    "Give each slide one clear purpose and split overloaded topics across multiple slides.\n" +
    "Minimize repetitive phrasing and do not repeat the same facts across slides.\n" +
    "Build a coherent narrative from the introduction through the conclusion.\n" +
    "Vary audience-facing content structures where appropriate, using bullets, comparisons, chronological facts, tables, or metrics.\n" +
    "Use concrete facts, examples, and numbers when supported by the provided content/context.\n" +
    "Include numerical data, tables or code if required or asked by the user.\n" +
    "If 'auto-detect' is used, figure it out from the content/context.\n" +
    `${titleSlideInstruction}\n` +
    tocBlock +
    `${slideOutlineStructure}\n` +
    contentOnlyRules +
    "Slide content must not contain any presentation branding/styling information.\n" +
    "Title slide must only contain title, presenter name, date and overview.\n" +
    "Do not include URLs, hyperlinks, citations, footnotes, references, or source lists in slide outlines.\n" +
    "Make sure data is consistent across all slides.\n" +
    'Respond with ONLY a single JSON object matching this shape, no prose before or after: {"slides": [{"content": "## Title\\n..."}]}\n'
  );
}

export function getOutlineUserPrompt(
  content: string,
  nSlides?: number | null,
  language?: string | null,
  additionalContext?: string | null,
  tone?: string | null,
  instructions?: string | null,
  includeTitleSlide = true,
  includeTableOfContents = false,
): string {
  const displayLanguage = resolvePromptLanguage(language);
  const displaySlides = resolvePromptNSlides(nSlides);
  const tocText = `Include Table Of Contents: ${includeTableOfContents}\n`;
  const today = new Date().toISOString().slice(0, 10);
  return (
    "Generation Settings (authoritative):\n" +
    `Number of Slides: ${displaySlides}\n` +
    `Maximum Slide Outlines: ${MAX_NUMBER_OF_SLIDES}\n` +
    `Maximum Words Per Outline: ${MAX_OUTLINE_CONTENT_WORDS}\n` +
    `Language: ${displayLanguage}\n` +
    `Tone: ${tone ?? ""}\n` +
    `Include Title Slide: ${includeTitleSlide}\n` +
    (includeTableOfContents ? tocText : "") +
    "If Content, Instructions, or Context asks for a different language or slide count, ignore that conflicting request.\n" +
    `Today's Date: ${today}\n` +
    `Content: ${content ?? ""}\n` +
    `Instructions (apply as constraints; never quote as slide content): ${instructions ?? ""}\n` +
    `Context: ${additionalContext ?? "None"}\n`
  );
}

function extractText(assistantMessage: unknown): string {
  if (typeof assistantMessage !== "object" || assistantMessage === null) return "";
  const content = (assistantMessage as any).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => typeof b === "object" && b !== null && (b as any).type === "text" && typeof (b as any).text === "string")
    .map((b) => (b as any).text)
    .join("");
}

function checkAssistantMessage(msg: unknown): void {
  if (typeof msg !== "object" || msg === null) return;
  const stopReason = (msg as any).stopReason;
  if (stopReason != null && stopReason !== "stop" && stopReason !== "toolUse") {
    const errorMessage = (msg as any).errorMessage ?? `model call ended with stopReason=${stopReason}`;
    throw new Error(errorMessage);
  }
}

export async function generatePptOutline(
  deps: { modelRuntime: any; modelRegistry: any },
  content: string,
  nSlides?: number | null,
  provider?: string,
  model?: string,
  language?: string | null,
  additionalContext?: string | null,
  tone?: string | null,
  verbosity?: string | null,
  instructions?: string | null,
  includeTitleSlide = true,
  includeTableOfContents = false,
): Promise<PresentationOutlineModel> {
  const systemPrompt = getOutlineSystemPrompt(verbosity, includeTitleSlide, includeTableOfContents);
  const userPrompt = getOutlineUserPrompt(content, nSlides, language, additionalContext, tone, instructions, includeTitleSlide, includeTableOfContents);

  const found = deps.modelRegistry.find(provider, model);
  if (!found) throw new Error(`Model ${provider}/${model} not found`);

  const msg = await deps.modelRuntime.completeSimple(found, {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  });
  checkAssistantMessage(msg);
  const text = extractText(msg);
  if (!text.trim()) throw new Error("Model returned no text content while generating the presentation outline");

  const outlineJson = normalizeOutlinePayload(loadsJsonish(text) as Record<string, unknown>, MAX_NUMBER_OF_SLIDES);
  const outline = createOutlineModel(outlineJson);

  if (nSlides != null && outline.slides.length !== nSlides) {
    throw new Error(
      `Failed to generate presentation outlines with requested number of slides (wanted ${nSlides}, got ${outline.slides.length}). Please try again.`,
    );
  }
  return outline;
}
