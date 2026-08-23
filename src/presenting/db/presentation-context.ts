/**
 * Presentation context store — implements the memory/context layer for chat tools.
 * Port of presenting/engine/services/memory_layer.py (PresentationChatMemoryLayer).
 *
 * All DB operations use better-sqlite3 (synchronous). Template data is loaded
 * from the same template-store used by generation.
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index.js";
import { resolveTemplateData, type TemplateResolutionContext } from "../services/template-resolver.js";
import { buildTemplateLayoutModel, hydrateTemplateSlideUi } from "../services/template-binding.js";
import { getTemplateSchema } from "../services/template-schema.js";
import { IMAGE_GENERATION_SERVICE } from "../services/image-generation-service.js";
import { ICON_FINDER_SERVICE } from "../services/icon-finder-service.js";
import {
  processSlideAndFetchAssets,
  processOldAndNewSlidesAndFetchAssets,
  type SlideForProcessing,
} from "../services/process-slides.js";
import {
  collectEditableElements,
  compactComponents,
  resolveElementPath,
  componentIdForPath,
  updateTextElement,
  updateTextListElement,
  updateTableCellInElement,
  updateTableElement,
  updateVectorElement,
  updateInfographicElement,
  updateChartElement,
  normalizeChartElement,
  applyElementStylePatch,
  applyImageElementValue,
  resolveImageUpdatePayload,
  looksLikeAssetReference,
  contentUpdateRequestedForType,
  updateElementBox,
  mergeUiPatch,
  validateCurrentElementModel,
} from "../chat/slide-ui-helpers.js";
import { normalizeOutlineContent, MAX_OUTLINE_CONTENT_WORDS } from "../utils/outline-limits.js";
import { MAX_NUMBER_OF_SLIDES } from "../utils/models.js";
import { DEFAULT_ICON_WEIGHT } from "../utils/icon-weights.js";
import { filesystemImagePathToAppDataUrl } from "../utils/asset-directory-utils.js";
import { PRESENTATION_MEMORY_SERVICE } from "../services/memory-layer.js";

const BLANK_SLIDE_LAYOUT_ID = "__blank_slide__";
const MAX_SCHEMA_ERRORS = 10;
const THEMES_STORAGE_KEY = "presentation_custom_themes";

const CHAT_BUILTIN_THEMES = [
  { id: "edge-yellow", name: "Edge Yellow", description: "Yellow and dark theme.", user: "system", logo: null, logo_url: null, company_name: null, data: { colors: { primary: "#f5f547", background: "#1f1f1f", card: "#424242", stroke: "#585858", primary_text: "#161616", background_text: "#f5f547", graph_0: "#ffff54", graph_1: "#f1f142", graph_2: "#dada15", graph_3: "#c1bf00", graph_4: "#a8a600", graph_5: "#908c00", graph_6: "#797400", graph_7: "#625c00", graph_8: "#4d4500", graph_9: "#382f00" }, fonts: { textFont: { name: "Playfair Display", url: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&display=swap" } } } },
  { id: "light-rose", name: "Light Rose", description: "Rose background with punchy font.", user: "system", logo: null, logo_url: null, company_name: null, data: { colors: { primary: "#030204", background: "#f69c9c", card: "#ffaeb4", stroke: "#bf6a6b", primary_text: "#bebebe", background_text: "#030202", graph_0: "#2f2c32", graph_1: "#444147", graph_2: "#5a565d", graph_3: "#706d73", graph_4: "#88848b", graph_5: "#a09da4", graph_6: "#b9b6bd", graph_7: "#d3cfd6", graph_8: "#eae6ed", graph_9: "#f7f3fb" }, fonts: { textFont: { name: "Overpass", url: "https://fonts.googleapis.com/css2?family=Overpass:wght@100..900&display=swap" } } } },
  { id: "professional-dark", name: "Professional Dark", description: "Clean and professional for dark usage.", user: "system", logo: null, logo_url: null, company_name: null, data: { colors: { primary: "#eff5f1", background: "#050505", card: "#424242", stroke: "#585858", primary_text: "#050505", background_text: "#eff5f1", graph_0: "#ebf6ff", graph_1: "#dee8fa", graph_2: "#c7d2e3", graph_3: "#aeb8c9", graph_4: "#959fb0", graph_5: "#7d8797", graph_6: "#666f7f", graph_7: "#505867", graph_8: "#3a4351", graph_9: "#262e3c" }, fonts: { textFont: { name: "Instrument Sans", url: "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap" } } } },
];

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

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function saveSlideDb(presentationId: string, slide: {
  id?: string; layout?: string; layoutGroup?: string; index: number;
  content: Record<string, unknown>; ui?: unknown; speakerNote?: string | null;
}, replace: boolean): void {
  const db = getDb();
  const id = slide.id ?? uuidv4();
  const content = JSON.stringify(slide.content);
  const ui = slide.ui != null ? JSON.stringify(slide.ui) : null;
  if (replace) {
    db.prepare("UPDATE slides SET id=?, layout=?, layout_group=?, content=?, ui=?, speaker_note=? WHERE presentation_id=? AND slide_index=?")
      .run(id, slide.layout ?? "", slide.layoutGroup ?? "", content, ui, slide.speakerNote ?? null, presentationId, slide.index);
  } else {
    // Shift existing slides at >= index up
    db.prepare("UPDATE slides SET slide_index = slide_index + 1 WHERE presentation_id = ? AND slide_index >= ?")
      .run(presentationId, slide.index);
    db.prepare("INSERT INTO slides (id, presentation_id, layout_group, layout, slide_index, content, ui, speaker_note) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, presentationId, slide.layoutGroup ?? "", slide.layout ?? "", slide.index, content, ui, slide.speakerNote ?? null);
  }
}

function updatePresentationOutlines(presentationId: string, outlines: unknown): void {
  getDb().prepare("UPDATE presentations SET outlines = ? WHERE id = ?").run(JSON.stringify(outlines), presentationId);
}

function updateSlideUi(presentationId: string, index: number, ui: unknown): void {
  getDb().prepare("UPDATE slides SET ui = ? WHERE presentation_id = ? AND slide_index = ?")
    .run(JSON.stringify(ui), presentationId, index);
}

function extractSpeakerNote(content: Record<string, unknown>): string | null {
  const note = content.__speaker_note__;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

// ── Context store ─────────────────────────────────────────────────────────────

export class PresentationContextStore {
  readonly presentationId: string;
  readonly presentationType: string;
  private readonly templateContext?: TemplateResolutionContext;

  constructor(presentationId: string, presentationType = "standard", templateContext?: TemplateResolutionContext) {
    this.presentationId = presentationId;
    this.presentationType = presentationType === "smart" ? "smart" : "standard";
    this.templateContext = templateContext;
  }

  private resolveTemplate(templateId: string): Record<string, unknown> | null {
    return resolveTemplateData(templateId, this.templateContext);
  }

  // ── Outline helpers ──────────────────────────────────────────────────────────

  private normalizeOutlineSlides(outlines: unknown): Array<{ content: string }> {
    if (!outlines || typeof outlines !== "object") return [];
    const raw = outlines as Record<string, unknown>;
    const slides = Array.isArray(raw.slides) ? raw.slides : [];
    return slides
      .map((s) => {
        if (typeof s === "string") return { content: s };
        if (s && typeof s === "object") return { content: String((s as any).content ?? "") };
        return null;
      })
      .filter((s): s is { content: string } => s !== null);
  }

  private extractOutlineTitle(content: string): string {
    for (const line of content.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      const m = /^#{1,6}\s*(.+?)\s*$/.exec(s);
      if (m) return m[1].trim();
      return s.substring(0, 120);
    }
    return "";
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async get(key: string): Promise<unknown> {
    if (key !== "presentation_outline") return null;
    const slides = getSlides(this.presentationId);
    if (slides.length) {
      return {
        source: "slides_table",
        slide_count: slides.length,
        slides: slides.map((s) => ({
          slide_id: s.id,
          index: s.slide_index,
          layout_id: s.layout,
          content: parseJson(s.content, {}),
          speaker_note: s.speaker_note ?? null,
        })),
      };
    }
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return null;
    return parseJson(presentation.outlines as string | null, null);
  }

  async search(query: string, limit = 5): Promise<unknown[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const slides = getSlides(this.presentationId);
    const qLower = q.toLowerCase();
    const tokens = new Set(qLower.match(/[a-z0-9]{2,}/g) ?? []);
    const ranked: Array<[number, Record<string, unknown>]> = [];
    for (const slide of slides) {
      const content = parseJson<Record<string, unknown>>(slide.content, {});
      const serialized = JSON.stringify(content).toLowerCase();
      let score = serialized.includes(qLower) ? 8 : 0;
      for (const t of tokens) { if (serialized.includes(t)) score++; }
      if (score <= 0) continue;
      ranked.push([score, {
        slide_id: slide.id, index: slide.slide_index, slide_number: slide.slide_index + 1,
        layout_id: slide.layout, snippet: serialized.substring(0, 200), score,
      }]);
    }
    ranked.sort((a, b) => b[0] - a[0]);
    return ranked.slice(0, Math.max(1, limit)).map(([, r]) => r);
  }

  async getSlideAtIndex(index: number, includeFullContent = false): Promise<Record<string, unknown> | null> {
    const slide = getSlideByIndex(this.presentationId, index);
    if (!slide) return null;
    const content = parseJson<Record<string, unknown>>(slide.content, {});
    const ui = parseJson<Record<string, unknown> | null>(slide.ui, null);
    const response: Record<string, unknown> = {
      slide_id: slide.id, index: slide.slide_index, slide_number: slide.slide_index + 1,
      layout_id: slide.layout, content_preview: JSON.stringify(content).substring(0, 420),
      speaker_note: slide.speaker_note ?? null,
    };
    if (includeFullContent) {
      response.content = content;
      response.ui = ui;
    }
    if (ui) {
      response.ui_summary = await this.getSlideUiElements(index, false);
    }
    return response;
  }

  async addOutline(content: string, index?: number | null): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { saved: false, message: "Presentation not found." };
    const outlines = parseJson<Record<string, unknown>>(presentation.outlines as string | null, { slides: [] });
    const slides = this.normalizeOutlineSlides(outlines);
    if (slides.length >= MAX_NUMBER_OF_SLIDES) {
      return { saved: false, message: `Outline slide limit reached (${MAX_NUMBER_OF_SLIDES}).` };
    }
    const insertIndex = index == null ? slides.length : Math.min(Math.max(0, index), slides.length);
    slides.splice(insertIndex, 0, { content: normalizeOutlineContent(content.trim()) });
    updatePresentationOutlines(this.presentationId, { slides });
    return { saved: true, action: "created", message: `Outline slide added at index ${insertIndex}.`, index: insertIndex, slide_count: slides.length };
  }

  async updateOutline(index: number, content: string): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { saved: false, message: "Presentation not found." };
    const outlines = parseJson<Record<string, unknown>>(presentation.outlines as string | null, { slides: [] });
    const slides = this.normalizeOutlineSlides(outlines);
    if (index >= slides.length) return { saved: false, message: `No outline slide at index ${index}.` };
    slides[index] = { content: normalizeOutlineContent(content.trim()) };
    updatePresentationOutlines(this.presentationId, { slides });
    return { saved: true, action: "updated", message: `Outline slide at index ${index} updated.`, index, slide_count: slides.length };
  }

  async deleteOutline(index: number): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { deleted: false, message: "Presentation not found." };
    const outlines = parseJson<Record<string, unknown>>(presentation.outlines as string | null, { slides: [] });
    const slides = this.normalizeOutlineSlides(outlines);
    if (index >= slides.length) return { deleted: false, message: `No outline slide at index ${index}.` };
    slides.splice(index, 1);
    updatePresentationOutlines(this.presentationId, { slides });
    return { deleted: true, message: `Outline slide at index ${index} deleted.`, slide_count: slides.length };
  }

  async getAvailableLayouts(): Promise<unknown[]> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return [];
    const layoutData = parseJson<Record<string, unknown>>(presentation.layout as string | null, {});
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = templateId ? this.resolveTemplate(templateId) : null;
    if (!templateData) return [];
    const layoutModel = buildTemplateLayoutModel({ ...templateData, name: templateId, template_id: templateId }, { layout_name: templateId });
    return layoutModel.slides.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? "" }));
  }

  async getAvailableBlocks(opts: {
    query?: string | null;
    layoutId?: string | null;
    elementType?: string | null;
    blockId?: string | null;
    includeFullContent?: boolean;
    maxResults?: number;
  } = {}): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { found: false, count: 0, blocks: [], message: "Presentation not found." };
    const layoutData = parseJson<Record<string, unknown>>(presentation.layout as string | null, {});
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = templateId ? this.resolveTemplate(templateId) : null;
    if (!templateData) return { found: false, count: 0, blocks: [], message: "Template not found." };

    const { query = null, layoutId = null, elementType = null, blockId = null, includeFullContent = false, maxResults = 20 } = opts;
    const qText = (query ?? "").toLowerCase().trim();
    const elementFilter = (elementType ?? "").toLowerCase().trim();
    const blockFilter = (blockId ?? "").trim();
    const layoutFilter = (layoutId ?? "").trim();

    // Build block candidates from template layouts
    const rawLayouts = Array.isArray(templateData.layouts) ? templateData.layouts as unknown[] : [];
    const candidates: Array<Record<string, unknown>> = [];
    for (const rawLayout of rawLayouts) {
      if (!rawLayout || typeof rawLayout !== "object") continue;
      const layout = rawLayout as Record<string, unknown>;
      const lid = String(layout.id ?? "");
      if (layoutFilter && lid !== layoutFilter) continue;
      const components = Array.isArray(layout.components) ? layout.components as unknown[] : [];
      for (const comp of components) {
        if (!comp || typeof comp !== "object") continue;
        const c = comp as Record<string, unknown>;
        const cid = String(c.id ?? "");
        const blockIdVal = `${lid}/${cid}`;
        if (blockFilter && blockIdVal !== blockFilter) continue;
        const elements = Array.isArray(c.elements) ? c.elements as unknown[] : [];
        const etypes = elements.map((e) => typeof e === "object" && e ? String((e as any).type ?? "") : "").filter(Boolean);
        if (elementFilter && !etypes.includes(elementFilter)) continue;
        const desc = String(c.description ?? "");
        if (qText) {
          const searchable = `${cid} ${desc} ${etypes.join(" ")} ${lid}`.toLowerCase();
          if (!searchable.includes(qText)) continue;
        }
        const candidate: Record<string, unknown> = {
          block_id: blockIdVal, component_id: cid, layout_id: lid,
          description: desc, element_types: etypes, decorative: !!(c as any).decorative,
        };
        if (includeFullContent) candidate.component = JSON.parse(JSON.stringify(c));
        candidates.push(candidate);
      }
    }

    const limit = Math.min(Math.max(maxResults, 1), 50);
    const blocks = candidates.slice(0, limit);
    return {
      found: blocks.length > 0, count: blocks.length,
      total_matches: candidates.length, blocks, truncated: candidates.length > blocks.length,
      message: blocks.length > 0 ? `Found ${blocks.length} matching block(s).` : "No matching blocks found.",
    };
  }

  async getContentSchemaFromLayoutId(layoutId: string): Promise<unknown> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return null;
    const layoutData = parseJson<Record<string, unknown>>(presentation.layout as string | null, {});
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = templateId ? this.resolveTemplate(templateId) : null;
    if (!templateData) return null;
    return getTemplateSchema(templateData, layoutId);
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

  async addBlankSlide(index?: number | null): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { saved: false, message: "Presentation not found." };
    const slides = getSlides(this.presentationId);
    if (slides.length >= MAX_NUMBER_OF_SLIDES) {
      return { saved: false, message: `Slide limit reached (${MAX_NUMBER_OF_SLIDES}).` };
    }
    const insertIndex = index == null ? slides.length : Math.min(Math.max(0, index), slides.length);
    const newId = uuidv4();
    saveSlideDb(this.presentationId, {
      id: newId, layout: BLANK_SLIDE_LAYOUT_ID, layoutGroup: "",
      index: insertIndex, content: {}, ui: { id: BLANK_SLIDE_LAYOUT_ID, components: [], elements: [] },
    }, false);
    return { saved: true, action: "created", message: `Blank slide added at index ${insertIndex}.`, index: insertIndex, slide_id: newId };
  }

  private getLayoutForPresentation(): Record<string, unknown> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return {};
    return parseJson<Record<string, unknown>>(presentation.layout as string | null, {});
  }

  private getLayoutById(layoutId: string): Record<string, unknown> | null {
    const layoutData = this.getLayoutForPresentation();
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = templateId ? this.resolveTemplate(templateId) : null;
    if (!templateData) return null;
    const rawLayouts = Array.isArray(templateData.layouts) ? templateData.layouts as unknown[] : [];
    return (rawLayouts.find((l): l is Record<string, unknown> =>
      !!l && typeof l === "object" && String((l as any).id) === layoutId
    ) ?? null);
  }

  private buildSlideUi(layoutId: string, content: Record<string, unknown>): unknown {
    const rawLayout = this.getLayoutById(layoutId);
    if (!rawLayout) return null;
    const layoutData = this.getLayoutForPresentation();
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = this.resolveTemplate(templateId);
    if (!templateData) return null;
    const slideLayout = buildTemplateLayoutModel({ ...templateData, name: templateId, template_id: templateId }, { layout_name: templateId })
      .slides.find((s) => s.id === layoutId);
    if (!slideLayout) return null;
    return hydrateTemplateSlideUi(rawLayout, slideLayout.id, content, { ...templateData, name: templateId, template_id: templateId });
  }

  private validateSlideContent(content: Record<string, unknown>, schema: Record<string, unknown> | null | undefined): string[] {
    if (!schema) return [];
    // Basic required field check without full JSON Schema validator
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const errors: string[] = [];
    const properties = schema.properties as Record<string, unknown> ?? {};
    for (const field of required) {
      if (!(field in content)) errors.push(`Missing required field: ${field}`);
    }
    if (errors.length > MAX_SCHEMA_ERRORS) return errors.slice(0, MAX_SCHEMA_ERRORS);
    return errors;
  }

  async saveSlide(opts: {
    content: Record<string, unknown>;
    layoutId: string;
    index: number;
    replaceOldSlideAtIndex: boolean;
  }): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { saved: false, message: "Presentation not found.", validation_errors: [] };

    const rawLayout = this.getLayoutById(opts.layoutId);
    if (!rawLayout) return { saved: false, message: `Layout '${opts.layoutId}' not found.`, validation_errors: [`Unknown layout_id '${opts.layoutId}'.`] };

    const layoutData = this.getLayoutForPresentation();
    const templateId = String(layoutData.template_id ?? layoutData.name ?? "");
    const templateData = this.resolveTemplate(templateId);
    const slideLayout = templateData
      ? buildTemplateLayoutModel({ ...templateData, name: templateId, template_id: templateId }, { layout_name: templateId })
          .slides.find((s) => s.id === opts.layoutId)
      : null;

    const validationErrors = this.validateSlideContent(opts.content, slideLayout?.json_schema as Record<string, unknown> ?? null);
    if (validationErrors.length) return { saved: false, message: "Slide content failed schema validation.", validation_errors: validationErrors };

    const targetIndex = Math.max(0, opts.index);
    const iconWeight = DEFAULT_ICON_WEIGHT;

    if (opts.replaceOldSlideAtIndex) {
      const existingSlide = getSlideByIndex(this.presentationId, targetIndex);
      if (!existingSlide) return { saved: false, message: `No existing slide at index ${targetIndex}.`, validation_errors: [] };

      const updatedContent = JSON.parse(JSON.stringify(opts.content)) as Record<string, unknown>;
      const oldContent = parseJson<Record<string, unknown>>(existingSlide.content, {});
      const slideForProcessing: SlideForProcessing = { content: updatedContent };
      await processOldAndNewSlidesAndFetchAssets(oldContent, updatedContent, iconWeight, true, true);
      const ui = this.buildSlideUi(opts.layoutId, updatedContent);
      const newId = uuidv4();
      saveSlideDb(this.presentationId, {
        id: newId, layout: opts.layoutId, layoutGroup: templateId,
        index: targetIndex, content: updatedContent, ui,
        speakerNote: extractSpeakerNote(updatedContent),
      }, true);
      return { saved: true, action: "replaced", message: `Slide at index ${targetIndex} replaced.`, slide_id: newId, index: targetIndex };
    }

    const slides = getSlides(this.presentationId);
    if (slides.length >= MAX_NUMBER_OF_SLIDES) {
      return { saved: false, message: `Slide limit reached (${MAX_NUMBER_OF_SLIDES}).`, validation_errors: [], slide_count: slides.length };
    }
    const insertIndex = slides.length ? Math.min(targetIndex, Math.max(...slides.map((s) => s.slide_index)) + 1) : 0;
    const newContent = JSON.parse(JSON.stringify(opts.content)) as Record<string, unknown>;
    const slideForProcessing: SlideForProcessing = { content: newContent };
    await processSlideAndFetchAssets(slideForProcessing, undefined, iconWeight, true);
    const ui = this.buildSlideUi(opts.layoutId, newContent);
    const newId = uuidv4();
    saveSlideDb(this.presentationId, {
      id: newId, layout: opts.layoutId, layoutGroup: templateId,
      index: insertIndex, content: newContent, ui,
      speakerNote: extractSpeakerNote(newContent),
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

  async getSlideUiElements(index: number, includeFullJson = false): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, index);
    if (!slide) return { found: false, message: `No slide found at index ${Math.max(0, index)}.` };
    const ui = parseJson<Record<string, unknown> | null>(slide.ui, null);
    if (!ui) return { found: true, editable: false, index, slide_number: index + 1, message: "This slide has no UI layout. Use saveSlide instead." };
    const editable = collectEditableElements(ui, true);
    const response: Record<string, unknown> = {
      found: true, editable: true, index, slide_number: index + 1,
      layout_id: ui.id, description: ui.description,
      component_count: Array.isArray(ui.components) ? ui.components.length : 0,
      components: compactComponents(ui),
      editable_count: editable.length, elements: editable,
      message: `Slide ${index + 1} has ${editable.length} editable element(s).`,
    };
    if (includeFullJson) response.ui = ui;
    return response;
  }

  async updateSlideUiElement(opts: {
    index: number; elementPath: string;
    text?: string | null; items?: string[] | null;
    tableCell?: Record<string, unknown> | null; table?: Record<string, unknown> | null;
    chart?: Record<string, unknown> | null; vector?: Record<string, unknown> | null;
    infographic?: Record<string, unknown> | null; elementPatch?: Record<string, unknown> | null;
    position?: { x: number; y: number } | null; size?: { width: number; height: number } | null;
  }): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, opts.index);
    if (!slide) return { updated: false, message: `No slide found at index ${opts.index}.` };
    const ui = parseJson<Record<string, unknown> | null>(slide.ui, null);
    if (!ui) return { updated: false, message: "This slide has no editable UI layout; use saveSlide instead." };

    const uiCopy = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
    const element = resolveElementPath(uiCopy, opts.elementPath);
    const elementType = String(element.type ?? "");
    let elementUpdated = false;

    if (opts.elementPatch) {
      mergeUiPatch(element, opts.elementPatch);
      if (elementType === "chart") normalizeChartElement(element);
      applyElementStylePatch(element, opts.elementPatch);
      elementUpdated = true;
    }

    const contentUpdateRequested = contentUpdateRequestedForType(elementType, {
      text: opts.text, items: opts.items, tableCell: opts.tableCell, table: opts.table,
      chart: opts.chart, vector: opts.vector, infographic: opts.infographic,
    });

    if (contentUpdateRequested) {
      if (elementType === "text") {
        if (opts.text == null) throw new Error("text is required for text elements.");
        updateTextElement(element, opts.text);
      } else if (elementType === "text-list") {
        if (!opts.items) throw new Error("items is required for text-list elements.");
        updateTextListElement(element, opts.items);
      } else if (elementType === "table") {
        if (opts.table) updateTableElement(element, opts.table);
        else if (opts.tableCell) updateTableCellInElement(element, opts.tableCell);
        else throw new Error("table or tableCell is required for table elements.");
      } else if (elementType === "chart") {
        if (!opts.chart) throw new Error("chart is required for chart elements.");
        updateChartElement(element, opts.chart);
      } else if (elementType === "vector") {
        if (!opts.vector) throw new Error("vector is required for vector content updates.");
        updateVectorElement(element, opts.vector);
      } else if (elementType === "infographic") {
        if (!opts.infographic) throw new Error("infographic is required for infographic content updates.");
        updateInfographicElement(element, opts.infographic);
      } else if (elementType === "image") {
        const payload = resolveImageUpdatePayload(opts.text ?? null, opts.items ?? null);
        if (!payload) throw new Error("Image/icon updates require `text` with a URL.");
        if (typeof payload === "string" && !looksLikeAssetReference(payload)) {
          const generated = element.is_icon ? await this.generateIcon(payload) : await this.generateImage(payload);
          element.data = generated;
        } else {
          applyImageElementValue(element, payload);
        }
      } else {
        throw new Error(`Element type '${elementType}' is not content-editable.`);
      }
    }

    const geometryUpdated = updateElementBox(element, opts.position, opts.size);
    if (!contentUpdateRequested && !geometryUpdated && !elementUpdated) {
      throw new Error("No element content or geometry update was provided.");
    }
    validateCurrentElementModel(element);
    updateSlideUi(this.presentationId, opts.index, uiCopy);
    const componentId = componentIdForPath(uiCopy, opts.elementPath);
    return {
      updated: true, index: opts.index, slide_number: opts.index + 1,
      component_id: componentId, element_path: opts.elementPath, element_type: elementType,
      message: `Updated ${elementType} on slide ${opts.index + 1}.`,
    };
  }

  async addSlideUiElement(opts: {
    index: number; element: Record<string, unknown>;
    componentId?: string | null; insertIndex?: number | null;
  }): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, opts.index);
    if (!slide) return { added: false, message: `No slide found at index ${opts.index}.` };
    const ui = parseJson<Record<string, unknown>>(slide.ui, { components: [], elements: [] });
    const uiCopy = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;

    if (opts.componentId) {
      const comps = Array.isArray(uiCopy.components) ? uiCopy.components as unknown[] : [];
      const comp = comps.find((c): c is Record<string, unknown> =>
        !!c && typeof c === "object" && String((c as any).id) === opts.componentId
      );
      if (!comp) return { added: false, message: `Component '${opts.componentId}' not found.` };
      const elements = Array.isArray(comp.elements) ? comp.elements as unknown[] : [];
      const insertAt = opts.insertIndex ?? elements.length;
      elements.splice(Math.min(insertAt, elements.length), 0, opts.element);
      comp.elements = elements;
    } else {
      const comps = Array.isArray(uiCopy.components) ? uiCopy.components as unknown[] : [];
      const newComp = { id: `el-${uuidv4().slice(0, 8)}`, description: "", elements: [opts.element] };
      const insertAt = opts.insertIndex ?? comps.length;
      comps.splice(Math.min(insertAt, comps.length), 0, newComp);
      uiCopy.components = comps;
    }

    updateSlideUi(this.presentationId, opts.index, uiCopy);
    return { added: true, message: `Element added to slide ${opts.index + 1}.`, index: opts.index };
  }

  async addSlideUiComponent(opts: {
    index: number; component: Record<string, unknown>; insertIndex?: number | null;
  }): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, opts.index);
    if (!slide) return { added: false, message: `No slide found at index ${opts.index}.` };
    const ui = parseJson<Record<string, unknown>>(slide.ui, { components: [], elements: [] });
    const uiCopy = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
    const comps = Array.isArray(uiCopy.components) ? uiCopy.components as unknown[] : [];
    if (!opts.component.id) opts.component.id = `comp-${uuidv4().slice(0, 8)}`;
    const insertAt = opts.insertIndex ?? comps.length;
    comps.splice(Math.min(insertAt, comps.length), 0, opts.component);
    uiCopy.components = comps;
    updateSlideUi(this.presentationId, opts.index, uiCopy);
    const cid = String(opts.component.id);
    return { added: true, message: `Component added to slide ${opts.index + 1}.`, component_id: cid, index: opts.index };
  }

  async updateSlideUiComponent(opts: {
    index: number; componentId: string; action?: string | null;
    componentIds?: string[] | null; position?: { x: number; y: number } | null;
    size?: { width: number; height: number } | null; replacementComponent?: Record<string, unknown> | null;
  }): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, opts.index);
    if (!slide) return { updated: false, message: `No slide found at index ${opts.index}.` };
    const ui = parseJson<Record<string, unknown> | null>(slide.ui, null);
    if (!ui) return { updated: false, message: "No UI layout on this slide." };
    const uiCopy = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
    const comps = Array.isArray(uiCopy.components) ? uiCopy.components as unknown[] : [];
    const compIndex = comps.findIndex((c): c is Record<string, unknown> =>
      !!c && typeof c === "object" && String((c as any).id) === opts.componentId
    );
    if (compIndex < 0) return { updated: false, message: `Component '${opts.componentId}' not found.` };

    const action = opts.action ?? "update";
    if (action === "delete" || action === "remove") {
      comps.splice(compIndex, 1);
    } else if (action === "duplicate") {
      const copy = JSON.parse(JSON.stringify(comps[compIndex])) as Record<string, unknown>;
      copy.id = `${String(copy.id ?? "comp")}-copy-${uuidv4().slice(0, 6)}`;
      comps.splice(compIndex + 1, 0, copy);
    } else if (action === "bring-to-front" || action === "bringToFront") {
      const [c] = comps.splice(compIndex, 1);
      comps.push(c);
    } else if (action === "send-to-back" || action === "sendToBack") {
      const [c] = comps.splice(compIndex, 1);
      comps.unshift(c);
    } else if (opts.replacementComponent) {
      comps[compIndex] = opts.replacementComponent;
    } else if (opts.position || opts.size) {
      const comp = comps[compIndex] as Record<string, unknown>;
      if (opts.position) comp.position = opts.position;
      if (opts.size) comp.size = opts.size;
    }
    uiCopy.components = comps;
    updateSlideUi(this.presentationId, opts.index, uiCopy);
    return { updated: true, message: `Component '${opts.componentId}' updated on slide ${opts.index + 1}.`, index: opts.index };
  }

  async deleteSlideUiComponent(index: number, componentId: string): Promise<Record<string, unknown>> {
    return this.updateSlideUiComponent({ index, componentId, action: "delete" });
  }

  async deleteSlideUiElement(index: number, elementPath: string): Promise<Record<string, unknown>> {
    const slide = getSlideByIndex(this.presentationId, index);
    if (!slide) return { deleted: false, message: `No slide found at index ${index}.` };
    const ui = parseJson<Record<string, unknown> | null>(slide.ui, null);
    if (!ui) return { deleted: false, message: "No UI layout on this slide." };
    const uiCopy = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
    // Remove element at path from its parent array
    const segments = elementPath.split(".");
    if (!segments.length) return { deleted: false, message: "Invalid element path." };
    const lastSeg = segments[segments.length - 1];
    const match = /^(?<key>components|elements|children)\[(?<idx>\d+)\]$/.exec(lastSeg);
    if (!match?.groups) return { deleted: false, message: "Can only delete indexed elements." };
    const parentPath = segments.slice(0, -1).join(".");
    let parent: unknown = uiCopy;
    if (parentPath) {
      try { parent = resolveElementPath(uiCopy, parentPath); } catch { return { deleted: false, message: "Invalid element path." }; }
    }
    const key = match.groups.key;
    const idx = parseInt(match.groups.idx, 10);
    const arr = (parent as Record<string, unknown>)[key];
    if (!Array.isArray(arr) || idx >= arr.length) return { deleted: false, message: "Element not found at path." };
    arr.splice(idx, 1);
    updateSlideUi(this.presentationId, index, uiCopy);
    return { deleted: true, message: `Element deleted from slide ${index + 1}.`, element_path: elementPath };
  }

  async getPresentationThemeCatalog(): Promise<Record<string, unknown>> {
    const presentation = getPresentation(this.presentationId);
    if (!presentation) return { themes: CHAT_BUILTIN_THEMES, custom_themes: [] };
    const kvRow = getDb().prepare("SELECT value FROM key_value WHERE key = ? AND presentation_id = ?").get(THEMES_STORAGE_KEY, this.presentationId) as any;
    const customThemes = kvRow ? parseJson<unknown[]>(kvRow.value, []) : [];
    return { themes: CHAT_BUILTIN_THEMES, custom_themes: customThemes };
  }

  async setPresentationTheme(opts: {
    themeQuery?: string | null;
    customTheme?: Record<string, unknown> | null;
    saveCustomTheme?: boolean;
  }): Promise<Record<string, unknown>> {
    const { themeQuery, customTheme, saveCustomTheme = true } = opts;

    let resolvedTheme: Record<string, unknown> | null = null;
    if (customTheme) {
      resolvedTheme = customTheme;
    } else if (themeQuery) {
      const catalog = await this.getPresentationThemeCatalog();
      const all = [...(catalog.themes as unknown[]), ...(catalog.custom_themes as unknown[])];
      const q = themeQuery.toLowerCase();
      resolvedTheme = (all.find((t) => {
        if (!t || typeof t !== "object") return false;
        const id = String((t as any).id ?? "").toLowerCase();
        const name = String((t as any).name ?? "").toLowerCase();
        return id.includes(q) || name.includes(q);
      }) as Record<string, unknown>) ?? null;
    }

    if (!resolvedTheme) return { applied: false, message: `Theme '${themeQuery}' not found.` };

    // Save theme reference in presentation
    const db = getDb();
    db.prepare("UPDATE presentations SET theme_id = ? WHERE id = ?").run(String(resolvedTheme.id ?? ""), this.presentationId);

    if (customTheme && saveCustomTheme) {
      ensureKeyValueTable(db);
      const existing = db.prepare("SELECT value FROM key_value WHERE key = ? AND presentation_id = ?").get(THEMES_STORAGE_KEY, this.presentationId) as any;
      const themes = existing ? parseJson<unknown[]>(existing.value, []) : [];
      const idx = (themes as unknown[]).findIndex((t): t is Record<string, unknown> => !!t && typeof t === "object" && (t as any).id === resolvedTheme!.id);
      if (idx >= 0) themes[idx] = resolvedTheme;
      else themes.push(resolvedTheme);
      if (existing) {
        db.prepare("UPDATE key_value SET value = ? WHERE key = ? AND presentation_id = ?").run(JSON.stringify(themes), THEMES_STORAGE_KEY, this.presentationId);
      } else {
        db.prepare("INSERT INTO key_value (key, presentation_id, value) VALUES (?,?,?)").run(THEMES_STORAGE_KEY, this.presentationId, JSON.stringify(themes));
      }
    }

    return { applied: true, message: `Theme '${resolvedTheme.name ?? resolvedTheme.id}' applied.`, theme_id: resolvedTheme.id };
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
    return { message: "Smart presentation mode not fully implemented.", slides: [] };
  }

  async retrieveContext(query: string): Promise<string> {
    return PRESENTATION_MEMORY_SERVICE.retrieveContext(this.presentationId, query);
  }
}

function ensureKeyValueTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_value (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      presentation_id TEXT NOT NULL,
      value TEXT,
      UNIQUE(key, presentation_id)
    )
  `);
}
