/**
 * Presentation context store — implements the memory/context layer for chat tools.
 * Smart-mode only: slides are HTML fragments (slide.html_content), no
 * template/layout system.
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index.js";
import { IMAGE_GENERATION_SERVICE } from "../services/image-generation-service.js";
import { ICON_FINDER_SERVICE } from "../services/icon-finder-service.js";
import { DEFAULT_ICON_WEIGHT } from "../utils/icon-weights.js";
import { filesystemImagePathToAppDataUrl } from "../utils/asset-directory-utils.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";
import { normalizeSmartSlideHtml, SmartGenerationError } from "../services/smart-generation.js";

const MAX_NUMBER_OF_SLIDES = 50;

// ── DB helpers ────────────────────────────────────────────────────────────────

function getPresentation(presentationId: string): Record<string, unknown> | null {
  return (getDb().prepare("SELECT * FROM presentations WHERE id = ?").get(presentationId) as any) ?? null;
}

function getSlides(presentationId: string): any[] {
  return getDb().prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(presentationId) as any[];
}

function getSlideByIndex(presentationId: string, index: number): any | null {
  return (getDb().prepare("SELECT * FROM slides WHERE presentation_id = ? AND slide_index = ?").get(presentationId, index) as any) ?? null;
}

function saveSlideDb(presentationId: string, slide: {
  id?: string; layout?: string; layoutGroup?: string; index: number;
  htmlContent: string; speakerNote?: string | null;
}, replace: boolean): void {
  const db = getDb();
  const id = slide.id ?? uuidv4();
  if (replace) {
    db.prepare("UPDATE slides SET id=?, layout=?, layout_group=?, content=?, ui=?, html_content=?, speaker_note=? WHERE presentation_id=? AND slide_index=?")
      .run(id, slide.layout ?? "", slide.layoutGroup ?? "smart", "{}", null, slide.htmlContent, slide.speakerNote ?? null, presentationId, slide.index);
  } else {
    // Shift existing slides at >= index up
    db.prepare("UPDATE slides SET slide_index = slide_index + 1 WHERE presentation_id = ? AND slide_index >= ?")
      .run(presentationId, slide.index);
    db.prepare("INSERT INTO slides (id, presentation_id, layout_group, layout, slide_index, content, ui, html_content, speaker_note) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, presentationId, slide.layoutGroup ?? "smart", slide.layout ?? "", slide.index, "{}", null, slide.htmlContent, slide.speakerNote ?? null);
  }
}

// ── Context store ─────────────────────────────────────────────────────────────

export class PresentationContextStore {
  readonly presentationId: string;

  constructor(presentationId: string) {
    this.presentationId = presentationId;
  }

  async search(query: string, limit = 5): Promise<unknown[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const slides = getSlides(this.presentationId);
    const qLower = q.toLowerCase();
    const tokens = new Set(qLower.match(/[a-z0-9]{2,}/g) ?? []);
    const ranked: Array<[number, Record<string, unknown>]> = [];
    for (const slide of slides) {
      const text = String(slide.html_content ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
      let score = text.includes(qLower) ? 8 : 0;
      for (const t of tokens) { if (text.includes(t)) score++; }
      if (score <= 0) continue;
      ranked.push([score, {
        slide_id: slide.id, index: slide.slide_index, slide_number: slide.slide_index + 1,
        slide_type: slide.layout, snippet: text.trim().slice(0, 200), score,
      }]);
    }
    ranked.sort((a, b) => b[0] - a[0]);
    return ranked.slice(0, Math.max(1, limit)).map(([, r]) => r);
  }

  async getSlideAtIndex(index: number, includeFullContent = false): Promise<Record<string, unknown> | null> {
    const slide = getSlideByIndex(this.presentationId, index);
    if (!slide) return null;
    const html = String(slide.html_content ?? "");
    return {
      slide_id: slide.id, index: slide.slide_index, slide_number: slide.slide_index + 1,
      slide_type: slide.layout ?? null, speaker_note: slide.speaker_note ?? null,
      html: includeFullContent ? html : undefined,
      html_preview: includeFullContent ? undefined : html.slice(0, 400),
    };
  }

  async generateImage(prompt: string): Promise<string> {
    const result = await IMAGE_GENERATION_SERVICE.generateImage({ prompt });
    if (typeof result === "string") return result;
    return filesystemImagePathToAppDataUrl((result as any).path);
  }

  async generateIcon(query: string): Promise<string> {
    const results = ICON_FINDER_SERVICE.searchIcons(query, 1, DEFAULT_ICON_WEIGHT);
    return results[0] ?? "/static/icons/placeholder.svg";
  }

  async saveSlide(opts: { html: string; index: number; replaceOldSlideAtIndex: boolean }): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { saved: false, message: "Presentation not found.", validation_errors: [] };

    let normalized: string;
    try {
      normalized = normalizeSmartSlideHtml(opts.html);
    } catch (err) {
      const message = err instanceof SmartGenerationError ? err.message : err instanceof Error ? err.message : String(err);
      return { saved: false, message, validation_errors: [message] };
    }
    const slideType = (/^\s*<section\b[^>]*\bdata-slide-type\s*=\s*"([^"]*)"/i.exec(normalized)?.[1] ?? "content").toLowerCase();
    const targetIndex = Math.max(0, opts.index);

    if (opts.replaceOldSlideAtIndex) {
      const existingSlide = getSlideByIndex(this.presentationId, targetIndex);
      if (!existingSlide) return { saved: false, message: `No existing slide at index ${targetIndex}.`, validation_errors: [] };
      const newId = uuidv4();
      saveSlideDb(this.presentationId, {
        id: newId, layout: slideType, layoutGroup: "smart",
        index: targetIndex, htmlContent: normalized,
        speakerNote: existingSlide.speaker_note ?? null,
      }, true);
      return { saved: true, action: "replaced", message: `Slide at index ${targetIndex} replaced.`, slide_id: newId, index: targetIndex };
    }

    const slides = getSlides(this.presentationId);
    if (slides.length >= MAX_NUMBER_OF_SLIDES) {
      return { saved: false, message: `Slide limit reached (${MAX_NUMBER_OF_SLIDES}).`, validation_errors: [], slide_count: slides.length };
    }
    const insertIndex = slides.length ? Math.min(targetIndex, Math.max(...slides.map((s) => s.slide_index)) + 1) : 0;
    const newId = uuidv4();
    saveSlideDb(this.presentationId, {
      id: newId, layout: slideType, layoutGroup: "smart",
      index: insertIndex, htmlContent: normalized,
    }, false);
    return { saved: true, action: "created", message: `New slide saved at index ${insertIndex}.`, slide_id: newId, index: insertIndex };
  }

  async deleteSlide(index: number): Promise<Record<string, unknown>> {
    const db = getDb();
    const slide = getSlideByIndex(this.presentationId, index);
    if (!slide) return { deleted: false, message: `No slide found at index ${index}.` };
    db.prepare("DELETE FROM slides WHERE presentation_id = ? AND slide_index = ?").run(this.presentationId, index);
    db.prepare("UPDATE slides SET slide_index = slide_index - 1 WHERE presentation_id = ? AND slide_index > ?").run(this.presentationId, index);
    return { deleted: true, message: `Slide at index ${index} deleted.`, index };
  }

  async readSourceDocuments(opts: { query?: string | null; maxChars?: number | null }): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { found: false, message: "Presentation not found." };
    // Source document text is stored in file_paths / content fields on the presentation.
    const content = String(presentation.content ?? "");
    if (!content.trim()) return { found: false, message: "No source document available for this presentation." };
    const maxChars = opts.maxChars ?? 12000;
    const text = content.substring(0, maxChars);
    return { found: true, text, length: content.length, truncated: content.length > maxChars };
  }

  async getSmartPresentationContext(opts: { includeSlideHtml?: boolean; maxHtmlCharsPerSlide?: number } = {}): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { found: false, message: "Presentation not found.", slides: [] };
    const slides = getSlides(this.presentationId);
    const maxChars = opts.maxHtmlCharsPerSlide ?? 4000;
    return {
      found: true,
      title: presentation.title ?? null,
      slide_count: slides.length,
      slides: slides.map((s) => ({
        index: s.slide_index,
        slide_number: s.slide_index + 1,
        slide_type: s.layout ?? null,
        speaker_note: s.speaker_note ?? null,
        html: opts.includeSlideHtml ? String(s.html_content ?? "").slice(0, maxChars) : undefined,
      })),
    };
  }

  async retrieveContext(query: string): Promise<string> {
    return PRESENTATION_MEMORY_SERVICE.retrieveContext(this.presentationId, query);
  }
}
