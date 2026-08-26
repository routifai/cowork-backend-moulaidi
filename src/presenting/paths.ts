/**
 * Filesystem roots for Presenting Engine assets that still live next to
 * the old Python checkout (templates, icons, export runtime, liteparse).
 *
 * This file is `src/presenting/paths.ts`, so two `..` hops reach the
 * hypatia-backend repo root. Previous per-file path math used three or
 * four hops inconsistently and resolved into the wrong sibling.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "../..");

export function backendRoot(): string {
	return BACKEND_ROOT;
}

/** hypatia-backend/presenting/engine — templates, icons, vendor runtimes. */
export function presentingEngineRoot(): string {
	const override = (process.env.PRESENTING_ENGINE_DIR ?? "").trim();
	if (override) return override;
	return join(BACKEND_ROOT, "presenting", "engine");
}

export function exportRuntimeDir(): string {
	const fromEnv = process.env.EXPORT_RUNTIME_DIR;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return join(presentingEngineRoot(), "vendor", "presentation-export");
}

export function liteparseDir(): string {
	return join(presentingEngineRoot(), "vendor", "liteparse");
}
