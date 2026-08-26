/**
 * Verifies the targeted single-slide repair path (attemptTargetedRepair)
 * against a real model, deterministically: hand-crafts a 2-slide deck
 * where slide 1 deliberately violates the "too text-dense" rule (a real,
 * common validation failure), builds the same SmartGenerationError shape
 * parseSmartPresentationHtml would produce, and checks that repair
 * (a) succeeds, (b) actually fixes slide 1's content, (c) doesn't touch
 * slide 0, and (d) is much cheaper than a full-deck regeneration
 * (benchmark-smart-generation.ts measured ~55s for a 4-slide full
 * generation; a single-slide repair should be a fraction of that).
 * Run: npx tsx scripts/benchmark-targeted-repair.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { attemptTargetedRepair, normalizeSmartSlideHtml, SmartGenerationError, type SmartSlide } from "../src/presenting/services/smart-generation.js";

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

const GOOD_SLIDE_HTML =
	'<section data-slide-type="title" class="relative h-[720px] w-[1280px] overflow-hidden bg-white flex items-center justify-center"><h1 class="text-5xl font-bold">Electric Guitars</h1></section>';

// Deliberately violates SMART_TEXT_MAX_VISIBLE_WORDS (190) for a "content" slide.
const SENTENCE = "The electric guitar transformed twentieth century music by combining amplified strings with new playing techniques. ";
const TOO_MUCH_TEXT = SENTENCE.repeat(20);
const BROKEN_SLIDE_HTML = `<section data-slide-type="content" class="relative h-[720px] w-[1280px] overflow-hidden bg-white p-16"><p class="text-2xl">${TOO_MUCH_TEXT}</p></section>`;

async function main() {
	loadDotEnv(join(homedir(), "hypatia", "hypatia-frontend", ".env"));
	const provider = process.argv[2] ?? "anthropic";
	const model = process.argv[3] ?? "claude-sonnet-5";

	const piDir = join(homedir(), ".pi", "agent");
	const modelRuntime = await ModelRuntime.create({ authPath: join(piDir, "auth.json"), modelsPath: join(piDir, "models.json") });
	const modelRegistry = new ModelRegistry(modelRuntime);
	const found = modelRegistry.find(provider, model);
	if (!found) throw new Error(`Model ${provider}/${model} not found`);

	// Confirm the broken slide really does fail validation before testing repair against it.
	let confirmedBroken = false;
	try {
		normalizeSmartSlideHtml(BROKEN_SLIDE_HTML);
	} catch {
		confirmedBroken = true;
	}
	console.log("broken slide fails validation (expected true):", confirmedBroken);
	if (!confirmedBroken) throw new Error("Test fixture is not actually broken — fix the test, not the code.");

	const slides: SmartSlide[] = [
		{ title: "Electric Guitars", html: GOOD_SLIDE_HTML, speaker_note: "", slide_type: "title" },
		{ title: "Slide 2", html: BROKEN_SLIDE_HTML, speaker_note: "", slide_type: "content" },
	];
	const error = new SmartGenerationError(
		"The Smart content slide is too text-dense for its 1280x720 composition. Shorten or reflow the copy.",
		{ slideIndex: 1, partial: { title: "Electric Guitars", slides } },
	);

	const start = Date.now();
	const result = await attemptTargetedRepair({ modelRuntime, modelRegistry }, found, error, { include_title_slide: true, include_table_of_contents: false });
	const elapsed = (Date.now() - start) / 1000;

	console.log(`[timing] attemptTargetedRepair: ${elapsed.toFixed(1)}s`);
	if (!result) {
		console.log("RESULT: repair failed (returned null) — would fall back to full regeneration");
		process.exit(1);
	}
	console.log("RESULT: repair succeeded");
	console.log("slide 0 unchanged:", result.slides[0].html === GOOD_SLIDE_HTML);
	console.log("slide 1 new length:", result.slides[1].html.length, "(was", BROKEN_SLIDE_HTML.length, ")");
	let stillBroken = false;
	try {
		normalizeSmartSlideHtml(result.slides[1].html);
	} catch {
		stillBroken = true;
	}
	console.log("slide 1 now passes validation (expected true):", !stillBroken);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
