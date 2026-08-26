/**
 * Orchestrates the fully-editable (native, non-raster) pptx export.
 *
 * Per slide: render its `ui` tree as real HTML (dom-slide-renderer.ts), load
 * it in the vendored Chromium binary via puppeteer-core and read back exact
 * element geometry (dom-layout-resolver.ts) so text wrap points, flex/grid
 * positions etc. match a real layout engine instead of a JS approximation.
 * Map those leaves to pptx-from-json shapes (slide-to-pptx-shapes.ts).
 *
 * Any slide containing something the native path doesn't support yet
 * (charts, tables, non-rect/stroked/rotated vectors, filled containers,
 * svg, infographic, or an image whose source couldn't be resolved to a
 * local file) falls back to the existing raster path for that slide only —
 * one full-bleed "picture" shape holding the same PNG the old raster-only
 * exporter would have produced. The whole deck is still assembled as a
 * single pptx-from-json call, so native and raster-fallback slides sit
 * side by side in one real, python-pptx-built file — no more hand-rolled
 * OOXML ZIP writer (assemble-pptx.ts stays in the tree as unused fallback
 * reference, but nothing calls it anymore).
 */
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import { renderSlideUiToHtml, STAGE_WIDTH, STAGE_HEIGHT } from "./dom-slide-renderer.js";
import { launchLayoutBrowser, readLeafGeometry } from "./dom-layout-resolver.js";
import { leavesToPptxShapes, createShapeTempDir } from "./slide-to-pptx-shapes.js";
import { renderSlideToImage } from "./export.js";
import { renderSmartSlideToImage } from "./smart-slide-render.js";
import { ExportRuntimeError, runExportTask, type ExportRuntimeHandle } from "./export-runtime.js";
import { runWithConcurrency } from "../utils/concurrency.js";

const NATIVE_EXPORT_TIMEOUT_MS = 180_000;
const LAYOUT_READBACK_CONCURRENCY = 6;

function fileUrlToPath(url: string): string {
	return url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url;
}

/**
 * Resolve one slide's native shapes using the (already open) layout
 * browser. Returns null when the slide needs the raster fallback instead
 * (unsupported content, or an image leaf whose source didn't resolve) —
 * the caller renders that fallback in a second pass, after the browser is
 * closed (see exportPresentationNatively: running the vendored runtime's
 * OWN separate Chromium instance for json-to-image while this puppeteer
 * browser is still open causes the two Chromium processes to contend and
 * hang, confirmed by isolating each step during a real smoke test).
 */
async function resolveNativeShapes(
	ui: unknown,
	browser: Awaited<ReturnType<typeof launchLayoutBrowser>>,
	shapeTempDir: string,
): Promise<Record<string, unknown>[] | null> {
	const uiRecord = ui && typeof ui === "object" && !Array.isArray(ui) ? (ui as Record<string, unknown>) : null;
	if (!uiRecord) return null;

	const rendered = renderSlideUiToHtml(uiRecord);
	if (rendered.hasUnsupportedContent) return null;

	const boxes = await readLeafGeometry(browser, rendered.html, STAGE_WIDTH, STAGE_HEIGHT);
	const { shapes, failed } = leavesToPptxShapes(rendered.leaves, boxes, shapeTempDir);
	return failed ? null : shapes;
}

function pictureShape(imagePath: string): Record<string, unknown> {
	return {
		shape_type: "picture",
		position: { left: 0, top: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
		picture: { path: imagePath, is_network: false },
	};
}

async function renderFallbackShapes(ui: unknown, runtime: ExportRuntimeHandle, imageTempDir: string): Promise<Record<string, unknown>[]> {
	const imagePath = await renderSlideToImage(ui, runtime, imageTempDir);
	return [pictureShape(imagePath)];
}

export async function exportPresentationNatively(opts: {
	title: string;
	slides: Array<{ ui: unknown; htmlContent: string | null }>;
	runtime: ExportRuntimeHandle;
	outputPath: string;
}): Promise<void> {
	if (!opts.runtime.chromiumPath || !existsSync(opts.runtime.chromiumPath)) {
		throw new ExportRuntimeError(`Chromium not found at ${opts.runtime.chromiumPath}. Set PRESENTING_CHROMIUM_PATH.`);
	}

	const imageTempDir = mkdtempSync(join(tmpdir(), "pres-export-native-"));
	const shapeTempDir = createShapeTempDir();

	try {
		// Pass 1: resolve every slide's shapes with one shared browser instance —
		// Smart slides (arbitrary HTML) always raster via smart-slide-render.ts
		// (no native shape mapping for arbitrary markup yet, see this file's
		// header); TemplateV2 slides get real shapes where possible, `null`
		// marking one that needs the OTHER runtime's raster fallback instead.
		const browser = await launchLayoutBrowser(opts.runtime.chromiumPath);
		let passOneResults: Array<Record<string, unknown>[] | null>;
		try {
			passOneResults = await runWithConcurrency(opts.slides, LAYOUT_READBACK_CONCURRENCY, async (slide) => {
				if (slide.htmlContent != null) {
					const imagePath = await renderSmartSlideToImage(browser, slide.htmlContent, STAGE_WIDTH, STAGE_HEIGHT);
					return [pictureShape(imagePath)];
				}
				return resolveNativeShapes(slide.ui, browser, shapeTempDir);
			});
		} finally {
			await browser.close();
		}

		// Pass 2: render the raster fallback for whatever's left, now that the
		// layout browser is closed (see resolveNativeShapes's doc comment).
		const slidesPayload: Array<{ shapes: Record<string, unknown>[] }> = [];
		for (let i = 0; i < opts.slides.length; i++) {
			const shapes = passOneResults[i] ?? (await renderFallbackShapes(opts.slides[i].ui, opts.runtime, imageTempDir));
			slidesPayload.push({ shapes });
		}

		const taskTempDir = mkdtempSync(join(tmpdir(), "pres-export-task-"));
		try {
			const response = await runExportTask(
				{
					type: "pptx-from-json",
					session_id: uuidv4(),
					url: "",
					data: { name: opts.title, slides: slidesPayload },
				},
				opts.runtime,
				taskTempDir,
				{ timeoutMs: NATIVE_EXPORT_TIMEOUT_MS, requiresPythonConvert: true, requiresChromium: false },
			);
			const url = String(response.url ?? "");
			if (!url) throw new ExportRuntimeError("pptx-from-json did not return a result url");
			const resultPath = fileUrlToPath(url);
			if (!existsSync(resultPath)) throw new ExportRuntimeError(`pptx-from-json result file not found: ${resultPath}`);
			copyFileSync(resultPath, opts.outputPath);
		} finally {
			try {
				rmSync(taskTempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	} finally {
		try {
			rmSync(imageTempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		try {
			rmSync(shapeTempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
