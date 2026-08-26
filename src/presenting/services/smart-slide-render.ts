/**
 * Renders a Smart-mode slide (a raw `<section>` HTML/Tailwind/Chart.js
 * fragment, stored verbatim in slide.html_content) to a PNG for export.
 *
 * Smart slides are arbitrary LLM-authored markup — there's no constrained
 * schema to walk the way dom-slide-renderer.ts does for TemplateV2 `ui`
 * trees, so there's no native (editable-shapes) export path for them yet;
 * every Smart slide exports as one full-bleed raster picture, same as the
 * "unsupported content" fallback tier for TemplateV2 slides. A native path
 * would need per-element semantic tagging (which DOM nodes are text vs.
 * decoration vs. chart) that the current Smart generation prompt doesn't
 * produce — worth revisiting once Smart mode itself is proven out.
 *
 * Known limitation: Tailwind and Chart.js are loaded from CDN (jsdelivr —
 * the same CDN the vendored runtime itself references), matching how
 * Presenton's own Smart mode works. Export requires internet access; there
 * is no offline-bundled Tailwind/Chart.js build vendored yet.
 */
import type { Browser } from "puppeteer-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TAILWIND_CDN_SRC = "https://cdn.tailwindcss.com";
const CHART_JS_CDN_SRC = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js";
const CHART_JS_DATALABELS_CDN_SRC = "https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2/dist/chartjs-plugin-datalabels.min.js";

export function wrapSmartSlideHtml(sectionHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<script src="${TAILWIND_CDN_SRC}"></script>
<script src="${CHART_JS_CDN_SRC}"></script>
<script src="${CHART_JS_DATALABELS_CDN_SRC}"></script>
<script>if (window.Chart && window.ChartDataLabels) { Chart.register(ChartDataLabels); }</script>
<style>* { box-sizing: border-box; } html, body { margin: 0; padding: 0; width: 1280px; height: 720px; overflow: hidden; }</style>
</head><body>${sectionHtml}</body></html>`;
}

/** Render one Smart slide's html_content to a PNG file, returning its path. Caller owns cleanup of the returned temp dir's parent. */
export async function renderSmartSlideToImage(browser: Browser, sectionHtml: string, width: number, height: number): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(wrapSmartSlideHtml(sectionHtml), { waitUntil: "load" });
    // Chart.js IIFEs run synchronously on script load, but give a beat for
    // the datalabels plugin registration + canvas paint to settle.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = mkdtempSync(join(tmpdir(), "smart-slide-render-"));
    const path = join(dir, "slide.png");
    const buffer = await page.screenshot({ type: "png" });
    writeFileSync(path, buffer);
    return path;
  } finally {
    await page.close();
  }
}
