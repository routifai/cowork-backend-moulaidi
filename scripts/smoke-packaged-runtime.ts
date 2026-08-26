/**
 * Simulates production sidecar startup: sets EXPORT_RUNTIME_DIR to the
 * copied bundle (src-tauri/presenting-runtime, produced by
 * hypatia-frontend/scripts/prebuild.mjs's new copy step) instead of the
 * live hypatia-backend vendor checkout, and proves the export pipeline
 * still resolves and runs a real export from that location.
 * Run: npx tsx scripts/smoke-packaged-runtime.ts
 */
process.env.EXPORT_RUNTIME_DIR = "/Users/simo/hypatia/hypatia-frontend/src-tauri/presenting-runtime";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportPresentationNatively } from "../src/presenting/services/native-pptx-export.js";
import { resolveExportRuntime } from "../src/presenting/services/export-runtime.js";
import { smartExamplesDir } from "../src/presenting/paths.js";

async function main() {
	const runtime = resolveExportRuntime();
	console.log("resolved runtime:", runtime);
	const deck = JSON.parse(readFileSync(join(smartExamplesDir(), "meridian-strategy-fy27.json"), "utf-8")) as { title: string; slides: string[] };
	const outputPath = "/tmp/smoke-packaged-export.pptx";
	await exportPresentationNatively({
		title: deck.title,
		slides: deck.slides.slice(0, 2).map((htmlContent) => ({ htmlContent })),
		runtime,
		outputPath,
	});
	console.log("Wrote", outputPath, "using the PACKAGED (copied) runtime location");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
