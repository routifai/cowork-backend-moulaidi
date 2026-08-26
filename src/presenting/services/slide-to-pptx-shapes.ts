/**
 * Maps resolved leaf elements (source TemplateV2 element + its exact
 * Chromium-measured absolute box) to the `pptx-from-json` task's shape
 * schema. That schema was reverse-engineered empirically (no public docs —
 * see export-runtime.ts's header comment for the general protocol, and the
 * probes run this session for the "autoshape" shape specifically):
 *
 *   textbox:   { shape_type: "textbox", position: {left,top,width,height}, paragraphs: [{ text, font }] }
 *   picture:   { shape_type: "picture", position: {left,top,width,height}, picture: { path, is_network } }
 *   autoshape: { shape_type: "autoshape", position: {left,top,width,height}, fill: { color } }
 *
 * Important, non-obvious: the offset keys are `left`/`top`, NOT `x`/`y` — an
 * earlier assumption (`x`/`y`) silently produced shapes that all landed at
 * (0,0) regardless of the real position, since `x`/`y` are just ignored
 * extra fields rather than a validation error. Caught by testing a
 * deliberately non-zero position end-to-end and inspecting the real output
 * with python-pptx, not by the pydantic-error probing technique — an
 * unrecognized field here doesn't error, it's silently dropped.
 *
 * Confirmed constraints on `font`: `size` is the same px units as position
 * (auto-converted to pt internally at 0.75 — do not pre-convert), `color`
 * is hex WITHOUT a leading '#', the field for family is `name` (NOT
 * `family`), and `bold`/`family`/`weight` are silently ignored — there is no
 * way to request bold text through this API. Markdown syntax (`**bold**`)
 * is not parsed either, so it must be stripped before handing text over, or
 * it shows up as literal asterisks in the exported file.
 *
 * autoshape was confirmed (this session, via forced pydantic validation
 * errors against the frozen convert binary) to support only `shape_type`,
 * `position`, and an optional `fill: { color }` — no stroke, no corner
 * radius, no non-rectangle shape, no rotation. That's why
 * dom-slide-renderer.ts only treats an *unrotated, unstroked, axis-aligned
 * rectangle* vector as a native "rect" leaf; anything else (rounded cards,
 * bordered boxes, non-rect polygons) is left as unsupported so the whole
 * slide falls back to the existing raster export path instead of silently
 * dropping the stroke/rounding.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RenderedLeaf } from "./dom-slide-renderer.js";
import type { LeafBox } from "./dom-layout-resolver.js";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Strip the plain markdown emphasis syntax hypatia's own text content sometimes carries (matches the frontend's own `displayText()`), since pptx-from-json renders it literally otherwise. */
function stripMarkdown(text: string): string {
	return text
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/__(.*?)__/g, "$1")
		.replace(/\*(.*?)\*/g, "$1")
		.replace(/_(.*?)_/g, "$1");
}

function runsPlainText(runsValue: unknown): string {
	const runs = Array.isArray(runsValue) ? runsValue : [];
	return runs
		.map((r) => {
			const run = asRecord(r);
			if (!run) return "";
			return run.type === "latex" ? String(run.latex ?? "") : String(run.text ?? "");
		})
		.join("");
}

function firstRunFont(runsValue: unknown, elementFont: Record<string, unknown> | null): Record<string, unknown> {
	const runs = Array.isArray(runsValue) ? runsValue : [];
	const first = runs.map((r) => asRecord(r)).find((r) => r && asRecord(r?.font));
	return asRecord(first?.font) ?? elementFont ?? {};
}

function toHexNoHash(color: unknown): string {
	if (typeof color !== "string") return "111827";
	return color.startsWith("#") ? color.slice(1) : color;
}

function pptxFont(font: Record<string, unknown>): Record<string, unknown> {
	return {
		size: num(font.size) ?? 18,
		italic: Boolean(font.italic),
		color: toHexNoHash(font.color),
		name: typeof font.family === "string" ? font.family : "Arial",
	};
}

/** Resolve an image element's `data` (data: URI, file:// path, or bare local path) to a local file path pptx-from-json's `picture.path` can read. Returns null if unresolvable (caller should treat that element as unsupported). */
function resolveImagePath(data: string, tempDir: string): string | null {
	if (data.startsWith("data:")) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data);
		if (!match) return null;
		const [, mime, isBase64, payload] = match;
		const ext = (mime?.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
		const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf-8");
		const path = join(tempDir, `img-${Math.random().toString(36).slice(2)}.${ext}`);
		writeFileSync(path, buffer);
		return path;
	}
	const path = data.startsWith("file://") ? decodeURIComponent(data.slice(7)) : data;
	return existsSync(path) ? path : null;
}

export interface PptxShapeResult {
	shapes: Record<string, unknown>[];
	/** True if any leaf couldn't be mapped (e.g. an unresolvable image source) — caller should fall back that slide to raster export. */
	failed: boolean;
}

export function leavesToPptxShapes(leaves: RenderedLeaf[], boxes: Record<string, LeafBox>, tempDir: string): PptxShapeResult {
	const shapes: Record<string, unknown>[] = [];
	let failed = false;

	for (const leaf of leaves) {
		const box = boxes[leaf.id];
		if (!box) {
			failed = true;
			continue;
		}
		const position = { left: box.x, top: box.y, width: box.width, height: box.height };

		if (leaf.kind === "text") {
			const font = asRecord(leaf.element.font);
			const runFont = firstRunFont(leaf.element.runs, font);
			const text = stripMarkdown(runsPlainText(leaf.element.runs));
			shapes.push({
				shape_type: "textbox",
				position,
				paragraphs: [{ text, font: pptxFont(runFont) }],
			});
			continue;
		}

		if (leaf.kind === "text-list") {
			const font = asRecord(leaf.element.font);
			const items = Array.isArray(leaf.element.items) ? (leaf.element.items as unknown[]) : [];
			const paragraphs = items.map((runs) => ({
				text: stripMarkdown(runsPlainText(runs)),
				font: pptxFont(firstRunFont(runs, font)),
			}));
			shapes.push({ shape_type: "textbox", position, paragraphs });
			continue;
		}

		if (leaf.kind === "image") {
			const data = typeof leaf.element.data === "string" ? leaf.element.data : "";
			const path = data ? resolveImagePath(data, tempDir) : null;
			if (!path) {
				failed = true;
				continue;
			}
			shapes.push({ shape_type: "picture", position, picture: { path, is_network: false } });
			continue;
		}

		if (leaf.kind === "rect") {
			const fill = asRecord(leaf.element.fill)?.color;
			shapes.push({ shape_type: "autoshape", position, fill: { color: toHexNoHash(fill) } });
			continue;
		}
	}

	return { shapes, failed };
}

export function createShapeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pptx-shapes-"));
}
