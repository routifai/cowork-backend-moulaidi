/**
 * Verifies generateSmartPresentation's onProgress callback fires real,
 * well-formed events for the two-phase (outline + parallel slides)
 * pipeline — not just that generation still succeeds. Slides can complete
 * out of order now (real concurrency, not a sequential stream), so this
 * checks structural invariants (every "done" has a prior "started", every
 * slide gets exactly one "done") rather than assuming index order.
 * Run: npx tsx scripts/verify-generation-progress.ts [nSlides]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { generateSmartPresentation, type SmartGenerationProgressEvent } from "../src/presenting/services/smart-generation.js";

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

async function main() {
	loadDotEnv(join(homedir(), "hypatia", "hypatia-frontend", ".env"));
	const nSlides = Number(process.argv[2] ?? 4);

	const piDir = join(homedir(), ".pi", "agent");
	const modelRuntime = await ModelRuntime.create({ authPath: join(piDir, "auth.json"), modelsPath: join(piDir, "models.json") });
	const modelRegistry = new ModelRegistry(modelRuntime);

	const events: Array<SmartGenerationProgressEvent & { t: number }> = [];
	const start = Date.now();

	const result = await generateSmartPresentation(
		{ modelRuntime, modelRegistry },
		{
			content: "A short presentation about the history of synthesizers in popular music.",
			n_slides: nSlides,
			provider: "anthropic",
			model: "claude-sonnet-5",
			include_title_slide: true,
			include_table_of_contents: false,
			onProgress: (e) => events.push({ ...e, t: Date.now() - start }),
		},
	);

	console.log(`generated ${result.slides.length} slides in ${((Date.now() - start) / 1000).toFixed(1)}s`);
	console.log(`received ${events.length} progress events:`);
	for (const e of events) {
		if (e.phase === "outline") {
			console.log(`  [+${(e.t / 1000).toFixed(1)}s] outline ${e.status}`);
		} else {
			console.log(`  [+${(e.t / 1000).toFixed(1)}s] slide ${e.slideIndex + 1}/${e.totalSlides} ${e.status}`);
		}
	}

	let ok = true;
	const outlineEvents = events.filter((e): e is Extract<SmartGenerationProgressEvent, { phase: "outline" }> & { t: number } => e.phase === "outline");
	const slideEvents = events.filter((e): e is Extract<SmartGenerationProgressEvent, { phase: "slide" }> & { t: number } => e.phase === "slide");

	if (outlineEvents.length !== 2 || outlineEvents[0]?.status !== "started" || outlineEvents[1]?.status !== "done") {
		ok = false;
		console.log("FAIL: expected exactly [outline started, outline done]");
	}
	const outlineDoneAt = outlineEvents.find((e) => e.status === "done")?.t ?? -1;
	if (slideEvents.some((e) => e.t < outlineDoneAt)) {
		ok = false;
		console.log("FAIL: a slide event arrived before the outline finished");
	}

	const startedIdx = new Set(slideEvents.filter((e) => e.status === "started").map((e) => e.slideIndex));
	const doneIdx = new Set(slideEvents.filter((e) => e.status === "done").map((e) => e.slideIndex));
	for (const idx of doneIdx) {
		if (!startedIdx.has(idx)) {
			ok = false;
			console.log(`FAIL: slide ${idx} reported done without a started event`);
		}
	}
	if (doneIdx.size !== result.slides.length) {
		ok = false;
		console.log(`FAIL: got ${doneIdx.size} slide "done" events but ${result.slides.length} slides`);
	}
	console.log(ok ? "PASS: progress events are well-formed" : "FAIL: see above");
	if (!ok) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
