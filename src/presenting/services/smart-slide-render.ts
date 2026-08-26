/**
 * Wraps Smart-mode slide HTML (raw `<section>` fragments, stored verbatim
 * in each slide's html_content) in the *exact* DOM structure Presenton's
 * own real export page (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx`
 * in their open-source repo — genuinely readable, not obfuscated, unlike
 * the export-core package itself) wraps slides in for export: an
 * `#presentation-slides-wrapper` containing one `.main-slide` per slide,
 * each holding a `.slide-export-inner`, which for Smart/html_content
 * slides holds their `SmartHtmlPdfSlide` nesting
 * (`smart-slide-export-root` > `smart-slide-export-content` > the raw
 * section HTML) — ported field-for-field, including their `PDF_PRINT_STYLE`
 * sizing rules. The vendored `@presenton/export-core` package's
 * `html-to-any` task type specifically looks for `#presentation-slides-wrapper`
 * and errors ("Presentation slides wrapper not found") without it — this
 * isn't cosmetic, it's the real contract their DOM→pptx conversion expects.
 *
 * Given this wrapper, `html-to-any` runs Presenton's own actual
 * DOM-extraction/pptx-shape-building pipeline against our Smart HTML — real
 * editable text/shapes, native-quality output — instead of a hand-rolled
 * re-implementation of that same algorithm (see SMART_MODE_ARCHITECTURE.md
 * for why an earlier, custom DOM-heuristic version of this file was
 * replaced with this one).
 */
const TAILWIND_CDN_SRC = "https://cdn.tailwindcss.com";
const CHART_JS_CDN_SRC = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js";
const CHART_JS_DATALABELS_CDN_SRC = "https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2/dist/chartjs-plugin-datalabels.min.js";

const PDF_PRINT_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; }
#presentation-slides-wrapper {
  width: 100% !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  gap: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
}
#presentation-slides-wrapper .main-slide {
  width: 1280px !important;
  min-width: 1280px !important;
  max-width: 1280px !important;
  height: 720px !important;
  min-height: 720px !important;
  max-height: 720px !important;
  flex: 0 0 720px !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
#presentation-slides-wrapper .slide-export-inner {
  width: 1280px !important;
  height: 720px !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
`;

function wrapOneSlide(sectionHtml: string, index: number): string {
	return `<div id="slide-${index}" class="main-slide relative flex items-center justify-center">
  <div class="slide-export-inner group">
    <div class="smart-slide-export-root h-[720px] w-[1280px] overflow-hidden bg-white">
      <div class="smart-slide-export-content h-[720px] w-[1280px] overflow-hidden bg-white">
        <div class="h-[720px] w-[1280px] overflow-hidden bg-white">${sectionHtml}</div>
      </div>
    </div>
  </div>
</div>`;
}

/** Wraps every Smart slide's raw `<section>` HTML into one full deck document, ready for an `html-to-any` `format: "pptx"` task. */
export function wrapSmartDeckHtml(sections: string[]): string {
	const slidesHtml = sections.map(wrapOneSlide).join("\n");
	return `<!doctype html><html><head><meta charset="utf-8" />
<script src="${TAILWIND_CDN_SRC}"></script>
<script src="${CHART_JS_CDN_SRC}"></script>
<script src="${CHART_JS_DATALABELS_CDN_SRC}"></script>
<script>if (window.Chart && window.ChartDataLabels) { Chart.register(ChartDataLabels); }</script>
<style>* { box-sizing: border-box; } ${PDF_PRINT_STYLE}</style>
</head><body>
<div id="presentation-slides-wrapper" class="relative m-0 flex w-full flex-col items-start overflow-visible p-0">
${slidesHtml}
</div>
</body></html>`;
}
