/**
 * Presentation export: persisted slides -> .pptx file.
 * Port of presenting/engine/services/export.py + export_runtime_service.py.
 *
 * Renders each slide to a PNG via the vendored presentation-export runtime
 * (Chromium/Puppeteer), then packs those images into a .pptx in-process
 * (one full-bleed picture per slide — same shape as the old python-pptx
 * assembler, no Python).
 *
 * This is a visually faithful export — text is embedded in images, not
 * natively selectable in PowerPoint. Editing happens in Hypatia before export.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assemblePptxFromImages } from "./assemble-pptx.js";
import {
  ExportRuntimeError,
  resolveExportRuntime,
  runExportTask,
  type ExportRuntimeHandle,
} from "./export-runtime.js";

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

async function renderSlideToImage(slideUi: unknown, runtime: ExportRuntimeHandle, tempDir: string): Promise<string> {
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

function assemblePptx(imagePaths: string[], outputPath: string, title: string): void {
  try {
    assemblePptxFromImages(imagePaths, outputPath, title);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExportRuntimeError(`PPTX assembly failed: ${message.slice(0, 400)}`);
  }
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

  const tempDir = mkdtempSync(join(tmpdir(), "pres-export-"));
  try {
    const imagePaths: string[] = [];
    for (const slide of slides) {
      const ui = slide.ui ? JSON.parse(slide.ui) as unknown : null;
      if (!ui) throw new PresentationNotFoundForExportError(`Slide at index ${slide.slide_index} has no rendered UI to export`);
      const imagePath = await renderSlideToImage(ui, runtime, tempDir);
      imagePaths.push(imagePath);
    }
    assemblePptx(imagePaths, opts.outputPath, String(presentation.title ?? ""));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return opts.outputPath;
}
