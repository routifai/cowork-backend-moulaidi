/**
 * End-to-end smoke test: exports a small mixed deck (gradient-heavy slides
 * that previously fell 100% to whole-slide raster) via
 * exportPresentationNatively and writes a real .pptx to disk, for manual/
 * python-pptx inspection. Run: npx tsx scripts/smoke-full-export.ts [deckFile]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportPresentationNatively } from "../src/presenting/services/native-pptx-export.js";
import { resolveExportRuntime } from "../src/presenting/services/export-runtime.js";
import { smartExamplesDir } from "../src/presenting/paths.js";

async function main() {
	const deckFile = process.argv[2] ?? "arcade-sys-a-history-of-the-coin-op-era.json";
	const deck = JSON.parse(readFileSync(join(smartExamplesDir(), deckFile), "utf-8")) as { title: string; slides: string[] };
	const runtime = resolveExportRuntime();
	const outputPath = "/tmp/smoke-export.pptx";
	await exportPresentationNatively({
		title: deck.title,
		slides: deck.slides.slice(0, 4).map((htmlContent) => ({ htmlContent })),
		runtime,
		outputPath,
	});
	console.log("Wrote", outputPath);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
