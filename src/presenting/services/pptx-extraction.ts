/**
 * Phase A of Imported Template import: deterministic (no model call)
 * extraction of a raw per-slide element tree and rendered slide images from
 * a user-uploaded .pptx, via the vendored presentation-export runtime's
 * "pptx-to-json" and "pptx-to-html"+"html-to-images" task types.
 *
 * Response shapes below are all empirically confirmed (see export-runtime.ts
 * for how), not assumed from source-reading alone:
 *   - pptx-to-json  -> { url: "file://.../presentation.json" } containing
 *     { layouts: RawSlideLayout[] }
 *   - pptx-to-html  -> { url: "file://.../presentation.json" } containing
 *     { slides: string[] (one HTML doc per slide), width, height, ... }
 *   - html-to-images -> { file_paths: string[] } (one PNG per input HTML)
 */
import { readFileSync } from "node:fs";
import {
	createExportTempDir,
	cleanupExportTempDir,
	resolveExportRuntime,
	runExportTask,
	readFileUrlJson,
	ExportRuntimeError,
} from "./export-runtime.js";

export interface RawSlideElement {
	type: string;
	position: { x: number; y: number };
	size: { width: number; height: number };
	decorative?: boolean;
	[key: string]: unknown;
}

export interface RawSlideLayout {
	id: string;
	description: string;
	elements: RawSlideElement[];
}

export interface RawSlideLayouts {
	layouts: RawSlideLayout[];
}

const PPTX_EXTRACTION_TIMEOUT_MS = 180_000;
const SLIDE_RENDER_WIDTH_PX = 1280;
const SLIDE_RENDER_HEIGHT_PX = 720;

export async function extractRawSlideLayouts(pptxPath: string): Promise<RawSlideLayouts> {
	const runtime = resolveExportRuntime();
	const tempDir = createExportTempDir("pptx-to-json-");
	try {
		const response = await runExportTask(
			{ type: "pptx-to-json", pptx_path: pptxPath },
			runtime,
			tempDir,
			{ timeoutMs: PPTX_EXTRACTION_TIMEOUT_MS, requiresPythonConvert: true, requiresChromium: false },
		);
		const url = String(response.url ?? "");
		if (!url) throw new ExportRuntimeError("pptx-to-json did not return a result url");
		return readFileUrlJson(url) as RawSlideLayouts;
	} finally {
		cleanupExportTempDir(tempDir);
	}
}

async function renderPptxToSlideHtmls(pptxPath: string, runtime: ReturnType<typeof resolveExportRuntime>, tempDir: string): Promise<string[]> {
	const response = await runExportTask(
		{ type: "pptx-to-html", pptx_path: pptxPath, get_fonts: false },
		runtime,
		tempDir,
		{ timeoutMs: PPTX_EXTRACTION_TIMEOUT_MS, requiresPythonConvert: true, requiresChromium: false },
	);
	const url = String(response.url ?? "");
	if (!url) throw new ExportRuntimeError("pptx-to-html did not return a result url");
	const parsed = readFileUrlJson(url) as { slides?: unknown };
	if (!Array.isArray(parsed.slides)) throw new ExportRuntimeError("pptx-to-html result had no slides array");
	return parsed.slides as string[];
}

/** Render each slide of a .pptx to a PNG buffer, one per slide, in slide order. */
export async function renderSlideImages(pptxPath: string): Promise<Buffer[]> {
	const runtime = resolveExportRuntime();
	const tempDir = createExportTempDir("pptx-render-");
	try {
		const htmls = await renderPptxToSlideHtmls(pptxPath, runtime, tempDir);

		try {
			const response = await runExportTask(
				{ type: "html-to-images", htmls, width: SLIDE_RENDER_WIDTH_PX, height: SLIDE_RENDER_HEIGHT_PX },
				runtime,
				tempDir,
				{ timeoutMs: PPTX_EXTRACTION_TIMEOUT_MS, requiresPythonConvert: false, requiresChromium: true },
			);
			const filePaths = response.file_paths;
			if (!Array.isArray(filePaths) || filePaths.length !== htmls.length) {
				throw new ExportRuntimeError("html-to-images did not return one image per slide");
			}
			return (filePaths as string[]).map((p) => readFileSync(p));
		} catch {
			// Defensive fallback: some runtime builds may not support the
			// batch "html-to-images" task. Render one "html-to-image" call
			// per slide instead (matches presenton's own export_task_service.py
			// fallback behavior for the same reason).
			const images: Buffer[] = [];
			for (const html of htmls) {
				const response = await runExportTask(
					{ type: "html-to-image", html, width: SLIDE_RENDER_WIDTH_PX, height: SLIDE_RENDER_HEIGHT_PX },
					runtime,
					tempDir,
					{ timeoutMs: PPTX_EXTRACTION_TIMEOUT_MS, requiresPythonConvert: false, requiresChromium: true },
				);
				const filePath = String(response.file_path ?? "");
				if (!filePath) throw new ExportRuntimeError("html-to-image did not return a file_path");
				images.push(readFileSync(filePath));
			}
			return images;
		}
	} finally {
		cleanupExportTempDir(tempDir);
	}
}
