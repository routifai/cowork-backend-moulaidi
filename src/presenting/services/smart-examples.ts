/**
 * Bundled community Smart decks (`presenting/smart-examples/*.json`) — real
 * HTML slides pulled from Presenton's own public community gallery
 * (api.presenton.ai), saved locally so Smart Generation can offer them as an
 * optional design-reference style anchor, the same way Presenton's own
 * Smart mode lets a user pick a community deck to anchor style on (see
 * `community_presentations.py`'s `build_community_design_context` — this
 * mirrors its "paste a couple of the reference deck's real slides into the
 * prompt as style-only few-shot context" idea, just sourced from a small
 * local bundle instead of a live hosted API call per generation).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smartExamplesDir } from "../paths.js";

export interface SmartExampleManifestEntry {
	file: string;
	title: string;
	slides: number;
}

export interface SmartExampleSummary {
	id: string;
	title: string;
	slideCount: number;
	previewUrl: string;
}

interface SmartExampleDeck {
	source_id: number;
	title: string;
	author: string;
	slides: string[];
	fonts: Record<string, string>;
}

function readManifest(): SmartExampleManifestEntry[] {
	try {
		const raw = readFileSync(join(smartExamplesDir(), "manifest.json"), "utf-8");
		return JSON.parse(raw) as SmartExampleManifestEntry[];
	} catch {
		return [];
	}
}

function idFromFile(file: string): string {
	return file.replace(/\.json$/, "");
}

/** List every bundled example, for the design-reference picker UI. `previewUrl` points at a static PNG shipped in the frontend's public/ dir (same convention as Preset Templates' own thumbnails). */
export function listSmartExamples(): SmartExampleSummary[] {
	return readManifest().map((entry) => ({
		id: idFromFile(entry.file),
		title: entry.title,
		slideCount: entry.slides,
		previewUrl: `/smart-example-previews/${idFromFile(entry.file)}.png`,
	}));
}

/** Read up to `maxSlides` of a bundled example's real slide HTML, for injecting into the Smart generation prompt as style-only reference context. Returns null if the id doesn't match a bundled example (never throws on a bad/stale client-supplied id). */
export function getSmartExampleReferenceSlides(id: string, maxSlides = 2): { title: string; slides: string[] } | null {
	const manifest = readManifest();
	const entry = manifest.find((e) => idFromFile(e.file) === id);
	if (!entry) return null;
	try {
		const deck = JSON.parse(readFileSync(join(smartExamplesDir(), entry.file), "utf-8")) as SmartExampleDeck;
		return { title: deck.title, slides: deck.slides.slice(0, maxSlides) };
	} catch {
		return null;
	}
}
