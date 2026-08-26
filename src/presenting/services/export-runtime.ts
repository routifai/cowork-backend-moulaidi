/**
 * Shared plumbing for calling the vendored `@presenton/export-core` package
 * (presenting/engine/vendor/presentation-export) — an in-process, typed
 * `runTask()` function, not a subprocess. See sync-presentation-export.mjs
 * for why this replaced an older subprocess/task-file protocol (that
 * protocol talked to a different, now-superseded, python-backed vendored
 * runtime).
 *
 * The package is dynamically `import()`ed by absolute path from its
 * vendored `node_modules/@presenton/export-core/dist/index.js` rather than
 * being a normal `dependencies` entry in this repo's own package.json —
 * consistent with the "vendored, not a project dependency" treatment the
 * old runtime already had (see .gitignore: `presenting/engine/vendor/**`),
 * and it keeps this package's own heavy native deps (puppeteer, sharp) out
 * of hypatia-backend's esbuild bundle.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exportRuntimeDir } from "../paths.js";

export class ExportRuntimeError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "ExportRuntimeError";
	}
}

export function getExportRuntimeDir(): string {
	const fromEnv = process.env.EXPORT_RUNTIME_DIR;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const vendored = exportRuntimeDir();
	if (existsSync(vendored)) return vendored;
	throw new ExportRuntimeError(`Export runtime not found. Set EXPORT_RUNTIME_DIR or run sync scripts.`);
}

export function discoverChromiumPath(exportDir: string): string {
	const fromEnv = process.env.PRESENTING_CHROMIUM_PATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	// Try to find Chromium in the bundled cache
	const cacheDir = join(exportDir, "chromium-cache");
	if (!existsSync(cacheDir)) return "";
	const glob = (dir: string, depth: number): string => {
		if (depth <= 0) return "";
		try {
			for (const name of ["Chromium", "Google Chrome for Testing", "chrome", "chrome.exe", "Chromium.exe"]) {
				const candidate = join(dir, name);
				// existsSync alone isn't enough: on case-insensitive filesystems
				// (default on macOS/Windows), "Chromium" case-folds onto a sibling
				// "chromium" directory the vendored bundle ships
				// (chromium-cache/chromium/...) and would otherwise be accepted as
				// if it were the executable itself.
				try {
					if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
				} catch { /* skip */ }
			}
			for (const entry of readdirSync(dir)) {
				try {
					const full = join(dir, entry);
					if (statSync(full).isDirectory()) {
						const found = glob(full, depth - 1);
						if (found) return found;
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
		return "";
	};
	// The real executable sits 7 levels below chromium-cache/ on macOS
	// (chromium/<build>/chrome-mac/Chromium.app/Contents/MacOS/Chromium) —
	// confirmed by actually running this against the vendored bundle. A
	// shallower limit silently returns "" past that point.
	return glob(cacheDir, 8);
}

export interface ExportRuntimeHandle {
	exportDir: string;
	chromiumPath: string;
}

/** Resolve the runtime dir + Chromium path once, to pass into runPptxFromJson. */
export function resolveExportRuntime(): ExportRuntimeHandle {
	const exportDir = getExportRuntimeDir();
	const chromiumPath = discoverChromiumPath(exportDir);
	return { exportDir, chromiumPath };
}

interface ExportCoreModule {
	runTask(task: Record<string, unknown>, options: Record<string, unknown>): Promise<{ filePath: string; url: string; mimeType: string }>;
}

let cachedModule: Promise<ExportCoreModule> | null = null;

function loadExportCore(exportDir: string): Promise<ExportCoreModule> {
	if (cachedModule) return cachedModule;
	const entrypoint = join(exportDir, "node_modules", "@presenton", "export-core", "dist", "index.js");
	if (!existsSync(entrypoint)) {
		throw new ExportRuntimeError(`@presenton/export-core not found at ${entrypoint}. Run presenting/engine/vendor/sync-presentation-export.mjs.`);
	}
	// Dynamic import of an absolute path — @presenton/export-core ships as
	// ESM ("type": "module" in its package.json); this works from a CJS
	// caller (this repo's esbuild bundle output) because Node's dynamic
	// import() supports loading ESM from CJS.
	cachedModule = import(entrypoint) as Promise<ExportCoreModule>;
	return cachedModule;
}

export const DEFAULT_EXPORT_TASK_TIMEOUT_MS = 180_000;

/**
 * Run an `html-to-any` `format: "pptx"` task against the vendored
 * export-core package and return the resulting .pptx's absolute local
 * path. This is Presenton's own real HTML→pptx conversion pipeline — see
 * smart-slide-render.ts's `wrapSmartDeckHtml()` for the exact DOM wrapper
 * their own `PdfMakerPage.tsx` uses, which this task's handler requires
 * (`#presentation-slides-wrapper` / `.main-slide` — it 400s with
 * "Presentation slides wrapper not found" without it).
 */
export async function runHtmlToAnyPptxTask(
	html: string,
	title: string,
	runtime: ExportRuntimeHandle,
	tempDir: string,
	opts: { timeoutMs?: number } = {},
): Promise<string> {
	if (!runtime.chromiumPath || !existsSync(runtime.chromiumPath)) {
		throw new ExportRuntimeError(`Chromium not found at ${runtime.chromiumPath}. Set PRESENTING_CHROMIUM_PATH.`);
	}
	const { runTask } = await loadExportCore(runtime.exportDir);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_EXPORT_TASK_TIMEOUT_MS;
	const task = { type: "html-to-any", html, format: "pptx", title };
	const runPromise = runTask(task, {
		outputDirectory: tempDir,
		tempDirectory: tempDir,
		browserLaunchOptions: {
			executablePath: runtime.chromiumPath,
			headless: true,
			args: ["--no-sandbox", "--disable-gpu"],
		},
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new ExportRuntimeError(`html-to-any task timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		const response = await Promise.race([runPromise, timeoutPromise]);
		if (!response.filePath || !existsSync(response.filePath)) {
			throw new ExportRuntimeError(`html-to-any did not produce a file: ${JSON.stringify(response)}`);
		}
		return response.filePath;
	} catch (err) {
		if (err instanceof ExportRuntimeError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new ExportRuntimeError(`Export runtime failed: ${msg.slice(0, 500)}`);
	}
}
