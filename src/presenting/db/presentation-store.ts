/**
 * Save presentations to in-memory SQLite (Smart mode only).
 */
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index.js";

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
