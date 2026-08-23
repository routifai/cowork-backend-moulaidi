/**
 * Per-slide content generation.
 * Port of presenting/engine/services/slide_content_generation.py
 */
import { loadsJsonish } from "../utils/jsonish.js";
import { removeFieldsFromSchema, addFieldInSchema, ensureArraySchemasHaveItems } from "../utils/schema-utils.js";
import type { SlideLayoutModel } from "../utils/models.js";

const ASSET_ONLY_FIELDS = ["__image_url__", "__icon_url__"];
const AUTO_DETECT_LANGUAGE_INSTRUCTION =
  "auto-detect from the slide content and use the same language as the slide content";

const SLIDE_CONTENT_SYSTEM_PROMPT = `You will be given slide content and response schema.
You need to generate structured content json based on the schema.

# Steps
1. Analyze the content.
2. Analyze the response schema.
3. Generate structured content json based on the schema.
4. Generate speaker note if required.
5. Provide structured content json as output.

# General Rules
- Follow language guidelines.
- Slide Language is authoritative when it is explicitly set. If slide content
  or user instructions request a different language, ignore that conflicting
  language request unless Slide Language says auto-detect.
- Speaker notes must be plain text (no markdown).
- Never exceed max character limits; do not clip mid-sentence to fit—rephrase instead.
- Do not use emojis or $schema fields.
- Follow the intended outcome of user instructions when they do not conflict with Slide
  Language; do not generalize or expand their scope.
- Apply slide-specific instructions only to the exact slide mentioned (first/second/last/named) and only once.
- Do not apply patterns across multiple slides unless explicitly requested.
- If instructions are ambiguous, use the most direct interpretation without extending scope.
- Treat chart, layout, styling, positioning, and other visual instructions as production
  controls. Honor them through the selected schema, but never emit those instructions or
  meta-commentary as a title, body, label, table cell, or speaker note.
- Output fields must contain only audience-facing content and data. For chart fields,
  populate the requested labels, series, and values rather than text such as "create a
  bar chart" or "show this data as a graph".

# Math Expression Rules
- Wrap every LaTeX expression in \`<latex>\` and \`</latex>\` inside the generated string.
- Put only valid LaTeX inside the tags and do not include \`$\`, \`$$\`, \`\\(\`, or \`\\[\` delimiters.
- Keep surrounding prose outside the tags. Example: \`The area is <latex>\\pi r^2</latex>.\`
- Apply the same rule to strings in text lists and table cells.
- Do not use \`<latex>\` tags for ordinary text.

- Strictly use markdown to emphasize important points, by bolding or italicizing the part of text.

{user_instructions}

{tone_instructions}

{verbosity_instructions}

# Output Fields:
{output_fields_instructions}

Respond with ONLY a single JSON object matching the response schema, no prose before or after.
`;

const SLIDE_CONTENT_USER_PROMPT = `# Current Date and Time:
{current_date_time}

# Icon Query And Image Prompt Language:
English

# Slide Language:
{language}

{slide_number_section}# SLIDE CONTENT: START
{content}
# SLIDE CONTENT: END
`;

function resolveLanguage(language?: string | null): string {
  if (!language) return AUTO_DETECT_LANGUAGE_INSTRUCTION;
  const s = language.trim();
  if (!s || s.toLowerCase() === "auto" || s.toLowerCase() === "auto-detect") return AUTO_DETECT_LANGUAGE_INSTRUCTION;
  return s;
}

function getSchemaMarkdown(schema?: Record<string, unknown> | null): string {
  if (!schema) return "- Follow the provided response schema strictly.";
  try { return `- Follow this response schema exactly: ${JSON.stringify(schema)}`; }
  catch { return "- Follow the provided response schema strictly."; }
}

function schemaHasContentFields(schema?: Record<string, unknown> | null): boolean {
  if (!schema) return false;
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props).length > 0;
}

function prepareResponseSchema(jsonSchema?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!jsonSchema || typeof jsonSchema !== "object") return null;
  let schema = removeFieldsFromSchema(jsonSchema, ASSET_ONLY_FIELDS);
  if (!schemaHasContentFields(schema)) return null;
  if (schema.type !== "object") schema = { ...schema, type: "object" };
  schema = addFieldInSchema(schema, {
    __speaker_note__: { type: "string", minLength: 100, maxLength: 500, description: "Speaker note for the slide" },
  }, true);
  return ensureArraySchemasHaveItems(schema);
}

export function getSlideSystemPrompt(
  tone?: string | null,
  verbosity?: string | null,
  instructions?: string | null,
  responseSchema?: Record<string, unknown> | null,
): string {
  const userInstructions = instructions ? `# User Instructions:\n${instructions}` : "";
  const toneInstructions = tone ? `# Tone Instructions:\nMake slide as ${tone} as possible.` : "";
  let verbosityInstructions = "";
  if (verbosity) {
    verbosityInstructions = "# Verbosity Instructions:\n";
    if (verbosity === "concise") verbosityInstructions += "Make slide as concise as possible.";
    else if (verbosity === "standard") verbosityInstructions += "Make slide as standard as possible.";
    else if (verbosity === "text-heavy") verbosityInstructions += "Make slide as text-heavy as possible.";
  }
  return SLIDE_CONTENT_SYSTEM_PROMPT
    .replace("{user_instructions}", userInstructions)
    .replace("{tone_instructions}", toneInstructions)
    .replace("{verbosity_instructions}", verbosityInstructions)
    .replace("{output_fields_instructions}", getSchemaMarkdown(responseSchema));
}

export function getSlideUserPrompt(
  content: string,
  language?: string | null,
  slideNumber?: number | null,
): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const slideNumberSection = slideNumber != null ? `# Slide Number:\n${slideNumber}\n\n` : "";
  return SLIDE_CONTENT_USER_PROMPT
    .replace("{current_date_time}", now)
    .replace("{language}", resolveLanguage(language))
    .replace("{slide_number_section}", slideNumberSection)
    .replace("{content}", content);
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

export async function getSlideContentFromTypeAndOutline(
  deps: { modelRuntime: any; modelRegistry: any },
  slideLayout: SlideLayoutModel,
  outlineContent: string,
  provider: string,
  model: string,
  language?: string | null,
  tone?: string | null,
  verbosity?: string | null,
  instructions?: string | null,
  slideNumber?: number | null,
): Promise<Record<string, unknown>> {
  const responseSchema = prepareResponseSchema(slideLayout.json_schema as Record<string, unknown>);
  if (!responseSchema) return {};
  const systemPrompt = getSlideSystemPrompt(tone, verbosity, instructions, responseSchema);
  const userPrompt = getSlideUserPrompt(outlineContent, language, slideNumber);
  const found = deps.modelRegistry.find(provider, model);
  if (!found) throw new Error(`Model ${provider}/${model} not found`);
  const msg = await deps.modelRuntime.completeSimple(found, {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  });
  checkMsg(msg);
  const text = extractText(msg);
  if (!text.trim()) throw new Error("Model returned no text content while generating slide content");
  return loadsJsonish(text) as Record<string, unknown>;
}
