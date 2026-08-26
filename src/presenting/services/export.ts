/**
 * Presentation export: persisted slides -> .pptx file.
 *
 * The actual export orchestration lives in native-pptx-export.ts — this
 * file just loads the presentation from the DB and hands its slides' HTML
 * over. Every slide is a Smart-mode HTML fragment; native-pptx-export.ts
 * wraps the whole deck in Presenton's own real export-page DOM structure
 * and hands it to their own `@presenton/export-core` package's
 * `html-to-any` task — their real conversion pipeline, not a
 * reimplementation of it.
 */

import { ExportRuntimeError, resolveExportRuntime } from "./export-runtime.js";
import { exportPresentationNatively } from "./native-pptx-export.js";

export { ExportRuntimeError };

export class PresentationNotFoundForExportError extends Error {
  constructor(msg: string) { super(msg); this.name = "PresentationNotFoundForExportError"; }
}

export async function exportPresentationToPptx(opts: {
  presentationId: string;
  outputPath: string;
}): Promise<string> {
  const { getDb } = await import("../db/index.js");
  const db = getDb();
  const presentation = db.prepare("SELECT * FROM presentations WHERE id = ?").get(opts.presentationId) as any;
  if (!presentation) throw new PresentationNotFoundForExportError(`Presentation ${opts.presentationId} not found`);

  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(opts.presentationId) as any[];
  if (!slides.length) throw new PresentationNotFoundForExportError(`Presentation ${opts.presentationId} has no slides`);

  const runtime = resolveExportRuntime();

  const exportSlides = slides.map((slide) => {
    if (!slide.html_content) throw new PresentationNotFoundForExportError(`Slide at index ${slide.slide_index} has no HTML to export`);
    return { htmlContent: String(slide.html_content) };
  });

  await exportPresentationNatively({
    title: String(presentation.title ?? ""),
    slides: exportSlides,
    runtime,
    outputPath: opts.outputPath,
  });
  return opts.outputPath;
}
