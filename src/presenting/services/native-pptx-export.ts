/**
 * Orchestrates pptx export for Smart-mode decks. There's no custom
 * DOM-extraction/shape-mapping in this codebase anymore — every slide's
 * raw HTML is wrapped in Presenton's own real export-page DOM structure
 * (`wrapSmartDeckHtml()`, ported from their open-source `PdfMakerPage.tsx`)
 * and handed to their own `@presenton/export-core` package's `html-to-any`
 * task in one call for the whole deck. That package's real DOM→pptx
 * conversion (the same one their own product uses) decides what's
 * natively representable vs. rasterized, per element — not a
 * reimplementation of that decision on our side.
 *
 * An earlier version of this file (and smart-dom-extractor.ts,
 * smart-shape-mapper.ts, both deleted) walked the rendered DOM itself and
 * mapped leaves to `pptx-from-json` shapes directly. That produced worse,
 * more conservative results (whole-slide raster fallback on any gradient
 * background, for one) than just using Presenton's own real pipeline
 * directly — see SMART_MODE_ARCHITECTURE.md for the comparison.
 */
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapSmartDeckHtml } from "./smart-slide-render.js";
import { ExportRuntimeError, runHtmlToAnyPptxTask, type ExportRuntimeHandle } from "./export-runtime.js";

const NATIVE_EXPORT_TIMEOUT_MS = 300_000;

export async function exportPresentationNatively(opts: {
	title: string;
	slides: Array<{ htmlContent: string }>;
	runtime: ExportRuntimeHandle;
	outputPath: string;
}): Promise<void> {
	if (!opts.runtime.chromiumPath || !existsSync(opts.runtime.chromiumPath)) {
		throw new ExportRuntimeError(`Chromium not found at ${opts.runtime.chromiumPath}. Set PRESENTING_CHROMIUM_PATH.`);
	}

	const html = wrapSmartDeckHtml(opts.slides.map((s) => s.htmlContent));
	const taskTempDir = mkdtempSync(join(tmpdir(), "pres-export-task-"));
	try {
		const resultPath = await runHtmlToAnyPptxTask(html, opts.title, opts.runtime, taskTempDir, { timeoutMs: NATIVE_EXPORT_TIMEOUT_MS });
		copyFileSync(resultPath, opts.outputPath);
	} finally {
		try {
			rmSync(taskTempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
