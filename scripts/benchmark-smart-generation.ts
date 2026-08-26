/**
 * Times each real stage of "generate a Smart deck, then export it" against
 * the actual model/export pipeline (not mocked), to find out where the
 * ~3 minutes for a small deck actually goes — generation (one big blocking
 * LLM call for the whole deck) vs. export (html-to-any + CDN waits).
 * Run: npx tsx scripts/benchmark-smart-generation.ts [nSlides] [provider] [model]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { generateSmartPresentation } from "../src/presenting/services/smart-generation.js";
import { exportPresentationNatively } from "../src/presenting/services/native-pptx-export.js";
import { resolveExportRuntime } from "../src/presenting/services/export-runtime.js";

function loadDotEnv(path: string) {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (!process.env[key]) process.env[key] = val;
	}
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const start = Date.now();
	try {
		return await fn();
	} finally {
		console.log(`[timing] ${label}: ${((Date.now() - start) / 1000).toFixed(1)}s`);
	}
}

async function main() {
	loadDotEnv(join(homedir(), "hypatia", "hypatia-frontend", ".env"));

	const nSlides = Number(process.argv[2] ?? 4);
	const provider = process.argv[3] ?? "anthropic";
	const model = process.argv[4] ?? "claude-sonnet-5";

	const piDir = join(homedir(), ".pi", "agent");
	const authPath = join(piDir, "auth.json");
	const modelsPath = join(piDir, "models.json");

	const modelRuntime = await timed("ModelRuntime.create", () => ModelRuntime.create({ authPath, modelsPath }));
	const modelRegistry = new ModelRegistry(modelRuntime);

	const content = "A short presentation about the history and future of the electric guitar: origins, key innovators, iconic models, and where the instrument is headed with modern digital modeling.";

	const overallStart = Date.now();
	const result = await timed(`generateSmartPresentation (${nSlides} slides)`, () =>
		generateSmartPresentation(
			{ modelRuntime, modelRegistry },
			{ content, n_slides: nSlides, provider, model, include_title_slide: true, include_table_of_contents: false },
		),
	);
	console.log(`  -> generated ${result.slides.length} slides, title: ${result.title}`);

	const runtime = resolveExportRuntime();
	await timed("exportPresentationNatively", () =>
		exportPresentationNatively({
			title: result.title,
			slides: result.slides.map((htmlContent) => ({ htmlContent })),
			runtime,
			outputPath: "/tmp/benchmark-export.pptx",
		}),
	);

	console.log(`[timing] TOTAL: ${((Date.now() - overallStart) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
