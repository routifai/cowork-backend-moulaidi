/**
 * Presentation domain types.
 * Port of presenting/engine/services/models.py
 */
import { normalizeOutlineContent, MAX_OUTLINE_CONTENT_WORDS } from "./outline-limits.js";
import { DEFAULT_ICON_TYPE, extractIconTypeFromSettings } from "./icon-weights.js";

export const MAX_NUMBER_OF_SLIDES = 50;

export interface ImagePrompt {
  prompt: string;
  theme_prompt?: string;
}

export function imagePromptText(p: ImagePrompt, withTheme = true): string {
  const parts = [p.prompt];
  if (withTheme && p.theme_prompt) parts.push(p.theme_prompt);
  return parts.join(", ");
}

export interface ImageAsset {
  path: string;
  is_uploaded: boolean;
  extras?: Record<string, unknown>;
}

export interface SlideOutlineModel {
  content: string;
}

export interface PresentationOutlineModel {
  slides: SlideOutlineModel[];
}

export interface PresentationStructureModel {
  slides: number[];
}

export interface SlideLayoutModel {
  id: string;
  name?: string;
  description?: string;
  json_schema: Record<string, unknown>;
}

export interface PresentationLayoutModel {
  name: string;
  ordered: boolean;
  icon_type: string;
  icon_weight: string;
  slides: SlideLayoutModel[];
}

export class LayoutNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = "LayoutNotFoundError"; }
}

export function createOutlineModel(raw: Record<string, unknown>): PresentationOutlineModel {
  const slides = Array.isArray(raw.slides) ? raw.slides : [];
  return {
    slides: slides.map((s) => {
      const content = typeof s === "object" && s !== null ? (s as any).content : s;
      return { content: normalizeOutlineContent(content) };
    }),
  };
}

export function outlineToString(outline: PresentationOutlineModel): string {
  return outline.slides.map((s, i) => `## Slide ${i + 1}:\n  - Content: ${JSON.stringify(s)}\n`).join("");
}

export function layoutToString(layout: PresentationLayoutModel, withSchema = false): string {
  let msg = "## Presentation Layout\n\n";
  for (const [index, slide] of layout.slides.entries()) {
    msg += `### Slide Layout: ${index}\n`;
    msg += `- Name: ${slide.name ?? (slide.json_schema as any)?.title ?? ""}\n`;
    msg += `- Description: ${slide.description ?? ""}\n`;
    if (withSchema) {
      try { msg += `- Schema: ${JSON.stringify(slide.json_schema)}\n`; } catch { msg += "- Schema: {}\n"; }
    }
    msg += "\n";
  }
  return msg;
}

export function layoutToStructure(layout: PresentationLayoutModel): PresentationStructureModel {
  return { slides: layout.slides.map((_, i) => i) };
}

export function createLayoutModel(raw: Record<string, unknown>): PresentationLayoutModel {
  const iconType = extractIconTypeFromSettings(raw);
  return {
    name: String(raw.name ?? ""),
    ordered: Boolean(raw.ordered ?? false),
    icon_type: iconType,
    icon_weight: iconType,
    slides: Array.isArray(raw.slides)
      ? raw.slides.map((s) => ({
          id: String((s as any)?.id ?? ""),
          name: (s as any)?.name ?? undefined,
          description: (s as any)?.description ?? undefined,
          json_schema: (s as any)?.json_schema ?? {},
        }))
      : [],
  };
}
