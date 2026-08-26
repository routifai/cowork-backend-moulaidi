/**
 * Presentation export: persisted slides -> .pptx file.
 * Port of presenting/engine/services/export.py + export_runtime_service.py.
 *
 * The actual native/raster orchestration lives in native-pptx-export.ts —
 * this file loads the presentation from the DB and hands its slides over.
 * `renderSlideToImage` (below) is the one piece native-pptx-export.ts
 * reuses directly: rendering a slide's `ui` JSON to a full-bleed PNG via the
 * vendored runtime's Chromium, used as the per-slide fallback whenever a
 * slide has content the native (real, editable-shapes) path doesn't support
 * yet — see dom-slide-renderer.ts's header for exactly what that excludes.
 */

import { existsSync, readFileSync } from "fs";
import {
  ExportRuntimeError,
  resolveExportRuntime,
  runExportTask,
  type ExportRuntimeHandle,
} from "./export-runtime.js";
import { exportPresentationNatively } from "./native-pptx-export.js";

const SLIDE_WIDTH_PX = 1280;
const SLIDE_HEIGHT_PX = 720;
const EXPORT_TIMEOUT_MS = 120_000;

export { ExportRuntimeError };

export class PresentationNotFoundForExportError extends Error {
  constructor(msg: string) { super(msg); this.name = "PresentationNotFoundForExportError"; }
}

function localizeImageDataUris(value: unknown, cache: Map<string, string> = new Map()): unknown {
  if (Array.isArray(value)) return value.map((item) => localizeImageDataUris(item, cache));
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const localized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) localized[k] = localizeImageDataUris(v, cache);
  if (localized.type !== "image") return localized;
  const source = localized.data;
  if (typeof source !== "string" || !source) return localized;
  if (/^(https?:|data:|blob:)/i.test(source)) return localized;
  const path = source.startsWith("file://") ? decodeURIComponent(source.slice(7)) : source;
  if (!existsSync(path)) return localized;
  let dataUri = cache.get(path);
  if (!dataUri) {
    try {
      const data = readFileSync(path);
      const mime = guessMimeType(path);
      dataUri = `data:${mime};base64,${data.toString("base64")}`;
      cache.set(path, dataUri);
    } catch { return localized; }
  }
  localized.data = dataUri;
  return localized;
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
  return map[ext] ?? "application/octet-stream";
}

export async function renderSlideToImage(slideUi: unknown, runtime: ExportRuntimeHandle, tempDir: string): Promise<string> {
  const taskPayload = {
    type: "json-to-image",
    layout: localizeImageDataUris(slideUi),
    width: SLIDE_WIDTH_PX,
    height: SLIDE_HEIGHT_PX,
  };

  const response = await runExportTask(taskPayload, runtime, tempDir, { timeoutMs: EXPORT_TIMEOUT_MS });
  const imagePath = String(response.file_path ?? response.imagePath ?? response.image_path ?? "");
  if (!imagePath || !existsSync(imagePath)) throw new ExportRuntimeError("Export runtime did not produce an image file.");
  return imagePath;
}

export async function exportPresentationToPptx(opts: {
  presentationId: string;
  outputPath: string;
}): Promise<string> {
  // Load presentation from DB
  const { getDb } = await import("../db/index.js");
  const db = getDb();
  const presentation = db.prepare("SELECT * FROM presentations WHERE id = ?").get(opts.presentationId) as any;
  if (!presentation) throw new PresentationNotFoundForExportError(`Presentation ${opts.presentationId} not found`);

  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index ASC").all(opts.presentationId) as any[];
  if (!slides.length) throw new PresentationNotFoundForExportError(`Presentation ${opts.presentationId} has no slides`);

  const runtime = resolveExportRuntime();

  const exportSlides = slides.map((slide) => {
    if (presentation.generation_mode === "smart") {
      if (!slide.html_content) throw new PresentationNotFoundForExportError(`Smart slide at index ${slide.slide_index} has no HTML to export`);
      return { ui: null, htmlContent: String(slide.html_content) };
    }
    const ui = slide.ui ? (JSON.parse(slide.ui) as unknown) : null;
    if (!ui) throw new PresentationNotFoundForExportError(`Slide at index ${slide.slide_index} has no rendered UI to export`);
    return { ui, htmlContent: null };
  });

  await exportPresentationNatively({
    title: String(presentation.title ?? ""),
    slides: exportSlides,
    runtime,
    outputPath: opts.outputPath,
  });
  return opts.outputPath;
}
