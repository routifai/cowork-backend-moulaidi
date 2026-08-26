/**
 * Save/load presentations from in-memory SQLite.
 * Port of presenting/engine/services/presentation_store.py
 */
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index.js";
import { extractIconTypeFromSettings } from "../utils/icon-weights.js";

function buildLayoutPayload(templateName: string, templateData: Record<string, unknown>): Record<string, unknown> {
  const payload = JSON.parse(JSON.stringify(templateData)) as Record<string, unknown>;
  const iconType = extractIconTypeFromSettings(payload);
  payload.icon_type = iconType;
  payload.icon_weight = iconType;
  payload.name = templateName;
  payload.template_id = templateName;
  return payload;
}

export interface SavedPresentation {
  id: string;
  title?: string;
  template: string;
  language?: string;
  slides: Array<{
    id: string;
    layout: string;
    content: Record<string, unknown>;
    ui?: unknown;
    speaker_note?: string;
  }>;
}

export function saveGeneratedPresentation(
  generated: Record<string, unknown>,
  getTemplate: (name: string) => Record<string, unknown> | null,
): string {
  const db = getDb();
  const id = uuidv4();
  const template = String(generated.template ?? "");
  const templateData = getTemplate(template);
  if (!templateData) throw new Error(`Template '${template}' not found`);
  const layoutPayload = buildLayoutPayload(template, templateData);

  const slides = Array.isArray(generated.slides) ? generated.slides : [];

  const insertPresentation = db.prepare(`
    INSERT INTO presentations (id, version, content, n_slides, language, title, layout, generation_mode)
    VALUES (?, 'v2-standard', '', ?, ?, ?, ?, 'standard')
  `);

  const insertSlide = db.prepare(`
    INSERT INTO slides (id, presentation_id, layout_group, layout, slide_index, content, speaker_note, ui)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertPresentation.run(id, slides.length, generated.language ?? null, generated.title ?? null, JSON.stringify(layoutPayload));
    for (let index = 0; index < slides.length; index++) {
      const slide = slides[index] as Record<string, unknown>;
      const content = typeof slide.content === "object" && slide.content !== null ? { ...(slide.content as Record<string, unknown>) } : {};
      const speakerNote = (content.__speaker_note__ as string | undefined) ?? null;
      delete content.__speaker_note__;
      insertSlide.run(
        uuidv4(),
        id,
        template,
        String(slide.layout ?? ""),
        index,
        JSON.stringify(content),
        speakerNote,
        slide.ui != null ? JSON.stringify(slide.ui) : null,
      );
    }
  });
  tx();
  return id;
}

/** Save a Smart-mode presentation: slides are complete HTML fragments (slide.html_content), no template/ui JSON tree. */
export function saveGeneratedSmartPresentation(generated: {
  title: string;
  slides: Array<{ title: string; html: string; speaker_note: string; slide_type: string }>;
}): string {
  const db = getDb();
  const id = uuidv4();

  const insertPresentation = db.prepare(`
    INSERT INTO presentations (id, version, content, n_slides, title, generation_mode)
    VALUES (?, 'v2-smart', '', ?, ?, 'smart')
  `);
  const insertSlide = db.prepare(`
    INSERT INTO slides (id, presentation_id, layout_group, layout, slide_index, html_content, speaker_note)
    VALUES (?, ?, 'smart', ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertPresentation.run(id, generated.slides.length, generated.title);
    generated.slides.forEach((slide, index) => {
      insertSlide.run(uuidv4(), id, slide.slide_type, index, slide.html, slide.speaker_note || null);
    });
  });
  tx();
  return id;
}

export function loadPresentation(presentationId: string): SavedPresentation | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM presentations WHERE id = ?").get(presentationId) as any;
  if (!row) return null;
  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(presentationId) as any[];
  return {
    id: row.id,
    title: row.title ?? undefined,
    template: (() => { try { return (JSON.parse(row.layout) as any)?.template_id ?? ""; } catch { return ""; } })(),
    language: row.language ?? undefined,
    slides: slides.map((s) => ({
      id: s.id,
      layout: s.layout ?? "",
      content: s.content ? JSON.parse(s.content) : {},
      ui: s.ui ? JSON.parse(s.ui) : undefined,
      speaker_note: s.speaker_note ?? undefined,
    })),
  };
}
