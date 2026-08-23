/**
 * Shared plumbing for calling the vendored presentation-export runtime
 * (Chromium/Puppeteer, presenting/engine/vendor/presentation-export).
 *
 * The runtime is a single Node entrypoint invoked as a subprocess: write a
 * JSON task file, run `node index.js --task <path> --response <path>`. It
 * supports more task types than the one export.ts originally used
 * ("json-to-image") — confirmed both by grepping the vendored, minified
 * index.js for task-type string literals ("pptx-to-json", "pptx-to-html",
 * "html-to-image", "html-to-images", "extract-schema") and by actually
 * running each of them against a real .pptx. Empirically confirmed facts
 * that don't match what a naive reading of export.ts's original code would
 * suggest:
 *
 * - The `--response`/`EXPORT_RESPONSE_PATH` value is NOT where the runtime
 *   writes its output. It derives the response path itself as a sibling of
 *   the task file: `<task-file-dir>/<task-file-stem>.response.json`. This
 *   only ever appeared to work because export.ts (and this module) always
 *   name the task file "export_task.json", so the derived path happens to
 *   equal the "export_task.response.json" path already being read.
 * - The success payload has NO `{ok: true, ...}` wrapper — it's the
 *   handler's raw return value directly (e.g. `{file_path}` for
 *   json-to-image/html-to-image(s), `{url: "file://..."}` for
 *   pptx-to-json/pptx-to-html). A failed task never produces a response
 *   file at all (non-zero exit, already caught below) — there is no
 *   `{ok: false, error}` shape to check for on the happy path.
 * - "pptx-to-json"/"pptx-to-html" shell out to a *frozen Python binary*
 *   (`py/convert-<platform>-<arch>`, PyInstaller), not pure Node/Puppeteer
 *   like the image tasks. Without `BUILT_PYTHON_MODULE_PATH` pointed at that
 *   binary, the runtime's fallback (`.venv/bin/python py/convert.py`) does
 *   not exist in the vendored bundle. That Python binary also requires
 *   `APP_DATA_DIRECTORY` and `ASSETS_BASE_URL` env vars (the latter is only
 *   used to build asset URL strings embedded in its output JSON — it's
 *   never fetched, so a placeholder value is fine).
 * - "pptx-to-json"/"pptx-to-html" return `{url: "file://<path-to-json>"}` —
 *   the caller must read that file itself; the JSON is not inlined in the
 *   task response.
 *
 * This module is the one place that owns the subprocess/env/task-file
 * protocol so every caller (export.ts, pptx-extraction.ts) shares it instead
 * of re-deriving it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportRuntimeDir } from "../paths.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_EXPORT_TASK_TIMEOUT_MS = 120_000;

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

/**
 * Locate the frozen Python conversion binary the runtime shells out to for
 * "pptx-to-json"/"pptx-to-html"/"pptx-from-json" tasks (unlike
 * "json-to-image"/"html-to-image(s)", which are pure Node/Puppeteer).
 *
 * Without BUILT_PYTHON_MODULE_PATH set, the runtime's default fallback is
 * `.venv/bin/python py/convert.py` (a dev-time venv layout) — the shipped
 * vendored bundle has neither; it ships one pre-built binary per platform
 * instead, named `py/convert-${platform}-${arch}` (`.exe` on win32), matching
 * sync-presentation-export.mjs's own per-platform asset naming.
 */
export function discoverPythonConvertBinary(exportDir: string): string {
	const fromEnv = process.env.PRESENTING_PYTHON_CONVERT_PATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const suffix = process.platform === "win32" ? ".exe" : "";
	const candidate = join(exportDir, "py", `convert-${process.platform}-${process.arch}${suffix}`);
	return existsSync(candidate) ? candidate : "";
}

export interface ExportRuntimeHandle {
	exportDir: string;
	chromiumPath: string;
	pythonConvertPath: string;
}

/** Resolve the runtime dir + Chromium path + Python convert binary once, to pass into runExportTask. */
export function resolveExportRuntime(): ExportRuntimeHandle {
	const exportDir = getExportRuntimeDir();
	const chromiumPath = discoverChromiumPath(exportDir);
	const pythonConvertPath = discoverPythonConvertBinary(exportDir);
	return { exportDir, chromiumPath, pythonConvertPath };
}

/**
 * Run one task against the vendored runtime and return its parsed JSON
 * response. Throws ExportRuntimeError on any failure (missing entrypoint,
 * missing Chromium, subprocess failure, missing/malformed response,
 * response.ok !== true).
 */
export interface RunExportTaskOptions {
	timeoutMs?: number;
	/** Set when the task needs the vendored runtime's frozen Python conversion binary (see discoverPythonConvertBinary). */
	requiresPythonConvert?: boolean;
	/** Set false for tasks that never touch Chromium (e.g. pptx-to-json). Defaults to true. */
	requiresChromium?: boolean;
}

export async function runExportTask(
	taskPayload: Record<string, unknown>,
	runtime: ExportRuntimeHandle,
	tempDir: string,
	opts: RunExportTaskOptions = {},
): Promise<Record<string, unknown>> {
	const { exportDir, chromiumPath, pythonConvertPath } = runtime;
	const { timeoutMs = DEFAULT_EXPORT_TASK_TIMEOUT_MS, requiresPythonConvert = false, requiresChromium = true } = opts;
	const entrypoint = join(exportDir, "index.js");
	if (!existsSync(entrypoint)) throw new ExportRuntimeError(`Export runtime entrypoint not found at ${entrypoint}`);
	if (requiresChromium && (!chromiumPath || !existsSync(chromiumPath))) {
		throw new ExportRuntimeError(`Chromium not found at ${chromiumPath}. Set PRESENTING_CHROMIUM_PATH.`);
	}
	if (requiresPythonConvert && !pythonConvertPath) {
		throw new ExportRuntimeError(
			"Python convert binary not found for this platform. Set PRESENTING_PYTHON_CONVERT_PATH.",
		);
	}

	const workDir = mkdtempSync(join(tempDir, "export-task-"));
	const taskPath = join(workDir, "export_task.json");
	const responsePath = join(workDir, "export_task.response.json");
	writeFileSync(taskPath, JSON.stringify(taskPayload));

	const puppeteerTmpDir = join(tempDir, "puppeteer");
	mkdirSync(puppeteerTmpDir, { recursive: true });
	const puppeteerCacheDir = join(tempDir, "puppeteer-cache");
	mkdirSync(puppeteerCacheDir, { recursive: true });

	const appDataDirectory = process.env.APP_DATA_DIRECTORY ?? tmpdir();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		APP_DATA_DIRECTORY: appDataDirectory,
		TEMP_DIRECTORY: tempDir,
		PUPPETEER_TMP_DIR: puppeteerTmpDir,
		PUPPETEER_CACHE_DIR: puppeteerCacheDir,
		PUPPETEER_EXECUTABLE_PATH: chromiumPath,
		PRESENTON_ELECTRON: "true",
		EXPORT_TASK_PATH: taskPath,
		EXPORT_RESPONSE_PATH: responsePath,
		...(requiresPythonConvert
			? {
					BUILT_PYTHON_MODULE_PATH: pythonConvertPath,
					// The convert binary builds every extracted asset's "data" URL
					// as `${ASSETS_BASE_URL}/<relative-path-under-appDataDirectory>`.
					// Prefixing it with file:// over the same appDataDirectory root
					// (rather than an http URL) means those "data" values come back
					// as directly-readable file:// paths to the real extracted
					// asset — confirmed empirically by extracting a real embedded
					// image and reading it back at the returned path.
					ASSETS_BASE_URL: process.env.ASSETS_BASE_URL ?? `file://${appDataDirectory}`,
				}
			: {}),
	};

	try {
		await execFileAsync("node", [entrypoint, "--task", taskPath, "--response", responsePath], {
			cwd: exportDir,
			env,
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (err: any) {
		const msg = err.stderr ?? err.message ?? String(err);
		throw new ExportRuntimeError(`Export runtime failed: ${String(msg).slice(0, 500)}`);
	}

	if (!existsSync(responsePath)) throw new ExportRuntimeError("Export runtime did not produce a response file.");
	const response = JSON.parse(readFileSync(responsePath, "utf-8")) as Record<string, unknown>;
	// The runtime's success payload is the handler's raw return value (e.g.
	// { file_path } or { url }) with no "ok" wrapper — confirmed empirically
	// (a real json-to-image call returns exactly { file_path: "..." }, no
	// "ok" key at all). Failures never reach this point: a non-zero exit
	// (invalid task type, etc.) writes no response file and is already
	// caught by the execFileAsync try/catch above. Only treat an explicit
	// `error` field as failure, don't require an `ok` field to be truthy.
	if (response.error) throw new ExportRuntimeError(String(response.error));
	return response;
}

/** Read and parse the JSON file behind a `{ url: "file://..." }` task response (pptx-to-json/pptx-to-html). */
export function readFileUrlJson(fileUrl: string): unknown {
	const path = fileUrl.startsWith("file://") ? decodeURIComponent(new URL(fileUrl).pathname) : fileUrl;
	if (!existsSync(path)) throw new ExportRuntimeError(`Export runtime response file not found: ${path}`);
	return JSON.parse(readFileSync(path, "utf-8"));
}

/** Create (and the caller must clean up) a fresh temp dir for a batch of export-runtime tasks. */
export function createExportTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupExportTempDir(tempDir: string): void {
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch { /* ignore */ }
}
