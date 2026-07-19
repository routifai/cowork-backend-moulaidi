// Cross-platform prebuild script for Tauri beforeBuildCommand
// Bundles the agent-sidecar into a single self-contained CJS file
// with all dependencies inlined, so no node_modules/ needed at runtime.
//
// The vendored pi-anthropic-messages bridge is managed by
// `agent-sidecar/scripts/fetch-vendor.mjs`, which the sidecar's
// `postinstall` hook runs automatically before tsc/esbuild see the
// source. We don't duplicate that logic here — the `pnpm install` below
// triggers it.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sidecarDir = join(root, "backend", "agent-sidecar");

console.log("[prebuild] Building agent-sidecar bundle...");
execSync("pnpm install --frozen-lockfile && pnpm run bundle", {
	cwd: sidecarDir,
	shell: true,
	stdio: "inherit",
});

// Patch import_meta.url for CJS compatibility.
// esbuild shims `import.meta.url` as `import_meta<number> = {}` and reads `.url`
// at runtime. In CJS the object is empty so `.url` is undefined -> fileURLToPath
// throws at module load. Two shapes occur:
//   (a) top-level: `var import_meta10 = {};`            (our own source)
//   (b) inside __esm() wrappers, split: declaration `var ..., import_meta, ...;`
//       then assignment `import_meta = {};` with NO `var` (pi-SDK modules).
// Matching the assignment (no `var ` prefix) catches both.
console.log("[prebuild] Patching import_meta.url...");
const bundlePath = join(sidecarDir, "dist", "bundle.cjs");
let code = readFileSync(bundlePath, "utf-8");
const importMetaRe = /(import_meta\d*) = \{\};/g;
const patchedCount = (code.match(importMetaRe) || []).length;
code = code.replace(
	importMetaRe,
	'$1 = { url: require("url").pathToFileURL(__filename).href };',
);
console.log(`[prebuild]   patched ${patchedCount} import_meta.url shims`);
writeFileSync(bundlePath, code, "utf-8");

// Inline pi-coding-agent's package.json into the bundle to avoid
// needing the file at runtime (the bundled code reads its own
// package.json for name, version, piConfig.configDir, etc.).
console.log("[prebuild] Inlining pi-coding-agent package.json...");
const piPkgPath = join(sidecarDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const piPkg = JSON.parse(readFileSync(piPkgPath, "utf-8"));
const inlinedPkg = JSON.stringify({ name: piPkg.name, version: piPkg.version, piConfig: piPkg.piConfig });
code = code.replace(
	'var pkg = JSON.parse((0, import_fs.readFileSync)(getPackageJsonPath(), "utf-8"));',
	`var pkg = ${inlinedPkg};`,
);
writeFileSync(bundlePath, code, "utf-8");

// Inject the embedded Anthropic API key. There is no user-facing "paste your
// key" UI — the app boots straight into chat, authenticated by this key.
// Sourced from $ANTHROPIC_API_KEY or the gitignored
// backend/agent-sidecar/anthropic-api-key file, and baked into the bundle. If
// unavailable, the placeholder stays and chat requests fail cleanly until
// one is configured (see backend/agent-sidecar/src/index.ts).
console.log("[prebuild] Injecting embedded Anthropic API key...");
const anthropicKeyFile = join(sidecarDir, "anthropic-api-key");
const anthropicKey =
	(process.env.ANTHROPIC_API_KEY || "").trim() ||
	(existsSync(anthropicKeyFile) ? readFileSync(anthropicKeyFile, "utf-8").trim() : "");
if (anthropicKey) {
	code = code.split("__ANTHROPIC_API_KEY__").join(anthropicKey);
	writeFileSync(bundlePath, code, "utf-8");
	console.log("[prebuild]   Anthropic API key injected");
} else {
	console.warn("[prebuild]   no ANTHROPIC_API_KEY — chat will fail until one is configured");
}

writeFileSync(bundlePath, code, "utf-8");

// Copy bundled file into src-tauri/ for Tauri resource bundling
const targetDir = join(root, "src-tauri", "agent-sidecar");
mkdirSync(targetDir, { recursive: true });
// Clean stale files from previous builds
console.log("[prebuild] Cleaning stale artifacts...");
for (const f of ["index.cjs", "index.d.ts", "index.js", "index.js.map", "index.d.ts.map"]) {
	try { rmSync(join(targetDir, f)); } catch { /* ignore */ }
}

console.log("[prebuild] Copying bundle...");
cpSync(bundlePath, join(targetDir, "index.cjs"));

console.log(`[prebuild] Done (${(code.length / 1024 / 1024).toFixed(1)} MB)`);
