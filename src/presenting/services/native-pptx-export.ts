/**
 * Orchestrates pptx export for Smart-mode decks: every slide is arbitrary
 * LLM-written HTML with no semantic tagging of text/decoration/chart, so
 * there's no native (editable-shapes) mapping yet — each slide renders to
 * one full-bleed raster picture via smart-slide-render.ts, and the whole
 * deck is assembled as a single pptx-from-json call (one real,
 * python-pptx-built file, not a hand-rolled OOXML writer).
 */
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderSmartSlideToImage } from "./smart-slide-render.js";
import { ExportRuntimeError, runExportTask, type ExportRuntimeHandle } from "./export-runtime.js";
import { runWithConcurrency } from "../utils/concurrency.js";

const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;
const NATIVE_EXPORT_TIMEOUT_MS = 180_000;

async function launchLayoutBrowser(chromiumPath: string): Promise<Browser> {
	return puppeteer.launch({
		executablePath: chromiumPath,
		headless: true,
		args: ["--no-sandbox", "--force-device-scale-factor=1", "--disable-gpu"],
	});
}
const RENDER_CONCURRENCY = 6;

function fileUrlToPath(url: string): string {
	return url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url;
}

function pictureShape(imagePath: string): Record<string, unknown> {
	return {
		shape_type: "picture",
		position: { left: 0, top: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
		picture: { path: imagePath, is_network: false },
	};
}

export async function exportPresentationNatively(opts: {
	title: string;
	slides: Array<{ htmlContent: string }>;
	runtime: ExportRuntimeHandle;
	outputPath: string;
}): Promise<void> {
	if (!opts.runtime.chromiumPath || !existsSync(opts.runtime.chromiumPath)) {
		throw new ExportRuntimeError(`Chromium not found at ${opts.runtime.chromiumPath}. Set PRESENTING_CHROMIUM_PATH.`);
	}

	const browser = await launchLayoutBrowser(opts.runtime.chromiumPath);
	let slidesPayload: Array<{ shapes: Record<string, unknown>[] }>;
	try {
		const imagePaths = await runWithConcurrency(opts.slides, RENDER_CONCURRENCY, (slide) =>
			renderSmartSlideToImage(browser, slide.htmlContent, STAGE_WIDTH, STAGE_HEIGHT),
		);
		slidesPayload = imagePaths.map((imagePath) => ({ shapes: [pictureShape(imagePath)] }));
	} finally {
		await browser.close();
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
}
