/**
 * Drives the vendored runtime's own Chromium binary directly via
 * puppeteer-core (NOT through the vendored index.js task protocol — that
 * proprietary runtime only exposes fixed task types like "html-to-image"
 * that return a screenshot, never computed DOM geometry). This is the piece
 * that makes native export pixel-perfect: load the HTML dom-slide-renderer.ts
 * produced, let the real browser's layout engine (flexbox, grid, text
 * wrapping/kerning) run, then read back each marked element's
 * getBoundingClientRect(). Those exact numbers — not a JS approximation of
 * CSS layout — become the shape positions/sizes handed to pptx-from-json.
 *
 * Confirmed working against the same vendored Chromium binary
 * discoverChromiumPath() finds (chromium-cache/.../Chromium): real flexbox
 * wrapping + exact rect readback, verified with a throwaway POC before
 * wiring this in.
 */
import puppeteer, { type Browser } from "puppeteer-core";

export interface LeafBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export async function launchLayoutBrowser(chromiumPath: string): Promise<Browser> {
	return puppeteer.launch({
		executablePath: chromiumPath,
		headless: true,
		args: ["--no-sandbox", "--force-device-scale-factor=1", "--disable-gpu"],
	});
}

/** Load one slide's HTML and read back the bounding box of every `data-leaf="<id>"` element, keyed by id. */
export async function readLeafGeometry(
	browser: Browser,
	html: string,
	width: number,
	height: number,
): Promise<Record<string, LeafBox>> {
	const page = await browser.newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: 1 });
		await page.setContent(html, { waitUntil: "load" });
		return await page.evaluate(() => {
			const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
			for (const el of Array.from(document.querySelectorAll("[data-leaf]"))) {
				const id = el.getAttribute("data-leaf");
				if (!id) continue;
				const rect = el.getBoundingClientRect();
				out[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			}
			return out;
		});
	} finally {
		await page.close();
	}
}
