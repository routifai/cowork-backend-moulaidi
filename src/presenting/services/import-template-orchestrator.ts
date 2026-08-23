/**
 * Top-level pipeline for importing a user-uploaded .pptx as a new Imported
 * Template: Phase A (deterministic extraction) -> Phase B (per-slide vision)
 * -> assemble + persist template.json + static assets.
 *
 * Asset conventions below are empirically confirmed against a real shipped
 * Preset Template (presenting/engine/templates/general/template.json):
 *   - decorative image element -> real extracted bytes
 *   - non-decorative (content-slot) image element -> the shared, global
 *     placeholder (icons: a separate placeholder, keyed off the raw
 *     extraction's `is_icon` flag)
 *
 * Every image element's `data` is written as a self-contained base64
 * `data:` URI directly, not a "static/..." relative reference — nothing in
 * the shipped app actually serves those paths (no Tauri custom protocol, no
 * assetProtocol scope, no convertFileSrc use — see
 * template-asset-resolution.ts for the full story, which Preset Templates
 * hit the exact same way at load time). Decorative bytes are still also
 * written to this template's own static/ dir for reference, but nothing
 * needs to read them back from there to render.
 */
import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import { hypatiaAgentDir } from "../../agent-init.js";
import { extractRawSlideLayouts, renderSlideImages } from "./pptx-extraction.js";
import { generateSlideLayouts, type SlideLayout } from "./template-vision-generation.js";
import { deriveMergedComponents } from "./merged-components.js";
import { saveImportedTemplate, type ImportedTemplateMeta } from "./imported-template-store.js";
import { appStaticAssetPath, fileToDataUri } from "./template-asset-resolution.js";

const PLACEHOLDER_IMAGE_REF = "/static/images/replaceable_template_image.png";
const PLACEHOLDER_ICON_REF = "/static/icons/placeholder.svg";

export class TemplateImportError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "TemplateImportError";
	}
}

function isFileUrl(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("file://");
}

function readFileUrl(fileUrl: string): Buffer {
	return readFileSync(decodeURIComponent(new URL(fileUrl).pathname));
}

function bufferToDataUri(data: Buffer, ext: string): string {
	const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : "image/png";
	return `data:${mime};base64,${data.toString("base64")}`;
}

/** Rewrite every image element's `data` in-place to a self-contained base64 data URI: decorative -> the real extracted asset, content-slot -> the shared placeholder. */
function resolveImageAssets(
	layouts: SlideLayout[],
	staticAssets: { filename: string; data: Buffer }[],
): void {
	let assetCounter = 0;
	// Placeholder files are read once and reused for every content-slot element.
	const placeholderDataUris = new Map<string, string | null>();
	const placeholderDataUri = (ref: string): string | null => {
		if (!placeholderDataUris.has(ref)) placeholderDataUris.set(ref, fileToDataUri(appStaticAssetPath(ref)));
		return placeholderDataUris.get(ref) ?? null;
	};

	for (const layout of layouts) {
		for (const component of layout.components) {
			for (const element of component.elements) {
				if (element.type !== "image") continue;
				const el = element as Record<string, unknown>;
				const isIcon = Boolean(el.is_icon);
				const placeholderRef = isIcon ? PLACEHOLDER_ICON_REF : PLACEHOLDER_IMAGE_REF;

				if (element.decorative && isFileUrl(el.data)) {
					const original = el.data as string;
					const ext = extname(new URL(original).pathname) || ".png";
					try {
						const bytes = readFileUrl(original);
						staticAssets.push({ filename: `imported-${assetCounter++}${ext}`, data: bytes });
						el.data = bufferToDataUri(bytes, ext);
						continue;
					} catch {
						// Source asset vanished (temp dir cleanup race, etc.) — fall
						// through to the shared placeholder rather than ship a
						// broken reference.
					}
				}
				el.data = placeholderDataUri(placeholderRef) ?? placeholderRef;
			}
		}
	}
}

function assertValidTemplateJson(templateJson: Record<string, unknown>): void {
	if (!Array.isArray(templateJson.layouts) || templateJson.layouts.length === 0) {
		throw new TemplateImportError("Template import produced no usable layouts — the model may have failed to analyze any slide.");
	}
	for (const layout of templateJson.layouts as unknown[]) {
		if (typeof layout !== "object" || layout === null || !Array.isArray((layout as Record<string, unknown>).components)) {
			throw new TemplateImportError("Template import produced a malformed layout entry.");
		}
	}
}

export interface ImportTemplateOptions {
	pptxPath: string;
	name?: string;
	provider: string;
	model: string;
}

export async function importTemplateFromPptx(
	deps: { modelRuntime: any; modelRegistry: any; hypatiaDir: string; workspaceCwd: string },
	opts: ImportTemplateOptions,
): Promise<ImportedTemplateMeta> {
	const [rawLayouts, slideImages] = await Promise.all([
		extractRawSlideLayouts(opts.pptxPath),
		renderSlideImages(opts.pptxPath),
	]);

	if (rawLayouts.layouts.length === 0) {
		throw new TemplateImportError("The uploaded .pptx has no slides to import.");
	}

	const slideLayouts = await generateSlideLayouts(deps, opts.provider, opts.model, rawLayouts.layouts, slideImages);

	const staticAssets: { filename: string; data: Buffer }[] = [];
	resolveImageAssets(slideLayouts, staticAssets);

	const mergedComponents = deriveMergedComponents(slideLayouts);

	const name = opts.name?.trim() || basename(opts.pptxPath, extname(opts.pptxPath));
	const thumbnailFilename = "thumbnail.png";
	staticAssets.push({ filename: thumbnailFilename, data: slideImages[0] });

	const templateJson: Record<string, unknown> = {
		id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "imported-template",
		name,
		description: `Imported from ${basename(opts.pptxPath)}`,
		thumbnail: `static/${thumbnailFilename}`,
		merged_components: mergedComponents,
		layouts: slideLayouts.map((l) => ({ id: l.id, description: l.description, components: l.components })),
		fonts: {},
	};

	assertValidTemplateJson(templateJson);

	const baseDir = hypatiaAgentDir(deps.hypatiaDir);

	return saveImportedTemplate(baseDir, deps.workspaceCwd, {
		name,
		templateJson,
		staticAssets,
		thumbnailFilename,
		slideCount: slideLayouts.length,
	});
}
