/**
 * Resolves template-relative and app-wide `/static/...` image references
 * into self-contained base64 `data:` URIs.
 *
 * Root cause this fixes: nothing in the shipped app actually serves
 * `static/...`-relative or `/static/...`-absolute paths as loadable URLs —
 * no Tauri custom URI scheme, no assetProtocol scope, no convertFileSrc use,
 * no HTTP route. The frontend resolves an image element's `data` via
 * `new URL(source, window.location.href)` (editor/surface/nodes.tsx), so any
 * such reference just 404s and renders as an empty box. This affects Preset
 * Templates' own baked-in decorative images/placeholders exactly as much as
 * Imported Templates — it's not specific to either.
 */
import { join } from "node:path";
import { appStaticAssetPath, fileToDataUri } from "../utils/asset-directory-utils.js";

export { appStaticAssetPath, fileToDataUri };

function isAlreadyLoadable(src: string): boolean {
	return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * Deep-clones `templateJson` and replaces every image element's `data` with
 * a base64 data URI:
 *   - "/static/..." (leading slash) -> presenting/engine/static/... (app-wide, e.g. placeholders)
 *   - "static/..." (no leading slash) -> <templateStaticDir>/... (this template's own co-located assets)
 *   - already http(s)/data/blob -> left unchanged
 */
export function resolveTemplateImageAssets(templateJson: Record<string, unknown>, templateStaticDir: string): Record<string, unknown> {
	function walk(node: unknown): unknown {
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") {
			const obj = node as Record<string, unknown>;
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) result[key] = walk(value);
			if (result.type === "image" && typeof result.data === "string" && !isAlreadyLoadable(result.data)) {
				const src = result.data;
				const filePath = src.startsWith("/static/")
					? appStaticAssetPath(src)
					: src.startsWith("static/")
						? join(templateStaticDir, src.slice("static/".length))
						: null;
				const dataUri = filePath ? fileToDataUri(filePath) : null;
				if (dataUri) result.data = dataUri;
			}
			return result;
		}
		return node;
	}
	return walk(templateJson) as Record<string, unknown>;
}
